import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoredConversation } from "../store/types";
import {
  ACTION_TTL_MS,
  callServiceWanted,
  FALLBACK_LABEL,
  labelsKey,
  nativeActiveCall,
  nativeApiBase,
  nativeEndReason,
  PAGE_ONLY,
  pendingActionVerdict,
  readAction,
  readCapabilities,
  ringDisplay,
  ringExpiry,
  ringGoneReason,
  ringLabels,
  ringUiOwnsRinging,
  type ActiveCallInput,
  type ActionView,
  type CallFrame,
} from "./phone-rules";
import { RING_TIMEOUT_MS } from "./rules";

const SELF = "u-self";
const DEVICE = "d-self";
const NOW = 1_790_000_000_000;

// -- reading the native side ---------------------------------------------

test("a stub or absent plugin reads as page-only, never as a ring UI that silences the sheet", () => {
  assert.deepEqual(readCapabilities(null), PAGE_ONLY);
  assert.deepEqual(readCapabilities("callkit"), PAGE_ONLY);
  assert.deepEqual(readCapabilities({}), PAGE_ONLY);
  assert.deepEqual(readCapabilities({ ringUi: "siren", callService: "yes", voip: 1 }), PAGE_ONLY);
});

test("a full answer is read as given", () => {
  assert.deepEqual(readCapabilities({ ringUi: "callkit", callService: false, voip: true }), {
    ringUi: "callkit",
    callService: false,
    voip: true,
  });
  assert.deepEqual(readCapabilities({ ringUi: "notification", callService: true }), {
    ringUi: "notification",
    callService: true,
    voip: false,
  });
});

test("an action needs a known kind and a call id; the rest is optional", () => {
  assert.equal(readAction(null), null);
  assert.equal(readAction({ kind: "answer" }), null);
  assert.equal(readAction({ kind: "answer", callId: "" }), null);
  assert.equal(readAction({ kind: "mute", callId: "c" }), null);
  assert.deepEqual(readAction({ kind: "decline", callId: "c" }), {
    kind: "decline",
    callId: "c",
    conversationId: null,
    at: null,
  });
  assert.deepEqual(
    readAction({ kind: "answer", callId: "c", conversationId: "v", at: 12, extra: true }),
    { kind: "answer", callId: "c", conversationId: "v", at: 12 },
  );
  assert.equal(readAction({ kind: "hangup", callId: "c", at: Number.NaN })?.at, null);
});

// -- one ring UI per device -----------------------------------------------

test("only CallKit owns ringing; Android's notification leaves the page's sheet ringing", () => {
  assert.equal(ringUiOwnsRinging({ ringUi: "callkit", callService: false, voip: true }), true);
  assert.equal(ringUiOwnsRinging({ ringUi: "notification", callService: true, voip: false }), false);
  assert.equal(ringUiOwnsRinging(PAGE_ONLY), false);
});

// -- pending actions --------------------------------------------------------

const view = (over: Partial<ActionView> = {}): ActionView => ({
  ringing: false,
  inCall: false,
  ended: false,
  ...over,
});

test("an Answer joins a call that still rings here", () => {
  assert.deepEqual(
    pendingActionVerdict({ kind: "answer", callId: "c", at: NOW }, view({ ringing: true }), NOW),
    { act: "answer" },
  );
});

test("an Answer for a call the page has not listed yet waits for the rings", () => {
  assert.deepEqual(
    pendingActionVerdict({ kind: "answer", callId: "c", at: NOW }, view(), NOW + 1_000),
    { act: "wait" },
  );
  // No timestamp from the native side still waits; the bridge stamps it.
  assert.deepEqual(pendingActionVerdict({ kind: "answer", callId: "c" }, view(), NOW), {
    act: "wait",
  });
});

test("an Answer is dropped once the call is over, joined, or stale", () => {
  const answer = { kind: "answer" as const, callId: "c", at: NOW };
  assert.deepEqual(pendingActionVerdict(answer, view({ ended: true, ringing: true }), NOW), {
    act: "drop",
    reason: "ended",
  });
  assert.deepEqual(pendingActionVerdict(answer, view({ inCall: true, ringing: true }), NOW), {
    act: "drop",
    reason: "already-in-call",
  });
  assert.deepEqual(
    pendingActionVerdict(answer, view({ ringing: true }), NOW + ACTION_TTL_MS + 1),
    { act: "drop", reason: "stale" },
  );
  // At the edge it still counts.
  assert.deepEqual(pendingActionVerdict(answer, view({ ringing: true }), NOW + ACTION_TTL_MS), {
    act: "answer",
  });
});

test("the action window outlasts the ring window, for a cold start", () => {
  assert.ok(ACTION_TTL_MS > RING_TIMEOUT_MS);
});

