// Pure decisions the transports share or that the native transport makes
// on the shell's behalf -- kept here, tested, and out of Rust on purpose
// (docs/prompts/native-media-plan.md §0.4: policy in TypeScript, mechanism
// in Rust). Nothing here imports a media SDK or the Tauri API.

import type { AudioKind, TransportConnectionState, VoiceQuality } from "./transport";

/**
 * The account behind a participant. The server puts `{ userId }` in each
 * participant's metadata (`services/voice.ts`); a participant with none,
 * or with something unparseable there, is named by their identity -- the
 * device id -- which is a poor stand-in but never blank.
 */
export function userIdFromMetadata(metadata: string | undefined, identity: string): string {
  try {
    const parsed = JSON.parse(metadata ?? "") as { userId?: unknown };
    if (typeof parsed.userId === "string") return parsed.userId;
  } catch {
    // Fall through.
  }
  return identity;
}

/**
 * The browser error name `session.ts`'s `micFailure` understands, for a
 * code the shell's `voice_set_mic` reports. "refused" has no native
 * source yet: macOS does not fail a capture it has denied, it delivers
 * silence, so a refusal cannot be told apart from a quiet room here.
 */
export function micErrorName(code: string): "NotFoundError" | "NotAllowedError" | "UnknownError" {
  switch (code) {
    case "no_microphone":
      return "NotFoundError";
    case "permission":
      return "NotAllowedError";
    default:
      return "UnknownError";
  }
}

/**
 * What a listener's volume for somebody means natively -- two things, sent
 * together. The track is *enabled* only above silence: a disabled track
 * costs no decoding, and zero is the one value that must mean what it says
 * whatever the gain does. The *gain* is the volume itself, in WebRTC's
 * receive-stream range, where 1.0 is unity: the slider is never allowed to
 * make anybody louder than they sent themselves, so it is clamped to unity
 * even though WebRTC would take up to 10. (Before the fork's set_volume
 * existed, the enable flag was the whole story and anything above silence
 * played at full volume; the plan's §3.1.)
 */
export function playbackEnabledFor(volume: number): boolean {
  return volume > 0;
}

export function nativeGainFor(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(1, volume));
}

/** The SDK's frame-cryption states that mean a frame did not open. */
const ENCRYPTION_FAILURES: ReadonlySet<string> = new Set([
  "EncryptionFailed",
  "DecryptionFailed",
  "MissingKey",
  "InternalError",
]);

export function isEncryptionFailure(state: string): boolean {
  return ENCRYPTION_FAILURES.has(state);
}

export function qualityFromWord(word: string): VoiceQuality {
  switch (word) {
    case "excellent":
    case "good":
    case "poor":
    case "lost":
      return word;
    default:
      return "unknown";
  }
}

export function connectionFromWord(word: string): TransportConnectionState | null {
  switch (word) {
    case "connected":
    case "reconnecting":
    case "disconnected":
      return word;
    default:
      return null;
  }
}

/**
 * A stored device id is only worth sending if the shell can still see it:
 * one saved from the webview's `enumerateDevices` lives in a different id
 * space entirely, and one saved natively may have been unplugged since.
 * Null means the platform default, which is what either case deserves.
 */
export function knownDeviceId(
  id: string | null,
  devices: readonly { deviceId: string }[],
): string | null {
  // Falsy rather than `=== null`, because the empty string is a real value
  // here and it is not an id. Before microphone permission is granted a
  // browser's `enumerateDevices` answers with every `deviceId` blank -- so an
  // empty stored id would *match* one of those entries and be handed on as an
  // exact constraint, which is an OverconstrainedError on a machine whose
  // microphone is fine.
  if (!id) return null;
  return devices.some((device) => device.deviceId === id) ? id : null;
}

// ---------------------------------------------------------------------------
// Video (docs/prompts/video-execution-handoff.md §3)
// ---------------------------------------------------------------------------

/**
 * The publish codec, and the one line standing between this application
 * and a camera that appears to work and sends nothing.
 *
 * Stage 0 measured it (`docs/prompts/video-plan.md` §9.1): livekit-client's
 * E2EE worker throws for AV1 *before* the try that wraps the encryption,
 * so the transform callback rejects, the whole TransformStream errors, and
 * no frame is ever enqueued again -- while the encoder upstream carries on
 * encoding. The publisher sees a healthy publication and a perfect local
 * preview; `bytesSent` stays at 0 and nothing whatsoever leaves the
 * machine. One error is logged and then the pipeline is simply dead.
 *
 * So this is a function with a test rather than a literal at the call
 * site: the day the codec becomes configurable -- a setting, a per-account
 * override, an experiment -- the refusal has to already be here, because
 * the alternative is somebody discovering it as "my camera does not work
 * for anyone". H.264 also happens to be the right answer on its own
 * merits (hardware encode on every phone, no browser that cannot decode
 * it), and VP8 and VP9 both survived the same measurement if it ever
 * disappoints on a handset.
 */
