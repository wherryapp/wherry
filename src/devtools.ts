// Dev-only diagnostics. Loaded from main.tsx behind import.meta.env.DEV via
// a dynamic import, so none of this exists in a production bundle.
//
// Built for the Safari crypto-freeze hunt (docs/changelog.md's known-gaps
// entry): the freeze's throw is always caught before it reaches the console,
// and Safari cannot be driven by WebDriver without an admin toggle -- so
// instead of a debugger, the page itself reports. Two instruments:
//
//   ?trace=http://localhost:9999/t   Patches SubtleCrypto.prototype so every
//                                    WebCrypto call is recorded (method +
//                                    algorithm summary) and every REJECTION
//                                    is captured with the error and both
//                                    stacks, then POSTed to the given
//                                    collector. Page errors and unhandled
//                                    rejections ride along. The buffer is
//                                    also kept at window.__cryptoTrace for
//                                    an inspector, when one is available.
//
//   ?devlogin=user:password          Signs in as a dev test account exactly
//                                    the way Login.tsx does (login, save
//                                    session, unlock the account key), then
//                                    strips the query and reloads. Dev test
//                                    credentials only -- this whole module
//                                    never ships.

import { login } from "./api/client";
import { loadSession, saveSession } from "./api/session";
import { unlockAccountKey } from "./crypto/account";

type TraceEntry = {
  at: string;
  kind: "call" | "reject" | "window-error" | "unhandled-rejection";
  detail: Record<string, unknown>;
};

const buffer: TraceEntry[] = [];
let endpoint: string | null = null;

declare global {
  interface Window {
    __cryptoTrace?: TraceEntry[];
  }
}

function record(kind: TraceEntry["kind"], detail: Record<string, unknown>): void {
  const entry: TraceEntry = { at: new Date().toISOString(), kind, detail };
  buffer.push(entry);
  if (buffer.length > 500) buffer.shift();
  // Failures also go to the console -- the exact line the freeze diagnosis
  // never had without a breakpoint.
  const post =
    kind !== "call" ||
    (typeof detail["method"] === "string" && detail["method"].startsWith("__"));
  if (kind !== "call") console.error("[crypto-trace]", kind, detail);
  if (endpoint && post) {
    // Fire-and-forget; the collector is a dev scratch server.
    void fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    }).catch(() => {});
  }
}

/** A JSON-safe one-line summary of a WebCrypto algorithm argument. */
function describeAlgorithm(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return String(value);
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry instanceof ArrayBuffer) record[key] = `ArrayBuffer(${entry.byteLength})`;
    else if (ArrayBuffer.isView(entry)) record[key] = `${entry.constructor.name}(${entry.byteLength})`;
    else if (typeof entry === "object" && entry !== null) record[key] = describeAlgorithm(entry);
    else record[key] = entry;
  }
  return record;
}

function describeArg(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return `ArrayBuffer(${value.byteLength})`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.byteLength})`;
  if (value instanceof CryptoKey) {
    return `CryptoKey(${describeAlgorithm(value.algorithm)}, extractable=${value.extractable})`;
  }
  if (typeof value === "object" && value !== null) return describeAlgorithm(value);
  return value;
}

function installCryptoTrace(target: string): void {
  endpoint = target;
  window.__cryptoTrace = buffer;

  // Prototype-level, so it covers every caller including libraries that
  // cached a reference to the subtle object itself (the way @hpke/common's
  // NativeAlgorithm._setup does) -- only a cached bound METHOD would escape,
  // and nothing in the dependency tree does that.
  const proto = SubtleCrypto.prototype as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const methods = [
    "encrypt", "decrypt", "sign", "verify", "digest",
    "generateKey", "deriveKey", "deriveBits",
    "importKey", "exportKey", "wrapKey", "unwrapKey",
  ];
  for (const name of methods) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = function (...args: unknown[]) {
      const summary = args.slice(0, 3).map(describeArg);
      record("call", { method: name, args: summary });
      const callerStack = new Error().stack ?? "";
      try {
        const result = original.apply(this, args);
        return Promise.resolve(result).catch((error: unknown) => {
          record("reject", {
            method: name,
            args: summary,
            errorName: error instanceof Error ? error.name : String(error),
            errorMessage: error instanceof Error ? error.message : "",
            errorStack: error instanceof Error ? (error.stack ?? "") : "",
            callerStack,
          });
          throw error;
        });
      } catch (error) {
        record("reject", {
          method: name,
          args: summary,
          sync: true,
          errorName: error instanceof Error ? error.name : String(error),
          errorMessage: error instanceof Error ? error.message : "",
          callerStack,
        });
        throw error;
      }
    };
  }

  window.addEventListener("error", (event) => {
    record("window-error", {
      message: event.message,
      source: `${event.filename}:${event.lineno}`,
      stack: event.error instanceof Error ? (event.error.stack ?? "") : "",
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    record("unhandled-rejection", {
      errorName: reason instanceof Error ? reason.name : String(reason),
      errorMessage: reason instanceof Error ? reason.message : "",
      stack: reason instanceof Error ? (reason.stack ?? "") : "",
    });
  });

  record("call", { method: "__trace-installed", args: [navigator.userAgent] });

  // Liveness + what the person would be seeing: an 8-second heartbeat with
  // the call count and the first line of any status banner. A frozen UI
  // whose heartbeat keeps arriving tells us the wedge is input, not JS.
  let lastCount = 0;
  setInterval(() => {
    const banner =
      document.querySelector("[class*='amber']")?.textContent ?? "";
    record("call", {
      method: "__heartbeat",
      args: [buffer.length, buffer.length - lastCount, banner.slice(0, 120)],
    });
    lastCount = buffer.length;
  }, 8_000);
}

async function maybeDevLogin(params: URLSearchParams): Promise<void> {
  const creds = params.get("devlogin");
  if (!creds || loadSession()) return;
  const colon = creds.indexOf(":");
  if (colon < 1) return;

  const username = creds.slice(0, colon);
  const password = creds.slice(colon + 1);

  try {
    // The exact Login.tsx sequence: login, save, unlock while the password
    // is in hand. A recovery-needed answer is left for the real form.
    const result = await login({
      username,
      password,
      device: { displayName: "devtools", platform: "desktop" },
    });
    saveSession(result);
    await unlockAccountKey(password);
  } catch (error) {
    record("window-error", {
      message: "devlogin failed",
      stack: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return;
  }

  // Credentials out of the URL, keeping ?trace= if present; the reload
  // boots the app signed-in, which is where the crypto under test runs.
  params.delete("devlogin");
  const query = params.size > 0 ? `?${params}` : "";
  window.location.replace(`${window.location.pathname}${query}`);
  await new Promise(() => {}); // never resolves; the navigation wins
}

/** Called from main.tsx, dev builds only, before the app renders. */
export async function installDevtools(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const trace = params.get("trace");
  if (trace) installCryptoTrace(trace);
  await maybeDevLogin(params);
}
