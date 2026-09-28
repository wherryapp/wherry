// The decisions behind the phones' native call pieces, as pure functions
// (docs/prompts/phone-calls-plan.md §5.3). phone-bridge.ts is the stateful
// half that feeds them; the plugin (plugins/wherry-calls) only carries out
// what they decide. No DOM, no Tauri, no store -- so phone-rules.test.ts
// runs under node:test.

import type { StoredConversation } from "../store/types";
import type { SyncState } from "../sync/engine";
import { conversationTitle } from "../ui/format";
import type {
  ActiveReport,
  IncomingAnswer,
  PhoneAction,
  PhoneActionKind,
  PhoneCapabilities,
  PhoneEndReason,
  RingUi,
  VoipToken,
} from "./phone-calls";
import { RING_TIMEOUT_MS } from "./rules";

// ---------------------------------------------------------------------------
// Reading the native side
// ---------------------------------------------------------------------------

/** What a build without the plugin -- or a stub of it -- can do: nothing
 *  native, and the page's own sheet rings. */
export const PAGE_ONLY: PhoneCapabilities = { ringUi: "page", callService: false, voip: false };

function isRingUi(value: unknown): value is RingUi {
  return value === "page" || value === "notification" || value === "callkit";
}

/** A native `capabilities()` answer, read defensively: a stub or an older
 *  plugin may leave fields out, and anything unrecognised reads as
 *  "cannot" -- never as a ring UI that would silence the page's sheet. */
export function readCapabilities(raw: unknown): PhoneCapabilities {
  if (typeof raw !== "object" || raw === null) return PAGE_ONLY;
  const record = raw as Record<string, unknown>;
  return {
    ringUi: isRingUi(record["ringUi"]) ? record["ringUi"] : "page",
    callService: record["callService"] === true,
    voip: record["voip"] === true,
  };
}

/** A queued or live native action, or null for anything malformed. */
export function readAction(raw: unknown): PhoneAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const kind = record["kind"];
  const callId = record["callId"];
  if (kind !== "answer" && kind !== "decline" && kind !== "hangup") return null;
  if (typeof callId !== "string" || callId.length === 0) return null;
  const conversationId = record["conversationId"];
  const at = record["at"];
  return {
    kind,
    callId,
    conversationId:
      typeof conversationId === "string" && conversationId.length > 0 ? conversationId : null,
    at: typeof at === "number" && Number.isFinite(at) ? at : null,
  };
}

/** A `reportIncoming` answer. Anything but an explicit `shown: true` --
 *  a stub's empty answer, a failure's null -- reads as not shown, so the
 *  page's sheet rings. */
export function readIncomingAnswer(raw: unknown): IncomingAnswer {
  if (typeof raw !== "object" || raw === null) return { shown: false };
  return { shown: (raw as Record<string, unknown>)["shown"] === true };
}

/** A `pushToken()` answer or a `push-token` event (plan §5.2, hunk H4):
 *  null without a token. The environment and the key pair are passed on as
 *  found, and a missing one reads as null rather than failing the token:
 *  `registerNativeToken` is the one place that decides whether a
 *  registration may be sent, and it refuses one without them before any
 *  request, naming what is missing. The keys' spelling is checked there too
 *  (`normaliseKeys`), not here. */
export function readVoipToken(raw: unknown): VoipToken | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const token = record["token"];
  if (typeof token !== "string" || token.length === 0) return null;
  const environment = record["environment"];
  const p256dh = record["p256dh"];
  const auth = record["auth"];
  return {
    token,
    environment: environment === "sandbox" || environment === "production" ? environment : null,
    keys:
      typeof p256dh === "string" && p256dh.length > 0 && typeof auth === "string" && auth.length > 0
        ? { p256dh, auth }
        : null,
  };
}

// ---------------------------------------------------------------------------
// One ring UI per device (plan §2.7)
// ---------------------------------------------------------------------------

