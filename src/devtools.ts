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
//   &devhold=<seconds>&devcycles=<n> With ?devcall: leave after <seconds>
//                                    connected, wait a beat, and place the
//                                    call again, <n> times in all -- the
//                                    join/leave soak the native media plan's
//                                    stage 2 is gated on, from a shell nobody
//                                    can tap. Without them the call is placed
//                                    once and left ringing or connected.
//
//   ?devnative=1 (or 0)              Turns the desktop shell's own media
//                                    engine on (or off) for this device before
//                                    anything places a call -- the Settings
//                                    toggle, for a shell nothing can tap.
//                                    Stored like the toggle stores it
//                                    (voice/prefs.ts), so it outlives the
//                                    URL; pass 0 to put the device back.
//   ?devprocessing=aec,ns,agc        Sets the three microphone processing
//                                    switches for this device as 0/1 in that
//                                    order (e.g. 0,1,1 turns echo cancellation
//                                    off). Settings → Voice, without a tap.
//   ?devvolume=<0..1>&devvolumeafter=<s>  With ?devcall: once connected,
//                                    waits <s> seconds (default 20) and sets
//                                    every peer's volume to the value -- the
//                                    unattended check of the native gain.
//
//   ?devcamera=canvas                Substitutes a drawn canvas for the
//                                    camera, so a session with no hands can
//                                    be a video *publisher*: the browser pane
//                                    refuses camera access exactly as it
//                                    refuses the microphone, and a real camera
//                                    is a row the maintainer runs. The pattern
//                                    is a bright block sweeping a dark field,
//                                    so the far end can tell a decode from a
//                                    black frame by mean luminance rather than
//                                    by opinion -- the stage-0 spike's own
//                                    source, kept after the spike went.
//                                    Driven by setInterval and NEVER
//                                    requestAnimationFrame: a hidden page
//                                    fires no animation frames, so the first
//                                    version of this encoded exactly one frame
//                                    and sat at bytesSent 0 forever, which
//                                    reads convincingly like a broken codec
//                                    (docs/prompts/video-plan.md §9.1).
//   &devcamerasize=WxH&devcamerafps=N
//                                    The sweep at another size and rate. The
//                                    default 640x480 at 10 fps proves a
//                                    decode; a measurement of a 720p tile
//                                    needs a source that is really 720p.
//   &devvideo=1                      With ?devcall: turn the camera on a few
//                                    seconds after the call connects.
//
//   ?devui=1                         Posts a snapshot of the call surface to
//                                    the ?trace= collector every few seconds
//                                    (kind __dev-ui): every button with its
//                                    label, disabled state, title and pressed
//                                    state, every <video> with its dimensions,
//                                    the call bar's own text, and the
//                                    native-engine preference. The desktop
//                                    shell relays no console and cannot be
//                                    inspected, so this is the only way a row
//                                    that reads the *rendering* -- "the button
//                                    is disabled, not hidden", "the tile shows
//                                    a picture" -- can be run with nobody at
//                                    the keyboard.
//   ?devclick=<a>|<b>&devclickafter=<s>
//                                    Clicks buttons by label, in order, the
//                                    first <s> seconds (default 20) after the
//                                    app renders and one every <s> after
//                                    that. A label matches an aria-label or
//                                    the button's own text, case-insensitively
//                                    and by prefix, so "Switch engine" finds
//                                    "Switch engine for this call". What it
//                                    found (or did not) goes to the collector.
//
//   VITE_DEVLOGIN / VITE_DEVCALL     The same two, from the dev server's
//   VITE_TRACE / VITE_DEVUI          environment rather than the URL, for a
//   VITE_DEVCLICK                    shell in `tauri ios dev` -- which loads
//   VITE_DEVCLICKAFTER               the dev server's root and takes no query
//                                    string. Vite inlines VITE_* at serve
//                                    time, so they are read exactly where the
//                                    URL params are. The last four were added
//                                    2026-09-08: without them the iOS
//                                    simulator is the one platform that
//                                    cannot report what it rendered, since it
//                                    can neither take a query string nor be
//                                    tapped.
//
// The voice session is also exposed as window.__voice for an inspector.

import { login } from "./api/client";
import { loadSession, saveSession } from "./api/session";
import { unlockAccountKey } from "./crypto/account";
import { loadVoicePrefs, saveVoicePrefs } from "./voice/prefs";

