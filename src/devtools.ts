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
//   ?devspeaker=<deviceId>           Chooses a playout device for this
//   &devmic=<deviceId>               device, and a capture device, exactly as
//                                    the two Settings → Voice pickers do.
//                                    Added 2026-09-11 for row D-55: the
//                                    second-call defect only bites a device
//                                    that has *chosen* one, because the shell
//                                    calls neither switch_ function while the
//                                    preference is the platform default -- so
//                                    an unattended leave-and-rejoin soak
//                                    could not reach it at all. `default` is
//                                    a real id on the native engine and not
//                                    the same as leaving it unset.
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
//   ?devtone=<hz>                    Substitutes a sine at <hz> for the
//                                    microphone, the way ?devcamera=canvas
//                                    substitutes the camera: the dev Mac has
//                                    no microphone, and every background row
//                                    of the phone-calls plan reads whether a
//                                    *known* tone still reaches the far end
//                                    (phone-calls-plan.md §12: the peer runs
//                                    440, the phone 660). Webview engine
//                                    only -- the native engine never calls
//                                    getUserMedia. The tone comes from an
//                                    AudioContext, which a page without a
//                                    user gesture may be handed suspended;
//                                    the state is logged, and
//                                    window.__devtone.resume() is there for
//                                    a CDP Runtime.evaluate with
//                                    userGesture: true.
//   ?devring=<json>                  Calls the phone shells' debug-only
//   &devringafter=<s>                `debugIncoming` command <s> seconds
//                                    (default 5) after boot, with the JSON
//                                    as its plaintext ring payload
//                                    (phone-calls-plan.md §4.2) -- how the
//                                    iOS simulator is rung with nobody to
//                                    tap. An absent "exp" is filled in as
//                                    now + 45 s, so a payload kept in an
//                                    environment variable does not arrive
//                                    already expired. Outside a shell, or
//                                    before the wherry-calls plugin exists,
//                                    it logs why and does nothing.
//
//   Both are dev-server only, like everything here: `pnpm tauri android
//   dev`, `pnpm tauri ios dev` and the browser pane, never an installed
//   build, debug APKs and IPAs included. Installed debug builds inject
//   through the plugin's debug-only native paths instead (§12).
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
//   ?devsteps=<step>;<step>;…        A scripted sequence against the rendered
//                                    page (click, key, wait, and the readings
//                                    rows W-58, W-103 and D-66 name), for the
//                                    macOS shell, which no DevTools protocol
//                                    can drive. See maybeDevSteps. A `+` in a
//                                    key chord must be written %2B.
//   ?devnomic=1                      The native transport answers the
//                                    join's microphone (startMicrophone,
//                                    muted or not) and every later unmute
//                                    with `no_microphone` without asking the
//                                    shell: a listen-only call that never
//                                    opens the device (for a machine whose
//                                    consent prompt nobody can answer).
//
//   VITE_DEVLOGIN / VITE_DEVCALL     The same two, from the dev server's
//   VITE_TRACE / VITE_DEVUI          environment rather than the URL, for a
//   VITE_DEVCLICK                    shell in `tauri ios dev` -- which loads
//   VITE_DEVCLICKAFTER               the dev server's root and takes no query
//   VITE_DEVTONE / VITE_DEVRING      string. Vite inlines VITE_* at serve
//                                    time, so they are read exactly where the
//                                    URL params are. VITE_TRACE to
//                                    VITE_DEVCLICKAFTER were added 2026-09-08:
//                                    without them the iOS simulator is the
//                                    one platform that cannot report what it
//                                    rendered, since it can neither take a
//                                    query string nor be tapped. The tone and
//                                    the ring followed on 2026-09-27 for the
//                                    same reason (phone-calls-plan.md §5.3).
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

/**
 * `?devspeaker=` / `?devmic=`: the two device pickers, without a tap.
 *
 * Row D-55 is the reason this exists. The second call in a process failed on
 * Windows with `set_playout_device: DeviceNotFound`, and only for somebody
 * who had chosen a device -- the `None` arms in `voice/mod.rs` leave the
 * platform default alone and call nothing. An unattended soak that never
 * chooses one therefore exercises the *other* branch however many times it
 * cycles, which is exactly why every pass before 2026-09-10 walked past the
 * defect. The ids are the shell's own (`voice_audio_devices`), which on
 * macOS are Core Audio device ids as strings and on Windows the 55-character
 * endpoint guids.
 */
