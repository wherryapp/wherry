import { test } from "node:test";
import assert from "node:assert/strict";
import type { Call } from "../api/types";
import {
  audioPresetFor,
  callKeyContext,
  cameraOnVisibility,
  grantLine,
  echoLine,
  echoState,
  ERLE_CONVERGED_DB,
  ERLE_IDLE_DB,
  callNotice,
  DEFAULT_AUDIO_QUALITY,
  isAudioQuality,
  keyIndexFor,
  KEYRING_SIZE,
  micLine,
  micStatus,
  peerFlow,
  reduceRings,
  SILENT_ENERGY,
  subscriptionFor,
  videoLine,
  RING_TIMEOUT_MS,
  shouldJoinMuted,
  shouldRingAudibly,
  type Ring,
} from "./rules.js";

test("audio quality: speech by default, tiers validated as untrusted input, presets in bits per second", () => {
  assert.equal(DEFAULT_AUDIO_QUALITY, "speech");
  assert.equal(isAudioQuality("music"), true);
  assert.equal(isAudioQuality("musicHighQuality"), true);
  // A stored string that names an Object.prototype member is not a tier.
  assert.equal(isAudioQuality("toString"), false);
  assert.equal(isAudioQuality("hd"), false);
  assert.equal(isAudioQuality(24), false);
  assert.equal(isAudioQuality(null), false);
  assert.deepEqual(audioPresetFor("telephone"), { maxBitrate: 12_000 });
  assert.deepEqual(audioPresetFor("speech"), { maxBitrate: 24_000 });
  assert.deepEqual(audioPresetFor("musicHighQuality"), { maxBitrate: 96_000 });
});

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
  assert.equal(shouldRingAudibly({ conversationMuted: false, ringtoneEnabled: true, dnd: true }), false);
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

test("echo: a call joined with the canceller off says so, whatever the numbers read", () => {
  assert.equal(echoState({ echoReturnLoss: 0, echoReturnLossEnhancement: 0, disabled: true }), "off");
  assert.equal(echoState({ echoReturnLoss: -30, echoReturnLossEnhancement: 20, disabled: true }), "off");
  assert.match(echoLine({ echoReturnLoss: 0, echoReturnLossEnhancement: 0, disabled: true }), /off for this call/);
});

test("echo: ERLE names the canceller's state; missing numbers are unreported, never a fault", () => {
  assert.equal(echoState({ echoReturnLoss: null, echoReturnLossEnhancement: null }), "unreported");
  assert.equal(echoState({ echoReturnLoss: 20, echoReturnLossEnhancement: null }), "unreported");
  assert.equal(echoState({ echoReturnLoss: 20, echoReturnLossEnhancement: Number.NaN }), "unreported");
  assert.equal(echoState({ echoReturnLoss: 5, echoReturnLossEnhancement: 0 }), "idle");
  assert.equal(echoState({ echoReturnLoss: 5, echoReturnLossEnhancement: ERLE_IDLE_DB - 0.1 }), "idle");
  assert.equal(echoState({ echoReturnLoss: 5, echoReturnLossEnhancement: ERLE_IDLE_DB }), "converging");
  assert.equal(echoState({ echoReturnLoss: 5, echoReturnLossEnhancement: ERLE_CONVERGED_DB - 0.1 }), "converging");
  assert.equal(echoState({ echoReturnLoss: 5, echoReturnLossEnhancement: ERLE_CONVERGED_DB }), "converged");
  assert.equal(echoState({ echoReturnLoss: 5, echoReturnLossEnhancement: 40 }), "converged");

  assert.equal(
    echoLine({ echoReturnLoss: null, echoReturnLossEnhancement: null }),
    "canceller not reported by this browser",
  );
  assert.equal(
    echoLine({ echoReturnLoss: 7.6, echoReturnLossEnhancement: 18.2 }),
    "canceller converged (ERL 8 dB · ERLE 18 dB)",
  );
  assert.equal(
    echoLine({ echoReturnLoss: null, echoReturnLossEnhancement: 6 }),
    "canceller converging (ERL ? · ERLE 6 dB)",
  );
  assert.match(echoLine({ echoReturnLoss: 30, echoReturnLossEnhancement: 0.4 }), /^canceller idle -- headphones/);
});

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

