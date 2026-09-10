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
// prefs.ts). It shipped dark and has been **on by default since
// 2026-09-07 evening**, once the cryptor-thread leak and the hidden-page
// stall both closed; a device that unticks the box in Settings keeps that
// choice. The web and the phones have no shell and are untouched either
// way.

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
  /** The shell does *all* of video natively — camera, screen and render.
   *  macOS since 2026-09-08; no other platform, since Windows has no
   *  camera capture. Absent from an older shell, which reads as false. */
  video?: boolean;
  /** The shell can capture a screen or window through a picker of its own
   *  (macOS, and Windows since 2026-09-09; stage W1). Split from `video`
   *  because Windows came apart: it captured a screen months before it
   *  could draw a received tile, and it still has no camera. */
  screenCapture?: boolean;
  /** The shell can draw received tiles natively: macOS since 2026-09-08
   *  (stage 3N), Windows since 2026-09-10 (stage W3, a child HWND over
   *  WebView2). True on Windows while `video` stays false — the mixed
   *  answer `rules.ts`'s `nativeEngine` exists to tell from a phone. */
  videoRender?: boolean;
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

/**
 * The engine is here *and* it does video end to end — a camera it can open
 * and a tile it can draw.
 *
 * Deliberately still the undivided `video` field: both callers are about
 * the **camera** (the device list, and the settings preview), and Windows
 * capturing a screen says nothing about either. `capabilities()` in
 * transport-native.ts is where the three answers come apart.
 */
export function nativeVideoAvailable(): boolean {
  return probe?.available === true && probe.video === true;
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