function maybeDevDevices(params: URLSearchParams): void {
  const speaker = params.get("devspeaker");
  const mic = params.get("devmic");
  if (speaker === null && mic === null) return;
  const prefs = loadVoicePrefs();
  saveVoicePrefs({
    ...prefs,
    speakerDeviceId: speaker ?? prefs.speakerDeviceId,
    micDeviceId: mic ?? prefs.micDeviceId,
  });
  console.error(`[devdevices] speaker=${speaker ?? "unchanged"} mic=${mic ?? "unchanged"}`);
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

/** `?devtone=`'s accepted range: audible, and inside Opus's band. */
const DEV_TONE_MIN_HZ = 20;
const DEV_TONE_MAX_HZ = 20_000;
/** Loud enough to read clearly above the floor, well short of clipping. */
const DEV_TONE_GAIN = 0.2;

declare global {
  interface Window {
    /** ?devtone's generator, for an inspector: its context and a resume()
     *  a CDP `Runtime.evaluate` with `userGesture: true` can call. */
    __devtone?: { hz: number; context: AudioContext; resume(): Promise<string> };
  }
}

/**
 * `?devtone=<hz>` (or `VITE_DEVTONE`): the microphone becomes a sine.
 *
 * The phone rows read whether a *known* sound still reaches the far end once
 * the app is backgrounded, and the dev Mac has no microphone to make one.
 * An `OscillatorNode` into a `MediaStreamAudioDestinationNode` gives a real
 * `MediaStreamTrack`, so it goes through the same publish options, encoder
 * and frame cryptor a microphone would; what it cannot answer is the
 * microphone permission prompt, which is a device row either way.
 *
 * It wraps whatever `getUserMedia` is current, so it composes with
 * `?devcamera=canvas` in either order: a request for audio and video asks
 * the inner function for the video alone and adds the tone.
 *
 * One oscillator for the life of the page, and every request gets a clone of
 * its track: the SDK stops the track it was given on unpublish, and a
 * stopped clone must not silence the next call's.
 *
 * The context is the one fragile part. A page with no user gesture yet may
 * be handed a suspended `AudioContext`, and a suspended context produces
 * silence that reads exactly like a background-suspended page -- the very
 * thing the rows measure. So its state is logged at every request and on
 * every change, it is resumed at every request and at the first touch or
 * key, and `window.__devtone.resume()` is exposed for CDP.
 */
function maybeDevTone(params: URLSearchParams): void {
  const raw = params.get("devtone") ?? devEnv("VITE_DEVTONE");
  if (raw === null) return;
  const hz = Number(raw);
  if (!Number.isFinite(hz) || hz < DEV_TONE_MIN_HZ || hz > DEV_TONE_MAX_HZ) {
    console.error(`[devtone] ignored: ${JSON.stringify(raw)} is not a frequency in Hz`);
    return;
  }
  if (params.has("devtone")) {
    params.delete("devtone");
    const query = params.size > 0 ? `?${params}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${query}`);
  }

  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!media || typeof media.getUserMedia !== "function") {
    console.error("[devtone] no getUserMedia to substitute");
    return;
  }

  let generator: { context: AudioContext; track: MediaStreamTrack } | null = null;
  const resume = async (): Promise<string> => {
    if (!generator) return "not-started";
    if (generator.context.state !== "running") {
      try {
        await generator.context.resume();
      } catch {
        // Still suspended; the state logged below is the reading.
      }
    }
    return generator.context.state;
  };
  const source = (): MediaStreamTrack => {
    if (!generator) {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = hz;
      const gain = context.createGain();
      gain.gain.value = DEV_TONE_GAIN;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      const track = destination.stream.getAudioTracks()[0];
      if (!track) throw new Error("devtone: the destination produced no audio track");
      context.addEventListener("statechange", () => {
        console.error(`[devtone] context ${context.state}`);
      });
      generator = { context, track };
      window.__devtone = { hz, context, resume };
      const onGesture = (): void => {
        void resume();
      };
      for (const type of ["pointerdown", "touchstart", "keydown"]) {
        window.addEventListener(type, onGesture, { capture: true, once: true });
      }
    }
    // The state now, not after resume(): a resume refused for want of a
    // gesture can stay pending, and a log line waiting on it would never
    // come. The statechange listener reports it reaching `running`.
    console.error(`[devtone] ${hz} Hz track handed out, context ${generator.context.state}`);
    void resume();
    return generator.track.clone();
  };

  const inner = media.getUserMedia.bind(media);
  media.getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    if (!constraints?.audio) return inner(constraints);
    const tone = source();
    if (!constraints.video) return new MediaStream([tone]);
    const stream = await inner({ video: constraints.video });
    stream.addTrack(tone);
    return stream;
  };

  // As ?devcamera does for the camera: a picker or a device check that sees
  // no audio input at all would refuse before it ever asked for a track.
  const innerEnumerate = media.enumerateDevices.bind(media);
  media.enumerateDevices = async (): Promise<MediaDeviceInfo[]> => {
    const devices = await innerEnumerate();
    if (devices.some((device) => device.kind === "audioinput" && device.deviceId !== "")) {
      return devices;
    }
    return [
      ...devices.filter((device) => device.kind !== "audioinput"),
      {
        deviceId: "devtone",
        kind: "audioinput",
        label: `Tone ${hz} Hz (devtools)`,
        groupId: "devtone",
        toJSON: () => ({}),
      } as MediaDeviceInfo,
    ];
  };
  console.error(`[devtone] ${hz} Hz source installed`);
}

