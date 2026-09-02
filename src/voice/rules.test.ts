import { test } from "node:test";
import assert from "node:assert/strict";
import type { Call } from "../api/types";
import {
  callKeyContext,
  callNotice,
  keyIndexFor,
  KEYRING_SIZE,
  micLine,
  micStatus,
  peerFlow,
  reduceRings,
  SILENT_ENERGY,
  RING_TIMEOUT_MS,
  shouldJoinMuted,
  shouldRingAudibly,
  type Ring,
} from "./rules.js";

test("keyIndexFor wraps epochs into the keyring and never goes negative", () => {
  assert.equal(keyIndexFor(0), 0);
  assert.equal(keyIndexFor(5), 5);
  assert.equal(keyIndexFor(KEYRING_SIZE), 0);
  assert.equal(keyIndexFor(KEYRING_SIZE + 3), 3);
  assert.equal(keyIndexFor(-1), KEYRING_SIZE - 1);
});

test("callKeyContext is the call id's UTF-8 bytes -- distinct calls, distinct keys", () => {
  assert.deepEqual([...callKeyContext("ab")], [0x61, 0x62]);
  assert.notDeepEqual([...callKeyContext("call-1")], [...callKeyContext("call-2")]);
});

const ring = (callId: string, now = 1_000): Ring => ({
  callId,
  conversationId: "conv",
  byUserId: "alice",
  receivedAt: now,
});

test("a ring adds once; a second frame for the same call is a no-op", () => {
  const once = reduceRings([], { type: "ring", callId: "c1", conversationId: "conv", byUserId: "alice", now: 1 });
  const twice = reduceRings(once, { type: "ring", callId: "c1", conversationId: "conv", byUserId: "alice", now: 2 });
  assert.equal(once.length, 1);
  assert.equal(twice.length, 1);
  assert.equal(twice[0]!.receivedAt, 1);
});

test("a state frame clears the ring when the call ended or when this user is in it", () => {
  const rings = [ring("c1")];
  assert.equal(
    reduceRings(rings, { type: "state", callId: "c1", status: "ended", participants: [], selfUserId: "bob" }).length,
    0,
  );
  // Answered elsewhere: bob's other device picked up.
  assert.equal(
    reduceRings(rings, {
      type: "state",
      callId: "c1",
      status: "active",
      participants: [{ userId: "alice", joined: true }, { userId: "bob", joined: true }],
      selfUserId: "bob",
    }).length,
    0,
  );
  // Somebody else answered a group call: bob is still being asked.
  assert.equal(
    reduceRings(rings, {
      type: "state",
      callId: "c1",
      status: "active",
      participants: [{ userId: "alice", joined: true }, { userId: "carol", joined: true }, { userId: "bob", joined: false }],
      selfUserId: "bob",
    }).length,
    1,
  );
  // A frame about another call leaves this ring alone.
  assert.equal(
    reduceRings(rings, { type: "state", callId: "c9", status: "ended", participants: [], selfUserId: "bob" }).length,
    1,
  );
});

const call = (over: Partial<Call> & { id: string }): Call => ({
  conversationId: "conv",
  kind: "call",
  status: "ringing",
  startedByUserId: "alice",
  startedAt: "2026-09-01T00:00:00.000Z",
  answeredAt: null,
  endedAt: null,
  endReason: null,
  participants: [
    { userId: "alice", deviceId: "a1", invitedAt: "x", answeredAt: "x", declinedAt: null, joinedAt: null, leftAt: null },
    { userId: "bob", deviceId: null, invitedAt: "x", answeredAt: null, declinedAt: null, joinedAt: null, leftAt: null },
  ],
  ...over,
});

test("a snapshot keeps only calls this user is merely invited to, preserving known timestamps", () => {
  const existing = [ring("c1", 500)];
  const next = reduceRings(existing, {
    type: "snapshot",
    calls: [
      call({ id: "c1" }),
      call({ id: "c2" }),
      call({ id: "c3", status: "active" }),
      call({ id: "c4", startedByUserId: "bob" }),
      call({
        id: "c5",
        participants: [
          { userId: "bob", deviceId: null, invitedAt: "x", answeredAt: null, declinedAt: "x", joinedAt: null, leftAt: null },
        ],
      }),
    ],
    selfUserId: "bob",
    now: 9_000,
  });
  assert.deepEqual(next.map((r) => r.callId), ["c1", "c2"]);
  assert.equal(next[0]!.receivedAt, 500); // kept
  assert.equal(next[1]!.receivedAt, 9_000); // new
});

test("dismiss and tick", () => {
  assert.equal(reduceRings([ring("c1")], { type: "dismiss", callId: "c1" }).length, 0);
  const old = ring("old", 0);
  const fresh = ring("fresh", 40_000);
  const kept = reduceRings([old, fresh], { type: "tick", now: RING_TIMEOUT_MS + 6_000 });
  assert.deepEqual(kept.map((r) => r.callId), ["fresh"]);
});