export function videoCodecFor(e2ee: boolean): "h264" {
  // Unconditional today, and the parameter is not decoration: it is where
  // the AV1 branch would go the moment a readable hub wants it (the plan's
  // §10.1 keeps that option open, and nothing encrypts frames there).
  void e2ee;
  return "h264";
}

/** A resolved grant, as `videoOptionsFor` needs to read it. */
export type VideoGrantLimits = {
  sources: readonly ("camera" | "screen")[];
  camera: { maxHeight: number; maxFps: number } | null;
  screen: { maxHeight: number; maxFps: number } | null;
};

/** The person's own camera tier (prefs.ts), in heights. */
const TIER_HEIGHT: Readonly<Record<"auto" | "standard" | "hd", number>> = {
  // Auto is deliberately not "whatever the grant allows": 1080p on a
  // laptop battery is a heat decision nobody made, and 720 is where a
  // camera stops looking better and starts costing more. Asking for HD is
  // how somebody makes that decision on purpose.
  auto: 720,
  standard: 360,
  hd: Number.POSITIVE_INFINITY,
};

/**
 * The camera ceiling this device will actually ask for: the person's tier,
 * never above the grant. The grant is the authority in both directions --
 * a tier cannot raise it, and a tier below it is honoured, which is what
 * makes "standard" mean something on a slow link.
 */
export function cameraCeilingFor(
  granted: { maxHeight: number; maxFps: number } | null,
  tier: "auto" | "standard" | "hd",
): { maxHeight: number; maxFps: number } | null {
  if (!granted) return null;
  return { ...granted, maxHeight: Math.min(granted.maxHeight, TIER_HEIGHT[tier]) };
}

/**
 * Past how many people in the call a screen drops one height step.
 *
 * The plan's §2 audience rule, and the number is a *default to revisit on
 * the first measurement*, not a measured constraint: a screen at 1080p is
 * the single most expensive thing on the SFU (about 3 Mbps at 15 fps, per
 * the plan's §6) and it is fanned out to everybody, so the cost is linear
 * in the audience while the benefit is not. Twelve is the same number the
 * seeded policy uses for `topLayerCallSize`, deliberately: one call size
 * past which this application stops spending on fidelity.
 */
export const SCREEN_AUDIENCE_STEP = 12;

/** The height ladder a screen steps down through. */
const SCREEN_HEIGHTS = [360, 720, 1080] as const;

/**
 * The screen ceiling for a call of this size: the grant, dropped one step
 * where the audience is large.
 *
 * Evaluated **at publish time only** and never re-applied mid-share. A
 * republish is a black frame and a fresh key frame for every viewer, and
 * doing that because somebody joined would make a big call visibly worse
 * for everybody each time it grew. The person who starts sharing to forty
 * people gets the smaller screen; the person who was already sharing to
 * eleven keeps what they had.
 */
export function screenOptionsFor(
  granted: { maxHeight: number; maxFps: number } | null,
  audience: number,
): { maxHeight: number; maxFps: number } | null {
  if (!granted) return null;
  if (audience <= SCREEN_AUDIENCE_STEP) return granted;
  const index = SCREEN_HEIGHTS.findIndex((height) => height >= granted.maxHeight);
  // A ceiling below the bottom rung, or exactly it, has nowhere to go.
  if (index <= 0) return granted;
  return { ...granted, maxHeight: SCREEN_HEIGHTS[index - 1]! };
}

/**
 * The grant as the transport wants it: a ceiling per source, present only
 * where the source is actually granted. Two shapes rather than one because
 * "may publish a camera" and "how big a camera" are different questions
 * and the SDK asks them in different places -- `canPublishSources` in the
 * token settles the first, and these numbers only ever narrow what the
 * client asks for.
 */
export function videoOptionsFor(
  grant: VideoGrantLimits | null,
  e2ee: boolean,
  tier: "auto" | "standard" | "hd" = "auto",
): { codec: "h264"; camera: { maxHeight: number; maxFps: number } | null; screen: { maxHeight: number; maxFps: number } | null } {
  const has = (source: "camera" | "screen"): boolean =>
    grant !== null && grant.sources.includes(source);
  return {
    codec: videoCodecFor(e2ee),
    camera: has("camera") ? cameraCeilingFor(grant?.camera ?? null, tier) : null,
    screen: has("screen") ? (grant?.screen ?? null) : null,
  };
}

