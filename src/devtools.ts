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
//
//   ?devcall=<conversationId>        Starts a call in that conversation a few
//                                    seconds after the app renders, exactly
//                                    as the header's call button would, then
//                                    strips itself from the URL. For engines
//                                    nothing can tap: the iOS simulator's
//                                    Safari or a shell driven by simctl alone,
//                                    where the voice pipeline (mic capture,
//                                    frame encryption) needs exercising with
//                                    no finger on the glass.
//
//   VITE_DEVLOGIN / VITE_DEVCALL     The same two, from the dev server's
//                                    environment rather than the URL, for a
//                                    shell in `tauri ios dev` -- which loads
//                                    the dev server's root and takes no query
//                                    string. Vite inlines VITE_* at serve
//                                    time, so they are read exactly where the
//                                    URL params are.
//
// The voice session is also exposed as window.__voice for an inspector.

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
    /** The voice session singleton, for an inspector; dev only. */
    __voice?: unknown;
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

/** A VITE_* value, or null: Vite inlines them as strings, absent as undefined. */
function devEnv(name: string): string | null {
  const value: unknown = import.meta.env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function maybeDevLogin(params: URLSearchParams): Promise<void> {
  const creds = params.get("devlogin") ?? devEnv("VITE_DEVLOGIN");
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

/**
 * Before the auto-call fires: the engine's first pass, and the external
 * join a fresh device may need. session.ts then waits up to 20 s more for
 * the call key itself, so this only needs to clear the app's own boot.
 */
const DEV_CALL_DELAY_MS = 4_000;

/** How long the auto-call waits for a session to appear before giving up. */
const DEV_CALL_SESSION_WAIT_MS = 30_000;

function maybeDevCall(params: URLSearchParams): void {
  const conversationId = params.get("devcall") ?? devEnv("VITE_DEVCALL");
  if (!conversationId) return;
  if (params.has("devcall")) {
    // Out of the URL before anything can copy it: a reload must not place
    // a second call.
    params.delete("devcall");
    const query = params.size > 0 ? `?${params}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${query}`);
  }
  const deadline = Date.now() + DEV_CALL_SESSION_WAIT_MS;
  const place = (): void => {
    // Signed out, or a shell whose session is still on its way back from
    // the keychain: try again shortly rather than never.
    if (!loadSession()) {
      if (Date.now() < deadline) setTimeout(place, 500);
      return;
    }
    void import("./voice/session").then(({ voice }) => {
      // Sealed (a DM, a group, a private-hub channel): the call is
      // frame-encrypted, which is the path worth exercising. A public
      // room's plain relay is not what this instrument is for.
      void voice.startCall({ id: conversationId, hubVisibility: null });
      // The same reading the bar's "Details" shows, to the console every
      // few seconds while connected. console.error rather than log on
      // purpose: `tauri ios dev` relays the webview's errors into its own
      // terminal, which is the only readout a simulator without a panel
      // has.
      setInterval(() => {
        void voice.sampleDiagnostics().then((sample) => {
          if (sample) console.error("[voice-diag]", JSON.stringify(sample));
        });
      }, DEV_DIAG_INTERVAL_MS);
    });
  };
  setTimeout(place, DEV_CALL_DELAY_MS);
}

const DEV_DIAG_INTERVAL_MS = 3_000;

/**
 * Called from main.tsx, dev builds only, before the app renders. `restore`
 * is the shells' keychain restore, run here -- after the trace is armed,
 * before anything reads the session -- so the auto-login does not sign in
 * a second device over one the keychain still holds.
 */
export async function installDevtools(restore: (() => Promise<void>) | null): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const trace = params.get("trace");
  if (trace) installCryptoTrace(trace);
  if (restore) {
    try {
      await restore();
    } catch {
      // As main.tsx: a broken keychain reads as "storage really is empty".
    }
  }
  await maybeDevLogin(params);
  void import("./voice/session").then(({ voice }) => {
    window.__voice = voice;
  });
  maybeDevCall(params);
}
