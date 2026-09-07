// Pure decisions the transports share or that the native transport makes
// on the shell's behalf -- kept here, tested, and out of Rust on purpose
// (docs/prompts/native-media-plan.md §0.4: policy in TypeScript, mechanism
// in Rust). Nothing here imports a media SDK or the Tauri API.

import type { TransportConnectionState, VoiceQuality } from "./transport";

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
 * What a listener's volume for somebody means natively. The Rust SDK has
 * no per-track gain (the plan's §3.1), only enabled-or-not at the WebRTC
 * track level, so anything above silence plays at full volume until an
 * upstream gain exists. Zero is the one value that must mean what it says.
 */
export function playbackEnabledFor(volume: number): boolean {
  return volume > 0;
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
  if (id === null) return null;
  return devices.some((device) => device.deviceId === id) ? id : null;
}
