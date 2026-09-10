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

import { nativeMediaSelected } from "./native-media";
import type { VoiceTransport } from "./transport";
import { NativeTransport } from "./transport-native";
import { WebviewTransport } from "./transport-webview";

/**
 * `override` is the per-call engine switch (docs/prompts/video-execution-
 * handoff.md §0): a desktop shell on the native engine cannot publish or
 * render video in v1, so the call bar offers to rejoin this one call
 * through the webview. It beats the preference for that call only and is
 * cleared on teardown -- the `nativeMedia` preference itself is never
 * touched, because the person did not change their mind about audio.
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
 * 2026-09-10: Windows renders a received tile natively and still has no
 * camera capture (stage W3), so the camera button is the switch while the
 * screen button shares in place. A phone webview that cannot share a
 * screen has nothing to switch *to*, and offering it a switch would be a
 * dead control. Nothing else may ask which implementation it got.
 */
export function transportIsNative(override?: "webview" | null): boolean {
  if (override === "webview") return false;
  return nativeMediaSelected();
}

export type { VoiceTransport } from "./transport";