test("a Decline goes to the server even for a call the page has not heard of", () => {
  const decline = { kind: "decline" as const, callId: "c", at: NOW };
  assert.deepEqual(pendingActionVerdict(decline, view(), NOW), { act: "decline" });
  assert.deepEqual(pendingActionVerdict(decline, view({ ringing: true }), NOW), { act: "decline" });
  assert.deepEqual(pendingActionVerdict(decline, view({ ended: true }), NOW), {
    act: "drop",
    reason: "ended",
  });
  assert.deepEqual(pendingActionVerdict(decline, view({ inCall: true }), NOW), {
    act: "drop",
    reason: "already-in-call",
  });
  assert.deepEqual(pendingActionVerdict(decline, view(), NOW + ACTION_TTL_MS + 1), {
    act: "drop",
    reason: "stale",
  });
});

test("a Hang up leaves only the call this device is in, however old the press", () => {
  const hangup = { kind: "hangup" as const, callId: "c", at: NOW };
  assert.deepEqual(pendingActionVerdict(hangup, view({ inCall: true }), NOW + 10 * ACTION_TTL_MS), {
    act: "hangup",
  });
  assert.deepEqual(pendingActionVerdict(hangup, view({ ringing: true }), NOW), {
    act: "drop",
    reason: "not-in-call",
  });
});

// -- end reasons ------------------------------------------------------------

const frame = (over: Partial<CallFrame>): CallFrame => ({
  status: "ringing",
  reason: null,
  participants: [],
  ...over,
});

test("an ended frame maps the server's reason; a decline in a frame came from another device", () => {
  assert.equal(nativeEndReason(frame({ status: "ended", reason: "cancelled" }), SELF, DEVICE), "cancelled");
  assert.equal(nativeEndReason(frame({ status: "ended", reason: "unanswered" }), SELF, DEVICE), "unanswered");
  assert.equal(
    nativeEndReason(frame({ status: "ended", reason: "declined" }), SELF, DEVICE),
    "declined_elsewhere",
  );
  assert.equal(nativeEndReason(frame({ status: "ended", reason: "hangup" }), SELF, DEVICE), "ended");
  assert.equal(nativeEndReason(frame({ status: "ended", reason: "empty" }), SELF, DEVICE), "ended");
  assert.equal(nativeEndReason(frame({ status: "ended", reason: null }), SELF, DEVICE), "ended");
});

test("an open call's frame says which of this user's devices answered", () => {
  const answeredBy = (deviceId: string | null): CallFrame =>
    frame({
      status: "active",
      participants: [
        { userId: "u-caller", deviceId: "d-caller", joined: true },
        { userId: SELF, deviceId, joined: deviceId !== null },
      ],
    });
  assert.equal(nativeEndReason(answeredBy(DEVICE), SELF, DEVICE), "answered");
  assert.equal(nativeEndReason(answeredBy("d-laptop"), SELF, DEVICE), "answered_elsewhere");
  // Merely invited: nothing to end yet.
  assert.equal(nativeEndReason(answeredBy(null), SELF, DEVICE), null);
  // Somebody else answering a group call does not end this device's ring.
  assert.equal(
    nativeEndReason(
      frame({
        status: "active",
        participants: [
          { userId: "u-other", deviceId: "d-other", joined: true },
          { userId: SELF, deviceId: null, joined: false },
        ],
      }),
      SELF,
      DEVICE,
    ),
    null,
  );
  // A device that has lost its id reads every answer as elsewhere.
  assert.equal(nativeEndReason(answeredBy(DEVICE), SELF, null), "answered_elsewhere");
});

test("what this device did itself wins over the frame and the clock", () => {
  assert.equal(
    ringGoneReason({ marked: "declined", frameReason: "cancelled", receivedAt: NOW, now: NOW }),
    "declined",
  );
  assert.equal(
    ringGoneReason({ marked: "answered", frameReason: null, receivedAt: NOW, now: NOW + RING_TIMEOUT_MS }),
    "answered",
  );
  assert.equal(
    ringGoneReason({ marked: null, frameReason: "answered_elsewhere", receivedAt: NOW, now: NOW }),
    "answered_elsewhere",
  );
});

test("a ring gone with no frame is unanswered past its window, and unnamed before it", () => {
  assert.equal(
    ringGoneReason({ marked: null, frameReason: null, receivedAt: NOW, now: NOW + RING_TIMEOUT_MS }),
    "unanswered",
  );
  assert.equal(
    ringGoneReason({ marked: null, frameReason: null, receivedAt: NOW, now: NOW + 1_000 }),
    "ended",
  );
});

test("the ring's expiry is in the push payload's unit, seconds", () => {
  assert.equal(ringExpiry(NOW), (NOW + RING_TIMEOUT_MS) / 1000);
  assert.equal(ringExpiry(NOW + 999), Math.floor((NOW + 999 + RING_TIMEOUT_MS) / 1000));
});

