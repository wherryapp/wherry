// Which media transport this build uses -- the one place that decides,
// the way `crypto/index.ts` picks the E2E provider and `db/client.ts`
// owns the pool. Today there is one implementation, the webview's; the
// native desktop transport (docs/prompts/native-media-plan.md §5) lands
// here as a second arm gated on `isTauriShell()` and a local flag, and
// nothing outside this file will need to change for it.

import type { VoiceTransport } from "./transport";
import { WebviewTransport } from "./transport-webview";

export function createTransport(): VoiceTransport {
  return new WebviewTransport();
}

export type { VoiceTransport } from "./transport";
