// The external-commit join flow, end to end at the protocol level.
//
// This pins the exact sequence crypto/mls.ts runs for the self-join path --
// GroupInfo derived with the external pub and the ratchet tree riding
// inside, wire-encoded as an MLSMessage, joined against with a fresh
// never-published key package, the resulting external commit applied by
// every member off the wire -- against ts-mls directly, because the
// MlsHandshake class itself needs IndexedDB and Web Locks and so cannot run
// under Node. The one piece of app logic duplicated here is the resync
// rule, and that duplication is the point of the test: resync MUST be
// decided by signature key, the same comparison ts-mls uses to find the
// dead leaf. Deciding it any other way (the credential, say) makes ts-mls
// hunt for a leaf that is not there -- observed as an unbounded spin, not
// an error, which is exactly the kind of breakage only a pinned test
// catches.
//
// Run with `pnpm test` from client/. No database, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptAll,
  createApplicationMessage,
  createGroup,
  createGroupInfoWithExternalPubAndRatchetTree,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackageWithKey,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroupExternal,
  processMessage,
  type ClientState,
  type Credential,
} from "ts-mls";
import { ratchetTreeFromExtension } from "ts-mls/groupInfo.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const suitePromise = getCiphersuiteImpl(
  getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
);

type IdentityKeys = { publicKey: Uint8Array; signKey: Uint8Array };

function credentialFor(userId: string, deviceId: string): Credential {
  return {
    credentialType: "basic",
    identity: encoder.encode(JSON.stringify({ u: userId, d: deviceId })),
  };
}

async function freshPackage(
  userId: string,
  deviceId: string,
  keys: IdentityKeys,
) {
  const suite = await suitePromise;
  return await generateKeyPackageWithKey(
    credentialFor(userId, deviceId),
    defaultCapabilities(),
    defaultLifetime,
    [],
    keys,
    suite,
  );
}

/** GroupInfo export, exactly as exportGroupInfo wires it. */
async function exportInfo(state: ClientState): Promise<Uint8Array> {
  const suite = await suitePromise;
  const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
    state,
    [],
    suite,
  );
  return encodeMlsMessage({
    version: "mls10",
    wireformat: "mls_group_info",
    groupInfo,
  });
}

/** External join, exactly as joinExternal runs it -- including the resync rule. */
async function externalJoin(
  userId: string,
  deviceId: string,
  keys: IdentityKeys,
  groupInfoWire: Uint8Array,
): Promise<{ state: ClientState; commitWire: Uint8Array; resync: boolean }> {
  const suite = await suitePromise;
  const decoded = decodeMlsMessage(groupInfoWire, 0);
  assert.ok(decoded, "GroupInfo wire must decode");
  const [message] = decoded;
  assert.equal(message.wireformat, "mls_group_info");
  if (message.wireformat !== "mls_group_info") throw new Error("unreachable");

  const tree = ratchetTreeFromExtension(message.groupInfo);
  assert.ok(tree, "the ratchet tree must ride inside the GroupInfo");

  // The resync rule under test: signature key, nothing weaker.
  const resync = tree.some((node) => {
    if (!node || node.nodeType !== "leaf") return false;
    const leafKey = node.leaf.signaturePublicKey;
    if (leafKey.length !== keys.publicKey.length) return false;
    return leafKey.every((byte, i) => byte === keys.publicKey[i]);
  });

  const pkg = await freshPackage(userId, deviceId, keys);
  const result = await joinGroupExternal(
    message.groupInfo,
    pkg.publicPackage,
    pkg.privatePackage,
    resync,
    suite,
  );

  return {
    state: result.newState,
    commitWire: encodeMlsMessage({
      version: "mls10",
      wireformat: "mls_public_message",
      publicMessage: result.publicMessage,
    }),
    resync,
  };
}

/** Commit application, exactly as the patched applyCommit accepts wires. */
async function applyCommitWire(
  state: ClientState,
  wire: Uint8Array,
): Promise<ClientState> {
  const suite = await suitePromise;
  const decoded = decodeMlsMessage(wire, 0);
  assert.ok(decoded, "commit wire must decode");
  const [message] = decoded;
  assert.ok(
    message.wireformat === "mls_private_message" ||
      message.wireformat === "mls_public_message",
    `a commit is a private or public message, got ${message.wireformat}`,
  );
  if (
    message.wireformat !== "mls_private_message" &&
    message.wireformat !== "mls_public_message"
  ) {
    throw new Error("unreachable");
  }
  const result = await processMessage(
    message,
    state,
    emptyPskIndex,
    acceptAll,
    suite,
  );
  return result.newState;
}

/** Device ids in the tree, sorted; duplicates preserved deliberately. */
function rosterDevices(state: ClientState): string[] {
  const out: string[] = [];
  for (let i = 0; i < state.ratchetTree.length; i += 2) {
    const node = state.ratchetTree[i];
    if (!node || node.nodeType !== "leaf") continue;
    if (node.leaf.credential.credentialType !== "basic") continue;
    const parsed = JSON.parse(
      decoder.decode(node.leaf.credential.identity),
    ) as { d: string };
    out.push(parsed.d);
  }
  return out.sort();
}

async function send(
  state: ClientState,
  text: string,
): Promise<{ state: ClientState; wire: Uint8Array }> {
  const suite = await suitePromise;
  const result = await createApplicationMessage(
    state,
    encoder.encode(text),
    suite,
  );
  return {
    state: result.newState,
    wire: encodeMlsMessage({
      version: "mls10",
      wireformat: "mls_private_message",
      privateMessage: result.privateMessage,
    }),
  };
}

