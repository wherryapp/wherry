import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoredConversation } from "../store/types";
import type { PhoneCapabilities } from "./phone-calls";
import {
  ACTION_TTL_MS,
  bridgeRunStep,
  callServiceWanted,
  FALLBACK_LABEL,
  labelsKey,
  nativeActiveCall,
  nativeApiBase,
  nativeEndReason,
  nativeRingOf,
  notificationLabels,
  PAGE_ONLY,
  pageAliveWanted,
  pageRingDuties,
  pendingActionVerdict,
  readAction,
  readCapabilities,
  readIncomingAnswer,
  readVoipToken,
  ringDisplay,
  ringExpiry,
  ringGoneReason,
  ringIsHeadsUpOnly,
  ringLabels,
  ringsDiff,
  type ActiveCallInput,
  type ActionView,
  type CallFrame,
  type NativeRing,
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
  assert.deepEqual(
    readCapabilities({ ringUi: "siren", callService: "yes", voip: 1, fullScreen: "true" }),
    PAGE_ONLY,
  );
});

test("a full answer is read as given", () => {
  assert.deepEqual(
    readCapabilities({ ringUi: "callkit", callService: false, voip: true, fullScreen: true }),
    { ringUi: "callkit", callService: false, voip: true, fullScreen: true },
  );
  assert.deepEqual(readCapabilities({ ringUi: "notification", callService: true }), {
    ringUi: "notification",
    callService: true,
    voip: false,
    fullScreen: false,
  });
});