/** What the page's own ring does on this device (IncomingCall.tsx). */
export type PageRingDuties = {
  /** The sheet, and with it the back layer that declines. */
  sheet: boolean;
  /** The page's ring tone (before the mute, ringtone and DND checks of
   *  `shouldRingAudibly`). */
  tone: boolean;
  /** plugin-notification's plain "Incoming call from X": the one outside
   *  ring a shell without a native ring UI has while it is not in front. */
  notification: boolean;
};

const RING_NOTHING: PageRingDuties = { sheet: false, tone: false, notification: false };

/** The page is the only ring: the sheet and the tone, and the plain
 *  notification when the window is not in front, because nothing else would
 *  say a call is coming. The web and the desktop shell, always. */
function pageAlone(windowFocused: boolean): PageRingDuties {
  return { sheet: true, tone: true, notification: !windowFocused };
}

/**
 * One ring UI per device (plan §2.7), from the page's side: what the page
 * itself draws, sounds and posts for one ring.
 *
 * - `capabilities` null: a shell whose plugin has not answered yet. Nothing
 *   until it has -- on iOS the answer may be CallKit, and a sheet, a tone and
 *   a notification started first would be a second ring (the phone-bridge
 *   probe runs at page load, so this lasts one IPC round trip at most, and
 *   the bridge gives up waiting after `PROBE_PATIENCE_MS`).
 * - `"page"`: the page alone rings.
 * - `"callkit"`: CallKit rings in every app state, so the page stays silent
 *   *for a ring CallKit took* (`nativeShown` true). Until `reportIncoming`
 *   has answered, nothing; if CallKit did not take it, the page rings as if
 *   there were no plugin -- a half-working plugin must never cost the ring.
 * - `"notification"` (Android from A2): the plugin posts its `CallStyle`
 *   ring only while the activity is not resumed, with the channel's own
 *   sound. The sheet stays (it is what the person sees on coming back, and
 *   invisible until then); the tone plays only in front, where the plugin
 *   posts nothing; the plain notification never, unless the plugin said it
 *   rang nothing -- then the page rings alone.
 *
 * `windowFocused` is desktop-notify.ts's `windowIsFocused()`, which is false
 * in a backgrounded Android shell (unlike `document.hasFocus()`).
 */
export function pageRingDuties(input: {
  capabilities: PhoneCapabilities | null;
  /** This ring's `reportIncoming` answer; null until it has come. */
  nativeShown: boolean | null;
  windowFocused: boolean;
}): PageRingDuties {
  const { capabilities, nativeShown, windowFocused } = input;
  if (capabilities === null) return RING_NOTHING;
  switch (capabilities.ringUi) {
    case "page":
      return pageAlone(windowFocused);
    case "callkit":
      return nativeShown === false ? pageAlone(windowFocused) : RING_NOTHING;
    case "notification":
      if (nativeShown === false) return pageAlone(windowFocused);
      return { sheet: true, tone: windowFocused, notification: false };
  }
}

/** How long the page waits for the plugin before it treats a shell as
 *  having none. A missing plugin rejects at once; this is for one that
 *  never answers, which must not keep the sheet from ringing. */
export const PROBE_PATIENCE_MS = 2_000;

/** How long a ring waits for its `reportIncoming` answer before the page
 *  rings on its own. CallKit answers within a frame or two; a native side
 *  that hangs costs a moment of silence, not the call. A late `shown: true`
 *  still stands the page down. */
export const REPORT_PATIENCE_MS = 2_000;

// ---------------------------------------------------------------------------
// Whose bridge it is
// ---------------------------------------------------------------------------