/**
 * What a screen share's audio is captured with.
 *
 * All three switches **off**, and this is a requirement rather than a
 * preference (the maintainer, 2026-09-09): the browser's canceller,
 * suppressor and gain control are tuned for a voice in a room, and they
 * mangle music and dialogue — the suppressor hears a soundtrack as noise
 * and the gain control pumps it. There is also nothing for a canceller to
 * do here: this audio never went through a speaker, so there is no echo
 * path to model. Stereo is asked for because the material is usually
 * mixed for it and a screen share is the one place in a call where that
 * matters.
 *
 * Chromium may ignore any of these on a display capture; asking is still
 * right, and what it actually honours is a Windows row.
 */
export function screenAudioCapture(): {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  channelCount: number;
} {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
  };
}

/**
 * What a screen share's audio is published with, in bits per second.
 *
 * `AudioPresets.musicHighQualityStereo`, mirrored by hand rather than
 * imported for the reason rules.ts states about every SDK number: this
 * file must not import livekit-client.
 *
 * The room's own audio defaults are wrong here in a way that is easy to
 * miss. They carry `dtx` — discontinuous transmission, which stops sending
 * during silence — and on speech that is free bandwidth, while on music it
 * audibly clips the quiet passages and the tails of notes. `red` is
 * redundant encoding, useful for a voice on a lossy link and pure overhead
 * on a stream nobody is straining to understand word by word. And a speech
 * bitrate is a quarter of what music needs.
 */
export const SCREEN_AUDIO_BITRATE = 128_000;

export function screenAudioPublish(): {
  dtx: boolean;
  red: boolean;
  forceStereo: boolean;
  maxBitrate: number;
} {
  return { dtx: false, red: false, forceStereo: true, maxBitrate: SCREEN_AUDIO_BITRATE };
}

/**
 * How a per-person volume is keyed, now that a person can be two sources
 * of sound: their voice, and the audio of whatever they are sharing.
 *
 * A string key rather than a nested map because it is remembered in three
 * places — the session, both transports — and the awkward case is a volume
 * set for somebody whose track has not arrived yet, which a flat map
 * replays trivially. Pure, so the three cannot drift.
 */
export function volumeKey(userId: string, kind: AudioKind): string {
  return `${userId}/${kind}`;
}

/** A rectangle in CSS pixels, viewport origin -- `getBoundingClientRect`'s. */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * What the native transport tells the shell about one tile: the rect the
 * tile occupies, the rect it is clipped to, and whether any of it is on
 * screen.
 *
 * A native view is above the page and cannot be clipped by the page's
 * scroller, so the clip goes across the seam beside the frame: the shell
 * puts the video inside a container the size of the clip, offset by how
 * far the tile pokes out of it. The clip is the tile's nearest
 * `[data-video-clip]` ancestor's rect intersected with the viewport, or
 * the viewport alone. `visible` is false for a tile with no area, one
 * entirely outside its clip, or one whose clip is itself off screen --
 * the cases where the shell should draw nothing rather than a sliver.
 */
export function tileRect(
  frame: Rect,
  clip: Rect | null,
  viewport: { width: number; height: number },
): { frame: Rect; clip: Rect; visible: boolean } {
  const screen: Rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const clipped = intersect(clip ?? screen, screen);
  const shown = intersect(frame, clipped);
  const visible =
    frame.width > 0 && frame.height > 0 && shown.width > 0 && shown.height > 0;
  return { frame, clip: clipped, visible };
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * Why a publish failed, in words the bar can show.
 *
 * The SFU refuses a source the token does not name by failing the
 * **publish**, not the join -- the call is already up and audible by then
 * -- so without this the camera button spins and stops with nothing said.
 * The browser's own refusals come through as the same DOMException names
 * getUserMedia raises, and `NotAllowedError` covers both a denied
 * permission and a screen picker the person dismissed, which is why that
 * wording has to fit both.
 */
export function publishErrorMessage(error: unknown, source: "camera" | "screen"): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const thing = source === "camera" ? "camera" : "screen";
  if (/permission|not allowed|insufficient/i.test(message) && /publish|source|track/i.test(message)) {
    return `This call does not allow ${thing} video.`;
  }
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return source === "camera"
        ? "Camera access was refused."
        : "Screen sharing was refused or cancelled.";
    case "NotFoundError":
      return source === "camera" ? "No camera was found." : "No screen was available to share.";
    case "NotReadableError":
      return `The ${thing} is in use by another application.`;
    case "OverconstrainedError":
      return `The ${thing} cannot produce what this call asked for.`;
    default:
      return source === "camera"
        ? "The camera could not be started."
        : "The screen could not be shared.";
  }
}