type TraceEntry = {
  at: string;
  kind: "call" | "reject" | "window-error" | "unhandled-rejection" | "console";
  detail: Record<string, unknown>;
};

const buffer: TraceEntry[] = [];
let endpoint: string | null = null;
// The console as it was before the trace wrapped it (see installCryptoTrace):
// record() must not feed its own mirror back into itself.
const nativeConsole = { warn: console.warn.bind(console), error: console.error.bind(console) };

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
  if (kind !== "call" && kind !== "console") nativeConsole.error("[crypto-trace]", kind, detail);
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

  // The shell relays no console at all (docs/prompts/native-media-handoff.md
  // §4), and the sync engine reports its failures with console.warn -- so
  // warnings and errors ride along to the collector too, first argument
  // and a short rendering of the rest. Dev only, like everything here.
  const mirror = (level: "warn" | "error") =>
    (...args: unknown[]): void => {
      nativeConsole[level](...args);
      if (typeof args[0] === "string" && args[0].startsWith("[")) return; // our own tags
      record("console", {
        level,
        message: args
          .map((a) => describeForConsole(a))
          .join(" ")
          .slice(0, 400),
      });
    };
  console.warn = mirror("warn");
  console.error = mirror("error");

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

function maybeDevNative(params: URLSearchParams): void {
  const value = params.get("devnative");
  if (value === null) return;
  saveVoicePrefs({ nativeMedia: value === "1" });
  params.delete("devnative");
  const query = params.size > 0 ? `?${params}` : "";
  window.history.replaceState(null, "", `${window.location.pathname}${query}`);
}

function maybeDevProcessing(params: URLSearchParams): void {
  const value = params.get("devprocessing");
  if (value === null) return;
  const [aec, ns, agc] = value.split(",");
  saveVoicePrefs({
    echoCancellation: aec !== "0",
    noiseSuppression: ns !== "0",
    autoGainControl: agc !== "0",
  });
  params.delete("devprocessing");
  const query = params.size > 0 ? `?${params}` : "";
  window.history.replaceState(null, "", `${window.location.pathname}${query}`);
}

/** The canvas source's size and rate: 640x480 at 10 fps is enough to prove
 *  a decode and cheap enough to run in a throttled tab. */
const DEV_CAMERA = { width: 640, height: 480, fps: 10 };
/** `&devcamerasize=1280x720&devcamerafps=30`: the sweep at another size, so a
 *  720p tile can be measured from a source that is really 720p. */
function devCameraSize(params: URLSearchParams): { width: number; height: number; fps: number } {
  const parts = (params.get("devcamerasize") ?? "").split("x").map(Number);
  const width = parts[0] ?? 0;
  const height = parts[1] ?? 0;
  const fps = Number(params.get("devcamerafps") ?? "");
  return {
    width: Number.isFinite(width) && width > 0 ? width : DEV_CAMERA.width,
    height: Number.isFinite(height) && height > 0 ? height : DEV_CAMERA.height,
    fps: Number.isFinite(fps) && fps > 0 ? fps : DEV_CAMERA.fps,
  };
}

/**
 * Replaces the camera with a drawn canvas for this page.
 *
 * A `captureStream` track goes through the same encoder, the same simulcast
 * layers and the same frame cryptor as a real camera, so it answers every
 * question about the *pipeline*; what it cannot answer is the camera
 * permission prompt per platform, which is a device row either way.
 *
 * `enumerateDevices` is patched alongside `getUserMedia` because the SDK
 * resolves a deviceId against the list before it asks for a track, and an
 * empty list is a picker with nothing in it.
 */
