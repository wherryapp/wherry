// The decisions behind the voice UI, as pure functions: which rings to
// show, whether to ring audibly, whether to join muted, which key index an
// epoch lands in. No DOM, no livekit-client, no store -- so the tests
// beside this file run under node:test, and the stateful modules
// (session.ts, hooks.ts) stay thin.

import type { Call, CallKind } from "../api/types";

/** Mirrors the server's ring window (services/voice-rules.ts). A ring the
 *  server forgot to end is dropped here at the same age, plus grace. */
export const RING_TIMEOUT_MS = 45_000;
const RING_GRACE_MS = 5_000;

/** The MLS exporter label; the call id is the context. Versioned so a
 *  later change to what the bytes key cannot collide with these. */
export const CALL_KEY_LABEL = "wherry voice v1";

/** livekit-client's keyring: keys live at an index the frame trailer
 *  names, so a receiver decrypts each frame with the key it was sealed
 *  under. One key per MLS epoch, at epoch mod this. */
export const KEYRING_SIZE = 16;

export function keyIndexFor(epoch: number): number {
  return ((epoch % KEYRING_SIZE) + KEYRING_SIZE) % KEYRING_SIZE;
}

export function callKeyContext(callId: string): Uint8Array {
  return new TextEncoder().encode(callId);
}

// ---------------------------------------------------------------------------
// Incoming rings
// ---------------------------------------------------------------------------

export type Ring = {
  callId: string;
  conversationId: string;
  byUserId: string;
  /** When this device first learned of the ring (its clock). */
  receivedAt: number;
};

export type RingEvent =
  | { type: "ring"; callId: string; conversationId: string; byUserId: string; now: number }
  | {
      type: "state";
      callId: string;
      status: "ringing" | "active" | "ended";
      participants: readonly { userId: string; joined: boolean }[];
      selfUserId: string;
    }
  | { type: "snapshot"; calls: readonly Call[]; selfUserId: string; now: number }
  | { type: "dismiss"; callId: string }
  | { type: "tick"; now: number };

/**
 * The rings this device should be showing, after an event.
 *
 * - a ring adds (once per call);
 * - a state frame removes the ring when the call ended, or when this user
 *   is already in it (answered here or on another device);
 * - a snapshot from GET /voice/active replaces the set with the calls this
 *   user is merely invited to -- the self-heal after a missed frame;
 * - a tick drops anything older than the ring window, the local backstop
 *   for a missed `ended`.
 */
export function reduceRings(rings: readonly Ring[], event: RingEvent): Ring[] {
  switch (event.type) {
    case "ring": {
      if (rings.some((ring) => ring.callId === event.callId)) return [...rings];
      return [
        ...rings,
        {
          callId: event.callId,
          conversationId: event.conversationId,
          byUserId: event.byUserId,
          receivedAt: event.now,
        },
      ];
    }
    case "state": {
      if (event.status === "ended") {
        return rings.filter((ring) => ring.callId !== event.callId);
      }
      const selfIn = event.participants.some(
        (p) => p.userId === event.selfUserId && p.joined,
      );
      if (selfIn) return rings.filter((ring) => ring.callId !== event.callId);
      return [...rings];
    }
    case "snapshot": {
      const invited = event.calls.filter((call) => {
        if (call.status !== "ringing") return false;
        if (call.startedByUserId === event.selfUserId) return false;
        const mine = call.participants.find((p) => p.userId === event.selfUserId);
        return (
          mine !== undefined &&
          mine.answeredAt === null &&
          mine.declinedAt === null &&
          mine.leftAt === null
        );
      });
      return invited.map((call) => {
        const existing = rings.find((ring) => ring.callId === call.id);
        return (
          existing ?? {
            callId: call.id,
            conversationId: call.conversationId,
            byUserId: call.startedByUserId,
            receivedAt: event.now,
          }
        );
      });
    }
    case "dismiss":
      return rings.filter((ring) => ring.callId !== event.callId);
    case "tick":
      return rings.filter(
        (ring) => event.now - ring.receivedAt < RING_TIMEOUT_MS + RING_GRACE_MS,
      );
  }
}

/**
 * Whether a ring makes a sound. A muted conversation rings silently (the
 * overlay still shows -- mute is about noise, and a call is a person
 * waiting); the ringtone preference is the global off switch. The window
 * being focused does NOT silence a ring, unlike a message notification: a
 * call needs an answer now, and the in-app tone is the right surface for
 * a focused window.
 */
export function shouldRingAudibly(input: {
  conversationMuted: boolean;
  ringtoneEnabled: boolean;
}): boolean {
  return input.ringtoneEnabled && !input.conversationMuted;
}

// ---------------------------------------------------------------------------
// Join-mute
// ---------------------------------------------------------------------------

export type JoinMutePreference = "auto" | "unmuted" | "muted";

/**
 * The maintainer's rule (docs/prompts/voice-plan.md §11 item 3): a call you
 * started or answered joins live, always; a room honours the channel's
 * threshold (the server's `joinMuted` verdict) unless this person's own
 * preference says otherwise.
 */
export function shouldJoinMuted(input: {
  kind: CallKind;
  preference: JoinMutePreference;
  serverJoinMuted: boolean;
}): boolean {
  if (input.kind === "call") return false;
  switch (input.preference) {
    case "unmuted":
      return false;
    case "muted":
      return true;
    case "auto":
      return input.serverJoinMuted;
  }
}

// ---------------------------------------------------------------------------
// Notice lines
// ---------------------------------------------------------------------------

/**
 * What a call_ended notice says to this viewer. "Missed" is per viewer: the
 * call rang for them and nobody on their account answered. A caller sees
 * "No answer" for the same call.
 */
export function callNotice(input: {
  endReason: string | null;
  startedByUserId: string;
  startedByName: string;
  answeredAt: string | null;
  startedAt: string;
  endedAt: string | null;
  participantUserIds: readonly string[];
  selfUserId: string;
}): string {
  const mine = input.startedByUserId === input.selfUserId;
  const who = mine ? "You" : input.startedByName;
  switch (input.endReason) {
    case "unanswered":
      return mine ? "No answer" : `Missed call from ${input.startedByName}`;
    case "declined":
      return mine ? "Call declined" : "Declined call";
    case "cancelled":
      return mine ? "You cancelled the call" : `${input.startedByName} cancelled the call`;
    default: {
      const from = input.answeredAt ?? input.startedAt;
      const to = input.endedAt;
      const minutes =
        to === null
          ? null
          : Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
      const length =
        minutes === null ? "" : minutes < 1 ? " · under a minute" : ` · ${minutes} min`;
      return `${who} called${length}`;
    }
  }
}