/**
 * What the bridge does with its per-account run when the sync engine's
 * status changes. The engine runs exactly while a signed-in, verified
 * session does in this page: App.tsx starts it with the session and stops it
 * on sign-out, on a 401 and behind the version wall. Its status is therefore
 * the account's lifetime here, and since sign-out does not reload the page,
 * nothing else would tell the bridge the account changed.
 *
 * - `start`: begin a run for the session's account.
 * - `stop`: end the run (end what it reported natively, `resetAccount`,
 *   forget its state). The bridge defers it one tick, so the stop-and-start
 *   of a re-run effect (StrictMode, a refreshed session object) does not
 *   wipe and rebuild the native cache.
 * - `switch`: another account runs than the run was started for: stop,
 *   then start, at once.
 *
 * `unauthorized` counts as stopped: the token is dead, and App.tsx signs out
 * next.
 */
export function bridgeRunStep(input: {
  syncState: SyncState;
  sessionUserId: string | null;
  runUserId: string | null;
}): "start" | "stop" | "switch" | "keep" {
  const running = input.syncState !== "stopped" && input.syncState !== "unauthorized";
  const wanted = running ? input.sessionUserId : null;
  if (wanted === null) return input.runUserId === null ? "keep" : "stop";
  if (input.runUserId === null) return "start";
  return input.runUserId === wanted ? "keep" : "switch";
}

/**
 * The page's ring list against the one the bridge last held: which rings
 * are new (report them natively) and which have gone (end them natively).
 * By call id; a ring whose object changed but whose call did not is the
 * same ring.
 */
export function ringsDiff<R extends { callId: string }>(
  previous: readonly R[],
  next: readonly R[],
): { shown: R[]; gone: R[] } {
  const before = new Set(previous.map((r) => r.callId));
  const after = new Set(next.map((r) => r.callId));
  return {
    shown: next.filter((r) => !before.has(r.callId)),
    gone: previous.filter((r) => !after.has(r.callId)),
  };
}

// ---------------------------------------------------------------------------
// Queued and live actions
// ---------------------------------------------------------------------------

/** How long a queued action stays worth acting on: the ring window, plus a
 *  margin for a cold start (the page has to boot and list its rings before
 *  an Answer can find the call). An older Answer would join a call the
 *  person long since stopped expecting. */
export const ACTION_TTL_MS = RING_TIMEOUT_MS + 15_000;

/** What the page knows about the action's call at the moment it decides. */
export type ActionView = {
  /** The call is ringing on this device (it is in the page's rings). */
  ringing: boolean;
  /** The voice session is in this call (connecting or connected). */
  inCall: boolean;
  /** A `call_state` frame said the call is over. */
  ended: boolean;
};

export type ActionVerdict =
  | { act: PhoneActionKind }
  /** Not decidable yet -- the rings have not loaded. Ask again when they
   *  change, until the action is older than `ACTION_TTL_MS`. */
  | { act: "wait" }
  | { act: "drop"; reason: "stale" | "ended" | "already-in-call" | "not-in-call" };

/**
 * What to do with a press on the native call UI.
 *
 * - Answer: join if the call still rings here. If the page has not heard of
 *   it yet (a cold start from the lock screen), wait for the rings; drop it
 *   once it is over, once this device is already in it, or once it is stale.
 * - Decline: decline unless the call is over or this device is in it. An
 *   unknown call is still declined -- the person pressed Decline, and the
 *   server only acts if they are invited.
 * - Hang up: leave, if this device is in that call; otherwise it is a press
 *   for a call that has already gone.
 */
export function pendingActionVerdict(
  action: PhoneAction,
  view: ActionView,
  now: number,
): ActionVerdict {
  if (action.kind === "hangup") {
    return view.inCall ? { act: "hangup" } : { act: "drop", reason: "not-in-call" };
  }
  if (view.inCall) return { act: "drop", reason: "already-in-call" };
  if (view.ended) return { act: "drop", reason: "ended" };
  if (action.at != null && now - action.at > ACTION_TTL_MS) {
    return { act: "drop", reason: "stale" };
  }
  if (action.kind === "decline") return { act: "decline" };
  return view.ringing ? { act: "answer" } : { act: "wait" };
}

// ---------------------------------------------------------------------------
// Ending a ring on the native side
// ---------------------------------------------------------------------------