function maybeDevCamera(params: URLSearchParams): void {
  if (params.get("devcamera") !== "canvas") return;
  params.delete("devcamera");
  const query = params.size > 0 ? `?${params}` : "";
  window.history.replaceState(null, "", `${window.location.pathname}${query}`);

  const size = devCameraSize(params);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  let x = 0;
  setInterval(() => {
    if (!context) return;
    context.fillStyle = "#101018";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#f0f0ff";
    context.fillRect(x, 40, 120, canvas.height - 80);
    x = (x + 37) % (canvas.width - 120);
  }, Math.round(1000 / size.fps));

  const media = navigator.mediaDevices;
  const realGetUserMedia = media.getUserMedia.bind(media);
  const realEnumerate = media.enumerateDevices.bind(media);

  media.getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    if (!constraints?.video) return realGetUserMedia(constraints);
    const stream = (canvas as HTMLCanvasElement & {
      captureStream(fps?: number): MediaStream;
    }).captureStream(size.fps);
    if (!constraints.audio) return stream;
    // A call asking for both: give it the canvas for video and whatever
    // the browser will give for audio, rather than failing the whole ask.
    try {
      const audio = await realGetUserMedia({ audio: constraints.audio });
      for (const track of audio.getAudioTracks()) stream.addTrack(track);
    } catch {
      // Listen-only, which is what the pane gives anyway.
    }
    return stream;
  };

  // The screen, on the same terms and for the same reason: the pane cannot
  // open the system picker either, and `getDisplayMedia` needs a user
  // gesture no synthetic click satisfies. A canvas goes through the same
  // publish options, the same `contentHint` and the same frame cryptor, so
  // it answers everything about the *path*; what it cannot answer is the
  // picker and the macOS Screen Recording prompt, which are device rows.
  const realGetDisplayMedia = media.getDisplayMedia?.bind(media);
  media.getDisplayMedia = async (
    constraints?: DisplayMediaStreamOptions,
  ): Promise<MediaStream> => {
    void constraints;
    void realGetDisplayMedia;
    return (canvas as HTMLCanvasElement & {
      captureStream(fps?: number): MediaStream;
    }).captureStream(size.fps);
  };

  media.enumerateDevices = async (): Promise<MediaDeviceInfo[]> => {
    const devices = await realEnumerate();
    if (devices.some((device) => device.kind === "videoinput")) return devices;
    return [
      ...devices,
      {
        deviceId: "devcamera",
        kind: "videoinput",
        label: "Canvas camera (devtools)",
        groupId: "devcamera",
        toJSON: () => ({}),
      } as MediaDeviceInfo,
    ];
  };
  console.error("[devcamera] canvas source installed");
}

/**
 * The call surface as it is actually rendered, for the collector.
 *
 * Everything here is a *rendering* question that no state dump answers:
 * whether a control is disabled rather than absent, what its title says,
 * whether a tile is showing a picture or a placeholder. The desktop shell
 * relays no console and takes no inspector, so without this a row like D-28
 * ("disabled, not hidden, with the reason and a way out") can only be run
 * with a hand on the window.
 *
 * Labels come from `aria-label` first because kit's IconButton puts the
 * words there and an icon in the button; text is the fallback for the
 * ordinary ones.
 */
function snapshotCallUi(): Record<string, unknown> {
  const buttons = Array.from(document.querySelectorAll("button"))
    .map((button) => ({
      label: button.getAttribute("aria-label") ?? button.textContent?.trim().slice(0, 60) ?? "",
      disabled: button.disabled,
      title: button.getAttribute("title"),
      pressed: button.getAttribute("aria-pressed"),
    }))
    .filter((entry) => entry.label !== "");
  const videos = Array.from(document.querySelectorAll("video")).map((video) => ({
    width: video.videoWidth,
    height: video.videoHeight,
    paused: video.paused,
    source: video.srcObject === null ? null : "stream",
  }));
  // The bar is the one region whose sentences are the reading (the reason
  // line beside the switch); its own element carries no test hook, so it is
  // found by the class the call bar alone paints itself with.
  const bar = document.querySelector("[class*='bg-accent-50']");
  return {
    buttons,
    videos,
    bar: bar?.textContent?.trim().slice(0, 400) ?? null,
    nativeMedia: loadVoicePrefs().nativeMedia,
  };
}

function maybeDevUi(params: URLSearchParams): void {
  if (params.get("devui") !== "1" && devEnv("VITE_DEVUI") !== "1") return;
  setInterval(() => {
    record("call", { method: "__dev-ui", args: [snapshotCallUi()] });
  }, DEV_UI_INTERVAL_MS);
}

/**
 * Press buttons by label, in order, on a timer.
 *
 * Prefix and case-insensitive on purpose: a row is written against the
 * words a person would read ("Switch engine"), not against the exact string
 * a component happens to render, and a label that has drifted should fail
 * the row loudly rather than silently match nothing.
 */
