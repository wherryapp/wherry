// Which media transport this build uses -- the one place that decides,
// the way `crypto/index.ts` picks the E2E provider and `db/client.ts`
// owns the pool. Two implementations since 2026-09-07: the webview's
// (livekit-client, every platform) and the desktop shell's own media
// engine (`transport-native.ts` over src-tauri/src/voice.rs), chosen when
// the shell has it *and* this device turned it on in Settings → Voice.
// Both compile into every build; the native one is unreachable on the web
// (no shell) and on the phones (no command), by feature detection rather
// than by platform name -- see native-media.ts. Nothing outside this file
// asks which one it got.

import { nativeMediaSelected, probeNativeMedia } from "./native-media";
import type { OrphanedTransport, VoiceTransport } from "./transport";
import { findNativeOrphan, NativeTransport } from "./transport-native";
import { WebviewTransport } from "./transport-webview";

/**
 * `override` is the per-call engine switch (docs/prompts/video-execution-
 * handoff.md §0). It began when the native engine could do no video at
 * all; since stage 3N on macOS and W4 on Windows it captures and renders
 * everything there, so what still takes the switch is a shell whose probe
 * says it cannot -- Linux, which does no video natively, or an installed
 * Windows shell built between W3 and W4, which has no camera. For such a
 * source, its button rejoins this one call through the webview. It
 * beats the preference for that call only and is cleared on teardown --
 * the `nativeMedia` preference itself is never touched, because the person
 * did not change their mind about audio.
 */
export function createTransport(override?: "webview" | null): VoiceTransport {
  return transportIsNative(override) ? new NativeTransport() : new WebviewTransport();
}

/**
 * The same decision, asked rather than taken — so `switchEngineForThisCall`
 * has a way to know it has somewhere to go.
 *
 * The session needs this because "this transport cannot open a camera" and
 * "there is another engine that can" stopped being the same sentence on
 * 2026-09-10: a Windows shell from stage W3 renders a received tile
 * natively with no camera capture (W4 added it, and an installed W3 shell
 * still answers this way), so the camera button is the switch while the
 * screen button shares in place. A phone webview that cannot share a
 * screen has nothing to switch *to*, and offering it a switch would be a
 * dead control. Nothing else may ask which implementation it got.
 */
export function transportIsNative(override?: "webview" | null): boolean {
  if (override === "webview") return false;
  return nativeMediaSelected();
}

/**
 * A call already running when this page loaded, or null.
 *
 * Only the shell's engine can have one -- its room lives in the shell
 * process and survives a page reload, where the webview's dies with the
 * document -- so this asks the shell whatever `nativeMedia` says now: a call
 * that is running is running, whichever engine this page would pick next.
 */
export async function findOrphanedCall(): Promise<OrphanedTransport | null> {
  if (!(await probeNativeMedia())) return null;
  return findNativeOrphan();
}

export type { VoiceTransport } from "./transport";
