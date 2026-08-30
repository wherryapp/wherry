// The provider the rest of the client uses.
//
// One module owns the choice, the same way `store/index.ts` owns which
// `MessageStore` implementation is live. Nothing else constructs a provider
// directly.
//
// The choice is build-time: `VITE_E2E=mls pnpm dev` runs the real MLS
// provider, anything else runs the passthrough. Default passthrough,
// deliberately -- production stays v1 until the cutover ships with the wipe,
// while dev exercises MLS end to end. Flipping the default IS the cutover's
// client half.

import { MlsE2EProvider } from "./mls";
import { PassthroughE2EProvider } from "./passthrough";
import type { E2EProvider } from "./provider";

export const e2e: E2EProvider =
  import.meta.env.VITE_E2E === "mls"
    ? new MlsE2EProvider()
    : new PassthroughE2EProvider();

export * from "./provider";
export { PassthroughE2EProvider } from "./passthrough";