test("a tile nobody can see asks for nothing at all", () => {
  const off = subscriptionFor({
    visible: false,
    pinned: true,
    source: "camera",
    participants: 2,
    topLayerCallSize: 12,
  });
  // Not "low": unsubscribed. A tab with the stage closed should pull no
  // video, which is also the whole of the old-client sympathy answer.
  assert.equal(off, "off");
});

test("a screen is always high when visible -- text at the low layer is a smear", () => {
  for (const pinned of [true, false]) {
    assert.equal(
      subscriptionFor({
        visible: true,
        pinned,
        source: "screen",
        participants: 40,
        topLayerCallSize: 12,
      }),
      "high",
    );
  }
});

test("a visible camera is low unless it is the pinned one", () => {
  const base = { visible: true, source: "camera" as const, participants: 4, topLayerCallSize: 12 };
  assert.equal(subscriptionFor({ ...base, pinned: false }), "low");
  assert.equal(subscriptionFor({ ...base, pinned: true }), "high");
});

test("topLayerCallSize is enforced here and only here", () => {
  const base = { visible: true, pinned: true, source: "camera" as const, topLayerCallSize: 12 };
  // At the limit the pinned tile still gets the top layer.
  assert.equal(subscriptionFor({ ...base, participants: 12 }), "high");
  // Past it nobody asks for it, which dynacast turns into the sender not
  // encoding it -- no publisher-side republish anywhere.
  assert.equal(subscriptionFor({ ...base, participants: 13 }), "low");
  // Null is no cutoff.
  assert.equal(
    subscriptionFor({ ...base, participants: 500, topLayerCallSize: null }),
    "high",
  );
});

test("cameraOnVisibility pauses a live camera and resumes only what it paused", () => {
  const hide = (cameraOn: boolean, paused: boolean): string =>
    cameraOnVisibility({ hidden: true, cameraOn, paused });
  const show = (cameraOn: boolean, paused: boolean): string =>
    cameraOnVisibility({ hidden: false, cameraOn, paused });

  assert.equal(hide(true, false), "pause");
  // Already paused, or never on: nothing to do.
  assert.equal(hide(true, true), "nothing");
  assert.equal(hide(false, false), "nothing");

  assert.equal(show(true, true), "resume");
  // Coming back must never start a camera nobody asked for.
  assert.equal(show(false, false), "nothing");
  assert.equal(show(true, false), "nothing");
});

test("grantLine says what this call will carry, and says so when it will not", () => {
  assert.equal(
    grantLine({
      sources: ["camera", "screen"],
      camera: { maxHeight: 720, maxFps: 30 },
      screen: { maxHeight: 1080, maxFps: 15 },
    }),
    "Camera up to 720p · Screen up to 1080p at 15 fps",
  );
  // A source the grant does not carry is not a line reading "0p".
  assert.equal(
    grantLine({
      sources: ["camera"],
      camera: { maxHeight: 360, maxFps: 30 },
      screen: { maxHeight: 1080, maxFps: 15 },
    }),
    "Camera up to 360p",
  );
  assert.equal(grantLine(null), "no video on this call");
  assert.equal(grantLine({ sources: [], camera: null, screen: null }), "no video on this call");
});

test("videoLine degrades to what the browser actually reported", () => {
  assert.equal(
    videoLine({
      width: 1280,
      height: 720,
      fps: 29.7,
      codec: "H264",
      layer: "f",
      implementation: "VideoToolbox",
      limitedBy: "cpu",
    }),
    "1280×720 · 30 fps · H264 · layer f · VideoToolbox · limited by cpu",
  );
  // The stage-0 Chromium reported null for both implementation strings,
  // so a row must still say something with almost nothing in it.
  assert.equal(
    videoLine({
      width: 640,
      height: 360,
      fps: null,
      codec: null,
      layer: null,
      implementation: null,
      limitedBy: null,
    }),
    "640×360",
  );
  // "none" is the browser's word for "nothing is limiting this", which is
  // the good case and deserves no clause.
  assert.equal(
    videoLine({
      width: null,
      height: null,
      fps: null,
      codec: "VP8",
      layer: null,
      implementation: null,
      limitedBy: "none",
    }),
    "VP8",
  );
  assert.equal(
    videoLine({
      width: null,
      height: null,
      fps: null,
      codec: null,
      layer: null,
      implementation: null,
      limitedBy: null,
    }),
    "no reading yet",
  );
});
