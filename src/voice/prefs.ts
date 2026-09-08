// Device-local voice preferences: which microphone and speaker, whether
// to join rooms muted, whether rings make a sound. localStorage rather
// than the store's meta table because these are per-device hardware
// choices read synchronously at join time, never synced anywhere.

import {
  DEFAULT_AUDIO_QUALITY,
  isAudioQuality,
  type AudioQuality,
  type JoinMutePreference,
} from "./rules";

const KEY = "messenger.voice.prefs.v1";

export type VoicePrefs = {
  joinMute: JoinMutePreference;
  ringtone: boolean;
  /** `deviceId`s from enumerateDevices; null = the browser's default. */
  micDeviceId: string | null;
  speakerDeviceId: string | null;
  /**
   * The uplink bitrate tier (rules.ts). Read once at join, so a change
   * applies to the next call. Device-local like the rest, and the control
   * that writes it is flag-gated (Settings → Voice) -- but the value is
   * honoured regardless of the flag, because the flag is advisory the way
   * every other feature flag here is; see the 0021 migration's note.
   */
  audioQuality: AudioQuality;
  /**
   * The microphone's three processing switches (docs/prompts/native-media-
   * plan.md §6). One setting, two implementations behind the transport seam:
   * the webview hands them to the browser as getUserMedia constraints, the
   * desktop engine to WebRTC's software audio processing module. Read at
   * join, so a change applies to the next call. All on by default -- what
   * both paths always did; the switches exist for the two honest reasons to
   * turn one off (headphones leave the echo canceller nothing to remove and
   * it can only degrade the signal; noise suppression eats music).
   */
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /**
   * Run calls through the shell's own media engine rather than the
   * webview (docs/prompts/native-media-plan.md §5). **On by default since
   * 2026-09-07 (evening)**, the maintainer's decision once both of the
   * plan's §5.1 gates were answered; it shipped dark on 2026-09-07 morning
   * and was turned on per device until then. Honoured only where the engine
   * exists (native-media.ts's probe -- the desktop shell), so on the web
   * and the phones the value is stored and ignored and this default changes
   * nothing there. A device that unticks the box keeps its choice. Read at
   * join, so it applies to the next call.
   */
  nativeMedia: boolean;
  /** `deviceId` from enumerateDevices; null = the platform default. In the
   *  browser's id space, so it is checked against the live camera list
   *  before it is used, exactly as the microphone's is. */
  cameraDeviceId: string | null;
  /**
   * How much camera this device would like to send, capped by the grant at
   * publish time -- so a person on a fast machine can ask for HD and a
   * person on a laptop battery can ask for less, and neither can exceed
   * what the server allowed. `auto` is the grant's own ceiling.
   */
  videoQuality: VideoQualityTier;
  /**
   * What the call bar shows while somebody's video is live and the call
   * page is closed: a moving thumbnail, or a badge that costs nothing.
   *
   * `thumbnail` is the default because it answers a question a badge
   * cannot -- whether their camera is actually working -- and because it
   * is the affordance that gets people to the call page at all. It holds
   * one low-layer subscription (a couple of hundred kbit/s) for as long as
   * it is on screen; `badge` is for a metered connection, and is the
   * switch to reach for when that matters more than the glance.
   */
  videoPreview: VideoPreviewMode;
};

/** The call bar's two answers to "somebody is live". */
export type VideoPreviewMode = "thumbnail" | "badge";

/** Settings' three words for the camera tier; the numbers are in rules.ts. */
export type VideoQualityTier = "auto" | "standard" | "hd";

function isVideoQualityTier(value: unknown): value is VideoQualityTier {
  return value === "auto" || value === "standard" || value === "hd";
}

const DEFAULTS: VoicePrefs = {
  joinMute: "auto",
  ringtone: true,
  micDeviceId: null,
  speakerDeviceId: null,
  audioQuality: DEFAULT_AUDIO_QUALITY,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  nativeMedia: true,
  cameraDeviceId: null,
  videoQuality: "auto",
  videoPreview: "thumbnail",
};

export function loadVoicePrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<VoicePrefs>;
    return {
      joinMute:
        parsed.joinMute === "unmuted" || parsed.joinMute === "muted"
          ? parsed.joinMute
          : "auto",
      ringtone: parsed.ringtone !== false,
      micDeviceId: typeof parsed.micDeviceId === "string" ? parsed.micDeviceId : null,
      speakerDeviceId:
        typeof parsed.speakerDeviceId === "string" ? parsed.speakerDeviceId : null,
      audioQuality: isAudioQuality(parsed.audioQuality)
        ? parsed.audioQuality
        : DEFAULT_AUDIO_QUALITY,
      echoCancellation: parsed.echoCancellation !== false,
      noiseSuppression: parsed.noiseSuppression !== false,
      autoGainControl: parsed.autoGainControl !== false,
      nativeMedia: parsed.nativeMedia !== false,
      cameraDeviceId: typeof parsed.cameraDeviceId === "string" ? parsed.cameraDeviceId : null,
      videoQuality: isVideoQualityTier(parsed.videoQuality) ? parsed.videoQuality : "auto",
      videoPreview: parsed.videoPreview === "badge" ? "badge" : "thumbnail",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const listeners = new Set<() => void>();

export function saveVoicePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
  const next = { ...loadVoicePrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the in-memory value still applies this session.
  }
  for (const listener of listeners) listener();
  return next;
}

/** For useSyncExternalStore in the Settings section. */
export function subscribeVoicePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
