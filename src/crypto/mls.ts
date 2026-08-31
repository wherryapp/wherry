// The real E2EProvider: MLS via ts-mls, RFC 9420.
//
// ---------------------------------------------------------------------------
// The shape of the thing
// ---------------------------------------------------------------------------
//
// One MLS group per conversation; the leaves are *devices* (rule 4 -- devices
// are the unit of identity). Each leaf's credential is UTF-8 JSON
// `{"u": userId, "d": deviceId}`, signed by the device's stable identity key
// -- the one published to `devices.identity_public_key`. Messages are sealed
// once for the whole group and the server copies the ciphertext into every
// member device's envelope; archive rows are a separate HPKE seal to each
// recipient user's account key (crypto/keys.ts), because a device that joins
// next year can never open ciphertext ratcheted away this year.
//
// ---------------------------------------------------------------------------
// State, and why every operation loads it fresh
// ---------------------------------------------------------------------------
//
// MLS state is a ratchet: encrypting, decrypting and committing all advance
// it, and two copies that both advance have forked -- messages start failing
// to decrypt and the group is corrupt. Any tab may call encrypt (enqueue runs
// wherever the user typed), so the state cannot live in module memory.
// Instead every operation takes a Web Lock named for the conversation, loads
// the state from IndexedDB inside the lock, mutates, persists, releases.
// Tabs never share or cache state, so they cannot fork it. Web Locks is
// already a hard dependency -- the sync leader election is built on it.
//
// The commit operations extend the lock across server delivery: a commit the
// server rejected (somebody else won the epoch) must never advance local
// state, so persistence happens only after the 201, with the lock held so
// nothing else touches the group in between.
//
// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// ts-mls throws its own error types; this file maps them onto E2EError codes
// the engine dispatches on. NOT_IN_GROUP means "no state at all" -- the
// forward archive sync will cover the message. EPOCH_UNAVAILABLE means state
// exists but cannot open this ciphertext -- ahead of us (commits pending) or
// behind us (ratchet key consumed; the dedup-before-decrypt rule exists so
// this is never hit for a redelivery).

import {
  acceptAll,
  createApplicationMessage,
  createCommit,
  createGroup as mlsCreateGroup,
  createGroupInfoWithExternalPubAndRatchetTree,
  decodeGroupState,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  generateKeyPackageWithKey,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  joinGroupExternal,
  processMessage,
  type ClientState,
  type Credential,
  type MLSMessage,
  type Proposal,
} from "ts-mls";
import { defaultClientConfig } from "ts-mls/clientConfig.js";
import { ratchetTreeFromExtension } from "ts-mls/groupInfo.js";
import {
  deleteGroup,
  deleteKeyPackage,
  latestHistoryKey,
  listKeyPackages,
  loadAccountKeypair,
  loadGroup,
  loadHistoryKey,
  loadMlsIdentity,
  saveGroup,
  saveKeyPackages,
  saveMlsIdentity,
} from "./db";
import { openArchive, openWithHistoryKey, sealWithHistoryKey } from "./keys";
import {
  E2EError,
  PROTOCOL_HISTORY_KEY,
  PROTOCOL_MLS,
  PROTOCOL_PLAINTEXT,
  type AddMemberInput,
  type ArchivePayload,
  type DecryptInput,
  type E2EProvider,
  type HandshakeOps,
  type InitSessionInput,
  type ProtocolVersion,
  type RosterEntry,
  type WirePayload,
} from "./provider";

// The default suite: X25519 KEM (the same curve the account key uses),
// AES-128-GCM, Ed25519 signatures. The one suite ts-mls supports with no
// extra dependencies, and there is no reason to be exotic here.
const CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

let csPromise: ReturnType<typeof getCiphersuiteImpl> | null = null;

function cs() {
  csPromise ??= getCiphersuiteImpl(getCiphersuiteFromName(CIPHERSUITE));
  return csPromise;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function credentialFor(me: { userId: string; deviceId: string }): Credential {
  return {
    credentialType: "basic",
    identity: encoder.encode(JSON.stringify({ u: me.userId, d: me.deviceId })),
  };
}

function parseCredential(
  credential: Credential,
): { userId: string; deviceId: string } | null {
  if (credential.credentialType !== "basic") return null;
  try {
    const parsed = JSON.parse(decoder.decode(credential.identity)) as {
      u?: string;
      d?: string;
    };
    if (typeof parsed.u !== "string" || typeof parsed.d !== "string") {
      return null;
    }
    return { userId: parsed.u, deviceId: parsed.d };
  } catch {
    return null;
  }
}

function withGroupLock<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return navigator.locks.request(`messenger.mls.${conversationId}`, fn);
}