/** The part of a `call_state` frame (sync/engine.ts's SyncEvent) these
 *  decisions read. */
export type CallFrame = {
  status: "ringing" | "active" | "ended";
  reason: string | null;
  participants: readonly { userId: string; deviceId: string | null; joined: boolean }[];
};

/**
 * What a `call_state` frame means for a ring this device reported natively,
 * or null when it does not end it.
 *
 * - Ended: the server's end reason, with `declined` read as "declined
 *   elsewhere" -- a decline on *this* device is known before the frame
 *   (`ringGoneReason`'s `marked`), so a frame-borne one came from another
 *   device of this user (a direct call has one callee).
 * - Still open: this user's participant row names the device that answered.
 *   This device means it was answered here; another means elsewhere.
 */
export function nativeEndReason(
  frame: CallFrame,
  selfUserId: string,
  selfDeviceId: string | null,
): PhoneEndReason | null {
  if (frame.status === "ended") {
    switch (frame.reason) {
      case "cancelled":
        return "cancelled";
      case "unanswered":
        return "unanswered";
      case "declined":
        return "declined_elsewhere";
      default:
        return "ended";
    }
  }
  const self = frame.participants.find((p) => p.userId === selfUserId && p.deviceId !== null);
  if (!self) return null;
  return self.deviceId === selfDeviceId ? "answered" : "answered_elsewhere";
}

/**
 * Why a ring the page reported natively has gone from the page's rings.
 *
 * `marked` is what this device did itself (its sheet's buttons, or a native
 * action it carried out), and wins: it is the only certain answer. Then the
 * last frame for the call. Then time: a ring that outlived its window was
 * unanswered. Anything else -- the self-heal read dropped it with no frame
 * seen -- is over for a reason the page cannot name.
 */
export function ringGoneReason(input: {
  marked: "answered" | "declined" | null;
  frameReason: PhoneEndReason | null;
  receivedAt: number;
  now: number;
}): PhoneEndReason {
  if (input.marked) return input.marked;
  if (input.frameReason) return input.frameReason;
  if (input.now - input.receivedAt >= RING_TIMEOUT_MS) return "unanswered";
  return "ended";
}

/** The ring window's close in the push payload's unit (seconds since the
 *  epoch), from when this device learned of the ring. */
export function ringExpiry(receivedAt: number): number {
  return Math.floor((receivedAt + RING_TIMEOUT_MS) / 1000);
}

// ---------------------------------------------------------------------------
// The call's lifetime
// ---------------------------------------------------------------------------

/** The voice state these decisions read (session.ts's VoiceState). */
export type ActiveCallInput = {
  phase: "idle" | "connecting" | "connected" | "reconnecting" | "elsewhere";
  conversationId: string | null;
  call: { id: string } | null;
  camera: { on: boolean };
  screen: { on: boolean };
  participants: readonly { camera: boolean; screen: boolean }[];
};

/**
 * Whether the native call service should run: from the moment a join
 * starts until the session is idle again. Starting at `connecting` matters
 * on Android -- the person has just pressed call or answer, so the app is in
 * the foreground, which is when a `microphone` foreground service may start.
 * `elsewhere` (another tab of the profile holds the call) is not a call on
 * this page.
 */
export function callServiceWanted(state: Pick<ActiveCallInput, "phase">): boolean {
  return (
    state.phase === "connecting" || state.phase === "connected" || state.phase === "reconnecting"
  );
}

/** What `setActive` is told. The call id is null while the join is still
 *  asking the server for its token.
 *
 *  `pageOwnsAudio` is branch B of row I-58 (phone-calls-plan.md §7),
 *  measured on an iPhone on 2026-09-28: while a CallKit call is live and the
 *  page is in front, WebKit re-activates the audio session CallKit owns and
 *  marks its own microphone interrupted, so the call is silent both ways
 *  for exactly as long as Wherry is on screen. So once the page's call has
 *  connected and the page is in front, CallKit has carried the ring and the
 *  plugin ends its call (never the page's); a call answered on the lock
 *  screen keeps CallKit until the app is opened. The plugin ignores it
 *  where it holds no CallKit call (Android; an outgoing call). */
