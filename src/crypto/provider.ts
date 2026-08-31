// The E2E seam: the contract between the sync engine and whatever does the
// cryptography.
//
// Under end-to-end encryption the client is where keys live and where
// encrypt/decrypt actually run -- see CLAUDE.md rule 7. The engine is
// written against "a provider turns plaintext into wire bytes and back"
// instead of "payload is whatever decodeBase64 hands me", which is what let
// MLS land as a new file implementing this interface plus one line in
// index.ts rather than a rewrite of the sync engine. The server once had a
// sibling interface that did the v1 fan-out; it was deleted at the cutover
// -- the server now stores bytes it cannot read, full stop.
//
// The seam is scoped to what the wire actually carries: one plaintext in,
// one wire payload out, and back. A group's MLS ciphertext is one blob the
// server copies into every member device's envelope, so a client sealing a
// message produces exactly the one payload the wire has a field for; the
// per-recipient work that remains client-side -- the archive rows -- gets
// its own method, because those really are N different seals.

export const PROTOCOL_PLAINTEXT = 1;
export const PROTOCOL_MLS = 2;
// v3 is an archive-row format only: AEAD under the per-conversation history
// key. Envelopes are untouched -- live delivery stays MLS ciphertext stamped
// PROTOCOL_MLS. Mirrors server/src/protocol.ts.
export const PROTOCOL_HISTORY_KEY = 3;
// v4 is plaintext BY DESIGN -- public hub channel content, the scoped
// rule-1/9 amendment (docs/architecture.md's hubs section). Deliberately NOT
// part of ProtocolVersion below: no provider ever produces or opens it,
// because there is nothing cryptographic about it. The sync engine
// short-circuits v4 before the provider is ever asked (see decryptForStorage
// in sync/engine.ts), which keeps this seam crypto-only. Mirrors
// server/src/protocol.ts.
export const PROTOCOL_PUBLIC = 4;

export type ProtocolVersion =
  | typeof PROTOCOL_PLAINTEXT
  | typeof PROTOCOL_MLS
  | typeof PROTOCOL_HISTORY_KEY;

/** What actually crosses the wire, and what the local store persists. */
export type WirePayload = {
  protocolVersion: ProtocolVersion;
  payload: Uint8Array;
  /**
   * The group epoch the payload was sealed under. Version 2 only: the send
   * request names it so the server can refuse a message the current roster
   * could not read (409 EPOCH_STALE). Absent under passthrough.
   */
  epoch?: number;
};

export type InitSessionInput = {
  conversationId: string;
  /** Every device that should be able to read the conversation at creation. */
  memberDeviceIds: readonly string[];
};

export type AddMemberInput = {
  conversationId: string;
  deviceId: string;
};

export type DecryptInput = {
  conversationId: string;
  /**
   * Read straight off the envelope or archive row, so it is whatever the
   * server sent rather than a value this process chose -- hence `number`, not
   * `ProtocolVersion`. Validating it is the provider's job, same as on the
   * server.
   */
  protocolVersion: number;
  payload: Uint8Array;
  /**
   * Which of the two content tables the bytes came from. The same
   * protocol_version means two different seals: an envelope is MLS
   * ciphertext for the group, an archive row is HPKE sealed to the account
   * key (v2) or AEAD under a history key (v3). Passthrough ignores this,
   * because under v1 both are plaintext.
   */
  source: "envelope" | "archive";
  /**
   * v3 archive rows only: which history-key generation sealed the payload,
   * read straight off the row like protocolVersion above. Null/absent for
   * everything else.
   */
  keyGeneration?: number | null;
};

export type E2EErrorCode =
  | "UNSUPPORTED_PROTOCOL_VERSION"
  /** No group state for this conversation -- not joined yet. The archive
   * covers what the envelopes cannot; see the engine's forward sync. */
  | "NOT_IN_GROUP"
  /** The message is sealed under an epoch this state cannot open -- ahead
   * (commits not yet processed) or behind (ratchet key already consumed). */
  | "EPOCH_UNAVAILABLE"
  /** The account private key is not unlocked on this device. */
  | "NO_ACCOUNT_KEY"
  /** The history-key generation that sealed this payload is not cached on
   * this device yet -- or, on encrypt, no generation is cached at all. The
   * poll loop's key refresh and the generation walk are what heal it. */
  | "HISTORY_KEY_UNAVAILABLE";

/** Same shape as the server's E2EError: a code, never anything HTTP-shaped. */
export class E2EError extends Error {
  readonly code: E2EErrorCode;

  constructor(code: E2EErrorCode, message: string) {
    super(message);
    this.name = "E2EError";
    this.code = code;
  }
}

/**
 * One recipient user's published account key -- what history keys are
 * *wrapped* to (crypto/history.ts). The archive payload itself stopped being
 * sealed per recipient at protocol v3.
 */
export type ArchiveRecipient = {
  userId: string;
  /** The account public key from GET /conversations/:id/recipients. */
  publicKey: Uint8Array;
};

/** One archive seal: the whole message under one history-key generation. */
export type ArchivePayload = {
  generation: number;
  payload: Uint8Array;
};

/** One leaf of the MLS group, as the reconciliation sweep reads it. */
export type RosterEntry = {
  userId: string;
  deviceId: string;
  /** What a Remove proposal names. */
  leafIndex: number;
};

