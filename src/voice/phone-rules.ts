// The decisions behind the phones' native call pieces, as pure functions
// (docs/prompts/phone-calls-plan.md §5.3). phone-bridge.ts is the stateful
// half that feeds them; the plugin (plugins/wherry-calls) only carries out
// what they decide. No DOM, no Tauri, no store -- so phone-rules.test.ts
// runs under node:test.

import type { StoredConversation } from "../store/types";
import { conversationTitle } from "../ui/format";
import type {
  ActiveReport,
  PhoneAction,
  PhoneActionKind,
  PhoneCapabilities,
  PhoneEndReason,
  RingUi,
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

// ---------------------------------------------------------------------------
// One ring UI per device (plan §2.7)
// ---------------------------------------------------------------------------

/**
 * Whether the native side owns ringing outright, so the page's sheet and its
 * tone stand down. Only CallKit does: it is the ring UI in every app state
 * on iOS, and a second, in-page ring over it would be two answers to one
 * call. Android's notification is posted only while the activity is not
 * resumed, so there the page still rings whenever it is showing.
 */
export function ringUiOwnsRinging(capabilities: PhoneCapabilities): boolean {
  return capabilities.ringUi === "callkit";
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
 *  asking the server for its token. */
export function nativeActiveCall(
  state: ActiveCallInput,
  labels: Readonly<Record<string, string>>,
): ActiveReport {
  const active = callServiceWanted(state);
  if (!active) return { active: false, callId: null, label: null, audioOnly: true };
  const video =
    state.camera.on || state.screen.on || state.participants.some((p) => p.camera || p.screen);
  return {
    active: true,
    callId: state.call?.id ?? null,
    label: state.conversationId ? (labels[state.conversationId] ?? null) : null,
    audioOnly: !video,
  };
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