test("shouldRingAudibly: muted conversations and the ringtone switch silence, focus does not", () => {
  assert.equal(shouldRingAudibly({ conversationMuted: false, ringtoneEnabled: true }), true);
  assert.equal(shouldRingAudibly({ conversationMuted: true, ringtoneEnabled: true }), false);
  assert.equal(shouldRingAudibly({ conversationMuted: false, ringtoneEnabled: false }), false);
});

test("shouldJoinMuted: calls never; rooms follow the preference, Automatic follows the server", () => {
  assert.equal(shouldJoinMuted({ kind: "call", preference: "muted", serverJoinMuted: true }), false);
  assert.equal(shouldJoinMuted({ kind: "room", preference: "auto", serverJoinMuted: true }), true);
  assert.equal(shouldJoinMuted({ kind: "room", preference: "auto", serverJoinMuted: false }), false);
  assert.equal(shouldJoinMuted({ kind: "room", preference: "unmuted", serverJoinMuted: true }), false);
  assert.equal(shouldJoinMuted({ kind: "room", preference: "muted", serverJoinMuted: false }), true);
});

test("callNotice is per viewer", () => {
  const base = {
    startedByUserId: "alice",
    startedByName: "Alice",
    answeredAt: "2026-09-01T00:00:10.000Z",
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:12:10.000Z",
    participantUserIds: ["alice", "bob"],
  };
  assert.equal(callNotice({ ...base, endReason: "hangup", selfUserId: "bob" }), "Alice called · 12 min");
  assert.equal(callNotice({ ...base, endReason: "hangup", selfUserId: "alice" }), "You called · 12 min");
  assert.equal(
    callNotice({ ...base, endReason: "hangup", answeredAt: "2026-09-01T00:12:00.000Z", selfUserId: "bob" }),
    "Alice called · under a minute",
  );
  assert.equal(callNotice({ ...base, endReason: "unanswered", answeredAt: null, selfUserId: "bob" }), "Missed call from Alice");
  assert.equal(callNotice({ ...base, endReason: "unanswered", answeredAt: null, selfUserId: "alice" }), "No answer");
  assert.equal(callNotice({ ...base, endReason: "declined", answeredAt: null, selfUserId: "bob" }), "Declined call");
  assert.equal(callNotice({ ...base, endReason: "cancelled", answeredAt: null, selfUserId: "bob" }), "Alice cancelled the call");
  assert.equal(callNotice({ ...base, endReason: "hangup", endedAt: null, selfUserId: "bob" }), "Alice called");
});

test("micStatus: a failure wins, then off > ended > system-muted > muted > on", () => {
  const base = { published: true, muted: false, systemMuted: false, ended: false, failure: null };
  assert.equal(micStatus(base), "on");
  assert.equal(micStatus({ ...base, muted: true }), "muted");
  assert.equal(micStatus({ ...base, systemMuted: true, muted: true }), "system-muted");
  assert.equal(micStatus({ ...base, ended: true, systemMuted: true }), "ended");
  assert.equal(micStatus({ ...base, published: false }), "off");
  assert.equal(micStatus({ ...base, published: false, failure: "refused" }), "refused");
  assert.equal(micStatus({ ...base, published: false, failure: "missing" }), "missing");
  assert.equal(micStatus({ ...base, published: false, failure: "failed" }), "failed");
});

test("micLine names the live-but-silent uplink, and only that, from the packet delta", () => {
  assert.equal(micLine("on", null), "on");
  assert.equal(micLine("on", 97), "on, sending");
  assert.equal(micLine("on", 0), "on, but nothing is leaving this device");
  assert.equal(micLine("muted", 0), "muted");
  assert.match(micLine("system-muted", 40), /silenced by the system/);
  assert.equal(micLine("missing", null), "no microphone found");
});

test("peerFlow tells nothing-arriving, unreadable, silent, not-playing and flowing apart", () => {
  const ok = { bytesDelta: 4_000, energyDelta: 0.02, encryptionErrorsDelta: 0, playing: true };
  assert.equal(peerFlow(ok), "flowing");
  assert.equal(peerFlow({ ...ok, bytesDelta: null }), "no-data");
  assert.equal(peerFlow({ ...ok, bytesDelta: 0 }), "nothing-arriving");
  // Bytes climb, errors climb, no decoded energy: the key is wrong.
  assert.equal(peerFlow({ ...ok, energyDelta: 0, encryptionErrorsDelta: 50 }), "arriving-unreadable");
  assert.equal(peerFlow({ ...ok, energyDelta: null, encryptionErrorsDelta: 50 }), "arriving-unreadable");
  // Errors at an epoch turn with sound still decoding are not a mismatch.
  assert.equal(peerFlow({ ...ok, encryptionErrorsDelta: 3 }), "flowing");
  assert.equal(peerFlow({ ...ok, energyDelta: SILENT_ENERGY / 10 }), "arriving-silent");
  assert.equal(peerFlow({ ...ok, playing: false }), "not-playing");
  // An engine without totalAudioEnergy still gets a verdict on the rest.
  assert.equal(peerFlow({ ...ok, energyDelta: null }), "flowing");
});
