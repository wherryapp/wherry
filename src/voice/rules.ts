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

// ---------------------------------------------------------------------------
// Call details -- the readout behind the bar's "Details"
// ---------------------------------------------------------------------------
//
// Written for the first device pass, where the report was "no sound from
// the phone" and nothing in the bar could say *where* the sound stopped.
// Every row of the readout is one of four places: the microphone (does a
// track exist and is it live), the uplink (do packets leave), the
// downlink per peer (do bytes arrive, do they decode to energy, does the
// element play), and the key (do frames fail to open). The functions here
// turn the raw flags and counters into the words; session.ts gathers the
// numbers.

/** The local microphone track's own flags, as the browser reports them. */
export type MicReport = {
  /** A track is published: getUserMedia succeeded at some point. */
  published: boolean;
  /** Muted by this person -- the bar's button, or the join-mute rule. */
  muted: boolean;
  /**
   * MediaStreamTrack.muted: the platform silenced the track underneath
   * us. iOS sets it when an embedded web view leaves the foreground, and
   * any phone sets it during an audio-session interruption (a phone call,
   * Siri). The track is still "live" and still published, which is why
   * it needs its own word.
   */
  systemMuted: boolean;
  /** MediaStreamTrack.readyState === "ended": the device was taken away. */
  ended: boolean;
  /** How getUserMedia failed, when it did: permission refused, no device
   *  at all, or some other error. Null when it succeeded or never ran. */
  failure: MicFailure | null;
};

export type MicFailure = "refused" | "missing" | "failed";

export type MicStatus =
  | "off"
  | MicFailure
  | "ended"
  | "system-muted"
  | "muted"
  | "on";

export function micStatus(report: MicReport): MicStatus {
  if (report.failure) return report.failure;
  if (!report.published) return "off";
  if (report.ended) return "ended";
  if (report.systemMuted) return "system-muted";
  if (report.muted) return "muted";
  return "on";
}

/**
 * The microphone row. `packetsDelta` is outbound packets since the last
 * sample (null before there are two): a live, unmuted track that sends
 * nothing is the one case the flags alone cannot name.
 */
export function micLine(status: MicStatus, packetsDelta: number | null): string {
  switch (status) {
    case "off":
      return "not started";
    case "refused":
      return "refused -- nobody can hear you";
    case "missing":
      return "no microphone found";
    case "failed":
      return "could not be started";
    case "ended":
      return "taken away by the system";
    case "system-muted":
      return "silenced by the system (backgrounded, or interrupted)";
    case "muted":
      return "muted";
    case "on":
      if (packetsDelta === null) return "on";
      return packetsDelta > 0 ? "on, sending" : "on, but nothing is leaving this device";
  }
}

/**
 * Where a peer's audio is, from two samples of their inbound stats.
 *
 * - `bytesDelta`: inbound-rtp bytes since the last sample. Zero means the
 *   SFU is forwarding nothing for them (they are muted, or the media path
 *   is down); DTX keeps a trickle of comfort noise flowing when they are
 *   merely quiet.
 * - `energyDelta`: inbound-rtp totalAudioEnergy since the last sample --
 *   the energy of *decoded* audio, so it stays flat when frames arrive
 *   but fail to open. Null where the engine does not report it.
 * - `encryptionErrorsDelta`: frames this device failed to open, all peers.
 * - `playing`: the attached element is not paused; null with none attached.
 */
export type PeerFlow =
  | "no-data"
  | "nothing-arriving"
  | "arriving-unreadable"
  | "arriving-silent"
  | "not-playing"
  | "flowing";

/** Decoded energy below this over a sample is silence or comfort noise. */
export const SILENT_ENERGY = 1e-5;

export function peerFlow(input: {
  bytesDelta: number | null;
  energyDelta: number | null;
  encryptionErrorsDelta: number;
  playing: boolean | null;
}): PeerFlow {
  if (input.bytesDelta === null) return "no-data";
  if (input.bytesDelta <= 0) return "nothing-arriving";
  const silent = input.energyDelta !== null && input.energyDelta < SILENT_ENERGY;
  if (input.encryptionErrorsDelta > 0 && (input.energyDelta === null || silent)) {
    return "arriving-unreadable";
  }
  if (silent) return "arriving-silent";
  if (input.playing === false) return "not-playing";
  return "flowing";
}

export function peerFlowLine(flow: PeerFlow): string {
  switch (flow) {
    case "no-data":
      return "waiting for stats";
    case "nothing-arriving":
      return "nothing arriving";
    case "arriving-unreadable":
      return "arriving, but the frames cannot be opened (key mismatch)";
    case "arriving-silent":
      return "arriving, silent";
    case "not-playing":
      return "decoded, but not playing";
    case "flowing":
      return "flowing";
  }
}

// ---------------------------------------------------------------------------
// Audio quality
// ---------------------------------------------------------------------------

/**
 * The Opus ceiling this device publishes at, as a named tier. Uplink only:
 * what a device sends. What it hears is whatever each peer chose, so two
 * people on different tiers each hear the other's.
 *
 * The numbers mirror livekit-client's `AudioPresets` (telephone, speech,
 * music, musicHighQuality) so this module stays free of the SDK; the
 * session hands the bitrate through as a custom preset. Speech is the
 * default the plan settled on (voice-plan.md §6): 24 kbps is transparent
 * for a voice, and everything above it buys music fidelity at the cost of
 * data and battery -- docs/voice-efficiency.md has the reasoning for why
 * bitrate is a smaller lever on power than the encoder's own complexity.
 */
export type AudioQuality = "telephone" | "speech" | "music" | "musicHighQuality";

export const AUDIO_QUALITY_KBPS: Readonly<Record<AudioQuality, number>> = {
  telephone: 12,
  speech: 24,
  music: 48,
  musicHighQuality: 96,
};

export const DEFAULT_AUDIO_QUALITY: AudioQuality = "speech";

/** A stored preference is untrusted input: anything not a tier is the default. */
export function isAudioQuality(value: unknown): value is AudioQuality {
  return (
    typeof value === "string" &&
    (Object.keys(AUDIO_QUALITY_KBPS) as string[]).includes(value)
  );
}

/** livekit-client's `AudioPreset` shape (bits per second), without importing it. */
export function audioPresetFor(quality: AudioQuality): { maxBitrate: number } {
  return { maxBitrate: AUDIO_QUALITY_KBPS[quality] * 1000 };
}
