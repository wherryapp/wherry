// The native media transport, TypeScript half: `VoiceTransport` over the
// shell's `voice_*` commands and its `voice` event (src-tauri/src/voice/ is
// the other half; docs/prompts/native-media-plan.md §5 is the plan, and
// docs/prompts/video-next-stages-handoff.md §3 the video stage on top).
// Chosen in index.ts when the desktop shell has the engine and this device
// turned it on; every other platform keeps `transport-webview.ts`.
//
// What lives on which side of the boundary: the shell captures, encrypts,
// sends, receives and plays, and reports facts (a roster, a state word, a
// stats reading). Everything that is a decision -- which ring index an
// epoch maps to, whether a volume is silence, what an encryption state
// means, whether a saved device id is still real, where a tile is and
// whether anything covers it -- is made here or in `transport-rules.ts`,
// and crosses the IPC already decided.
//
// **Video, since 2026-09-08 on macOS (path (b)).** The camera and the
// screen are captured and published by the shell; a received track is
// drawn by the shell in a native view *above* the page, placed at the rect
// this file measures from the `<video>` element the tile hands over. The
// element itself stays empty -- it is the placeholder the native view
// covers, and what shows through when the view hides. Two things follow.
// The rect is reported on every change this file can observe (resize,
// scroll, the element's own size) and polled slowly for the ones it
// cannot (a sibling tile leaving, which moves this one without resizing
// it). And the page says which *surface* a tile is on and when that
// surface is covered (ui/back.ts's overlay depth), because a native view
// cannot be told by the document's stacking order what is drawn over it.
//
// **Windows shares a screen (W1, 2026-09-09), draws (W3, 2026-09-10) and,
// since W4 (2026-09-15), opens a camera.** The three capabilities used to
// be one probe field and now are three, because that platform came apart
// on the way: it captures a screen and its sound in the shell through a
// picker of our own, and it puts every received tile in a child window
// over the page. Capturing natively is a choice, not a necessity: on
// Windows 11 WebView2 opens its own chooser and `getDisplayMedia` settles
// both ways (row S-00, re-checked 2026-09-26), so the webview engine can
// share there too. The shell's capture is what gives per-application audio
// and Windows 10, where a bare wry window opened no picker on 2026-09-09
// (still unexplained). Between W3 and W4 it had no path to a **camera**,
// so that one button stayed the engine switch while the screen button
// shared in place, and an installed shell from then still answers that
// way. Which made a third shape the rules had never met: an engine that
// renders and cannot capture. `rules.ts`'s `nativeEngine` is what tells it
// from a phone.

import { keyIndexFor, type VideoQualityRequest, type VideoSource } from "./rules";
import { nativeMediaProbe } from "./native-media";
import { probeRoom } from "./room-probe";
import type {
  AudioKind,
  FrameTransformKind,
  ScreenChoice,
  ScreenSource,
  TransportCapabilities,
  TransportConnectOptions,
  TransportEnd,
  TransportEvents,
  TransportParticipant,
  TransportStats,
  TransportVideoOptions,
  VideoSurface,
  VoiceQuality,
  VoiceTransport,
} from "./transport";
import {
  connectionFromWord,
  isEncryptionFailure,
  knownDeviceId,
  nativeErrorName,
  nativeGainFor,
  playbackEnabledFor,
  playoutAfterDeviceChange,
  playoutReadingChanged,
  qualityFromWord,
  ROOM_PROBE_EVERY_MS,
  ROOM_PROBE_FIRST_MS,
  screenAudioMode,
  screenOptionsFor,
  tileRect,
  transportEndFor,
  userIdFromMetadata,
  volumeKey,
  type Rect,
} from "./transport-rules";

/** One remote participant as the shell reports them (voice/mod.rs `RosterEntry`). */
type NativeEntry = {
  identity: string;
  name: string;
  metadata: string;
  speaking: boolean;
  micMuted: boolean;
  encrypted: boolean;
  audioLevel: number;
  playing: boolean | null;
  hasCamera: boolean;
  hasScreen: boolean;
  hasScreenAudio: boolean;
  cameraMuted: boolean;
};