/** ?devring: how long after boot the ring is injected, by default. */
const DEV_RING_DELAY_S = 5;
/** ?devring: the ring's lifetime when the payload names no `exp`, as the
 *  server's own ring TTL (phone-calls-plan.md §4.2). */
const DEV_RING_TTL_S = 45;

/**
 * `?devring=<json>` (or `VITE_DEVRING`): ring this shell as a push would.
 *
 * It calls the wherry-calls plugin's debug-only `debugIncoming` command with
 * `{ payload }`, where `payload` is the plaintext ring or dismissal object of
 * phone-calls-plan.md §4.2 (`{"w":1,"k":"call_ring","call":...}`) -- the
 * handler body PushKit or the FCM broadcast reaches after decryption. That is
 * the whole contract this file holds with the plugin; the plugin's own
 * `debugIncoming` is compiled only into debug builds.
 *
 * After a delay rather than at once, so the page's bridge is listening for
 * the plugin's `action` event by the time a ring can produce one. Out of the
 * URL first, so a reload does not ring twice.
 */
function maybeDevRing(params: URLSearchParams): void {
  const raw = params.get("devring") ?? devEnv("VITE_DEVRING");
  if (raw === null) return;
  const afterS = Number(params.get("devringafter") ?? DEV_RING_DELAY_S);
  if (params.has("devring")) {
    params.delete("devring");
    params.delete("devringafter");
    const query = params.size > 0 ? `?${params}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${query}`);
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    payload = parsed as Record<string, unknown>;
  } catch (error) {
    console.error(`[devring] ignored: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (payload["exp"] === undefined) {
    payload["exp"] = Math.floor(Date.now() / 1000) + DEV_RING_TTL_S;
  }

  const ring = async (): Promise<void> => {
    const { isTauriShell } = await import("./api/shell");
    if (!isTauriShell()) {
      console.error("[devring] not in a shell: nothing to ring");
      return;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("plugin:wherry-calls|debug_incoming", { payload });
      console.error(`[devring] debugIncoming(${String(payload["k"])}, ${String(payload["call"])}) accepted`);
      record("call", { method: "__dev-ring", args: [{ accepted: true, kind: payload["k"] }] });
    } catch (error) {
      // Before PC1's plugin exists, and in a build without it, this is the
      // expected answer: the command is not registered.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[devring] debugIncoming refused: ${message}`);
      record("call", { method: "__dev-ring", args: [{ accepted: false, error: message }] });
    }
  };
  setTimeout(() => void ring(), Math.max(0, Number.isFinite(afterS) ? afterS : DEV_RING_DELAY_S) * 1_000);
}