function maybeDevClick(params: URLSearchParams): void {
  const raw = params.get("devclick") ?? devEnv("VITE_DEVCLICK");
  if (!raw) return;
  const labels = raw.split("|").map((label) => label.trim()).filter((label) => label !== "");
  if (labels.length === 0) return;
  const everyMs =
    Math.max(1, Number(params.get("devclickafter") ?? devEnv("VITE_DEVCLICKAFTER") ?? "20")) * 1_000;

  const press = (label: string, deadline: number): void => {
    const wanted = label.toLowerCase();
    const button = Array.from(document.querySelectorAll("button")).find((candidate) => {
      const aria = candidate.getAttribute("aria-label")?.toLowerCase() ?? "";
      const text = candidate.textContent?.trim().toLowerCase() ?? "";
      return aria.startsWith(wanted) || text.startsWith(wanted);
    });
    if (!button) {
      // Not there *yet* is the common case, not a drifted label: a control
      // that appears once a reconnect finishes is exactly what the row after
      // an engine switch waits on. Retry to the deadline, then say so.
      if (Date.now() < deadline) {
        setTimeout(() => press(label, deadline), DEV_CLICK_RETRY_MS);
        return;
      }
      console.error(`[devclick] no button matching ${JSON.stringify(label)}`);
      record("call", { method: "__dev-click", args: [{ label, found: false }] });
      return;
    }
    const disabled = button.disabled;
    button.click();
    console.error(`[devclick] pressed ${JSON.stringify(label)}${disabled ? " (disabled)" : ""}`);
    record("call", { method: "__dev-click", args: [{ label, found: true, disabled }] });
  };

  labels.forEach((label, index) => {
    setTimeout(() => press(label, Date.now() + DEV_CLICK_WAIT_MS), everyMs * (index + 1));
  });
}

/**
 * `?devscreen=1` (or `VITE_DEVSCREEN=1`): what this engine actually does
 * with `getDisplayMedia`, reported to the collector.
 *
 * Written for the wry display-capture spike, where two different stories
 * were on record and only one can be true: that WebKit *rejects* the
 * promise because wry's UI delegate does not answer the screen selector,
 * or that `getDisplayMedia` is not exposed in a WKWebView at all. The
 * first is fixable with one delegate method; the second is not fixable
 * from wry, and shipping a fork on the strength of the wrong one is
 * exactly what the patch file refused to do. `typeof` settles it before
 * anything is called.
 *
 * Note this deliberately does NOT go through `?devcamera=canvas`, which
 * substitutes `getDisplayMedia` -- running both would measure the stand-in.
 */
function maybeDevScreen(params: URLSearchParams): void {
  if (params.get("devscreen") !== "1" && devEnv("VITE_DEVSCREEN") !== "1") return;
  setTimeout(() => {
    const media = navigator.mediaDevices as MediaDevices | undefined;
    const kind = typeof media?.getDisplayMedia;
    record("call", { method: "__dev-screen", args: [{ stage: "typeof", getDisplayMedia: kind }] });
    if (kind !== "function") return;
    void media!
      .getDisplayMedia({ video: true })
      .then((stream) => {
        const track = stream.getVideoTracks()[0];
        record("call", {
          method: "__dev-screen",
          args: [{ stage: "resolved", label: track?.label ?? null, settings: track?.getSettings() ?? null }],
        });
        for (const t of stream.getTracks()) t.stop();
      })
      .catch((error: unknown) => {
        const e = error as { name?: string; message?: string };
        record("call", {
          method: "__dev-screen",
          args: [{ stage: "rejected", name: e?.name ?? null, message: e?.message ?? String(error) }],
        });
      });
  }, DEV_SCREEN_DELAY_MS);
}