async function loadState(conversationId: string): Promise<ClientState | null> {
  const stored = await loadGroup(conversationId);
  if (!stored) return null;
  const [groupState] = decodeGroupState(stored.state, 0)!;
  // ClientState is GroupState plus config; the config is behaviour, not
  // state, so it is reattached rather than persisted.
  return { ...groupState, clientConfig: defaultClientConfig };
}

async function persistState(
  conversationId: string,
  state: ClientState,
): Promise<void> {
  await saveGroup(conversationId, {
    state: encodeGroupState(state),
    epoch: Number(state.groupContext.epoch),
  });
}

/** MLSMessage -> wire bytes and back, with the checks the wire cannot make. */
function decodeWire(bytes: Uint8Array, expect: string): MLSMessage {
  const decoded = decodeMlsMessage(bytes, 0);
  if (!decoded) {
    throw new E2EError("EPOCH_UNAVAILABLE", "Payload is not an MLS message");
  }
  const [message] = decoded;
  if (message.wireformat !== expect) {
    throw new E2EError(
      "EPOCH_UNAVAILABLE",
      `Expected ${expect}, got ${message.wireformat}`,
    );
  }
  return message;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

class MlsHandshake implements HandshakeOps {
  async ensureIdentity(me: {
    userId: string;
    deviceId: string;
  }): Promise<Uint8Array> {
    void me;
    const existing = await loadMlsIdentity();
    if (existing) return existing.publicKey;

    const suite = await cs();
    const pair = await suite.signature.keygen();
    await saveMlsIdentity({
      publicKey: pair.publicKey,
      privateKey: pair.signKey,
    });
    return pair.publicKey;
  }

  async generateKeyPackages(
    me: { userId: string; deviceId: string },
    count: number,
  ): Promise<Uint8Array[]> {
    const suite = await cs();
    const identity = await loadMlsIdentity();
    if (!identity) {
      throw new Error("ensureIdentity must run before generateKeyPackages");
    }

    const wires: Uint8Array[] = [];
    const records = [];
    for (let i = 0; i < count; i++) {
      // The stable identity key signs every package, so the leaf this
      // device occupies in any group is verifiable against the one key the
      // server publishes for it.
      const pkg = await generateKeyPackageWithKey(
        credentialFor(me),
        defaultCapabilities(),
        defaultLifetime,
        [],
        { signKey: identity.privateKey, publicKey: identity.publicKey },
        suite,
      );
      const wire = encodeMlsMessage({
        version: "mls10",
        wireformat: "mls_key_package",
        keyPackage: pkg.publicPackage,
      });
      wires.push(wire);
      records.push({
        publicWire: wire,
        initPrivateKey: pkg.privatePackage.initPrivateKey,
        hpkePrivateKey: pkg.privatePackage.hpkePrivateKey,
        signaturePrivateKey: pkg.privatePackage.signaturePrivateKey,
        createdAt: new Date().toISOString(),
      });
    }

    await saveKeyPackages(records);
    return wires;
  }

  async epoch(conversationId: string): Promise<number | null> {
    const stored = await loadGroup(conversationId);
    return stored ? stored.epoch : null;
  }

  async createGroup(
    conversationId: string,
    me: { userId: string; deviceId: string },
  ): Promise<void> {
    await withGroupLock(conversationId, async () => {
      if (await loadGroup(conversationId)) return;

      const suite = await cs();
      const identity = await loadMlsIdentity();
      if (!identity) {
        throw new Error("ensureIdentity must run before createGroup");
      }

      // The creator's own leaf comes from a key package generated and
      // consumed on the spot -- never published, so no welcome can ever
      // reference it.
      const pkg = await generateKeyPackageWithKey(
        credentialFor(me),
        defaultCapabilities(),
        defaultLifetime,
        [],
        { signKey: identity.privateKey, publicKey: identity.publicKey },
        suite,
      );

      const state = await mlsCreateGroup(
        encoder.encode(conversationId),
        pkg.publicPackage,
        pkg.privatePackage,
        [],
        suite,
      );
      await persistState(conversationId, state);
    });
  }

  async roster(conversationId: string): Promise<RosterEntry[]> {
    const state = await loadState(conversationId);
    if (!state) return [];

    // Leaves sit at the even node indexes of the ratchet tree; a blank one
    // is an empty slot. leafIndex = nodeIndex / 2 is what a Remove names.
    const entries: RosterEntry[] = [];
    for (let i = 0; i < state.ratchetTree.length; i += 2) {
      const node = state.ratchetTree[i];
      if (!node || node.nodeType !== "leaf") continue;
      const parsed = parseCredential(node.leaf.credential);
      if (!parsed) continue;
      entries.push({ ...parsed, leafIndex: i / 2 });
    }
    return entries;
  }

  async commitAdd(
    conversationId: string,
    keyPackages: readonly Uint8Array[],
    deliver: (out: {
      epoch: number;
      commit: Uint8Array;
      welcome: Uint8Array;
    }) => Promise<boolean>,
  ): Promise<number | null> {
    return await withGroupLock(conversationId, async () => {
      const suite = await cs();
      const state = await loadState(conversationId);
      if (!state) {
        throw new E2EError("NOT_IN_GROUP", "No group state to add members to");
      }

      const proposals: Proposal[] = keyPackages.map((wire) => {
        const message = decodeWire(wire, "mls_key_package");
        if (message.wireformat !== "mls_key_package") throw new Error("unreachable");
        return { proposalType: "add", add: { keyPackage: message.keyPackage } };
      });

      const result = await createCommit(
        { state, cipherSuite: suite },
        // The ratchet tree rides inside the welcome, so a joiner needs
        // nothing out of band.
        { extraProposals: proposals, ratchetTreeExtension: true },
      );
      if (!result.welcome) {
        throw new Error("an add commit must produce a welcome");
      }

      const epoch = Number(result.newState.groupContext.epoch);
      const accepted = await deliver({
        epoch,
        commit: encodeMlsMessage(result.commit),
        welcome: encodeMlsMessage({
          version: "mls10",
          wireformat: "mls_welcome",
          welcome: result.welcome,
        }),
      });

      // Only now. A rejected commit (409 -- somebody else won the epoch)
      // must leave local state exactly where it was.
      if (!accepted) return null;
      await persistState(conversationId, result.newState);
      return epoch;
    });
  }

  async commitRemove(
    conversationId: string,
    leafIndexes: readonly number[],
    deliver: (out: { epoch: number; commit: Uint8Array }) => Promise<boolean>,
  ): Promise<number | null> {
    return await withGroupLock(conversationId, async () => {
      const suite = await cs();
      const state = await loadState(conversationId);
      if (!state) {
        throw new E2EError("NOT_IN_GROUP", "No group state to remove from");
      }

      const proposals: Proposal[] = leafIndexes.map((leafIndex) => ({
        proposalType: "remove",
        remove: { removed: leafIndex },
      }));

      const result = await createCommit(
        { state, cipherSuite: suite },
        { extraProposals: proposals },
      );

      const epoch = Number(result.newState.groupContext.epoch);
      const accepted = await deliver({
        epoch,
        commit: encodeMlsMessage(result.commit),
      });

      if (!accepted) return null;
      await persistState(conversationId, result.newState);
      return epoch;
    });
  }

  async applyCommit(
    conversationId: string,
    commit: Uint8Array,
  ): Promise<{ epoch: number; removed: boolean }> {
    return await withGroupLock(conversationId, async () => {
      const suite = await cs();
      const state = await loadState(conversationId);
      if (!state) {
        throw new E2EError("NOT_IN_GROUP", "No group state to apply a commit to");
      }

      // Two legitimate shapes: a member's commit is a private message, and
      // an external commit -- a device joining by itself off the published
      // GroupInfo -- is a public one, per RFC 9420. Same feed, same apply.
      const decoded = decodeMlsMessage(commit, 0);
      if (!decoded) {
        throw new E2EError("EPOCH_UNAVAILABLE", "Payload is not an MLS message");
      }
      const [message] = decoded;
      if (
        message.wireformat !== "mls_private_message" &&
        message.wireformat !== "mls_public_message"
      ) {
        throw new E2EError(
          "EPOCH_UNAVAILABLE",
          `Expected a commit message, got ${message.wireformat}`,
        );
      }

      let result;
      try {
        result = await processMessage(
          message,
          state,
          emptyPskIndex,
          acceptAll,
          suite,
        );
      } catch (error) {
        throw new E2EError(
          "EPOCH_UNAVAILABLE",
          `Could not apply commit: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const epoch = Number(result.newState.groupContext.epoch);

      // Being removed is a normal ending, not an error: the state is gone
      // and the caller stops trying to reconcile this conversation.
      if (result.newState.groupActiveState.kind !== "active") {
        await deleteGroup(conversationId);
        return { epoch, removed: true };
      }

      await persistState(conversationId, result.newState);
      return { epoch, removed: false };
    });
  }

  async joinFromWelcome(
    conversationId: string,
    welcome: Uint8Array,
  ): Promise<{ epoch: number }> {
    return await withGroupLock(conversationId, async () => {
      const suite = await cs();
      const message = decodeWire(welcome, "mls_welcome");
      if (message.wireformat !== "mls_welcome") throw new Error("unreachable");

      // What this device already has, if anything -- the guard below needs
      // it, and reading it once outside the loop keeps the hot path cheap.
      const existing = await loadGroup(conversationId);

      // The welcome names one of our published key packages by hash. Rather
      // than reimplementing the ref computation, try each stored private in
      // turn -- there are at most a couple of dozen, and a mismatch fails
      // immediately.
      const candidates = await listKeyPackages();
      for (const candidate of candidates) {
        const publicMessage = decodeMlsMessage(candidate.record.publicWire, 0);
        if (!publicMessage || publicMessage[0].wireformat !== "mls_key_package") {
          continue;
        }

        try {
          const state = await joinGroup(
            message.welcome,
            publicMessage[0].keyPackage,
            {
              initPrivateKey: candidate.record.initPrivateKey,
              hpkePrivateKey: candidate.record.hpkePrivateKey,
              signaturePrivateKey: candidate.record.signaturePrivateKey,
            },
            emptyPskIndex,
            suite,
          );

          const welcomeEpoch = Number(state.groupContext.epoch);

          // Never roll backwards. A welcome used to be the newest thing that
          // could arrive with state already present (a re-add, or a
          // redelivery), so it always won. External commits broke that: this
          // device can join itself at epoch N+1 while a welcome for epoch N
          // is still queued, and persisting the older state would strand it
          // one epoch behind a commit it can never apply -- its own. The
          // package is still consumed and the welcome still acked; the only
          // change is that the newer state stays.
          if (existing && existing.epoch >= welcomeEpoch) {
            await deleteKeyPackage(candidate.id);
            return { epoch: existing.epoch };
          }

          await persistState(conversationId, state);
          // Consumed: the server hands a key package out once, so no other
          // welcome will ever reference this one.
          await deleteKeyPackage(candidate.id);
          return { epoch: welcomeEpoch };
        } catch {
          // Not ours, or not this package. Try the next.
        }
      }

      throw new E2EError(
        "NOT_IN_GROUP",
        "No stored key package matches this welcome",
      );
    });
  }

  async exportGroupInfo(
    conversationId: string,
  ): Promise<{ epoch: number; groupInfo: Uint8Array } | null> {
    // Read-only -- deriving and signing a GroupInfo advances nothing -- but
    // still under the lock so the snapshot is of a settled state, not one
    // mid-commit in another tab.
    return await withGroupLock(conversationId, async () => {
      const suite = await cs();
      const state = await loadState(conversationId);
      if (!state) return null;

      // The ratchet tree rides inside as an extension, the same decision
      // commitAdd makes for welcomes: a joiner needs nothing out of band.
      const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
        state,
        [],
        suite,
      );

      return {
        epoch: Number(state.groupContext.epoch),
        groupInfo: encodeMlsMessage({
          version: "mls10",
          wireformat: "mls_group_info",
          groupInfo,
        }),
      };
    });
  }

  async joinExternal(
    conversationId: string,
    me: { userId: string; deviceId: string },
    groupInfoWire: Uint8Array,
    deliver: (out: { epoch: number; commit: Uint8Array }) => Promise<boolean>,
  ): Promise<number | null> {
    return await withGroupLock(conversationId, async () => {
      // A welcome that arrived while this call waited on the lock has
      // already given us the group; joining again would fork it.
      const existing = await loadGroup(conversationId);
      if (existing) return existing.epoch;

      const suite = await cs();
      const identity = await loadMlsIdentity();
      if (!identity) {
        throw new Error("ensureIdentity must run before joinExternal");
      }

      const message = decodeWire(groupInfoWire, "mls_group_info");
      if (message.wireformat !== "mls_group_info") throw new Error("unreachable");

      // Resync when a leaf signed by this device's identity key is already
      // in the tree -- the group state behind it is gone but the identity
      // survived, and RFC 9420's resync form removes the dead leaf in the
      // same commit that adds the live one. The test MUST be the signature
      // key, not the credential: ts-mls locates the leaf to remove by
      // comparing our new package's signature key against each leaf, so a
      // resync flagged on any weaker match (a credential naming this
      // device, say, left by an identity that no longer exists) would send
      // it hunting for a leaf it can never find. A dead leaf under a lost
      // identity is left alone -- a plain join adds our live leaf beside
      // it, and device management removes the stale one the day the old
      // device id is revoked.
      const tree = ratchetTreeFromExtension(message.groupInfo);
      if (!tree) {
        throw new E2EError(
          "EPOCH_UNAVAILABLE",
          "GroupInfo carries no ratchet tree",
        );
      }
      const resync = tree.some((node) => {
        if (!node || node.nodeType !== "leaf") return false;
        const leafKey = node.leaf.signaturePublicKey;
        if (leafKey.length !== identity.publicKey.length) return false;
        return leafKey.every((byte, i) => byte === identity.publicKey[i]);
      });

      // A fresh package generated and consumed on the spot, exactly like
      // createGroup's own leaf -- never published, so no welcome can ever
      // reference it.
      const pkg = await generateKeyPackageWithKey(
        credentialFor(me),
        defaultCapabilities(),
        defaultLifetime,
        [],
        { signKey: identity.privateKey, publicKey: identity.publicKey },
        suite,
      );

      const result = await joinGroupExternal(
        message.groupInfo,
        pkg.publicPackage,
        pkg.privatePackage,
        resync,
        suite,
      );

      const epoch = Number(result.newState.groupContext.epoch);
      const accepted = await deliver({
        epoch,
        commit: encodeMlsMessage({
          version: "mls10",
          wireformat: "mls_public_message",
          publicMessage: result.publicMessage,
        }),
      });

      // Only now, the discipline every commit here keeps: a rejected join
      // (stale GroupInfo, or somebody's commit won the epoch) must leave
      // this device exactly where it was -- outside.
      if (!accepted) return null;
      await persistState(conversationId, result.newState);
      return epoch;
    });
  }

  async forgetGroup(conversationId: string): Promise<void> {
    await withGroupLock(conversationId, async () => {
      await deleteGroup(conversationId);
    });
  }
}

export class MlsE2EProvider implements E2EProvider {
  readonly protocolVersion: ProtocolVersion = PROTOCOL_MLS;
  readonly handshake: HandshakeOps = new MlsHandshake();

  /** Group creation is driven through handshake.createGroup by the sync
   * orchestrator, which knows the device identity; this stays a no-op. */
  async initSession(_input: InitSessionInput): Promise<void> {
    // Intentionally empty.
  }

  /** Same: membership changes flow through the reconciliation sweep. */
  async addMember(_input: AddMemberInput): Promise<void> {
    // Intentionally empty.
  }

  async encrypt(
    conversationId: string,
    plaintext: Uint8Array,
  ): Promise<WirePayload> {
    return await withGroupLock(conversationId, async () => {
      const suite = await cs();
      const state = await loadState(conversationId);
      if (!state) {
        throw new E2EError(
          "NOT_IN_GROUP",
          "No group state for this conversation yet",
        );
      }

      const result = await createApplicationMessage(state, plaintext, suite);
      // Persisted before the ciphertext leaves this function: an encryption
      // that advanced the ratchet but was not recorded would reuse a key.
      await persistState(conversationId, result.newState);

      return {
        protocolVersion: PROTOCOL_MLS,
        payload: encodeMlsMessage({
          version: "mls10",
          wireformat: "mls_private_message",
          privateMessage: result.privateMessage,
        }),
        epoch: Number(result.newState.groupContext.epoch),
      };
    });
  }

  async encryptForArchive(
    conversationId: string,
    plaintext: Uint8Array,
  ): Promise<ArchivePayload> {
    // One seal under the newest cached history key -- the v3 replacement for
    // the per-recipient HPKE fan-out. The cache can be behind the server; a
    // send sealed under a stale generation bounces HISTORY_KEY_STALE and the
    // outbox repair re-seals, the same loop EPOCH_STALE already runs.
    const latest = await latestHistoryKey(conversationId);
    if (!latest) {
      throw new E2EError(
        "HISTORY_KEY_UNAVAILABLE",
        "No history key cached for this conversation yet",
      );
    }
    return {
      generation: latest.generation,
      payload: await sealWithHistoryKey(latest.key, plaintext),
    };
  }

  async decrypt(input: DecryptInput): Promise<Uint8Array> {
    if (input.protocolVersion === PROTOCOL_PLAINTEXT) {
      // A version-1 row: plaintext-era bytes, already content. After the
      // cutover wipe none exist server-side, but a long-lived IndexedDB may
      // still replay one through this path, and refusing it would be
      // refusing to read a message this device already had.
      return new Uint8Array(input.payload);
    }
    if (input.protocolVersion === PROTOCOL_HISTORY_KEY) {
      // v3 exists only in the archive: one row per message, AEAD under the
      // history-key generation the row names. An envelope claiming v3 is
      // nonsense -- live delivery is MLS, and stays version 2.
      if (input.source !== "archive" || input.keyGeneration == null) {
        throw new E2EError(
          "UNSUPPORTED_PROTOCOL_VERSION",
          "Protocol version 3 is an archive-row format only",
        );
      }
      const key = await loadHistoryKey(input.conversationId, input.keyGeneration);
      if (!key) {
        // Not an error state, a not-yet state: the key refresh or the
        // generation walk delivers it, and the row heals like any other
        // decryptFailed message.
        throw new E2EError(
          "HISTORY_KEY_UNAVAILABLE",
          `History key generation ${input.keyGeneration} is not cached ` +
            `for this conversation`,
        );
      }
      return await openWithHistoryKey(key, input.payload);
    }
    if (input.protocolVersion !== PROTOCOL_MLS) {
      throw new E2EError(
        "UNSUPPORTED_PROTOCOL_VERSION",
        `Message is protocol version ${input.protocolVersion}, and this ` +
          `provider reads ${PROTOCOL_PLAINTEXT}, ${PROTOCOL_MLS} and ` +
          `${PROTOCOL_HISTORY_KEY}`,
      );
    }

    // The two sources are two different seals under one version number.
    if (input.source === "archive") {
      // A v2 archive row: HPKE to the account key. Every row written before
      // the v3 send path is one of these, forever.
      const keypair = await loadAccountKeypair();
      if (!keypair) {
        throw new E2EError(
          "NO_ACCOUNT_KEY",
          "The account key is not unlocked on this device",
        );
      }
      return await openArchive(keypair.privateKey, input.payload);
    }

    return await withGroupLock(input.conversationId, async () => {
      const suite = await cs();
      const state = await loadState(input.conversationId);
      if (!state) {
        throw new E2EError(
          "NOT_IN_GROUP",
          "No group state for this conversation yet",
        );
      }

      const message = decodeWire(input.payload, "mls_private_message");
      if (message.wireformat !== "mls_private_message") throw new Error("unreachable");

      let result;
      try {
        result = await processMessage(
          message,
          state,
          emptyPskIndex,
          acceptAll,
          suite,
        );
      } catch (error) {
        // Ahead of us (commits pending), behind us (key consumed), or not
        // ours (our own echo -- which dedup-before-decrypt should have
        // filtered). All the same instruction to the engine: not now,
        // archive if ever.
        throw new E2EError(
          "EPOCH_UNAVAILABLE",
          `Could not decrypt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (result.kind !== "applicationMessage") {
        // A commit smuggled through the message path. Applying it here would
        // let any member reorder commits around the server's log.
        throw new E2EError(
          "EPOCH_UNAVAILABLE",
          "Envelope carried a handshake message; commits ride the commit log",
        );
      }

      // Decryption consumed a ratchet key; the state that knows so must be
      // durable before the plaintext is handed anywhere.
      await persistState(input.conversationId, result.newState);
      return result.message;
    });
  }
}