async function recv(
  state: ClientState,
  wire: Uint8Array,
): Promise<{ state: ClientState; text: string }> {
  const suite = await suitePromise;
  const decoded = decodeMlsMessage(wire, 0);
  assert.ok(decoded);
  const [message] = decoded;
  assert.equal(message.wireformat, "mls_private_message");
  if (message.wireformat !== "mls_private_message") throw new Error("unreachable");
  const result = await processMessage(
    message,
    state,
    emptyPskIndex,
    acceptAll,
    suite,
  );
  assert.equal(result.kind, "applicationMessage");
  if (result.kind !== "applicationMessage") throw new Error("unreachable");
  return { state: result.newState, text: decoder.decode(result.message) };
}

test("a group builds by external joins alone and messages flow across every epoch", async () => {
  const suite = await suitePromise;
  const keysA = await suite.signature.keygen();
  const keysB = await suite.signature.keygen();
  const keysC = await suite.signature.keygen();

  // A creates at epoch 0, the createGroup path: own leaf from a package
  // generated and consumed on the spot.
  const pkgA = await freshPackage("user1", "devA", keysA);
  let stateA = await createGroup(
    encoder.encode("conv-1"),
    pkgA.publicPackage,
    pkgA.privatePackage,
    [],
    suite,
  );
  assert.equal(Number(stateA.groupContext.epoch), 0);

  // B (same user, second device) external-joins off A's published GroupInfo.
  const joinB = await externalJoin("user1", "devB", keysB, await exportInfo(stateA));
  assert.equal(joinB.resync, false);
  let stateB = joinB.state;
  assert.equal(Number(stateB.groupContext.epoch), 1);

  // A applies B's external commit off the wire, like any commit in the feed.
  stateA = await applyCommitWire(stateA, joinB.commitWire);
  assert.equal(Number(stateA.groupContext.epoch), 1);
  assert.deepEqual(rosterDevices(stateA), ["devA", "devB"]);

  // C (another user's device) external-joins off B's fresh GroupInfo -- the
  // joiner publishes next, and the next joiner bootstraps from that.
  const joinC = await externalJoin("user2", "devC", keysC, await exportInfo(stateB));
  let stateC = joinC.state;
  stateA = await applyCommitWire(stateA, joinC.commitWire);
  stateB = await applyCommitWire(stateB, joinC.commitWire);
  assert.deepEqual(rosterDevices(stateA), ["devA", "devB", "devC"]);

  // Messages decrypt in every direction across the joined states.
  const fromA = await send(stateA, "hello after two external joins");
  stateA = fromA.state;
  const atB = await recv(stateB, fromA.wire);
  stateB = atB.state;
  const atC = await recv(stateC, fromA.wire);
  stateC = atC.state;
  assert.equal(atB.text, "hello after two external joins");
  assert.equal(atC.text, "hello after two external joins");

  const fromC = await send(stateC, "C answers");
  const atA = await recv(stateA, fromC.wire);
  assert.equal(atA.text, "C answers");
});

test("resync replaces the dead leaf when the identity survives a state loss", async () => {
  const suite = await suitePromise;
  const keysA = await suite.signature.keygen();
  const keysB = await suite.signature.keygen();

  const pkgA = await freshPackage("user1", "devA", keysA);
  let stateA = await createGroup(
    encoder.encode("conv-2"),
    pkgA.publicPackage,
    pkgA.privatePackage,
    [],
    suite,
  );

  const joinB = await externalJoin("user1", "devB", keysB, await exportInfo(stateA));
  stateA = await applyCommitWire(stateA, joinB.commitWire);

  // B's group state is gone, its identity key is not: the rejoin must be a
  // resync, and the roster must hold exactly one devB afterwards.
  const rejoin = await externalJoin("user1", "devB", keysB, await exportInfo(stateA));
  assert.equal(rejoin.resync, true);
  stateA = await applyCommitWire(stateA, rejoin.commitWire);
  assert.deepEqual(rosterDevices(stateA), ["devA", "devB"]);

  const fromB = await send(rejoin.state, "back");
  const atA = await recv(stateA, fromB.wire);
  assert.equal(atA.text, "back");
});

test("a rejoin under a fresh identity is a plain join beside the dead leaf", async () => {
  const suite = await suitePromise;
  const keysA = await suite.signature.keygen();
  const keysB = await suite.signature.keygen();

  const pkgA = await freshPackage("user1", "devA", keysA);
  let stateA = await createGroup(
    encoder.encode("conv-3"),
    pkgA.publicPackage,
    pkgA.privatePackage,
    [],
    suite,
  );

  const joinB = await externalJoin("user1", "devB", keysB, await exportInfo(stateA));
  stateA = await applyCommitWire(stateA, joinB.commitWire);

  // Full wipe: the identity key is gone too. Flagging resync anyway would
  // send ts-mls after a leaf it can never find; the rule under test keeps
  // this a plain join, dead leaf left beside the live one.
  const freshKeys = await suite.signature.keygen();
  const rejoin = await externalJoin("user1", "devB", freshKeys, await exportInfo(stateA));
  assert.equal(rejoin.resync, false);
  stateA = await applyCommitWire(stateA, rejoin.commitWire);
  assert.deepEqual(rosterDevices(stateA), ["devA", "devB", "devB"]);

  const fromB = await send(rejoin.state, "still here");
  const atA = await recv(stateA, fromB.wire);
  assert.equal(atA.text, "still here");
});
