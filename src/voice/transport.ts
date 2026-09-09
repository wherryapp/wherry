// The media transport seam (docs/prompts/native-media-plan.md §4): what a
// voice session needs from "the thing that captures, encrypts, sends,
// receives and plays audio", written down as an interface so that there
// can be two of them -- the webview's (livekit-client, `transport-
// webview.ts`, every platform today) and, on desktop, one that lives in
// the Tauri shell. The same shape as `E2EProvider`, `Storage`, `Mailer`
// and `VoiceProvider`: one interface, implementations chosen in
// `index.ts`, and nothing else in the client imports the SDK.
//
// Three things about the shape, decided on purpose:
//
// - No DOM. The per-participant <audio> elements, `setSinkId` and the
//   autoplay policy are the webview implementation's business; this
//   interface speaks in participants and volumes.
// - `startPlayback` survives as a concept the native side answers with a
//   no-op, so the UI never asks which transport it has; `playbackBlocked`
//   simply never becomes true there.
// - The call key is a secret and an epoch, nothing more. How it becomes a
//   frame key (HKDF into the SDK's keyring at the epoch's index) is each
//   implementation's, and the derivation itself stays in keys.ts, which
//   imports no SDK at all.
//
// Everything here is plain data or a method; no livekit type may appear
// in this file.

import type { EchoReport, VideoQualityRequest, VideoSource } from "./rules";

// `VideoSource` and `VideoQualityRequest` live in rules.ts, beside the
// pure decision that produces one (`subscriptionFor`), and are re-exported
// here so a caller that only knows the seam does not have to know that.
// The direction of the dependency is the same as `EchoReport`'s and
// `keyIndexFor`'s: rules.ts is the leaf and imports no transport.
export type { VideoQualityRequest, VideoSource } from "./rules";

/**
 * What this transport can actually do with video, asked after connect and
 * never inferred from a platform name. Video in v1 publishes and renders
 * through the webview transport only: the Rust SDK the desktop shell links
 * has no camera capture and no path from a received frame to the webview
 * (docs/prompts/video-execution-handoff.md §0), so the native transport
 * answers false to all three and the bar offers to switch engine for the
 * call. Stage 3N fills the second implementation in and this answer flips
 * on its own.
 */
export type TransportCapabilities = {
  /** This transport can publish a camera. */
  camera: boolean;
  /** ... and a screen (getDisplayMedia present, or 3N). */
  screen: boolean;
  /** ... and can put a received video track on an element. */
  renderVideo: boolean;
};

/**
 * The publish ceilings for this call, already resolved by the server and
 * narrowed by `transport-rules.ts`'s `videoOptionsFor`. `codec` is pinned
 * to H.264 while frame encryption exists at all: AV1 is refused outright
 * by livekit-client's E2EE worker, and the refusal is silent from the
 * publisher's side (the plan's §9.1), which is why `videoCodecFor` is a
 * tested function rather than a literal at the call site.
 */
export type TransportVideoOptions = {
  codec: "h264";
  camera: { maxHeight: number; maxFps: number } | null;
  screen: { maxHeight: number; maxFps: number } | null;
};

/**
 * The microphone's processing switches. The webview implementation hands
 * them to the browser (getUserMedia constraints, so the browser's own
 * canceller, suppressor and gain control); the native one to WebRTC's
 * software audio processing module in the shell. Fixed for the call at
 * connect time on both.
 */
