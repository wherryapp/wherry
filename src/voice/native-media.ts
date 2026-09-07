// Whether this build can run calls through the shell's own media engine
// (docs/prompts/native-media-plan.md §5), and whether this device has
// chosen to.
//
// Feature detection, not platform sniffing: the shell's `voice_probe`
// command exists exactly in the desktop Tauri shell, where the `livekit`
// crate is compiled in (src-tauri/src/voice.rs). On the web there is no
// shell and the probe resolves false without a round trip; on the phones
// the shell exists but the command does not, and the invoke rejects. Asked
// once at startup (main.tsx) and cached, because `createTransport` and the
// Settings toggle both need a synchronous answer.
//
// The choice itself is a device-local preference (`nativeMedia` in
// prefs.ts), off by default: the transport ships dark, exercised per device
// by whoever turns it on, the way the plan says.

import { isTauriShell } from "../api/shell";
import { loadVoicePrefs } from "./prefs";

export type NativeMediaProbe = {
  available: boolean;
  /** The SDK revision the shell carries, for the details readout. */
  livekitRev?: string;
  recordingDevices?: number;
  playoutDevices?: number;
  /** Which echo canceller, gain control and noise suppressor are active. */
  aec?: string;
  agc?: string;
  ns?: string;
};

let probe: NativeMediaProbe | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** True once the probe has answered yes; false before it answers. */
export function nativeMediaAvailable(): boolean {
  return probe?.available === true;
}

export function nativeMediaProbe(): NativeMediaProbe | null {
  return probe;
}

export async function probeNativeMedia(): Promise<boolean> {
  if (probe) return probe.available;
  if (!isTauriShell()) {
    probe = { available: false };
    notify();
    return false;
  }
  try {
    const core = await import("@tauri-apps/api/core");
    const answer = await core.invoke<Omit<NativeMediaProbe, "available">>("voice_probe");
    probe = { ...answer, available: true };
  } catch {
    probe = { available: false };
  }
  notify();
  return probe.available;
}

/** For useSyncExternalStore. */
export function subscribeNativeMedia(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The one predicate `index.ts` and `devices.ts` ask: the engine is here,
 * and this device turned it on.
 */
export function nativeMediaSelected(): boolean {
  return nativeMediaAvailable() && loadVoicePrefs().nativeMedia;
}