export function nativeActiveCall(
  state: ActiveCallInput,
  labels: Readonly<Record<string, string>>,
  inFront: boolean,
): ActiveReport {
  const active = callServiceWanted(state);
  if (!active) {
    return { active: false, callId: null, label: null, audioOnly: true, pageOwnsAudio: false };
  }
  const video =
    state.camera.on || state.screen.on || state.participants.some((p) => p.camera || p.screen);
  return {
    active: true,
    callId: state.call?.id ?? null,
    label: state.conversationId ? (labels[state.conversationId] ?? null) : null,
    audioOnly: !video,
    pageOwnsAudio: inFront && state.phase === "connected" && state.call !== null,
  };
}

/** How often the page says it is alive while a native call is up. */
export const PAGE_ALIVE_EVERY_MS = 1_000;

/**
 * Whether the page logs `calls: page alive` once a second: only while a
 * native call is up, that is a plugin answered, the page has told it a call
 * is active, and the plugin holds that call natively (CallKit on iOS, the
 * call service on Android). Row I-60 counts those lines per 10 s through a
 * locked call to see whether the page's timers run; a page-only ring or
 * call (the simulator, a browser) has nothing to measure and stays quiet.
 */
export function pageAliveWanted(
  present: boolean | null,
  capabilities: PhoneCapabilities | null,
  report: Pick<ActiveReport, "active">,
): boolean {
  if (present !== true || capabilities === null || !report.active) return false;
  return capabilities.ringUi === "callkit" || capabilities.callService;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** What a ring says when the page has no name for its conversation. */
export const FALLBACK_LABEL = "Wherry call";

/** The label cache's cap: enough for anyone's recent conversations, small
 *  enough that the native store stays a few kilobytes. */
export const MAX_LABELS = 500;

/**
 * The on-device label cache: conversation id to the name a ring shows,
 * newest conversations first up to the cap. Names only -- a conversation's
 * title or its members' display names, which the phone already shows in
 * its list -- never content (rule 1). The push payload carries no name at
 * all (the push plan's D1), so this is what names a ring on a locked phone.
 * Voice channels are rooms and never ring, so they are left out.
 */
export function ringLabels(
  conversations: readonly StoredConversation[],
  selfUserId: string,
  max: number = MAX_LABELS,
): Record<string, string> {
  const labels: Record<string, string> = {};
  let count = 0;
  for (const conversation of conversations) {
    if (count >= max) break;
    if (conversation.channelKind === "voice") continue;
    labels[conversation.id] = conversationTitle(conversation, selfUserId);
    count += 1;
  }
  return labels;
}

/** A stable key for "did the labels change", so the bridge writes the
 *  native store only when they did. */
export function labelsKey(labels: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}

/** The label and shape of one ring the page is reporting. */
export function ringDisplay(
  conversation: StoredConversation | undefined,
  selfUserId: string,
): { label: string; group: boolean } {
  if (!conversation) return { label: FALLBACK_LABEL, group: false };
  return {
    label: conversationTitle(conversation, selfUserId),
    group: conversation.kind !== "direct",
  };
}

// ---------------------------------------------------------------------------
// Where native code reaches the server
// ---------------------------------------------------------------------------

/**
 * The API base native code may use for `decline-signed`, or null. Native
 * HTTP has no page origin to resolve a relative base against, and building
 * one from `location` is the desktop bug api/base.ts warns about; the phone
 * shells bake an absolute `VITE_API_BASE`, so a relative one means "this is
 * not a phone build" and native decline falls back to opening the app.
 */
export function nativeApiBase(apiBase: string): string | null {
  if (!/^https?:\/\/[^/]/i.test(apiBase)) return null;
  return apiBase.replace(/\/+$/, "");
}