/** An element's box in CSS pixels, rounded -- the frame `tileRect` works in. */
function boxOf(element: Element): { x: number; y: number; w: number; h: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
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
      // Added 2026-09-11 for row D-56. Where the shell draws tiles over the
      // page a control inside a tile's reported rect cannot be pressed at
      // all, so "is it there and enabled" stopped being the whole question:
      // *where* it is, against the `<video>` rect the shell was given, is
      // the reading. Opacity comes with it because the pin used to live
      // behind `group-hover`, and a pointer over a native tile produces no
      // hover -- so a pin at opacity 0 would be as unreachable as one under
      // the window, and the two failures look identical in a label dump.
      rect: boxOf(button),
      opacity: Number(getComputedStyle(button).opacity),
    }))
    .filter((entry) => entry.label !== "");
  const videos = Array.from(document.querySelectorAll("video")).map((video) => ({
    width: video.videoWidth,
    height: video.videoHeight,
    paused: video.paused,
    source: video.srcObject === null ? null : "stream",
    // This element's own box is what `transport-native.ts` reports to the
    // shell, so it is the rect a native tile covers.
    rect: boxOf(video),
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
 * The readings rows W-58 and W-103 name, taken from the rendered page.
 *
 * Added 2026-09-27 to read those rows on the macOS shell, which (unlike
 * WebView2 on the rig) takes no DevTools protocol: the expressions are the
 * rows' own, so a reading here means what it means on the rig.
 */
function snapshotRows(): Record<string, unknown> {
  const dialog = document.querySelector<HTMLElement>('[role=dialog][aria-label^="Call — "]');
  const headers = Array.from(document.querySelectorAll("header span")).map((s) => s.textContent ?? "");
  const state: unknown = window.history.state;
  const layer =
    typeof state === "object" && state !== null ? (state as Record<string, unknown>)["wherryBackLayer"] : undefined;
  const bar = document.querySelector("[class*='bg-accent-50']");
  return {
    calling: Array.from(document.querySelectorAll("*")).some(
      (e) => e.childElementCount === 0 && e.textContent === "Calling…",
    ),
    callPage: dialog?.getAttribute("aria-label") ?? null,
    settings: headers.includes("Settings"),
    search: headers.includes("Search"),
    headers: headers.slice(0, 8),
    backLayer: layer ?? null,
    dialogs: Array.from(document.querySelectorAll("[role=dialog], [role=alertdialog]")).map(
      (d) => d.getAttribute("aria-label") ?? d.tagName,
    ),
    hangUps: Array.from(document.querySelectorAll("button")).filter(
      (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "").startsWith("Hang up"),
    ).length,
    bar: bar?.textContent?.trim().slice(0, 200) ?? null,
  };
}

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
function tauriInvoke(): TauriInvoke | null {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: TauriInvoke } }).__TAURI_INTERNALS__;
  return internals?.invoke ?? null;
}

/** The shell's tiles and received video rows, as `scripts/rig/tile-bind.mjs` reads them. */
async function tileReading(): Promise<Record<string, unknown>> {
  const invoke = tauriInvoke();
  if (!invoke) return { error: "no shell" };
  const stats = (await invoke("voice_stats")) as {
    native?: { bound?: number; tiles?: number; drawn?: number };
    video?: { direction: string; identity: string; source: string; width?: number; height?: number; fps?: number }[];
    peers?: { identity: string }[];
  };
  return {
    identity: stats.peers?.[0]?.identity ?? null,
    bound: stats.native?.bound ?? null,
    tiles: stats.native?.tiles ?? null,
    drawn: stats.native?.drawn ?? null,
    received: (stats.video ?? [])
      .filter((r) => r.direction === "received")
      .map((r) => `${r.identity}/${r.source} ${r.width ?? "?"}x${r.height ?? "?"}@${r.fps ?? "?"}`),
  };
}