/**
 * The membership operations the sync orchestrator drives. An optional
 * capability object rather than methods on E2EProvider, so the passthrough
 * simply does not have one and the engine skips every step that needs it --
 * no stub implementations pretending an unencrypted build has a roster.
 *
 * The commit operations take a `deliver` callback and hold the group lock
 * across it: a commit the server rejected (409, somebody else won the epoch)
 * must never advance local state, and the only way to guarantee that is to
 * persist the new state after the server accepts, without letting another
 * operation touch the group in between.
 */
export interface HandshakeOps {
  /** This device's stable MLS signature public key, generating it on first call. */
  ensureIdentity(me: { userId: string; deviceId: string }): Promise<Uint8Array>;

  /** Fresh single-use key packages, wire-encoded; privates are kept locally. */
  generateKeyPackages(
    me: { userId: string; deviceId: string },
    count: number,
  ): Promise<Uint8Array[]>;

  /** Local epoch for a conversation, or null when this device has no group state. */
  epoch(conversationId: string): Promise<number | null>;

  /** Create the group at epoch 0. No-op if state already exists. */
  createGroup(
    conversationId: string,
    me: { userId: string; deviceId: string },
  ): Promise<void>;

  /** Who is in the local group state, per leaf credential. */
  roster(conversationId: string): Promise<RosterEntry[]>;

  /**
   * Commit adding the given (wire-encoded) key packages. `deliver` posts the
   * commit and welcome to the server; local state advances only if it
   * resolves true. Returns the new epoch, or null when delivery declined.
   */
  commitAdd(
    conversationId: string,
    keyPackages: readonly Uint8Array[],
    deliver: (out: {
      epoch: number;
      commit: Uint8Array;
      welcome: Uint8Array;
    }) => Promise<boolean>,
  ): Promise<number | null>;

  /** Commit removing the given leaves. Same delivery contract as commitAdd. */
  commitRemove(
    conversationId: string,
    leafIndexes: readonly number[],
    deliver: (out: { epoch: number; commit: Uint8Array }) => Promise<boolean>,
  ): Promise<number | null>;

  /**
   * Apply somebody else's commit from the wire. `removed` reports that this
   * very device was removed, after which the group state is gone.
   */
  applyCommit(
    conversationId: string,
    commit: Uint8Array,
  ): Promise<{ epoch: number; removed: boolean }>;

  /** Join a group from a welcome addressed to one of our key packages. */
  joinFromWelcome(
    conversationId: string,
    welcome: Uint8Array,
  ): Promise<{ epoch: number }>;

  /**
   * The current state as a wire-encoded GroupInfo (external pub + ratchet
   * tree riding inside), for the server's external-join bootstrap. Null when
   * this device holds no state for the conversation.
   */
  exportGroupInfo(
    conversationId: string,
  ): Promise<{ epoch: number; groupInfo: Uint8Array } | null>;

  /**
   * Join a group by external commit, from a wire-encoded GroupInfo -- the
   * path that needs no other device awake. Same delivery contract as
   * commitAdd: local state persists only if `deliver` resolves true.
   * Returns the epoch joined at, or null when delivery declined (the
   * GroupInfo was stale, or somebody's commit won the epoch race).
   */
  joinExternal(
    conversationId: string,
    me: { userId: string; deviceId: string },
    groupInfo: Uint8Array,
    deliver: (out: { epoch: number; commit: Uint8Array }) => Promise<boolean>,
  ): Promise<number | null>;

  /**
   * Discard local group state. For the creation race's loser: a device that
   * made an epoch-0 group nobody else follows discards it and waits for a
   * welcome into the real one.
   */
  forgetGroup(conversationId: string): Promise<void>;
}

export interface E2EProvider {
  /**
   * The version this provider stamps on messages it sends. Exposed so callers
   * never hardcode a number -- `PROTOCOL_PLAINTEXT` was hardcoded at the one
   * send call site before this interface existed, which is exactly the thing
   * this file is for.
   */
  readonly protocolVersion: ProtocolVersion;

  /**
   * The membership operations, present only on a provider that has any.
   * `e2e.handshake === undefined` is how the engine knows this build has no
   * groups to reconcile.
   */
  readonly handshake?: HandshakeOps | undefined;

  /** Establish the group for a new conversation. A no-op under passthrough. */
  initSession(input: InitSessionInput): Promise<void>;

  /** Add a device to an existing conversation. Also a no-op under passthrough. */
  addMember(input: AddMemberInput): Promise<void>;

  /**
   * Seal the archive copy: ONE payload for the whole message, AEAD under the
   * conversation's current history key (protocol v3). The per-recipient
   * signature this replaced was shaped for exactly the fan-out v3 removed --
   * who may read the archive is now decided by who holds the key, not by
   * whom the payload was sealed to. Throws HISTORY_KEY_UNAVAILABLE when no
   * generation is cached yet; the reconciliation sweep bootstraps one.
   */
  encryptForArchive(
    conversationId: string,
    plaintext: Uint8Array,
  ): Promise<ArchivePayload>;

  /**
   * Turn outgoing content bytes into what gets sent on the wire and kept in
   * the outbox. Called once, at compose time -- not re-run on retry, since a
   * retry resends the same wire bytes rather than re-encrypting.
   */
  encrypt(conversationId: string, plaintext: Uint8Array): Promise<WirePayload>;

  /**
   * Turn a received envelope or archive payload back into content bytes.
   *
   * Called once, when a message is first stored -- not at render time. A
   * ratcheting protocol may no longer hold the key for an old epoch by the
   * time something is rendered, so the store keeps the decrypted bytes rather
   * than re-deriving them on every read. See the note on `StoredMessage.payload`
   * in store/types.ts.
   */
  decrypt(input: DecryptInput): Promise<Uint8Array>;
}
