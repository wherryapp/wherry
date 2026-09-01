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

import { recordCall } from "../diagnostics";
import { MlsE2EProvider } from "./mls";
import { PassthroughE2EProvider } from "./passthrough";
import type { E2EProvider } from "./provider";

/**
 * Times every provider call and reports the slow ones to diagnostics.ts.
 *
 * Here because this module is the seam rule 7 already guarantees: nothing
 * constructs a provider directly, so wrapping the one that is chosen covers
 * every crypto call in the app without a single call site changing. That is
 * the same property the interface was created for, being spent on a
 * question it was not designed for and answers anyway.
 *
 * A Proxy rather than a hand-written decorator so the wrapper cannot drift
 * from the interface -- a method added to E2EProvider later is timed
 * without anyone remembering to come back here. `handshake` is wrapped in
 * turn because the expensive operations live on it (key package
 * generation, commits), and `undefined` for it is load-bearing: the engine
 * reads `e2e.handshake === undefined` to know this build has no groups.
 *
 * The overhead is one Date.now() pair per call against operations already
 * measured in milliseconds, and nothing is written unless a call is slow.
 */
function timed<T extends object>(target: T, prefix: string): T {
  return new Proxy(target, {
    get(obj, prop) {
      // Receiver deliberately defaults to the target rather than the proxy:
      // a getter reading a `#private` field throws outright when `this` is a
      // proxy, and instrumentation must never be able to break the thing it
      // instruments.
      const value: unknown = Reflect.get(obj, prop);
      if (typeof value !== "function") return value;
      const label = `${prefix}${String(prop)}`;
      return (...args: unknown[]): unknown => {
        const startedAt = Date.now();
        // Bound to the target, not the proxy: these classes read private
        // fields, and a proxy receiver breaks `#private` access outright.
        const out: unknown = (value as (...a: unknown[]) => unknown).apply(
          obj,
          args,
        );
        if (out instanceof Promise) {
          return out.finally(() => {
            recordCall(label, Date.now() - startedAt);
          });
        }
        recordCall(label, Date.now() - startedAt);
        return out;
      };
    },
  });
}

function instrument(provider: E2EProvider): E2EProvider {
  const wrapped = timed(provider, "e2e.");
  if (!provider.handshake) return wrapped;
  // `handshake` is a getter on the provider, so the outer proxy hands back
  // the raw object; wrap it explicitly and keep the rest of the surface.
  return new Proxy(wrapped, {
    get(obj, prop) {
      if (prop === "handshake") {
        return handshakeProxy;
      }
      return Reflect.get(obj, prop) as unknown;
    },
  });
}

const base: E2EProvider =
  import.meta.env.VITE_E2E === "passthrough"
    ? new PassthroughE2EProvider()
    : new MlsE2EProvider();

const handshakeProxy = base.handshake
  ? timed(base.handshake, "handshake.")
  : undefined;

export const e2e: E2EProvider = instrument(base);

export * from "./provider";
export { PassthroughE2EProvider } from "./passthrough";