/**
 * `?devnomic=1` (dev only, desktop shell): the native transport answers the
 * microphone with the error the shell gives on a machine with no input
 * device (`no_microphone`, a `NotFoundError`) without asking the shell, so
 * the session takes its listen-only path.
 *
 * Two entry points, both patched. The join's first publish is
 * `startMicrophone(muted)`: unmuted it is `setMicrophoneEnabled(true)`, but a
 * muted join (the room's default, or the person's preference) goes straight
 * to `voice_set_mic { publishMuted }`, which the second patch alone let
 * through, and which publishes a track. `setMicrophoneEnabled(true)` is every
 * later unmute. `setMicrophoneEnabled(false)` still reaches the shell. So
 * under this flag no call publishes a microphone at all, muted or not.
 *
 * Added 2026-09-27 for a Mac whose microphone consent prompt was pending and
 * could not be answered (the screen was locked): every native call's first
 * `StartRecording` then stalled the shell for minutes. Nothing read with it
 * needs the microphone (the engine hold, the connect, the tiles, the call
 * page, the SFU restart), and this keeps the engine off the device. Patched
 * on the prototype because `__TAURI_INTERNALS__.invoke` is read-only.
 */
async function maybeDevNoMic(params: URLSearchParams): Promise<void> {
  if (params.get("devnomic") !== "1") return;
  try {
    const { NativeTransport } = await import("./voice/transport-native");
    const proto = NativeTransport.prototype as unknown as {
      setMicrophoneEnabled: (on: boolean) => Promise<void>;
      startMicrophone: (muted: boolean) => Promise<void>;
    };
    const refuse = (what: string): Promise<void> => {
      record("call", { method: "__dev-nomic", args: [{ refused: what }] });
      const error = new Error("devnomic: no microphone for this run");
      error.name = "NotFoundError";
      return Promise.reject(error);
    };
    const original = proto.setMicrophoneEnabled;
    proto.setMicrophoneEnabled = function (this: unknown, on: boolean): Promise<void> {
      if (!on) return original.call(this, on);
      return refuse("setMicrophoneEnabled(true)");
    };
    proto.startMicrophone = function (muted: boolean): Promise<void> {
      return refuse(`startMicrophone(${muted ? "muted" : "unmuted"})`);
    };
    record("call", { method: "__dev-nomic", args: [{ installed: true }] });
  } catch (error) {
    record("call", { method: "__dev-nomic", args: [{ installed: false, error: String(error) }] });
  }
}

/**
 * `?devsteps=<step>;<step>;…` (dev only): a scripted sequence against the
 * rendered page, for a shell no protocol can drive (the macOS WKWebView).
 * Each step's outcome goes to the collector as `__dev-step`.
 *
 *   wait:<ms>          pause
 *   waitfor:<label>    until a button whose aria-label or text starts with
 *                      <label> (case-insensitive) exists, up to 120 s
 *   click:<label>      press that button (the same match as ?devclick)
 *   key:<mods+Key>     a keydown then keyup on the focused element, e.g.
 *                      key:Escape, key:Meta+Shift+F. Synthetic: the app's
 *                      document listener cannot tell, a trusted-event
 *                      check would
 *   snap:<tag>         snapshotRows() with the tag
 *   tiles:<tag>        the shell's voice_stats tiles, and 2 s later again,
 *                      with frames drawn in between (tile-bind's `moving`)
 *   sub:<q>[,<q>…]     voice_set_video_subscription for the first peer's
 *                      camera, each quality with no await between them
 *                      (tile-bind's `burst` is `sub:off,low`)
 *   sample:<ms>,<n>    snapRows every <ms>, <n> times, posted as one entry
 */
