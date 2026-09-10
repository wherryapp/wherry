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
// **Windows shares a screen and, since 2026-09-10, draws (stages W1 and
// W3).** The three capabilities used to be one probe field and now are
// three, because that platform came apart: it captures a screen and its
// sound through a picker of our own -- WebView2 opens none and
// `getDisplayMedia` hangs there (row S-00), so the shell is the only thing
// that can -- and it puts every received tile in a child window over the
// page. What it still has no path to is a **camera**, so that one button
// stays the engine switch while the screen button shares in place. Which
// made a third shape the rules had never met: an engine that renders and
// cannot capture. `rules.ts`'s `nativeEngine` is what tells it from a
// phone.

import { keyIndexFor, type VideoQualityRequest, type VideoSource } from "./rules";
import { nativeMediaProbe } from "./native-media";
import type {
  AudioKind,
  FrameTransformKind,
  ScreenChoice,
  ScreenSource,
  TransportCapabilities,
  TransportConnectOptions,
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
  micErrorName,
  nativeGainFor,
  playbackEnabledFor,
  qualityFromWord,
  screenAudioMode,
  screenOptionsFor,
  tileRect,
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
  | { kind: "connection"; state: string; quality: string }
  | { kind: "encryption"; identity: string; state: string }
  | { kind: "video_changed" }
);

type NativeDevices = {
  inputs: { deviceId: string; label: string }[];
  outputs: { deviceId: string; label: string }[];
};

type ConnectResult = { session: number; connectMs: number; roster: NativeRoster };

/** How often a tile's rect is re-read when nothing observable moved it. */
const RECT_POLL_MS = 500;

/** A command's rejection: the shell's `VoiceError`, or something else. */
function nativeError(error: unknown, mic = false): Error {
  if (error && typeof error === "object" && "code" in error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    const out = new Error(typeof message === "string" ? message : String(code));
    if (mic) out.name = micErrorName(typeof code === "string" ? code : "");
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

  async connect(options: TransportConnectOptions, events: TransportEvents): Promise<void> {
    this.#events = events;
    this.#echoCancellation = options.processing.echoCancellation;
    this.#video = options.video;
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
      const pending = this.#pending ?? [];
      this.#pending = null;
      for (const queued of pending) this.#onEvent(queued);
      this.#applyVolumes();
    } catch (error) {
      await this.disconnect();
      throw nativeError(error);
    }
  }

  async disconnect(): Promise<void> {
    const invoke = this.#invoke;
    this.#unlisten?.();
    this.#unlisten = null;
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

  async setOutputDevice(deviceId: string): Promise<void> {
    await this.#invoke?.("voice_set_output_device", { deviceId });
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
   * Windows made them come apart: a shell there captures a screen (stage
   * W1) long before it can draw a received tile (W3), and there is no
   * camera capture at all. So `video` stays the shell that does
   * everything -- macOS, and any shell older than the split -- and the two
   * narrower fields raise the ones that platform has.
   *
   * The camera keeps the engine switch on Windows while the screen button
   * shares for real, which `rules.ts`'s `videoNeedsSwitch` already handles:
   * it reads the per-source capability, not one flag for video.
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
        if (state) events.connection?.(state, this.#quality);
        break;
      }
      case "encryption":
        if (isEncryptionFailure(payload.state)) events.encryptionError?.(payload.state);
        break;
      case "video_changed":
        events.videoChanged?.();
        break;
    }
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