test("Settings says the ring is a heads-up only for Android's ring without the full-screen grant", () => {
  const android = readCapabilities({ ringUi: "notification", callService: true, fullScreen: false });
  assert.equal(ringIsHeadsUpOnly(android), true);
  assert.equal(ringIsHeadsUpOnly({ ...android, fullScreen: true }), false);
  // An answer without the field reads as not granted: the sentence is a
  // caution, and saying it wrongly costs less than hiding it.
  assert.equal(ringIsHeadsUpOnly(readCapabilities({ ringUi: "notification" })), true);
  // CallKit takes the screen regardless; the page's own sheet degrades nothing.
  assert.equal(ringIsHeadsUpOnly({ ...android, ringUi: "callkit" }), false);
  assert.equal(ringIsHeadsUpOnly(PAGE_ONLY), false);
  // Nothing is said before the plugin has answered.
  assert.equal(ringIsHeadsUpOnly(null), false);
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

test("only an explicit shown: true reads as a ring the native side took", () => {
  assert.deepEqual(readIncomingAnswer({ shown: true }), { shown: true, answered: true });
  // A stub's empty resolve, a failure's null, anything odd: the page rings,
  // and nothing was answered.
  assert.deepEqual(readIncomingAnswer(null), { shown: false, answered: false });
  assert.deepEqual(readIncomingAnswer({}), { shown: false, answered: false });
  assert.deepEqual(readIncomingAnswer({ shown: "true" }), { shown: false, answered: false });
  // Said in so many words: not shown, and answered.
  assert.deepEqual(readIncomingAnswer({ shown: false }), { shown: false, answered: true });
});

test("the native answer tells an explicit no from no answer at all", () => {
  assert.equal(nativeRingOf(readIncomingAnswer({ shown: true })), "shown");
  assert.equal(nativeRingOf(readIncomingAnswer({ shown: false })), "not_shown");
  // `phone-calls.ts`'s `#call` turns a rejected command into null.
  assert.equal(nativeRingOf(readIncomingAnswer(null)), "no_answer");
  assert.equal(nativeRingOf(readIncomingAnswer({})), "no_answer");
});

test("a VoIP token is read with its environment and keys, for the three-argument registration", () => {
  assert.deepEqual(
    readVoipToken({ token: "ab12", environment: "sandbox", p256dh: "BPk", auth: "c2Vj" }),
    { token: "ab12", environment: "sandbox", keys: { p256dh: "BPk", auth: "c2Vj" } },
  );
  assert.deepEqual(readVoipToken({ token: "ab12", environment: "production", p256dh: "B", auth: "a" }), {
    token: "ab12",
    environment: "production",
    keys: { p256dh: "B", auth: "a" },
  });
});

test("no token is no registration: a stub, Android, or PushKit not ready yet", () => {
  assert.equal(readVoipToken(null), null);
  assert.equal(readVoipToken({}), null);
  assert.equal(readVoipToken({ token: null }), null);
  assert.equal(readVoipToken({ token: "" }), null);
  assert.equal(readVoipToken({ token: 7, environment: "sandbox" }), null);
});

test("a token without its environment or keys is passed on with them null, for registerNativeToken to refuse", () => {
  // The token is still read: native-push.ts is the one place that decides
  // whether a registration may be sent, and it names what is missing.
  assert.deepEqual(readVoipToken({ token: "ab12" }), {
    token: "ab12",
    environment: null,
    keys: null,
  });
  assert.deepEqual(readVoipToken({ token: "ab12", environment: "staging", p256dh: "B" }), {
    token: "ab12",
    environment: null,
    keys: null,
  });
  // Half a key pair is no key pair.
  assert.equal(readVoipToken({ token: "ab12", p256dh: "B", auth: "" })?.keys, null);
});

const CALLKIT: PhoneCapabilities = { ringUi: "callkit", callService: false, voip: true, fullScreen: true };
const ANDROID_RING: PhoneCapabilities = {
  ringUi: "notification",
  callService: true,
  voip: false,
  fullScreen: true,
};
const NOTHING = { sheet: false, tone: false, notification: false };
const ALONE_IN_FRONT = { sheet: true, tone: true, notification: false };
const ALONE_BEHIND = { sheet: true, tone: true, notification: true };

const ANSWERS: readonly (NativeRing | null)[] = [null, "shown", "not_shown", "no_answer"];

test("the page alone rings where there is no native ring UI, and notifies only when not in front", () => {
  for (const native of ANSWERS) {
    assert.deepEqual(
      pageRingDuties({ capabilities: PAGE_ONLY, native, windowFocused: true }),
      ALONE_IN_FRONT,
    );
    assert.deepEqual(
      pageRingDuties({ capabilities: PAGE_ONLY, native, windowFocused: false }),
      ALONE_BEHIND,
    );
  }
});

test("before the plugin has answered, a shell's page draws, sounds and posts nothing", () => {
  // The first ring of a page on iOS: CallKit may be about to ring it, and a
  // sheet, a tone and a notification started now would be a second ring.
  for (const windowFocused of [true, false]) {
    assert.deepEqual(
      pageRingDuties({ capabilities: null, native: null, windowFocused }),
      NOTHING,
    );
  }
});

test("under CallKit the page stays silent for a ring CallKit took, and waits for the answer", () => {
  for (const windowFocused of [true, false]) {
    assert.deepEqual(
      pageRingDuties({ capabilities: CALLKIT, native: "shown", windowFocused }),
      NOTHING,
    );
    assert.deepEqual(
      pageRingDuties({ capabilities: CALLKIT, native: null, windowFocused }),
      NOTHING,
    );
  }
});

test("a ring CallKit refused, or never answered, rings on the page as if there were no plugin", () => {
  for (const native of ["not_shown", "no_answer"] as const) {
    assert.deepEqual(
      pageRingDuties({ capabilities: CALLKIT, native, windowFocused: true }),
      ALONE_IN_FRONT,
    );
    assert.deepEqual(
      pageRingDuties({ capabilities: CALLKIT, native, windowFocused: false }),
      ALONE_BEHIND,
    );
  }
});

test("under Android's ring notification the page never posts a second one, and is silent behind", () => {
  // Backgrounded (windowIsFocused() is false there even though
  // document.hasFocus() is true): the CallStyle ring is the one ring.
  for (const native of [null, "shown"] as const) {
    assert.deepEqual(
      pageRingDuties({ capabilities: ANDROID_RING, native, windowFocused: false }),
      { sheet: true, tone: false, notification: false },
    );
    // In front: the plugin posts nothing, so the sheet and the tone ring.
    assert.deepEqual(
      pageRingDuties({ capabilities: ANDROID_RING, native, windowFocused: true }),
      ALONE_IN_FRONT,
    );
  }
});

test("Android's plugin saying it posted nothing is authoritative over the webview's focus (row A-63)", () => {
  // The emulator, 2026-09-28 (API 36, dev shell): the app brought to the
  // front by `am start` with no touch. The plugin answered `shown: false`
  // (CallLifecycle.inFront: resumed and window focused) while the webview's
  // document.hasFocus() read false, so windowIsFocused() was false; the page
  // posted its own plain "Incoming call from X" on channel `default` beside
  // its sheet, and it stayed on the shade for 25 minutes after the ring.
  const emulator = {
    capabilities: ANDROID_RING,
    native: nativeRingOf(readIncomingAnswer({ shown: false })),
    windowFocused: false,
  };
  assert.deepEqual(pageRingDuties(emulator), ALONE_IN_FRONT);
  // The same answer with the webview agreeing (after one real tap).
  assert.deepEqual(pageRingDuties({ ...emulator, windowFocused: true }), ALONE_IN_FRONT);
});

test("an Android plugin that never answered leaves the page ringing alone, notification included", () => {
  // A command that failed, or hung past REPORT_PATIENCE_MS: nothing native
  // may be ringing, and behind, the page's notification is the one ring.
  assert.deepEqual(
    pageRingDuties({ capabilities: ANDROID_RING, native: "no_answer", windowFocused: false }),
    ALONE_BEHIND,
  );
  assert.deepEqual(
    pageRingDuties({ capabilities: ANDROID_RING, native: "no_answer", windowFocused: true }),
    ALONE_IN_FRONT,
  );
});

// -- whose bridge it is -----------------------------------------------------

test("the bridge runs for the signed-in account while the engine runs, and not otherwise", () => {
  const step = (syncState: Parameters<typeof bridgeRunStep>[0]["syncState"], sessionUserId: string | null, runUserId: string | null) =>
    bridgeRunStep({ syncState, sessionUserId, runUserId });
  assert.equal(step("follower", "a", null), "start");
  assert.equal(step("idle", "a", "a"), "keep");
  assert.equal(step("stopped", "a", "a"), "stop");
  assert.equal(step("idle", null, "a"), "stop");
  assert.equal(step("stopped", null, null), "keep");
  assert.equal(step("syncing", null, null), "keep");
  // A dead token is as good as signed out; App.tsx signs out next.
  assert.equal(step("unauthorized", "a", "a"), "stop");
  assert.equal(step("unauthorized", "a", null), "keep");
});

test("another account signed in without a reload replaces the run", () => {
  // A signs out and B signs in on the same page (signOutLocally does not
  // reload): B's rings must never be labelled or end-reasoned as A's.
  assert.equal(bridgeRunStep({ syncState: "follower", sessionUserId: "b", runUserId: "a" }), "switch");
});

test("the ring list is diffed by call id", () => {
  const a = { callId: "a", n: 1 };
  const b = { callId: "b", n: 1 };
  const c = { callId: "c", n: 1 };
  assert.deepEqual(ringsDiff([], [a, b]), { shown: [a, b], gone: [] });
  assert.deepEqual(ringsDiff([a, b], [b, c]), { shown: [c], gone: [a] });
  assert.deepEqual(ringsDiff([a], [{ callId: "a", n: 2 }]), { shown: [], gone: [] });
  assert.deepEqual(ringsDiff([a, b], []), { shown: [], gone: [a, b] });
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
  assert.deepEqual(nativeActiveCall(state(), labels, true), {
    active: false,
    callId: null,
    label: null,
    audioOnly: true,
    pageOwnsAudio: false,
  });
  // Still asking the server for a token: active, no id yet.
  assert.deepEqual(
    nativeActiveCall(state({ phase: "connecting", conversationId: "conv" }), labels, true),
    { active: true, callId: null, label: "Alice", audioOnly: true, pageOwnsAudio: false },
  );
  const connected = state({ phase: "connected", conversationId: "conv", call: { id: "c" } });
  assert.deepEqual(nativeActiveCall(connected, labels, false), {
    active: true,
    callId: "c",
    label: "Alice",
    audioOnly: true,
    pageOwnsAudio: false,
  });
  const at = (over: Partial<ActiveCallInput>) =>
    nativeActiveCall({ ...connected, ...over }, labels, false);
  assert.equal(at({ camera: { on: true } }).audioOnly, false);
  assert.equal(at({ screen: { on: true } }).audioOnly, false);
  assert.equal(at({ participants: [{ camera: false, screen: true }] }).audioOnly, false);
  assert.equal(at({ conversationId: "other" }).label, null);
});

test("the page owns the call's audio only once connected and in front (I-58, branch B)", () => {
  const connected = state({ phase: "connected", conversationId: "conv", call: { id: "c" } });
  assert.equal(nativeActiveCall(connected, {}, true).pageOwnsAudio, true);
  // In the background CallKit keeps the call: that is where its audio works.
  assert.equal(nativeActiveCall(connected, {}, false).pageOwnsAudio, false);
  // Not before the page's own call is up, or CallKit would end with nothing
  // carrying the call.
  for (const phase of ["connecting", "reconnecting"] as const) {
    assert.equal(nativeActiveCall({ ...connected, phase }, {}, true).pageOwnsAudio, false);
  }
  assert.equal(nativeActiveCall({ ...connected, call: null }, {}, true).pageOwnsAudio, false);
  assert.equal(nativeActiveCall({ ...connected, phase: "elsewhere" }, {}, true).pageOwnsAudio, false);
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

test("notification labels are ringLabels, with a hub channel as Hub › #channel", () => {
  const list = [
    conversation({ id: "a" }),
    conversation({ id: "b", kind: "group", title: "Hiking" }),
    conversation({ id: "v", kind: "channel", channelKind: "voice", title: "Lounge", hubId: "h1" }),
    conversation({ id: "t", kind: "channel", channelKind: "text", title: "general", hubId: "h1" }),
    conversation({ id: "o", kind: "channel", title: "orphan", hubId: "h-unknown" }),
  ];
  const labels = notificationLabels(list, SELF, new Map([["h1", "Climbers"]]));
  assert.deepEqual(labels, {
    a: "Alice",
    b: "Hiking",
    t: "Climbers › #general",
    o: "#orphan",
  });
  // Everything that is not a channel is exactly the ring's label.
  const rings = ringLabels(list, SELF);
  for (const id of ["a", "b"] as const) assert.equal(labels[id], rings[id]);
  // The same cap.
  assert.deepEqual(Object.keys(notificationLabels(list, SELF, new Map(), 2)), ["a", "b"]);
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

// -- row I-60's liveness line -------------------------------------------------

test("the page says it is alive only while a native call is up", () => {
  const callkit: PhoneCapabilities = { ringUi: "callkit", callService: false, voip: true, fullScreen: true };
  const android: PhoneCapabilities = { ringUi: "notification", callService: true, voip: false, fullScreen: true };
  const active = { active: true };
  const idle = { active: false };
  assert.equal(pageAliveWanted(true, callkit, active), true);
  assert.equal(pageAliveWanted(true, android, active), true);
  // No call, or the call ended.
  assert.equal(pageAliveWanted(true, callkit, idle), false);
  assert.equal(pageAliveWanted(true, android, idle), false);
  // No plugin, or not answered yet: nothing native to measure.
  assert.equal(pageAliveWanted(false, PAGE_ONLY, active), false);
  assert.equal(pageAliveWanted(null, null, active), false);
  assert.equal(pageAliveWanted(true, null, active), false);
  // A plugin that holds no call natively (the iOS simulator's `page`).
  assert.equal(pageAliveWanted(true, PAGE_ONLY, active), false);
});
