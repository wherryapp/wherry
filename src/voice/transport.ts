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

import type { EchoReport } from "./rules";

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
};

export type TransportConnectionState = "connected" | "reconnecting" | "disconnected";

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
  /** 0..1, the SFU's reading of their signal. */
  audioLevel: number;
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

export type TransportStats = {
  mic: TransportMicReport;
  packetsSent: number | null;
  roundTripMs: number | null;
  echo: EchoReport;
  peers: TransportPeerStats[];
};

/** How the frame cipher is applied: the browser SDK's two mechanisms, none
 *  at all, or the shell's own engine (libwebrtc's FrameCryptor in-process). */
export type FrameTransformKind = "encoded-streams" | "script-transform" | "none" | "native";

export interface VoiceTransport {
  connect(options: TransportConnectOptions, events: TransportEvents): Promise<void>;
  /** Idempotent; safe to call when never connected. */
  disconnect(): Promise<void>;

  setMicrophoneEnabled(on: boolean): Promise<void>;
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;

  /** The conversation's exporter secret for `epoch`, to be used from now. */
  setEpochKey(secret: Uint8Array, epoch: number): Promise<void>;

  /** This listener's own volume for one account's devices, 0..1: a gain on
   *  what this device plays, never sent anywhere. */
  setParticipantVolume(userId: string, volume: number): void;

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