type NativeRoster = { participants: NativeEntry[]; localLevel: number };

type NativeEvent = { session: number } & (
  | { kind: "roster"; roster: NativeRoster }
  | { kind: "speakers"; roster: NativeRoster }
  | { kind: "participant_joined" }
  | { kind: "participant_left" }
  // `reason` is the SDK's `DisconnectReason` by its Rust name, on
  // `disconnected` only. A shell built before it existed sends none, and
  // sends `disconnected` twice (the state change, then the room event).
  | { kind: "connection"; state: string; quality: string; reason?: string | null }
  | { kind: "encryption"; identity: string; state: string }
  | { kind: "video_changed" }
  // The SFU's refreshed token; a shell built before 2026-09-27 never sends
  // it, and its calls are probed with the join token (15 minutes).
  | { kind: "token"; token: string }
);

type NativeDevices = {
  inputs: { deviceId: string; label: string }[];
  outputs: { deviceId: string; label: string }[];
  /** The Windows default output, null when there is none; absent from a
   *  shell that leaves playout to the platform (voice/playout.rs). */
  defaultOutput?: string | null;
};

type ConnectResult = { session: number; connectMs: number; roster: NativeRoster };

/** How often a tile's rect is re-read when nothing observable moved it. */
const RECT_POLL_MS = 500;

/**
 * A command's rejection: the shell's `VoiceError`, or something else.
 *
 * `shown` means this rejection reaches a person as a sentence, so its code
 * is translated into the DOM error name the two message functions switch
 * on. It is passed by the microphone, the camera and the screen, and not by
 * the commands whose failures only reach the log.
 */