// -- the call's lifetime ------------------------------------------------------

const state = (over: Partial<ActiveCallInput> = {}): ActiveCallInput => ({
  phase: "idle",
  conversationId: null,
  call: null,
  camera: { on: false },
  screen: { on: false },
  participants: [],
  ...over,
});

test("the call service runs from the join's start until idle, and never for another tab's call", () => {
  assert.equal(callServiceWanted({ phase: "idle" }), false);
  assert.equal(callServiceWanted({ phase: "connecting" }), true);
  assert.equal(callServiceWanted({ phase: "connected" }), true);
  assert.equal(callServiceWanted({ phase: "reconnecting" }), true);
  assert.equal(callServiceWanted({ phase: "elsewhere" }), false);
});

test("setActive carries the call, its label and whether anybody's video is on", () => {
  const labels = { conv: "Alice" };
  assert.deepEqual(nativeActiveCall(state(), labels), {
    active: false,
    callId: null,
    label: null,
    audioOnly: true,
  });
  // Still asking the server for a token: active, no id yet.
  assert.deepEqual(nativeActiveCall(state({ phase: "connecting", conversationId: "conv" }), labels), {
    active: true,
    callId: null,
    label: "Alice",
    audioOnly: true,
  });
  const connected = state({ phase: "connected", conversationId: "conv", call: { id: "c" } });
  assert.deepEqual(nativeActiveCall(connected, labels), {
    active: true,
    callId: "c",
    label: "Alice",
    audioOnly: true,
  });
  assert.equal(nativeActiveCall({ ...connected, camera: { on: true } }, labels).audioOnly, false);
  assert.equal(nativeActiveCall({ ...connected, screen: { on: true } }, labels).audioOnly, false);
  assert.equal(
    nativeActiveCall({ ...connected, participants: [{ camera: false, screen: true }] }, labels)
      .audioOnly,
    false,
  );
  assert.equal(nativeActiveCall({ ...connected, conversationId: "other" }, labels).label, null);
});

// -- labels -----------------------------------------------------------------

function conversation(over: Partial<StoredConversation>): StoredConversation {
  return {
    id: "c0",
    kind: "direct",
    title: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    members: [
      { userId: SELF, username: "me", displayName: "Me", lastReadMessageId: null, lastReadAt: null },
      {
        userId: "u-alice",
        username: "alice",
        displayName: "Alice",
        lastReadMessageId: null,
        lastReadAt: null,
      },
    ],
    muted: false,
    ...over,
  } as StoredConversation;
}

test("labels are names only: the title, or the other members' display names", () => {
  const labels = ringLabels(
    [
      conversation({ id: "a" }),
      conversation({ id: "b", kind: "group", title: "Hiking" }),
      conversation({ id: "v", kind: "channel", channelKind: "voice", title: "Lounge" }),
      conversation({ id: "t", kind: "channel", channelKind: "text", title: "general" }),
    ],
    SELF,
  );
  assert.deepEqual(labels, { a: "Alice", b: "Hiking", t: "general" });
});

test("the label cache keeps the first (newest) conversations up to its cap", () => {
  const list = Array.from({ length: 5 }, (_, i) => conversation({ id: `c${i}` }));
  assert.deepEqual(Object.keys(ringLabels(list, SELF, 3)), ["c0", "c1", "c2"]);
});

test("the labels key ignores insertion order and changes with any name", () => {
  assert.equal(labelsKey({ a: "A", b: "B" }), labelsKey({ b: "B", a: "A" }));
  assert.notEqual(labelsKey({ a: "A" }), labelsKey({ a: "A2" }));
  assert.notEqual(labelsKey({ a: "A" }), labelsKey({ a: "A", b: "B" }));
});

test("a ring for an unknown conversation says the fallback, never an id", () => {
  assert.deepEqual(ringDisplay(undefined, SELF), { label: FALLBACK_LABEL, group: false });
  assert.deepEqual(ringDisplay(conversation({}), SELF), { label: "Alice", group: false });
  assert.deepEqual(ringDisplay(conversation({ kind: "group", title: "Hiking" }), SELF), {
    label: "Hiking",
    group: true,
  });
});

// -- where native code reaches the server -------------------------------------

test("native code gets an absolute API base or none", () => {
  assert.equal(nativeApiBase("https://wherry.app/api"), "https://wherry.app/api");
  assert.equal(nativeApiBase("http://192.168.1.20:3000/api/"), "http://192.168.1.20:3000/api");
  assert.equal(nativeApiBase("/api"), null);
  assert.equal(nativeApiBase(""), null);
  assert.equal(nativeApiBase("https://"), null);
  assert.equal(nativeApiBase("tauri://localhost/api"), null);
});