function maybeDevCall(params: URLSearchParams): void {
  const conversationId = params.get("devcall") ?? devEnv("VITE_DEVCALL");
  if (!conversationId) return;
  const holdMs = Number(params.get("devhold") ?? "0") * 1000;
  const cycles = Math.max(1, Number(params.get("devcycles") ?? "1"));
  const volume = params.has("devvolume") ? Number(params.get("devvolume")) : null;
  const volumeAfterMs = Number(params.get("devvolumeafter") ?? "20") * 1000;
  const video = params.get("devvideo") === "1";
  if (params.has("devcall")) {
    // Out of the URL before anything can copy it: a reload must not place
    // a second call.
    for (const key of ["devcall", "devhold", "devcycles", "devvolume", "devvolumeafter", "devvideo"]) params.delete(key);
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
      if (video) {
        // After the connect, not with it: the camera is an explicit act
        // every time (the plan's "camera-on at join: never"), and this is
        // that act with nobody at the keyboard.
        setTimeout(() => {
          void voice.setCameraEnabled(true).then(() => {
            console.error("[devvideo] camera on");
          });
        }, DEV_VIDEO_DELAY_MS);
      }
      if (volume !== null && Number.isFinite(volume)) {
        // The native gain check: turn every peer down after the baseline
        // window, and say so where the collector can see it.
        setTimeout(() => {
          for (const p of voice.getState().participants) voice.setVolume(p.userId, volume);
          console.error(`[voice-volume] set ${volume} for ${voice.getState().participants.length} peer(s)`);
          record("call", { method: "__voice-volume", args: [volume] });
        }, volumeAfterMs);
      }
      if (holdMs > 0) {
        let placed = 1;
        const cycle = (): void => {
          setTimeout(() => {
            void voice.leave().then(() => {
              console.error(`[voice-cycle] left after cycle ${placed} of ${cycles}`);
              if (placed >= cycles) return;
              placed += 1;
              setTimeout(() => {
                void voice.startCall({ id: conversationId, hubVisibility: null });
                cycle();
              }, 3_000);
            });
          }, holdMs);
        };
        cycle();
      }
      // The same reading the bar's "Details" shows, to the console every
      // few seconds while connected. console.error rather than log on
      // purpose: `tauri ios dev` relays the webview's errors into its own
      // terminal, which is the only readout a simulator without a panel
      // has.
      setInterval(() => {
        void voice.sampleDiagnostics().then((sample) => {
          if (!sample) return;
          console.error("[voice-diag]", JSON.stringify(sample));
          // And to the ?trace= collector when one is armed: the desktop
          // shell relays no console at all, and this is the only readout a
          // call placed in it has.
          record("call", { method: "__voice-diag", args: [sample] });
        });
      }, DEV_DIAG_INTERVAL_MS);
    });
  };
  setTimeout(place, DEV_CALL_DELAY_MS);
}

const DEV_DIAG_INTERVAL_MS = 3_000;
/** How often ?devui posts the rendered call surface. */
const DEV_UI_INTERVAL_MS = 3_000;
/** ?devscreen: long enough for the app to have rendered and settled. */
const DEV_SCREEN_DELAY_MS = 12_000;
/** ?devclick: how long to keep looking for a label, and how often. */
const DEV_CLICK_WAIT_MS = 120_000;
const DEV_CLICK_RETRY_MS = 1_000;
/** How long after the call is placed ?devvideo turns the camera on. */
const DEV_VIDEO_DELAY_MS = 6_000;

/**
 * Called from main.tsx, dev builds only, before the app renders. `restore`
 * is the shells' keychain restore, run here -- after the trace is armed,
 * before anything reads the session -- so the auto-login does not sign in
 * a second device over one the keychain still holds.
 */
export async function installDevtools(restore: (() => Promise<void>) | null): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const trace = params.get("trace") ?? devEnv("VITE_TRACE");
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
  maybeDevNative(params);
  maybeDevProcessing(params);
  // Before the call: the substitution has to be in place when the SDK
  // first asks for a track.
  maybeDevCamera(params);
  maybeDevCall(params);
  maybeDevUi(params);
  maybeDevClick(params);
  maybeDevScreen(params);
}

/** One console argument as a line: errors by name, message and any code. */
function describeForConsole(value: unknown): string {
  if (value instanceof Error) {
    const extra = Object.entries(value as unknown as Record<string, unknown>)
      .filter(([k, v]) => k !== "stack" && (typeof v === "string" || typeof v === "number"))
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    return `${value.name || "Error"}: ${value.message}${extra ? ` [${extra}]` : ""}`;
  }
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
    let body = "";
    try {
      body = JSON.stringify(value)?.slice(0, 200) ?? "";
    } catch {
      body = "";
    }
    return `${ctor} ${body} ${String(value)}`.trim();
  }
  return String(value);
}