function nativeError(error: unknown, shown = false): Error {
  if (error && typeof error === "object" && "code" in error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    const out = new Error(typeof message === "string" ? message : String(code));
    if (shown) out.name = nativeErrorName(typeof code === "string" ? code : "");
    return out;
  }
  return error instanceof Error ? error : new Error(String(error));
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function rectOf(element: Element): Rect {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

export class NativeTransport implements VoiceTransport {
  #invoke: Invoke | null = null;
  #unlisten: (() => void) | null = null;
  #session: number | null = null;
  /** Events that arrived while connect was in flight, replayed once the
   *  session id is known -- the shell starts emitting before the connect
   *  command returns. */
  #pending: NativeEvent[] | null = null;
  #roster: NativeRoster = { participants: [], localLevel: 0 };
  #quality: VoiceQuality = "unknown";
  #events: TransportEvents = {};
  /** This listener's volume per account, applied to every device of theirs
   *  as it appears. */
  #volumes = new Map<string, number>();
  /** `identity/kind` pairs whose playback flag has been sent to the shell. */
  #playbackSent = new Set<string>();
  /** Whether this call was joined with the echo canceller on (rules.ts's
   *  EchoReport.disabled is the readout's honest word when it was not). */
  #echoCancellation = true;
  /** The publish ceilings this call resolved, for the two publish commands. */
  #video: TransportVideoOptions = { codec: "h264", camera: null, screen: null };
  /** Tiles this transport has asked the shell for, by element, so a detach
   *  can find its id and a covered surface can be re-sent on reconnect. */
  #tiles = new Map<HTMLVideoElement, { id: number | null; stop: () => void }>();
  /** The speaker the person chose (the preference, unfiltered), null for the
   *  default; and whether playout is on the default right now because of
   *  that -- nothing chosen, or the choice gone (rows D-72, D-73). */
  #speakerChoice: string | null = null;
  #playoutFollowing = false;
  /** The shell's last device reading, for a choice made mid-call. */
  #devices: NativeDevices = { inputs: [], outputs: [] };
  #unlistenDevices: (() => void) | null = null;
  /** `voice-devices` events heard this call, so the catch-up read after
   *  connect can tell it has been overtaken by a newer one. */
  #deviceEvents = 0;
  /** Playout moves in order: a second device event never overtakes the
   *  first's command. */
  #playoutQueue: Promise<void> = Promise.resolve();
  /** The call's SFU URL and its latest token: the reconnect watch probes
   *  with it, and an end nobody reported hands it to the session. */
  #endpoint: { url: string; token: string } | null = null;
  /** This call's end has been reported: the session hears one
   *  `disconnected`, whichever path got there first. */
  #ended = false;
  /** Whether the reconnect watch is running, its pending timer, and the
   *  episode it belongs to -- bumped whenever the connection word moves on,
   *  so an answer that lands after a reconnect succeeded decides nothing. */
  #watching = false;
  #watchTimer: ReturnType<typeof setTimeout> | null = null;
  #episode = 0;

  async connect(options: TransportConnectOptions, events: TransportEvents): Promise<void> {
    this.#events = events;
    this.#echoCancellation = options.processing.echoCancellation;
    this.#video = options.video;
    this.#endpoint = { url: options.url, token: options.token };
    this.#ended = false;
    const [core, event] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]);
    const invoke: Invoke = (command, args) => core.invoke(command, args);
    this.#invoke = invoke;
    this.#pending = [];
    // Listening before connecting, so nothing the shell says about this
    // call is missed; the session id on every event keeps another call's
    // tail out.
    this.#unlisten = await event.listen<NativeEvent>("voice", (e) => this.#onEvent(e.payload));

    let devices: NativeDevices = { inputs: [], outputs: [] };
    try {
      devices = await invoke<NativeDevices>("voice_devices");
    } catch {
      // No devices to check against: both ids fall back to the default.
    }
    try {
      const result = await invoke<ConnectResult>("voice_connect", {
        args: {
          url: options.url,
          token: options.token,
          e2ee: options.e2ee,
          maxBitrate: options.maxBitrate,
          processing: options.processing,
          micDeviceId: knownDeviceId(options.micDeviceId, devices.inputs),
          speakerDeviceId: knownDeviceId(options.speakerDeviceId, devices.outputs),
          key: options.key
            ? { secret: Array.from(options.key.secret), keyIndex: keyIndexFor(options.key.epoch) }
            : null,
        },
      });
      this.#session = result.session;
      this.#roster = result.roster;
      this.#speakerChoice = options.speakerDeviceId;
      this.#devices = devices;
      // The shell put playout on the default at connect exactly when the id
      // it was handed was null.
      this.#playoutFollowing = knownDeviceId(options.speakerDeviceId, devices.outputs) === null;
      const pending = this.#pending ?? [];
      this.#pending = null;
      for (const queued of pending) this.#onEvent(queued);
      this.#applyVolumes();
      // Not a UI listener: this one lives with the call, so playout follows
      // with Settings closed. Registered after the replay, so no call event
      // is reordered around this await -- and so after the connect, which is
      // why the catch-up read follows it.
      this.#unlistenDevices = await event.listen<NativeDevices>("voice-devices", (e) =>
        this.#onDevices(e.payload),
      );
      void this.#catchUpDevices(invoke, devices);
    } catch (error) {
      await this.disconnect();
      throw nativeError(error);
    }
  }

  async disconnect(): Promise<void> {
    const invoke = this.#invoke;
    this.#unlisten?.();
    this.#unlisten = null;
    this.#unlistenDevices?.();
    this.#unlistenDevices = null;
    this.#stopWatch();
    this.#endpoint = null;
    this.#session = null;
    this.#pending = null;
    this.#events = {};
    this.#roster = { participants: [], localLevel: 0 };
    this.#playbackSent.clear();
    // The shell destroys its tiles with the session; the observers here
    // are ours to stop.
    for (const tile of this.#tiles.values()) tile.stop();
    this.#tiles.clear();
    if (invoke) {
      try {
        await invoke("voice_disconnect");
      } catch {
        // Already gone.
      }
    }
  }

  async setMicrophoneEnabled(on: boolean): Promise<void> {
    const invoke = this.#invoke;
    if (!invoke || this.#session === null) return;
    try {
      await invoke("voice_set_mic", { enabled: on });
    } catch (error) {
      throw nativeError(error, true);
    }
  }

  async setInputDevice(deviceId: string): Promise<void> {
    await this.#invoke?.("voice_set_input_device", { deviceId });
  }

  async setOutputDevice(deviceId: string | null): Promise<void> {
    this.#speakerChoice = deviceId;
    if (deviceId !== null) {
      this.#playoutFollowing = false;
      await this.#invoke?.("voice_set_output_device", { deviceId });
      return;
    }
    // Back to "Default" mid-call: the same decision a device change makes.
    await this.#movePlayout();
  }

  #onDevices(devices: NativeDevices): void {
    if (this.#session === null) return;
    this.#deviceEvents += 1;
    this.#devices = devices;
    void this.#movePlayout();
  }

  /** A device change inside the connect -- after the list read in front of
   *  `voice_connect`, before the listener above existed -- was emitted to
   *  nobody, and the shell's poller never repeats a reading (D-73's own
   *  case: headphones plugged in as the call starts, into a call that
   *  resolved no output). So read again now that the listener exists, and
   *  make the one decision that event would have made if the reading moved
   *  (`playoutReadingChanged`); nothing is asked of the shell when it did
   *  not. Never throws: a failed read leaves the next event to decide. */
  async #catchUpDevices(invoke: Invoke, atConnect: NativeDevices): Promise<void> {
    const seen = this.#deviceEvents;
    let now: NativeDevices;
    try {
      now = await invoke<NativeDevices>("voice_devices");
    } catch {
      return;
    }
    // An event heard while this read was in flight carries a reading at
    // least as new, and has already made the decision.
    if (this.#session === null || this.#deviceEvents !== seen) return;
    if (!playoutReadingChanged(atConnect, now)) return;
    this.#devices = now;
    await this.#movePlayout();
  }

  /** Ask the shell to move playout if `playoutAfterDeviceChange` says so;
   *  queued, and never throws (a failed move is the shell's log line). */
  #movePlayout(): Promise<void> {
    const run = async (): Promise<void> => {
      const invoke = this.#invoke;
      if (!invoke || this.#session === null) return;
      const move = playoutAfterDeviceChange({
        chosen: this.#speakerChoice,
        outputs: this.#devices.outputs,
        defaultOutput: this.#devices.defaultOutput,
        following: this.#playoutFollowing,
      });
      try {
        if (move.kind === "follow-default") {
          this.#playoutFollowing = true;
          await invoke("voice_follow_default_output");
        } else if (move.kind === "device") {
          this.#playoutFollowing = false;
          await invoke("voice_set_output_device", { deviceId: move.deviceId });
        }
      } catch {
        // The shell logged why; the next device event asks again.
      }
    };
    this.#playoutQueue = this.#playoutQueue.then(run, run);
    return this.#playoutQueue;
  }

  async setEpochKey(secret: Uint8Array, epoch: number): Promise<void> {
    const invoke = this.#invoke;
    if (!invoke || this.#session === null) throw new Error("not connected");
    try {
      await invoke("voice_set_epoch_key", {
        key: { secret: Array.from(secret), keyIndex: keyIndexFor(epoch) },
      });
    } catch (error) {
      throw nativeError(error);
    }
  }

  setParticipantVolume(userId: string, volume: number, kind: AudioKind): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.#volumes.set(volumeKey(userId, kind), clamped);
    for (const entry of this.#roster.participants) {
      if (userIdFromMetadata(entry.metadata, entry.identity) !== userId) continue;
      this.#sendPlayback(entry.identity, clamped, kind);
    }
  }

  // -- video -----------------------------------------------------------------

  /**
   * The three answers came from one probe field until 2026-09-09, when
   * Windows made them come apart: a shell there captured a screen (stage
   * W1) before it could draw a received tile (W3), and opened no camera
   * until W4. So `video` stays the shell that does everything -- macOS,
   * Windows since W4, and any shell older than the split -- and the two
   * narrower fields raise the ones a shell has short of that.
   *
   * A Windows shell built between W3 and W4 keeps the engine switch on the
   * camera while the screen button shares for real, which `rules.ts`'s
   * `videoNeedsSwitch` already handles: it reads the per-source capability,
   * not one flag for video.
   *
   * Never a platform name; an older shell without the fields reads as the
   * old all-or-nothing answer.
   */
  capabilities(): TransportCapabilities {
    const probe = nativeMediaProbe();
    const video = probe?.video === true;
    return {
      camera: video,
      screen: video || probe?.screenCapture === true,
      renderVideo: video || probe?.videoRender === true,
    };
  }

  /**
   * Empty where the OS has a picker of its own (macOS), a real list where
   * it has none (Windows). The page draws one exactly when this is
   * non-empty -- see the seam's comment on why that is the signal rather
   * than a platform check.
   */
  async screenSources(): Promise<ScreenSource[]> {
    const invoke = this.#invoke;
    if (!invoke) return [];
    try {
      return await invoke<ScreenSource[]>("voice_screen_sources");
    } catch {
      return [];
    }
  }

  async setCameraEnabled(on: boolean, deviceId: string | null): Promise<void> {
    const invoke = this.#invoke;
    if (!invoke || this.#session === null) return;
    const ceiling = this.#video.camera;
    try {
      await invoke("voice_set_camera", {
        args: {
          enabled: on,
          deviceId,
          maxHeight: ceiling?.maxHeight ?? 720,
          maxFps: ceiling?.maxFps ?? 30,
        },
      });
    } catch (error) {
      throw nativeError(error, true);
    }
  }

  async setScreenShareEnabled(
    on: boolean,
    audience = 1,
    choice?: ScreenChoice | null,
  ): Promise<void> {
    const invoke = this.#invoke;
    if (!invoke || this.#session === null) return;
    // The audience step, read now and never re-applied: see
    // transport-rules.ts's screenOptionsFor.
    const ceiling = screenOptionsFor(this.#video.screen, audience);
    try {
      await invoke("voice_set_screen", {
        args: {
          enabled: on,
          maxHeight: ceiling?.maxHeight ?? 1080,
          maxFps: ceiling?.maxFps ?? 15,
          // Null where the OS sheet chooses (macOS). The shell refuses to
          // start a capture without one anywhere else, which is what keeps
          // "a display captured with no consent interface" unreachable
          // rather than merely unused.
          source: choice?.sourceId ?? null,
          audio: choice?.audio === true,
          // The mode is decided here and never in Rust: which loopback a
          // share uses follows what was picked, and the shell receives it
          // already chosen (transport-rules.ts's screenAudioMode).
          audioMode: choice ? screenAudioMode(choice.sourceId) : null,
        },
      });
    } catch (error) {
      throw nativeError(error, true);
    }
  }

  attachVideo(
    identity: string,
    source: VideoSource,
    element: HTMLVideoElement,
    surface: VideoSurface,
  ): () => void {
    const invoke = this.#invoke;
    if (!invoke || this.#session === null || !this.capabilities().renderVideo) return () => {};
    if (this.#tiles.has(element)) return () => this.#detach(element);

    const entry: { id: number | null; stop: () => void } = { id: null, stop: () => {} };
    this.#tiles.set(element, entry);
    let gone = false;

    // -- the rect, reported on every change and polled for the rest ------
    let frame: number | null = null;
    let last = "";
    const report = (): void => {
      frame = null;
      if (gone || entry.id === null) return;
      const clipElement = element.closest("[data-video-clip]");
      const measured = tileRect(
        rectOf(element),
        clipElement ? rectOf(clipElement) : null,
        { width: window.innerWidth, height: window.innerHeight },
      );
      // Off screen for a disconnected element, or one hidden by CSS
      // (display: none measures 0x0 and is caught by `visible`).
      const visible = measured.visible && element.isConnected;
      const key = JSON.stringify([measured.frame, measured.clip, visible]);
      if (key === last) return;
      last = key;
      void invoke("voice_set_video_rect", {
        args: { tile: entry.id, clip: measured.clip, frame: measured.frame, visible },
      }).catch(() => {});
    };
    const schedule = (): void => {
      if (frame !== null || gone) return;
      frame = requestAnimationFrame(report);
    };
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    observer?.observe(document.documentElement);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    const poll = window.setInterval(schedule, RECT_POLL_MS);
    entry.stop = () => {
      gone = true;
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      window.clearInterval(poll);
    };

    void invoke<number>("voice_attach_video", { identity, source, surface })
      .then((id) => {
        if (gone) {
          void invoke("voice_detach_video", { tile: id }).catch(() => {});
          return;
        }
        entry.id = id;
        report();
      })
      .catch(() => {
        // No tile: the placeholder stays, which is the honest picture.
      });

    return () => this.#detach(element);
  }

  #detach(element: HTMLVideoElement): void {
    const entry = this.#tiles.get(element);
    if (!entry) return;
    this.#tiles.delete(element);
    entry.stop();
    if (entry.id !== null) {
      void this.#invoke?.("voice_detach_video", { tile: entry.id }).catch(() => {});
    }
  }

  setSurfaceCovered(surface: VideoSurface, covered: boolean): void {
    const invoke = this.#invoke;
    if (!invoke || this.#session === null) return;
    void invoke("voice_set_video_covered", { surface, covered }).catch(() => {});
  }

  setVideoSubscription(identity: string, source: VideoSource, quality: VideoQualityRequest): void {
    const invoke = this.#invoke;
    if (!invoke || this.#session === null) return;
    void invoke("voice_set_video_subscription", { identity, source, quality }).catch(() => {});
  }

  // -- playback and readings -------------------------------------------------

  async startPlayback(): Promise<void> {
    // Playback is the audio device module's; no autoplay policy applies.
  }

  playbackBlocked(): boolean {
    return false;
  }

  participants(): TransportParticipant[] {
    return this.#roster.participants.map((entry) => {
      const userId = userIdFromMetadata(entry.metadata, entry.identity);
      return {
        identity: entry.identity,
        userId,
        name: entry.name || userId,
        speaking: entry.speaking,
        micMuted: entry.micMuted,
        encrypted: entry.encrypted,
        audioLevel: entry.audioLevel,
        camera: entry.hasCamera,
        screen: entry.hasScreen,
        screenAudio: entry.hasScreenAudio,
        cameraMuted: entry.cameraMuted,
      };
    });
  }

  localAudioLevel(): number {
    return this.#roster.localLevel;
  }

  quality(): VoiceQuality {
    return this.#quality;
  }

  frameTransform(): FrameTransformKind {
    return "native";
  }

  async sampleStats(): Promise<TransportStats | null> {
    const invoke = this.#invoke;
    if (!invoke || this.#session === null) return null;
    try {
      const stats = await invoke<TransportStats>("voice_stats");
      // With the canceller off the APM reports no echo metrics, and the
      // shell's stats read an absent number as 0 dB; say "off" instead.
      const echo = this.#echoCancellation ? stats.echo : { ...stats.echo, disabled: true };
      return { ...stats, echo, video: stats.video ?? [] };
    } catch {
      return null;
    }
  }

  // -- the shell's events ----------------------------------------------------

  #onEvent(payload: NativeEvent): void {
    if (this.#pending) {
      this.#pending.push(payload);
      return;
    }
    if (payload.session !== this.#session) return;
    const events = this.#events;
    switch (payload.kind) {
      case "roster":
        this.#roster = payload.roster;
        this.#applyVolumes();
        events.rosterChanged?.();
        break;
      case "speakers":
        this.#roster = payload.roster;
        events.speakersChanged?.();
        break;
      case "participant_joined":
        events.participantJoined?.();
        break;
      case "participant_left":
        events.participantLeft?.();
        break;
      case "connection": {
        this.#quality = qualityFromWord(payload.quality);
        const state = connectionFromWord(payload.state);
        if (!state || this.#ended) break;
        if (state === "disconnected") {
          this.#end(payload.reason ?? null);
          break;
        }
        if (state === "reconnecting") this.#watchReconnect();
        else this.#stopWatch();
        events.connection?.(state, this.#quality);
        break;
      }
      case "encryption":
        if (isEncryptionFailure(payload.state)) events.encryptionError?.(payload.state);
        break;
      case "video_changed":
        events.videoChanged?.();
        break;
      case "token":
        // The join token expires after 15 minutes; a probe of a longer
        // call with it would read 401, which decides nothing.
        if (this.#endpoint) this.#endpoint = { ...this.#endpoint, token: payload.token };
        break;
    }
  }

  // -- a room the SFU no longer holds ------------------------------------------

  /**
   * While the shell reconnects, ask the SFU now and then whether the room is
   * still there, and end the call as soon as it says no.
   *
   * The Rust SDK retries a reconnect refused with 404 "requested room does
   * not exist" ten times over about a minute (upstream counts only 401 and
   * 403 as final), with the call's controls on screen the whole time, where
   * the webview engine stops at the first such answer (rig, 2026-09-27).
   * Changing that is a fork commit, so the page asks the question the SDK
   * asks and acts on the answer; `transport-rules.ts` says why the room
   * cannot come back. Nothing here stops a reconnect that can land: a room
   * that exists answers "present" and the SDK carries on.
   */
  #watchReconnect(): void {
    if (this.#watching || this.#ended) return;
    this.#watching = true;
    const episode = this.#episode;
    const tick = async (): Promise<void> => {
      this.#watchTimer = null;
      const endpoint = this.#endpoint;
      if (!endpoint || episode !== this.#episode) return;
      const verdict = await probeRoom(endpoint.url, endpoint.token);
      if (episode !== this.#episode || this.#ended || this.#session === null) return;
      if (verdict === "gone") {
        this.#report({ roomGone: true, unsettled: null });
        return;
      }
      this.#watchTimer = setTimeout(() => void tick(), ROOM_PROBE_EVERY_MS);
    };
    this.#watchTimer = setTimeout(() => void tick(), ROOM_PROBE_FIRST_MS);
  }

  #stopWatch(): void {
    this.#episode += 1;
    this.#watching = false;
    if (this.#watchTimer !== null) clearTimeout(this.#watchTimer);
    this.#watchTimer = null;
  }

  /**
   * The shell says the call is over, reported at once. Unless the reason says
   * somebody already knows, the end is unsettled (`transportEndFor`) and the
   * session keeps asking whether the room still exists: the SDK gives up on
   * a vanished room with no reason at all, and it gives up on an SFU that is
   * still down, which a single question at this moment could not reach.
   */
  #end(reason: string | null): void {
    if (this.#ended) return;
    this.#report(transportEndFor(reason, this.#endpoint));
  }

  /** The end, decided here and reported once. The session's teardown then
   *  closes the shell's room, which cancels the SDK's remaining attempts. */
  #report(end: TransportEnd): void {
    this.#ended = true;
    this.#stopWatch();
    this.#events.connection?.("disconnected", this.#quality, end);
  }

  /** A volume set before somebody's device appeared reaches it now. */
  #applyVolumes(): void {
    for (const entry of this.#roster.participants) {
      const userId = userIdFromMetadata(entry.metadata, entry.identity);
      for (const kind of ["microphone", "screen"] as const) {
        const sent = `${entry.identity}/${kind}`;
        if (this.#playbackSent.has(sent)) continue;
        const volume = this.#volumes.get(volumeKey(userId, kind));
        if (volume !== undefined) this.#sendPlayback(entry.identity, volume, kind);
      }
    }
  }

  /** The enable flag and the gain, both decided here (transport-rules.ts).
   *  `kind` reaches the shell as the source it applies to, so a volume for
   *  somebody's voice does not move the film they are sharing. */
  #sendPlayback(identity: string, volume: number, kind: AudioKind): void {
    const invoke = this.#invoke;
    if (!invoke || this.#session === null) return;
    const sent = `${identity}/${kind}`;
    this.#playbackSent.add(sent);
    void Promise.all([
      invoke("voice_set_playback", {
        identity,
        source: kind,
        enabled: playbackEnabledFor(volume),
      }),
      invoke("voice_set_volume", { identity, source: kind, volume: nativeGainFor(volume) }),
    ]).catch(() => {
      // The next roster event tries again.
      this.#playbackSent.delete(sent);
    });
  }
}
