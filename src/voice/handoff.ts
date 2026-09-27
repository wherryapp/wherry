// A call that outlived its page: what the page leaves with the shell so that
// the next page can pick the call up, and what that next page does with a
// call it finds. Pure, and the only place either decision is made; the
// session (session.ts) and the native transport (transport-native.ts) carry
// it out.
//
// Why this exists. On the native engine the call is not the page's: the room,
// the microphone and the tiles live in the shell process, and a page reload
// (the update banner, a server-driven hard reload, a developer's F5, the rig's
// `tile-bind.mjs preview`) destroys the page and nothing else. Before this the
// reloaded page came back showing "Start a call" while the shell stayed in the
// room -- audible, drawing tiles over the new page, and with the server's row
// open until the shell was relaunched (rig, 2026-09-27, H-candidate §3.2). It
// also refused the next call outright, since the shell allows one session.
//
// The webview engine has no such problem and never gets here: its room dies
// with the document, and the SFU's `participant_left` closes the row.
//
// The handoff is an opaque string to the shell, held in its memory for the
// session's life and never written anywhere. It carries no secret: the call
// key is re-derived from MLS by the page that picks the call up, and the SFU
// token is the shell's own (it refreshes it).

import type { Call, CallKind, HubVisibility, VideoLimits } from "../api/types";
import type { RoomEndpoint, TransportConnectionState, TransportEnd } from "./transport";
import { transportEndFor } from "./transport-rules";

/** What a page needs to take over a call it did not start. Version 1. */
export type Handoff = {
  v: 1;
  /** The account the call was joined as. A page signed in as somebody else
   *  must not take it, and must not tell the server about it either. */
  userId: string;
  callId: string;
  conversationId: string;
  hubVisibility: HubVisibility | null;
  kind: CallKind;
  e2ee: boolean;
  /** When the call connected on this device, for the bar's timer. */
  connectedAt: number;
  grant: VideoLimits | null;
  /** The server's view of the call at join time. Stale by the time it is
   *  read back; the next `call_state` frame replaces it, and nothing decides
   *  on it but the ringing, which `callerIsRinging` already believes only
   *  while nobody else is in the room. */
  call: Call | null;
};

export function encodeHandoff(handoff: Handoff): string {
  return JSON.stringify(handoff);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VISIBILITIES: ReadonlySet<string> = new Set(["private", "public", "invite_only"]);

/**
 * The handoff back from the shell, or null when there is none or it is not
 * one this page understands (a page from before it existed sends none, and a
 * later format is a different `v`). Null is not an error: it means "this
 * page cannot take the call over", which `orphanDecision` answers.
 */
export function decodeHandoff(text: string | null | undefined): Handoff | null {
  if (typeof text !== "string" || text.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.v !== 1) return null;
  const { userId, callId, conversationId, hubVisibility, kind, e2ee, connectedAt } = raw;
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof callId !== "string" || callId.length === 0) return null;
  if (typeof conversationId !== "string" || conversationId.length === 0) return null;
  if (kind !== "call" && kind !== "room") return null;
  if (typeof e2ee !== "boolean") return null;
  if (typeof connectedAt !== "number" || !Number.isFinite(connectedAt)) return null;
  if (hubVisibility !== null && !(typeof hubVisibility === "string" && VISIBILITIES.has(hubVisibility))) {
    return null;
  }
  // The two nested records are the server's own shapes, carried through; a
  // call snapshot is kept only if it is this call's.
  const call =
    isObject(raw.call) && raw.call.id === callId && typeof raw.call.status === "string"
      ? (raw.call as unknown as Call)
      : null;
  const grant = isObject(raw.grant) ? (raw.grant as unknown as VideoLimits) : null;
  return {
    v: 1,
    userId,
    callId,
    conversationId,
    hubVisibility: hubVisibility as HubVisibility | null,
    kind,
    e2ee,
    connectedAt,
    grant,
    call,
  };
}

/** A call the shell was still holding when this page loaded. */
export type OrphanReading = {
  handoff: string | null;
  state: TransportConnectionState;
  /** The SDK's disconnect reason, where the room ended while no page was
   *  listening. */
  reason: string | null;
  endpoint: RoomEndpoint | null;
};

export type OrphanDecision =
  /** Nothing is running in the shell: an ordinary page load. */
  | { kind: "none" }
  /** Take the call over where it is. */
  | { kind: "adopt"; handoff: Handoff }
  /**
   * Close the shell's room and tell the server nothing now. `followUp` is a
   * room whose fate is unknown, for the session's `#followUpRoom` -- the
   * same question it asks when the page watched the room end.
   */
  | {
      kind: "drop";
      followUp: { callId: string; unsettled: NonNullable<TransportEnd["unsettled"]> } | null;
    };

/**
 * What a freshly loaded page does with a call the shell kept running.
 *
 * - **Still in the room, joined by this account, and a handoff this page can
 *   read: adopt.** The call carries on without a gap -- no reconnect, so no
 *   `participant_left` for this device, no re-ring, and no 1:1 call ended
 *   underneath the person who reloaded.
 * - **Still in the room, but not ours to take** (no handoff, a handoff this
 *   page cannot read, or another account signed in, or nobody): close the
 *   room and tell the server nothing. Closing is what the SFU turns into
 *   `participant_left` *for this device*, which closes exactly this device's
 *   row. `leaveCall` would be wrong here: it acts on the signed-in *user's*
 *   row, which may be a different account's, or this account's other device
 *   that has since taken the call over.
 * - **The room ended while no page listened** (`disconnected`): close what is
 *   left of it, and hand the session the end the transport would have
 *   reported (`transportEndFor`), so a room the SFU forgot is followed up and
 *   the server told exactly as it would have been with the page there. Only
 *   for this account's own call, for the same reason as above.
 *
 * Adopting a call that is `reconnecting` is fine: the transport's reconnect
 * watch picks up from there.
 */
export function orphanDecision(input: {
  orphan: OrphanReading | null;
  /** The signed-in account that may take the call over; null when nobody
   *  is, or when this page is not in a state to hold a call (unverified,
   *  below the version floor). */
  userId: string | null;
}): OrphanDecision {
  const { orphan, userId } = input;
  if (!orphan) return { kind: "none" };
  const handoff = decodeHandoff(orphan.handoff);
  const ours = handoff !== null && userId !== null && handoff.userId === userId ? handoff : null;
  if (orphan.state === "disconnected") {
    // Never `roomGone`: only an answer the transport already holds says
    // that, and nobody was holding one.
    const unsettled = ours ? transportEndFor(orphan.reason, orphan.endpoint).unsettled : null;
    return {
      kind: "drop",
      followUp: ours && unsettled ? { callId: ours.callId, unsettled } : null,
    };
  }
  if (ours) return { kind: "adopt", handoff: ours };
  return { kind: "drop", followUp: null };
}