function maybeDevSteps(params: URLSearchParams): void {
  const raw = params.get("devsteps");
  if (!raw) return;
  const steps = raw.split(";").map((s) => s.trim()).filter((s) => s !== "");
  const post = (detail: Record<string, unknown>): void =>
    record("call", { method: "__dev-step", args: [detail] });
  const findButton = (label: string): HTMLButtonElement | undefined => {
    const wanted = label.toLowerCase();
    return Array.from(document.querySelectorAll("button")).find((candidate) => {
      const aria = candidate.getAttribute("aria-label")?.toLowerCase() ?? "";
      const text = candidate.textContent?.trim().toLowerCase() ?? "";
      return aria.startsWith(wanted) || text.startsWith(wanted);
    });
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const run = async (): Promise<void> => {
    for (const [index, step] of steps.entries()) {
      const colon = step.indexOf(":");
      const verb = colon < 0 ? step : step.slice(0, colon);
      const arg = colon < 0 ? "" : step.slice(colon + 1);
      const at = { step: index, verb, arg };
      try {
        if (verb === "wait") {
          await sleep(Number(arg));
        } else if (verb === "waitfor") {
          const deadline = Date.now() + DEV_CLICK_WAIT_MS;
          while (!findButton(arg) && Date.now() < deadline) await sleep(250);
          post({ ...at, found: !!findButton(arg) });
        } else if (verb === "click") {
          const button = findButton(arg);
          button?.click();
          post({ ...at, found: !!button, disabled: button?.disabled ?? null });
        } else if (verb === "key") {
          const parts = arg.split("+");
          const key = parts.pop() ?? "";
          const init: KeyboardEventInit = {
            key,
            bubbles: true,
            cancelable: true,
            ctrlKey: parts.includes("Ctrl"),
            metaKey: parts.includes("Meta"),
            shiftKey: parts.includes("Shift"),
            altKey: parts.includes("Alt"),
          };
          const target = document.activeElement ?? document.body;
          const before = snapshotRows();
          target.dispatchEvent(new KeyboardEvent("keydown", init));
          target.dispatchEvent(new KeyboardEvent("keyup", init));
          await sleep(300);
          post({ ...at, target: target.tagName, before, after: snapshotRows() });
        } else if (verb === "snap") {
          post({ ...at, rows: snapshotRows() });
        } else if (verb === "tiles") {
          const a = await tileReading();
          await sleep(2_000);
          const b = await tileReading();
          const drawnA = typeof a["drawn"] === "number" ? a["drawn"] : 0;
          const drawnB = typeof b["drawn"] === "number" ? b["drawn"] : 0;
          const verdict =
            b["bound"] === 0 ? "NOT BOUND" : drawnB > drawnA ? `drawing (+${drawnB - drawnA} in 2 s)` : "bound, NOT DRAWING";
          post({ ...at, reading: b, verdict });
        } else if (verb === "sub") {
          const invoke = tauriInvoke();
          const { identity } = await tileReading();
          if (!invoke || typeof identity !== "string") {
            post({ ...at, error: "no shell or no peer" });
          } else {
            for (const quality of arg.split(",")) {
              void invoke("voice_set_video_subscription", { identity, source: "camera", quality });
            }
            post({ ...at, identity });
          }
        } else if (verb === "sample") {
          const [every, count] = arg.split(",").map(Number);
          const samples: unknown[] = [];
          for (let i = 0; i < (count ?? 1); i++) {
            const rows = snapshotRows();
            samples.push({ t: new Date().toISOString(), calling: rows["calling"], bar: rows["bar"] });
            await sleep(every ?? 250);
          }
          post({ ...at, samples });
        } else {
          post({ ...at, error: "unknown step" });
        }
      } catch (error) {
        post({ ...at, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
      }
    }
    post({ step: steps.length, verb: "done" });
  };
  void run();
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
        // Say so every few seconds rather than going quiet for two
        // minutes: a watcher reading the collector should be able to tell
        // "still waiting for a control that has not appeared" from "the
        // page is dead", and the two look identical in silence.
        const waited = Math.round((Date.now() - (deadline - DEV_CLICK_WAIT_MS)) / 1_000);
        if (waited > 0 && waited % 10 === 0) {
          record("call", { method: "__dev-click", args: [{ label, waitingSeconds: waited }] });
        }
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
  maybeDevDevices(params);
  // Before the call: the substitution has to be in place when the SDK
  // first asks for a track.
  maybeDevCamera(params);
  maybeDevTone(params);
  await maybeDevNoMic(params);
  maybeDevCall(params);
  maybeDevRing(params);
  maybeDevUi(params);
  maybeDevClick(params);
  maybeDevSteps(params);
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
