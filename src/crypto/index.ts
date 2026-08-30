// The provider the rest of the client uses.
//
// One module owns the choice, the same way `store/index.ts` owns which
// `MessageStore` implementation is live. Nothing else constructs a provider
// directly -- switching v1 to MLS is a change to this file and the sync
// engine call sites, not a redesign of either.

import { PassthroughE2EProvider } from "./passthrough";
import type { E2EProvider } from "./provider";

export const e2e: E2EProvider = new PassthroughE2EProvider();

export * from "./provider";
export { PassthroughE2EProvider } from "./passthrough";