export type AudioProcessing = {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

export type TransportConnectOptions = {
  url: string;
  token: string;
  /** Frame encryption on (never for a public room). */
  e2ee: boolean;
  /** Opus ceiling for what this device sends, in bits per second. */
  maxBitrate: number;
  processing: AudioProcessing;
  /** `deviceId`s from enumerateDevices; null = the platform default. */
  micDeviceId: string | null;
  speakerDeviceId: string | null;
  /**
   * The first call key, in the keyring *before* the connection is made
   * so the first frames are not dropped against an empty ring. Required
   * when `e2ee` is true; later epochs arrive through `setEpochKey`.
   */
  key: { secret: Uint8Array; epoch: number } | null;
  /** Publish ceilings, from the join result's grant. Sizing the encoder
   *  at connect is the only moment simulcast layers can be chosen. */
  video: TransportVideoOptions;
};

export type TransportConnectionState = "connected" | "reconnecting" | "disconnected";

/**
 * Which of somebody's audio tracks is meant.
 *
 * A screen share may carry its own audio, and from 2026-09-09 that is a
 * separate thing from a person's voice everywhere it could be confused:
 * separate volume (the maintainer's decision — turning a colleague down
 * must not turn down the film they are showing you), separate mute state,
 * and a diagnostics readout that describes the microphone rather than
 * whichever track happened to be first. Before this, both would have been
 * "their audio", and a screen with sound would have made a muted person
 * read as unmuted.
 */
export type AudioKind = "microphone" | "screen";

/** One remote participant as the transport sees them, one per device. */
export type TransportParticipant = {
  identity: string;
  /** The account behind the device; falls back to the identity. */
  userId: string;
  name: string;
  speaking: boolean;
  micMuted: boolean;
  /** Whether their tracks arrive frame-encrypted. */
  encrypted: boolean;
  /** Their screen share carries audio as well as picture. Never folded
   *  into `micMuted`; it has its own volume. */
  screenAudio: boolean;
  /** 0..1, the SFU's reading of their signal — the microphone's. */
  audioLevel: number;
  /** A camera publication exists for them, muted or not. The tile draws
   *  from this; whether it is *subscribed* is the viewer's own choice. */
  camera: boolean;
  screen: boolean;
  /**
   * That publication is muted -- which is what "camera off" and the
   * background pause both actually are.
   *
   * Worth stating because it is not what it looks like: livekit-client's
   * `setCameraEnabled(false)` **mutes** the publication and stops the
   * underlying device track; it does not unpublish (a *screen* share, by
   * contrast, is unpublished, which is why there is no muted screen). So a
   * peer whose camera is off still has a camera publication, and without
   * this flag their tile would be an indefinitely black rectangle instead
   * of an honest "camera paused" -- exactly the frozen-frame outcome the
   * plan's §2 set out to avoid.
   */
  cameraMuted: boolean;
};

/** What the session wants to hear about. Every handler is optional. */
export type TransportEvents = {
  /** Somebody joined; the session stops its own ringback on this. */
  participantJoined?: () => void;
  participantLeft?: () => void;
  /** Roster, mute, speaker or encryption status changed: re-read
   *  `participants()`. Speaker changes are throttled by the session. */
  rosterChanged?: () => void;
  speakersChanged?: () => void;
  connection?: (state: TransportConnectionState, quality: VoiceQuality) => void;
  playbackChanged?: (blocked: boolean) => void;
  /** A frame this device could not open; `reason` is the SDK's word. */
  encryptionError?: (reason: string) => void;
  /** A video publication appeared or went: re-read `participants()` and
   *  re-attach. Separate from `rosterChanged` because a tile remounting
   *  is expensive where a name changing is not. */
  videoChanged?: () => void;
};

export type VoiceQuality = "excellent" | "good" | "poor" | "lost" | "unknown";

/** The local microphone's flags, for rules.ts's `micStatus`. */
export type TransportMicReport = {
  published: boolean;
  muted: boolean;
  systemMuted: boolean;
  ended: boolean;
};

export type TransportPeerStats = {
  identity: string;
  bytesReceived: number | null;
  /** inbound-rtp totalAudioEnergy: energy of the *decoded* audio. */
  audioEnergy: number | null;
  concealedSamples: number | null;
  /** Whether playback for them is running; null when nothing to play. */
  playing: boolean | null;
};

/**
 * One video track's reading, sent or received. Every number is nullable
 * because every one of them is a browser's courtesy: the implementation
 * strings in particular came back null from the Chromium the stage-0
 * spike ran in, which is why nothing here may be *required* to say
 * something useful -- see rules.ts's `videoLine`.
 */
export type TransportVideoStats = {
  /** `"self"` for what this device sends. */
  identity: string;
  source: VideoSource;
  direction: "sent" | "received";
  width: number | null;
  height: number | null;
  fps: number | null;
  /** The codec's own name as the browser spells it ("H264", "VP8"). */
  codec: string | null;
  /** The simulcast layer, where the browser names one (`rid`). */
  layer: string | null;
  /** `encoderImplementation` or `decoderImplementation`: the string that
   *  tells hardware from software on a device nobody can open. */
  implementation: string | null;
  /** `qualityLimitationReason` on a sent track: cpu, bandwidth, none. */
  limitedBy: string | null;
};

/** The shell's own video counters, where the transport renders natively. */
export type NativeVideoSummary = {
  cameraFrames: number | null;
  screenFrames: number | null;
  tiles: number;
  bound: number;
  drawn: number;
  dropped: number;
  /** Frames not drawn because the tile was hidden or covered. */
  skipped: number;
};

export type TransportStats = {
  mic: TransportMicReport;
  packetsSent: number | null;
  roundTripMs: number | null;
  echo: EchoReport;
  peers: TransportPeerStats[];
  /** Empty where no video is publishing or subscribed. */
  video: TransportVideoStats[];
  /** Only the native transport has one. */
  native?: NativeVideoSummary | null;
};

/**
 * Which piece of chrome a video element belongs to. The native transport
 * draws a tile *above* the page, so it needs to know whose overlays cover
 * it: the call page's tiles hide under a Popover opened over the page, the
 * bar's thumbnail hides under any overlay at all -- the page included.
 * The webview transport ignores it; its `<video>` is in the document and
 * the document's own stacking does the work.
 */
export type VideoSurface = "page" | "bar";

/** One row in our own screen picker, as the shell enumerated it. */
export type ScreenSource = {
  /** `screen:<id>` or `window:<id>`; opaque to the page except that
   *  `transport-rules.ts` reads the prefix to decide the audio mode. */
  id: string;
  title: string;
  isScreen: boolean;
};

/** What the person chose in that picker. */
export type ScreenChoice = {
  sourceId: string;
  /** Publish the shared thing's sound alongside the picture. */
  audio: boolean;
};

/** How the frame cipher is applied: the browser SDK's two mechanisms, none
 *  at all, or the shell's own engine (libwebrtc's FrameCryptor in-process). */
export type FrameTransformKind = "encoded-streams" | "script-transform" | "none" | "native";

export interface VoiceTransport {
  connect(options: TransportConnectOptions, events: TransportEvents): Promise<void>;
  /** What this transport can do with video. Constant for its lifetime;
   *  read after connect so the bar can disable rather than hide. */
  capabilities(): TransportCapabilities;
  /** Idempotent; safe to call when never connected. */
  disconnect(): Promise<void>;

  setMicrophoneEnabled(on: boolean): Promise<void>;
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;

  /** The conversation's exporter secret for `epoch`, to be used from now. */
  setEpochKey(secret: Uint8Array, epoch: number): Promise<void>;

  /** `deviceId` null is the platform default camera. */
  setCameraEnabled(on: boolean, deviceId: string | null): Promise<void>;
  /**
   * What this transport can share, for a picker of our own to draw.
   *
   * Empty means **the transport opens a picker itself** and the caller
   * must not draw one: `getDisplayMedia` is its own picker in a browser,
   * and so is the OS sheet on macOS. A non-empty list means there is no
   * picker to open — Windows, where WebView2 has none either (S-00) — and
   * the choice has to be made before `setScreenShareEnabled` is called.
   */
  screenSources(): Promise<ScreenSource[]>;
  /** `audience` is the call's size at publish time; the transport steps a
   *  large call's screen down one height (transport-rules.ts). `choice` is
   *  required exactly where `screenSources` answered non-empty. */
  setScreenShareEnabled(
    on: boolean,
    audience?: number,
    choice?: ScreenChoice | null,
  ): Promise<void>;

  /**
   * The one DOM crossing on this interface, and it is on purpose: audio
   * needed no surface, video does, and adaptive streaming measures the
   * *attached element* to decide which layer to ask for -- so the element
   * cannot stay on the UI side of the seam. `identity` is `"self"` for the
   * local preview, which is what keeps a second method off the interface.
   * Returns the detach; calling it twice is safe.
   */
  attachVideo(
    identity: string | "self",
    source: VideoSource,
    element: HTMLVideoElement,
    surface: VideoSurface,
  ): () => void;

  /**
   * Something is drawn over `surface`, or no longer is (ui/back.ts's
   * overlay depth, decided in the call page and the bar). A no-op on a
   * transport whose video lives in the document.
   */
  setSurfaceCovered(surface: VideoSurface, covered: boolean): void;

  /** Subscribe, unsubscribe, and pick the simulcast layer, in one verb --
   *  the three are one decision (`rules.ts`'s `subscriptionFor`). */
  setVideoSubscription(
    identity: string,
    source: VideoSource,
    quality: VideoQualityRequest,
  ): void;

  /** This listener's own volume for one account's devices, 0..1: a gain on
   *  what this device plays, never sent anywhere. `kind` says which of
   *  their tracks — a person's voice and the sound of what they are
   *  sharing are two controls. */
  setParticipantVolume(userId: string, volume: number, kind: AudioKind): void;

  /** The browser's autoplay tap; a no-op where playback needs none. */
  startPlayback(): Promise<void>;
  playbackBlocked(): boolean;

  participants(): TransportParticipant[];
  /** 0..1, the SFU's reading of this device's own signal. */
  localAudioLevel(): number;
  quality(): VoiceQuality;

  /** One reading; never throws, numbers it cannot get are null. */
  sampleStats(): Promise<TransportStats | null>;
  frameTransform(): FrameTransformKind;
}
