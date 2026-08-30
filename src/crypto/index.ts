// The provider the rest of the client uses.
//
// One module owns the choice, the same way `store/index.ts` owns which
// `MessageStore` implementation is live. Nothing else constructs a provider
// directly.
//
// MLS is the default -- this line flipping was the cutover's client half
// (2026-08-30). `VITE_E2E=passthrough` still selects the old provider, as a
// dev instrument only: a passthrough build cannot send against a v2 server
// (no epoch, no archive payloads), so what it is for is reading code paths
// and the occasional experiment, not talking to anything real.

import { MlsE2EProvider } from "./mls";
import { PassthroughE2EProvider } from "./passthrough";
import type { E2EProvider } from "./provider";

export const e2e: E2EProvider =
  import.meta.env.VITE_E2E === "passthrough"
    ? new PassthroughE2EProvider()
    : new MlsE2EProvider();

export * from "./provider";
export { PassthroughE2EProvider } from "./passthrough";
