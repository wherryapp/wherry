// The decisions behind the voice UI, as pure functions: which rings to
// show, whether to ring audibly, whether to join muted, which key index an
// epoch lands in. No DOM, no livekit-client, no store -- so the tests
// beside this file run under node:test, and the stateful modules
// (session.ts, hooks.ts) stay thin.

import type { Call, CallKind } from "../api/types";

/** The two video sources a call can carry, spelled the way the server's
 *  `VideoLimits` spells them. The SDK's own enum never leaves
 *  transport-webview.ts. */
export type VideoSource = "camera" | "screen";

/** What a viewer wants of one remote video track. `off` unsubscribes
 *  outright -- a tile nobody can see should cost nobody anything. */
export type VideoQualityRequest = "off" | "low" | "high";

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
  /** The callee is on do-not-disturb: the ring still shows, silently --
   *  the same "calls included" decision the server's push skip makes. */
  dnd?: boolean;
}): boolean {
  return input.ringtoneEnabled && !input.conversationMuted && !input.dnd;
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

// ---------------------------------------------------------------------------
// Echo cancellation
// ---------------------------------------------------------------------------

/**
 * The echo canceller's own reading, from the audio source's RTP stats
 * (Chromium reports `echoReturnLoss` / `echoReturnLossEnhancement` on
 * the `media-source` entry; WebKit reports neither). Both in dB.
 *
 * ERL is how much quieter the far end's sound is by the time this
 * microphone picks it up -- the acoustic path, headphones make it huge.
 * ERLE is how much *more* the canceller removes on top of that: the
 * adaptive filter's actual work, climbing from ~0 as it converges and
 * sitting near 0 when it has nothing to converge on. It is the number
 * that separates "converging slowly" from "never locked", which is why
 * the native media plan (docs/prompts/native-media-plan.md §2) wants it
 * read before anything about echo is rebuilt. Null means the browser did
 * not report it, never that the canceller is off.
 */
export type EchoReport = {
  echoReturnLoss: number | null;
  echoReturnLossEnhancement: number | null;
  /**
   * This call was joined with echo cancellation switched off (prefs.ts), so
   * there is no canceller to report on: the numbers above are meaningless
   * whatever they say -- the APM reports no echo metrics with the canceller
   * off, and the native stats deserialise an absent number as 0 dB.
   */
  disabled?: boolean;
};

/** ERLE at or above this is a converged canceller. */
export const ERLE_CONVERGED_DB = 12;
/** ERLE below this is a canceller that has not (yet) found the echo path. */
export const ERLE_IDLE_DB = 3;

export type EchoState = "off" | "unreported" | "idle" | "converging" | "converged";

export function echoState(report: EchoReport): EchoState {
  if (report.disabled) return "off";
  const erle = report.echoReturnLossEnhancement;
  if (erle === null || !Number.isFinite(erle)) return "unreported";
  if (erle >= ERLE_CONVERGED_DB) return "converged";
  if (erle >= ERLE_IDLE_DB) return "converging";
  return "idle";
}

/**
 * The echo row's words. Idle is deliberately not called a fault: with
 * headphones, or while nobody else is talking, there is no echo to
 * cancel and the reading is honestly near zero.
 */
export function echoLine(report: EchoReport): string {
  const db = (value: number | null): string =>
    value === null || !Number.isFinite(value) ? "?" : `${Math.round(value)} dB`;
  const numbers = `ERL ${db(report.echoReturnLoss)} · ERLE ${db(report.echoReturnLossEnhancement)}`;
  switch (echoState(report)) {
    case "off":
      return "echo cancellation is off for this call (Settings → Voice)";
    case "unreported":
      return "canceller not reported by this browser";
    case "converged":
      return `canceller converged (${numbers})`;
    case "converging":
      return `canceller converging (${numbers})`;
    case "idle":
      return `canceller idle -- headphones, or nobody else talking yet (${numbers})`;
  }
}

// ---------------------------------------------------------------------------
// Video (docs/prompts/video-plan.md §5.3, execution handoff §3.4)
// ---------------------------------------------------------------------------

/**
 * What a viewer should ask for of one remote video track.
 *
 * This one function is the whole of the decoder-limit answer (the plan's
 * §2) and most of the egress answer (§6), because a viewer that does not
 * ask for a layer is a sender that does not encode it -- dynacast turns
 * "nobody wants the top layer" into "stop producing it", at no cost to the
 * publisher and with no republish.
 *
 * A tile not on screen is unsubscribed outright rather than merely
 * downgraded: a tab with the stage closed should pull no video at all.
 * A screen share is always `high` when visible -- text in a shared window
 * is unreadable at the low layer, which is the entire point of sharing it.
 *
 * `topLayerCallSize` is enforced here and only here: past that many
 * participants nobody asks for the top layer, so a large call degrades to
 * medium tiles for everybody rather than dropping frames for whoever has
 * the slowest link. `topLayerViewers` is deliberately NOT enforced --
 * counting concurrent top-layer subscribers per track is something no
 * client can see and the server only could through the SFU's stats API;
 * it is carried, shown in Details, and left to the metering job the plan's
 * §10 names.
 */
export function subscriptionFor(input: {
  visible: boolean;
  pinned: boolean;
  source: VideoSource;
  participants: number;
  topLayerCallSize: number | null;
  /** A tile that is a *thumbnail* -- the call bar's live preview -- rather
   *  than something anybody is trying to read. It never asks for the top
   *  layer, screen or not: the screen exception below exists because text
   *  in a shared window is unreadable at the low layer, and nothing is
   *  readable at 96 pixels wide anyway. Without this a bar preview of a
   *  shared screen would quietly pull full resolution for the whole call. */
  preview?: boolean;
}): VideoQualityRequest {
  if (!input.visible) return "off";
  if (input.preview) return "low";
  if (input.source === "screen") return "high";
  if (!input.pinned) return "low";
  if (input.topLayerCallSize !== null && input.participants > input.topLayerCallSize) {
    return "low";
  }
  return "high";
}

/**
 * Who is showing something, in the order the call bar should prefer.
 *
 * A screen before a camera, because a screen is the thing somebody turned
 * on *to be looked at*; otherwise the first camera. A paused camera does
 * not count -- the point of the preview is to say "there is something to
 * see", and a paused tile has nothing.
 */
export function previewTileOf(
  participants: readonly {
    identity: string;
    name: string;
    camera: boolean;
    cameraMuted: boolean;
    screen: boolean;
  }[],
): { identity: string; name: string; source: VideoSource } | null {
  const screen = participants.find((participant) => participant.screen);
  if (screen) return { identity: screen.identity, name: screen.name, source: "screen" };
  const camera = participants.find(
    (participant) => participant.camera && !participant.cameraMuted,
  );
  if (camera) return { identity: camera.identity, name: camera.name, source: "camera" };
  return null;
}

/**
 * Whose video just came on, for the chime.
 *
 * Transitions only, and other people only: a chime for your own camera
 * would sound every time you pressed the button, and a chime for a state
 * that was already true would sound on every roster refresh -- which is
 * every few seconds. A camera coming *back* from the background pause
 * counts as new, because from the listener's side it is: there is
 * something to look at again where a moment ago there was not.
 */
export function videoJustStarted(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const had = new Set(before);
  return after.filter((key) => !had.has(key));
}

/** The keys `videoJustStarted` compares: one per live remote source. */
export function liveVideoKeys(
  participants: readonly {
    identity: string;
    camera: boolean;
    cameraMuted: boolean;
    screen: boolean;
  }[],
): string[] {
  const keys: string[] = [];
  for (const participant of participants) {
    if (participant.camera && !participant.cameraMuted) keys.push(`${participant.identity}/camera`);
    if (participant.screen) keys.push(`${participant.identity}/screen`);
  }
  return keys;
}

/**
 * What a visibility change does to the camera.
 *
 * Both phones stop capture when the app leaves the foreground and iOS
 * forbids it even natively, so a camera left published while hidden is a
 * frozen frame on everybody else's screen -- worse than an honest "camera
 * paused" tile. Unpublish on hidden, republish on visible, and only where
 * this device was the one that turned the camera on: coming back to the
 * foreground must never start a camera nobody asked for.
 *
 * **`platformPausesCapture` is why this is not unconditional** (2026-09-08).
 * The paragraph above is a statement about phones, and applying it
 * everywhere made a desktop camera go dark for everyone the moment its
 * tab lost focus -- which is neither forced by the platform nor what any
 * other video application does, and which makes looking at a shared
 * screen while your own camera is on impossible. A desktop keeps
 * capturing while hidden; a phone still pauses, because there the OS
 * stops the capture whether or not this code asks it to, and an honest
 * paused tile beats a frozen frame.
 *
 * Only the *pause* is gated. A resume still resumes whatever was paused,
 * on any platform: it is the recovery half, and a device that has somehow
 * got a paused camera must always be able to get out of it.
 *
 * Screen share is not paused. It is desktop-only, a covered window still
 * has content worth sending, and the shell keeps its page scheduled
 * anyway (CLAUDE.md, "WebKit suspends the page process").
 */
export function cameraOnVisibility(input: {
  hidden: boolean;
  cameraOn: boolean;
  paused: boolean;
  /** Whether this device's platform stops camera capture in the background
   *  regardless of what the app wants -- a phone. See session.ts's
   *  `capturePausesInBackground` for how it is sensed. */
  platformPausesCapture: boolean;
}): "pause" | "resume" | "nothing" {
  if (input.hidden) {
    if (!input.platformPausesCapture) return "nothing";
    return input.cameraOn && !input.paused ? "pause" : "nothing";
  }
  return input.paused ? "resume" : "nothing";
}

/** The grant line in the details: what this call will let this device send. */
export function grantLine(grant: {
  sources: readonly VideoSource[];
  camera: { maxHeight: number; maxFps: number } | null;
  screen: { maxHeight: number; maxFps: number } | null;
} | null): string {
  if (!grant) return "no video on this call";
  const parts: string[] = [];
  if (grant.sources.includes("camera") && grant.camera) {
    parts.push(`Camera up to ${grant.camera.maxHeight}p${fpsSuffix(grant.camera.maxFps)}`);
  }
  if (grant.sources.includes("screen") && grant.screen) {
    parts.push(`Screen up to ${grant.screen.maxHeight}p${fpsSuffix(grant.screen.maxFps)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "no video on this call";
}

function fpsSuffix(fps: number): string {
  // 30 is the default everywhere and saying so on every line is noise;
  // anything else is worth reading, because it is why a share looks
  // choppy.
  return fps === 30 ? "" : ` at ${fps} fps`;
}

/**
 * One video track's row. Everything is optional because everything here is
 * a browser's courtesy -- the stage-0 spike's Chromium reported null for
 * both implementation strings -- so the line degrades to the parts it has
 * rather than printing "unknown" four times.
 */
export function videoLine(stats: {
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  layer: string | null;
  implementation: string | null;
  limitedBy: string | null;
}): string {
  const parts: string[] = [];
  if (stats.width !== null && stats.height !== null && stats.width > 0 && stats.height > 0) {
    parts.push(`${stats.width}×${stats.height}`);
  }
  if (stats.fps !== null) parts.push(`${Math.round(stats.fps)} fps`);
  if (stats.codec) parts.push(stats.codec);
  if (stats.layer) parts.push(`layer ${stats.layer}`);
  if (stats.implementation) parts.push(stats.implementation);
  // "none" is the browser's word for "nothing is limiting this", which is
  // the good case and does not deserve a clause.
  if (stats.limitedBy && stats.limitedBy !== "none") parts.push(`limited by ${stats.limitedBy}`);
  return parts.length > 0 ? parts.join(" · ") : "no reading yet";
}

/**
 * The native engine's own video counters in one line (transport.ts's
 * `NativeVideoSummary`): what the shell captured and what its tiles drew.
 * "no tiles" is the honest word for a call page nobody has opened.
 */
export function nativeVideoLine(summary: {
  cameraFrames: number | null;
  screenFrames: number | null;
  tiles: number;
  bound: number;
  drawn: number;
  dropped: number;
  skipped?: number;
}): string {
  const parts: string[] = [];
  if (summary.cameraFrames !== null) parts.push(`camera ${summary.cameraFrames} frames`);
  if (summary.screenFrames !== null) parts.push(`screen ${summary.screenFrames} frames`);
  if (summary.tiles === 0) parts.push("no tiles");
  else {
    parts.push(`${summary.bound} of ${summary.tiles} tile${summary.tiles === 1 ? "" : "s"} bound`);
    parts.push(`${summary.drawn} drawn`);
    if (summary.dropped > 0) parts.push(`${summary.dropped} dropped`);
    if ((summary.skipped ?? 0) > 0) parts.push(`${summary.skipped} skipped while hidden`);
  }
  return parts.join(" · ");
}

// -- the video buttons ------------------------------------------------------

/** What a call allows and what this transport can do, for the two rules
 *  below. A subset of `VoiceState`, so they stay testable without one. */
export type VideoButtonState = {
  capabilities: { camera: boolean; screen: boolean; renderVideo: boolean };
  grant: { sources: readonly VideoSource[] } | null;
  /** The per-call engine switch, already taken or still available. */
  engineOverride: "webview" | null;
  /**
   * This call is running on the shell's own media engine, so there is a
   * browser engine to rejoin through.
   *
   * Added 2026-09-10, and the reason is that the three capabilities stopped
   * being able to tell two devices apart. A phone webview reads
   * `{ camera: true, screen: false, renderVideo: true }` and a Windows
   * shell after stage W3 reads `{ camera: false, screen: true,
   * renderVideo: true }` — both with no override taken, and only one of
   * them has anywhere to switch. Before W3 the difference was carried by
   * `renderVideo`, because a shell that could not draw was the only shell
   * that existed; a shell that draws and still cannot open a camera is the
   * third shape those rules were never written for.
   */
  nativeEngine: boolean;
};

/**
 * Whether pressing this button means switching engines first.
 *
 * A desktop shell on its own audio engine cannot do video (until 3N ships
 * on that platform), and the way out is one reconnect through the browser
 * engine. Until 2026-09-08 that was a separate *Switch engine* button
 * beside a disabled camera -- two presses for one intention. Now the
 * camera button *is* the switch: the session rejoins and then turns the
 * camera on, and this predicate is how the button and the session agree
 * on when that applies. False once the switch has been taken.
 *
 * Rendering stopped being the reason on 2026-09-10 (stage W3): Windows
 * draws everybody else's tile natively and still cannot open a camera, so
 * "this engine cannot show video" and "this engine cannot capture this
 * source" came apart. Not being able to capture is the reason now, and
 * being on the native engine is what makes the switch a real way out —
 * which a browser that simply lacks the API does not have.
 */
export function videoNeedsSwitch(state: VideoButtonState, source: VideoSource): boolean {
  if (state.capabilities[source]) return false;
  return state.nativeEngine && state.engineOverride === null;
}

/** The button's hover text while `videoNeedsSwitch` is true. */
export const VIDEO_SWITCH_NOTE =
  "Switches this call to the browser engine first — a second or two of silence";

/**
 * The reason a video button is disabled, or null when it is not.
 *
 * Three different answers, and telling them apart is the whole point of
 * disabling rather than hiding: the grant does not carry the source (the
 * button is hidden -- nothing to explain), this engine cannot do video
 * (the button switches engines and is *not* disabled -- see
 * `videoNeedsSwitch`), or this browser cannot (nothing is).
 */
export function videoDisabledReason(
  state: VideoButtonState,
  source: VideoSource,
): string | null {
  if (state.capabilities[source]) return null;
  // The press is the switch, so there is nothing to explain and nothing to
  // disable. Asked first because a shell that renders can still be here.
  if (videoNeedsSwitch(state, source)) return null;
  if (!state.capabilities.renderVideo) {
    return "Video runs through the browser engine on this device";
  }
  return source === "camera"
    ? "This browser cannot open a camera"
    : "This browser cannot share a screen";
}

/**
 * Whether to show a video button at all.
 *
 * Hidden when the grant does not carry the source -- nothing to explain --
 * and hidden again when the transport cannot do it and *nothing here can
 * fix that*: neither phone webview can share a screen and no web-side
 * switch changes it (the plan's §8), so offering a permanently dead
 * control is worse than offering none. It stays visible in the one case
 * that has a way out: a desktop shell on its own media engine, where the
 * press itself is the switch.
 *
 * "Has a way out" is `videoNeedsSwitch`, not `!renderVideo`, since
 * 2026-09-10 — a Windows shell renders and still needs the switch for its
 * camera, and reading the old condition there took the camera button off
 * the bar entirely.
 */
export function showsVideoButton(state: VideoButtonState, source: VideoSource): boolean {
  if (!state.grant?.sources.includes(source)) return false;
  if (state.capabilities[source]) return true;
  return videoNeedsSwitch(state, source);
}
