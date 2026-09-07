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

export function createTransport(): VoiceTransport {
  return nativeMediaSelected() ? new NativeTransport() : new WebviewTransport();
}

export type { VoiceTransport } from "./transport";
