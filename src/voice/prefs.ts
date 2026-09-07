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
   * Run calls through the shell's own media engine rather than the
   * webview (docs/prompts/native-media-plan.md §5). Off by default: the
   * native transport ships dark and is turned on per device. Honoured only
   * where the engine exists (native-media.ts's probe); elsewhere the value
   * is stored and ignored. Read at join, so it applies to the next call.
   */
  nativeMedia: boolean;
};

const DEFAULTS: VoicePrefs = {
  joinMute: "auto",
  ringtone: true,
  micDeviceId: null,
  speakerDeviceId: null,
  audioQuality: DEFAULT_AUDIO_QUALITY,
  nativeMedia: false,
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
      nativeMedia: parsed.nativeMedia === true,
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
