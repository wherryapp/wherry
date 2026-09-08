// The one voice session per browser profile (docs/prompts/voice-plan.md
// §6.1): a call's lifecycle, the key, and the state the UI renders. Since
// the VoiceTransport seam (docs/prompts/native-media-plan.md §4) this file
// imports no media SDK at all: the Room, the microphone, the remote audio
// and the frame-encryption worker are the transport's (transport-
// webview.ts today), chosen in index.ts; what is left here is every
// decision -- when to join, which key, what to tell the server, what the
// bar shows.
//
// What it talks to, and what it deliberately does not:
//
// - The app server, exactly three times per call: to obtain a token
//   (start/answer/join), and to say we left. Nothing about a call in
//   progress needs it -- media and signalling are held with the SFU
//   directly, which is what lets a call survive a server deploy.
// - The MLS provider, for the call key (keys.ts) and, every couple of
//   seconds while in an E2EE call, for the group's epoch: a turn means a
//   membership change, and the key follows it. Polled rather than pushed
//   because the sweep that applies commits may run in another tab; one
//   IndexedDB read per two seconds is nothing.
// - The other tabs, over the existing BroadcastChannel, so they can say
//   "in a call in another window" rather than offer a second session. The
//   session itself is guarded by a Web Lock, the way sync leadership is.
//
// Never throws into a caller: every public method resolves, and failures
// land in `state.error`. A throw anywhere near the sync loop has wedged all
// tap input before (CLAUDE.md), and a voice failure must cost a call, never
// the app.

import {
  ApiError,
  answerCall,
  joinVoiceRoom,
  leaveCall,
  leaveVoiceRoom,
  startCall,
} from "../api/client";
import { loadSession } from "../api/session";
import type { Call, CallKind, HubVisibility, JoinResult, VideoLimits } from "../api/types";
import { isServerReadable } from "../api/hub-class";
import { SHELL } from "../api/shell";
import { e2e } from "../crypto";
import { sync, type SyncEvent } from "../sync/engine";
import { broadcast, subscribeToBroadcasts } from "../sync/leader";
import { mlsSync } from "../sync/mls";
import { createTransport } from "./index";
import { deriveCallKey } from "./keys";
import { listVideoDevices } from "./devices";
import { loadVoicePrefs, saveVoicePrefs } from "./prefs";
import {
  audioPresetFor,
  cameraOnVisibility,
  grantLine,
  micStatus,
  shouldJoinMuted,
  subscriptionFor,
  videoLine,
  type EchoReport,
  type MicFailure,
  type MicStatus,
  type VideoSource,
} from "./rules";
import { videoOptionsFor } from "./transport-rules";
import { blip, startRingback } from "./sounds";
import type {
  FrameTransformKind,
  TransportCapabilities,
  VoiceQuality,
  VoiceTransport,
} from "./transport";

export type { VoiceQuality } from "./transport";

/** What a join needs to know about the conversation: the id, and the
 *  content class that decides whether media is frame-encrypted. Both the
 *  wire Conversation and the stored one (where the field is optional on
 *  rows from before hubs) satisfy it; absent means sealed. */
export type VoiceTarget = { id: string; hubVisibility?: HubVisibility | null | undefined };

export type VoicePhase =
  | "idle"
  /** Token obtained or being obtained, key being derived, SFU connecting. */
  | "connecting"
  | "connected"
  | "reconnecting"
  /** Another tab of this profile holds the session. */
  | "elsewhere";

export type VoiceParticipant = {
  userId: string;
  /** The device id -- one participant per device. */
  identity: string;
  name: string;
  speaking: boolean;
  micMuted: boolean;
  /** Whether the SFU reports this participant's tracks as E2EE. */
  encrypted: boolean;
  /** 0..1, this listener's own volume for them. */
  volume: number;
  /** A camera publication exists for them, muted or not; likewise a
   *  screen. What the stage draws a tile from. */
  camera: boolean;
  screen: boolean;
  /** Their camera publication is muted -- their camera is off, or their app
   *  is in the background. The tile says "camera paused" rather than
   *  showing a black rectangle; see TransportParticipant for why a camera
   *  turned off is a muted publication and not an absent one. */
  cameraMuted: boolean;
};

export type VoiceState = {
  phase: VoicePhase;
  conversationId: string | null;
  kind: CallKind | null;
  /** The latest server view; participants there are the invite/answer
   *  record, participants below are who the SFU says is present. */
  call: Call | null;
  /** Frame encryption is on for this session (never for a public room). */
  e2ee: boolean;
  /** The MLS epoch the current key came from; null while none is set. */
  keyEpoch: number | null;
  micMuted: boolean;
  /** The browser refused to play audio until a tap (transport.startPlayback). */
  playbackBlocked: boolean;
  participants: VoiceParticipant[];
  quality: VoiceQuality;
  /** Human-readable, for the bar; null when nothing is wrong. */
  error: string | null;
  /** When this device connected; null before. */
  connectedAt: number | null;
  /** Rings we still hear ourselves: "Calling…" until somebody answers. */
  ringing: boolean;
  /**
   * Frames this device could not open, and the transport's reason for the
   * last one. A few are expected at an epoch turn; a count that keeps
   * climbing while a peer speaks means their key differs from ours -- the
   * one failure the roster's `encrypted` flag cannot show, since the SFU
   * only knows that frames are sealed, not under what.
   */
  encryptionErrors: number;
  lastEncryptionError: string | null;
  /** What the server allowed this device to publish in this call; null
   *  outside a call, and on a server predating video. */
  grant: VideoLimits | null;
  /** What this transport can do with video. All false on the desktop
   *  shell's native engine until stage 3N -- the bar disables its buttons
   *  and offers `switchEngineForThisCall`. */
  capabilities: TransportCapabilities;
  /** `paused` is the background pause (rules.ts's `cameraOnVisibility`),
   *  which is a *remembered* on rather than an off: coming back to the
   *  foreground republishes, and nothing else does. */
  camera: { on: boolean; paused: boolean };
  screen: { on: boolean };
  /** The identity whose tile is enlarged, or null for the grid. */
  pinned: string | null;
  /** This call is running on the webview engine because the person asked
   *  for video on a shell that has none. Cleared on teardown; the
   *  `nativeMedia` preference is never touched. */
  engineOverride: "webview" | null;
};

const NO_CAPABILITIES: TransportCapabilities = {
  camera: false,
  screen: false,
  renderVideo: false,
};

const IDLE: VoiceState = {
  phase: "idle",
  conversationId: null,
  kind: null,
  call: null,
  e2ee: false,
  keyEpoch: null,
  micMuted: false,
  playbackBlocked: false,
  participants: [],
  quality: "unknown",
  error: null,
  connectedAt: null,
  ringing: false,
  encryptionErrors: 0,
  lastEncryptionError: null,
  grant: null,
  capabilities: NO_CAPABILITIES,
  camera: { on: false, paused: false },
  screen: { on: false },
  pinned: null,
  engineOverride: null,
};

/** One peer's row in the call details: the SFU's view of their signal,
 *  and this device's inbound stats for their track. */
export type PeerDiagnostics = {
  identity: string;
  name: string;
  /** 0..1 as the SFU reports it: the RTP audio-level extension, which
   *  their encoder sets from the raw audio before any frame encryption,
   *  so it reads true for a peer this device cannot decrypt. */
  level: number;
  speaking: boolean;
  encrypted: boolean;
  bytesReceived: number | null;
  /** inbound-rtp totalAudioEnergy: energy of the *decoded* audio. */
  audioEnergy: number | null;
  concealedSamples: number | null;
  /** Playback for them is running; null when nothing is attached. */
  playing: boolean | null;
};

/** One sample of where the sound is. rules.ts turns two into words. */
export type VoiceDiagnostics = {
  at: number;
  mic: MicStatus;
  /** 0..1, the SFU's reading of this device's signal. */
  micLevel: number;
  packetsSent: number | null;
  roundTripMs: number | null;
  /**
   * The echo canceller's own reading from the audio source stats
   * (`media-source`): ERL and ERLE in dB on Chromium, both null on
   * WebKit, which reports neither. rules.ts turns them into words.
   */
  echo: EchoReport;
  peers: PeerDiagnostics[];
  encryptionErrors: number;
  lastEncryptionError: string | null;
  keyEpoch: number | null;
  e2ee: boolean;
  /** How this transport applies the frame transform (the webview SDK
   *  picks encoded streams on Chromium and the script transform elsewhere). */
  transform: FrameTransformKind;
  playbackBlocked: boolean;
  quality: VoiceQuality;
  /** What this call would allow this device to send, in one sentence. */
  grant: string;
  /** What this transport can actually do with video. In the readout
   *  because "the camera button is disabled" and "this call does not allow
   *  a camera" are different answers and only one of them is fixable from
   *  here -- and because the desktop shell relays no console, so this is
   *  the only place its answer can be read. */
  capabilities: TransportCapabilities;
  /** One row per video track, sent or received, already worded. */
  video: { label: string; line: string }[];
};

const LOCK_NAME = "messenger.voice";
const EPOCH_POLL_MS = 2_000;
const KEY_WAIT_MS = 20_000;
/** How often a frame that would not open may trigger a group reconcile. */
const KEY_NUDGE_MS = 10_000;
/** Speaker changes arrive several times a second while anyone talks; the
 *  roster re-renders at most this often. Power, on the phones. */
const SPEAKER_REFRESH_MS = 250;

/**
 * Whether this device's platform stops camera capture in the background on
 * its own -- which is the only reason the background pause exists
 * (rules.ts's `cameraOnVisibility`).
 *
 * A phone does: WKWebView mutes capture when an iOS app leaves the
 * foreground, and Android blocks it without a foreground service. A
 * desktop does not, and pausing there turned somebody's camera off for the
 * whole call the moment they looked at another tab -- which is exactly
 * what a person does while watching a shared screen.
 *
 * Two ways of asking, because neither is sufficient alone. `SHELL` is
 * baked at build time and is definitive for the two phone bundles. Mobile
 * *web* has no such marker, so it is sensed by the absence of any fine
 * pointer -- `any-pointer` rather than `pointer` for the reason
 * ui/viewport.ts spells out: a touchscreen laptop reports a coarse
 * *primary* pointer while still having a mouse, and gating on the primary
 * pointer would put that machine back on the phone rule it does not need.
 * A device with no fine pointer anywhere is a phone or a tablet.
 *
 * Erring towards *not* pausing is the safe direction: the cost of a wrong
 * "desktop" is a frozen tile the platform was going to freeze anyway, and
 * the cost of a wrong "phone" is a camera that dies on every tab switch.
 */
function capturePausesInBackground(): boolean {
  if (SHELL === "ios" || SHELL === "android") return true;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia("(any-pointer: fine)").matches;
}

type JoinPlan = {
  kind: CallKind;
  conversation: VoiceTarget;
  obtain: () => Promise<JoinResult>;
};

class VoiceSession {
  #state: VoiceState = IDLE;
  #listeners = new Set<() => void>();
  /** The transport for the call in progress; null between calls. */
  #transport: VoiceTransport | null = null;
  #releaseLock: (() => void) | null = null;
  #epochTimer: ReturnType<typeof setInterval> | null = null;
  #unsubscribeSync: (() => void) | null = null;
  #unsubscribeBroadcasts: (() => void) | null = null;
  #ringback: { stop: () => void } | null = null;
  #volumes = new Map<string, number>();
  #leaving = false;
  /** How getUserMedia failed, if it did, for the details' mic row. */
  #micFailure: MicFailure | null = null;
  /** When a frame last sent the group to reconcile (see #nudgeGroup). */
  #lastNudge = 0;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Frames that failed to open, counted here and flushed to state on the
   *  roster's throttle: a mismatch fails every frame, fifty a second. */
  #encryptionErrors = 0;
  #lastEncryptionError: string | null = null;
  /** Set once at import: another tab's "I hold the session" claim. */
  #watchingTabs = false;
  /** The join that is running, kept so the engine switch can re-run it. */
  #plan: JoinPlan | null = null;
  /** Which tiles are on screen, keyed `identity/source` -- the input to
   *  `subscriptionFor`, held here rather than in state because it changes
   *  on every scroll and must not re-render the roster. */
  #visibleTiles = new Set<string>();
  #onVisibility: (() => void) | null = null;

  getState = (): VoiceState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#watchTabs();
    return () => this.#listeners.delete(listener);
  };

  // -- public actions ------------------------------------------------------

  async startCall(conversation: VoiceTarget): Promise<void> {
    await this.#join({
      kind: "call",
      conversation,
      obtain: () => startCall(conversation.id),
    });
  }

  async answerCall(callId: string, conversation: VoiceTarget): Promise<void> {
    await this.#join({
      kind: "call",
      conversation,
      obtain: () => answerCall(callId),
    });
  }

  async joinRoom(conversation: VoiceTarget): Promise<void> {
    await this.#join({
      kind: "room",
      conversation,
      obtain: () => joinVoiceRoom(conversation.id),
    });
  }

  /** Leave, telling the server; also the starter's cancel while ringing. */
  async leave(): Promise<void> {
    await this.#teardown({ tellServer: true, error: null });
  }

  async setMicMuted(muted: boolean): Promise<void> {
    const transport = this.#transport;
    if (!transport) return;
    try {
      await transport.setMicrophoneEnabled(!muted);
      this.#micFailure = null;
      this.#set({ micMuted: muted, error: null });
      blip(muted ? "mute" : "unmute");
    } catch (error) {
      this.#micFailure = micFailure(error);
      this.#set({ micMuted: true, error: micError(error) });
    }
  }

  toggleMic(): Promise<void> {
    return this.setMicMuted(!this.#state.micMuted);
  }

  async setMicDevice(deviceId: string): Promise<void> {
    const transport = this.#transport;
    if (!transport) return;
    try {
      await transport.setInputDevice(deviceId);
    } catch (error) {
      this.#set({ error: micError(error) });
    }
  }

  async setSpeakerDevice(deviceId: string): Promise<void> {
    const transport = this.#transport;
    if (!transport) return;
    try {
      await transport.setOutputDevice(deviceId);
    } catch {
      // No setSinkId here (Safari): the picker is hidden there anyway.
    }
  }

  setVolume(userId: string, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.#volumes.set(userId, clamped);
    this.#transport?.setParticipantVolume(userId, clamped);
    this.#refreshParticipants();
  }

  // -- video ---------------------------------------------------------------

  async setCameraEnabled(on: boolean): Promise<void> {
    const transport = this.#transport;
    if (!transport) return;
    try {
      await transport.setCameraEnabled(on, loadVoicePrefs().cameraDeviceId);
      // `paused` is cleared either way: turning the camera off by hand is
      // a decision the background resume must not undo.
      this.#set({ camera: { on, paused: false }, error: null });
    } catch (error) {
      this.#set({ camera: { on: false, paused: false }, error: publishError(error) });
    }
  }

  toggleCamera(): Promise<void> {
    return this.setCameraEnabled(!this.#state.camera.on);
  }

  /** Switch camera without stopping: a republish on the new device. */
  async setCameraDevice(deviceId: string): Promise<void> {
    saveVoicePrefs({ cameraDeviceId: deviceId });
    if (!this.#state.camera.on) return;
    await this.setCameraEnabled(true);
  }

  /**
   * Front to back on a phone. There is no `facingMode` switch on a
   * publication, so this is the device picker under another name: the
   * cameras are enumerated and the next one after the current is chosen,
   * which is what a two-camera phone means by "flip" and degrades sanely
   * on a laptop with one.
   */
  async flipCamera(): Promise<void> {
    const devices = await listVideoDevices();
    if (devices.length < 2) return;
    const current = loadVoicePrefs().cameraDeviceId;
    const index = devices.findIndex((device) => device.deviceId === current);
    const next = devices[(index + 1) % devices.length];
    if (next) await this.setCameraDevice(next.deviceId);
  }

  async setScreenShareEnabled(on: boolean): Promise<void> {
    const transport = this.#transport;
    if (!transport) return;
    try {
      await transport.setScreenShareEnabled(on, this.#state.participants.length + 1);
      this.#set({ screen: { on }, error: null });
    } catch (error) {
      // A cancelled picker is not a failure worth a red line, but it is
      // the same DOMException a refusal raises, so the message covers
      // both and the state goes back to off either way.
      this.#set({ screen: { on: false }, error: on ? publishError(error) : null });
    }
  }

  toggleScreenShare(): Promise<void> {
    return this.setScreenShareEnabled(!this.#state.screen.on);
  }

  /**
   * Hand a tile's `<video>` to the transport, and get the detach back.
   *
   * The session forwards rather than handing the transport out, so nothing
   * outside `index.ts` ever learns which engine it got -- the same reason
   * `startPlayback` survives as a concept the native side answers with a
   * no-op. A transport that cannot render answers with a no-op detach and
   * the tile draws its placeholder.
   */
  attachVideo(identity: string, source: VideoSource, element: HTMLVideoElement): () => void {
    return this.#transport?.attachVideo(identity, source, element) ?? (() => {});
  }

  /** A tile came on or off screen. Drives subscribe/unsubscribe and layer. */
  setTileVisible(identity: string, source: VideoSource, visible: boolean): void {
    const key = `${identity}/${source}`;
    if (visible) this.#visibleTiles.add(key);
    else this.#visibleTiles.delete(key);
    this.#applySubscription(identity, source);
  }

  pin(identity: string | null): void {
    if (this.#state.pinned === identity) return;
    const previous = this.#state.pinned;
    this.#set({ pinned: identity });
    // Only the two tiles whose answer can have changed.
    for (const who of [previous, identity]) {
      if (!who) continue;
      for (const source of ["camera", "screen"] as const) this.#applySubscription(who, source);
    }
  }

  /**
   * Rejoin this one call through the webview engine.
   *
   * The desktop shell's native engine has no camera capture and no way to
   * put a received frame on screen (docs/prompts/video-execution-handoff.md
   * §0), so somebody who wants video on this device pays one reconnect --
   * a second or two of silence -- and gets it. The `nativeMedia`
   * preference is deliberately untouched: they did not change their mind
   * about audio, and the next call starts on their engine again.
   *
   * `tellServer: false` on the way out: the participant row is about to be
   * re-taken by the same device, and telling the server we left would end
   * a one-person call underneath us.
   */
  async switchEngineForThisCall(): Promise<void> {
    const plan = this.#plan;
    if (!plan || this.#state.engineOverride === "webview") return;
    await this.#teardown({ tellServer: false, error: null, keepPlan: true });
    this.#set({ engineOverride: "webview" });
    await this.#join(plan, "webview");
  }

  /** From a tap: the browser's autoplay policy needs one. */
  async startAudio(): Promise<void> {
    const transport = this.#transport;
    if (!transport) return;
    try {
      await transport.startPlayback();
      this.#set({ playbackBlocked: transport.playbackBlocked() });
    } catch {
      this.#set({ playbackBlocked: true });
    }
  }

  /**
   * One reading of where the sound is, for the bar's details. The numbers
   * are the transport's; the mic's permission failure and the encryption
   * counters are this session's. Null when there is no call to read.
   */
  async sampleDiagnostics(): Promise<VoiceDiagnostics | null> {
    const transport = this.#transport;
    if (!transport) return null;
    const state = this.#state;
    const stats = await transport.sampleStats();
    if (!stats) return null;

    const roster = new Map(transport.participants().map((p) => [p.identity, p]));
    const peers: PeerDiagnostics[] = stats.peers.map((peer) => {
      const known = roster.get(peer.identity);
      return {
        identity: peer.identity,
        name: known?.name ?? peer.identity,
        level: known?.audioLevel ?? 0,
        speaking: known?.speaking ?? false,
        encrypted: known?.encrypted ?? false,
        bytesReceived: peer.bytesReceived,
        audioEnergy: peer.audioEnergy,
        concealedSamples: peer.concealedSamples,
        playing: peer.playing,
      };
    });
    peers.sort((a, b) => a.name.localeCompare(b.name));

    return {
      at: Date.now(),
      mic: micStatus({ ...stats.mic, failure: this.#micFailure }),
      micLevel: transport.localAudioLevel(),
      packetsSent: stats.packetsSent,
      roundTripMs: stats.roundTripMs,
      echo: stats.echo,
      peers,
      encryptionErrors: this.#encryptionErrors,
      lastEncryptionError: this.#lastEncryptionError,
      keyEpoch: state.keyEpoch,
      e2ee: state.e2ee,
      transform: transport.frameTransform(),
      playbackBlocked: state.playbackBlocked,
      quality: state.quality,
      grant: grantLine(state.grant),
      capabilities: state.capabilities,
      video: stats.video.map((track) => ({
        label:
          track.identity === "self"
            ? `Your ${track.source === "camera" ? "camera" : "screen"}`
            : `${roster.get(track.identity)?.name ?? track.identity}'s ${
                track.source === "camera" ? "camera" : "screen"
              }`,
        line: videoLine(track),
      })),
    };
  }

  // -- joining -------------------------------------------------------------

  async #join(plan: JoinPlan, engineOverride: "webview" | null = null): Promise<void> {
    if (this.#state.phase !== "idle" && this.#state.phase !== "elsewhere") {
      if (this.#state.conversationId === plan.conversation.id) return;
      // Switching rooms: out of the old one first, then in.
      await this.#teardown({ tellServer: true, error: null });
    }
    if (!(await this.#acquireLock())) {
      this.#set({ ...IDLE, phase: "elsewhere", error: "You are in a call in another window." });
      return;
    }
    this.#leaving = false;
    this.#plan = plan;
    // Sealed unless the conversation says the server may read it: a
    // public or invite-only hub channel relays media in the clear, the
    // media half of the readable-hub exception (CLAUDE.md rule 1).
    const e2ee = !isServerReadable(plan.conversation.hubVisibility ?? null);
    this.#set({
      ...IDLE,
      phase: "connecting",
      conversationId: plan.conversation.id,
      kind: plan.kind,
      e2ee,
      engineOverride,
    });

    let result: JoinResult;
    try {
      result = await plan.obtain();
    } catch (error) {
      await this.#teardown({ tellServer: false, error: joinError(error) });
      return;
    }
    this.#set({ call: result.call });

    let derived: { epoch: number; secret: Uint8Array } | null = null;
    if (e2ee) {
      derived = await this.#deriveKeyWithPatience(plan.conversation.id, result.call.id);
      if (!derived) {
        await this.#teardown({
          tellServer: true,
          error: "Encryption for this conversation is not ready on this device yet. Try again in a moment.",
        });
        return;
      }
    }

    const prefs = loadVoicePrefs();
    const grant = result.video ?? null;
    const transport = createTransport(engineOverride);
    this.#transport = transport;
    try {
      await transport.connect(
        {
          url: result.url,
          token: result.token,
          e2ee,
          maxBitrate: audioPresetFor(prefs.audioQuality).maxBitrate,
          processing: {
            echoCancellation: prefs.echoCancellation,
            noiseSuppression: prefs.noiseSuppression,
            autoGainControl: prefs.autoGainControl,
          },
          micDeviceId: prefs.micDeviceId,
          speakerDeviceId: prefs.speakerDeviceId,
          key: derived,
          video: videoOptionsFor(grant, e2ee, prefs.videoQuality),
        },
        this.#events(),
      );
    } catch (error) {
      await this.#teardown({ tellServer: true, error: connectError(error) });
      return;
    }
    for (const [userId, volume] of this.#volumes) transport.setParticipantVolume(userId, volume);

    this.#set({
      phase: "connected",
      connectedAt: Date.now(),
      keyEpoch: derived?.epoch ?? null,
      playbackBlocked: transport.playbackBlocked(),
      ringing: plan.kind === "call" && result.call.status === "ringing",
      grant,
      // Read after connect, never guessed from a platform: the same
      // transport answers differently on a browser without
      // getDisplayMedia.
      capabilities: transport.capabilities(),
    });
    this.#refreshParticipants();
    this.#announce();
    if (this.#state.ringing) this.#ringback = startRingback();

    // The microphone last, so a refused permission leaves a listen-only
    // participant rather than no call at all.
    const startMuted = shouldJoinMuted({
      kind: plan.kind,
      preference: prefs.joinMute,
      serverJoinMuted: result.joinMuted,
    });
    try {
      await transport.setMicrophoneEnabled(true);
      if (startMuted) await transport.setMicrophoneEnabled(false);
      this.#micFailure = null;
      this.#set({ micMuted: startMuted });
    } catch (error) {
      this.#micFailure = micFailure(error);
      this.#set({ micMuted: true, error: micError(error) });
    }

    if (e2ee) this.#watchEpoch(plan.conversation.id, result.call.id);
    this.#watchSync(result.call.id);
    this.#watchVisibility();
    blip("join");
  }

  async #acquireLock(): Promise<boolean> {
    // Already held by this session, so do not ask again.
    //
    // The engine switch (`switchEngineForThisCall`) tears the transport
    // down with `keepPlan` and rejoins, and that teardown deliberately does
    // *not* let the lock go -- the call never left this window. Asking a
    // second time from the context that already holds it is answered "not
    // available" like any other conflict, so the rejoin reported the call as
    // happening in another window and the switch failed every time. Found by
    // D-28 on 2026-09-08, the first run of that row.
    if (this.#releaseLock) return true;
    if (typeof navigator === "undefined" || !("locks" in navigator)) return true;
    return await new Promise<boolean>((resolve) => {
      void navigator.locks
        .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return Promise.resolve();
          }
          return new Promise<void>((release) => {
            this.#releaseLock = release;
            resolve(true);
          });
        })
        .catch(() => resolve(false));
    });
  }

  async #deriveKeyWithPatience(
    conversationId: string,
    callId: string,
  ): Promise<{ epoch: number; secret: Uint8Array } | null> {
    const handshake = e2e.handshake;
    if (!handshake) return null;
    const deadline = Date.now() + KEY_WAIT_MS;
    for (;;) {
      try {
        const derived = await deriveCallKey(handshake, conversationId, callId);
        if (derived) return derived;
      } catch {
        // Treated as "not yet": the sweep may be mid-join.
      }
      if (Date.now() >= deadline || this.#leaving) return null;
      this.#set({ error: "Setting up encryption…" });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  // -- the transport's events ------------------------------------------------

  #events(): Parameters<VoiceTransport["connect"]>[1] {
    return {
      participantJoined: () => {
        this.#stopRingback();
        this.#set({ ringing: false });
        this.#refreshParticipants();
        blip("join");
      },
      participantLeft: () => {
        this.#refreshParticipants();
        blip("leave");
      },
      rosterChanged: () => this.#refreshParticipants(),
      speakersChanged: () => this.#refreshParticipantsSoon(),
      videoChanged: () => {
        this.#refreshParticipants();
        // A publication that appeared after its tile mounted has to be
        // told what that tile wants; a tile that is already visible would
        // otherwise sit unsubscribed until the next scroll.
        this.#applyAllSubscriptions();
      },
      connection: (state, quality) => {
        if (this.#leaving) return;
        if (state === "reconnecting") this.#set({ phase: "reconnecting", quality });
        else if (state === "connected") this.#set({ phase: "connected", quality });
        else {
          // The SFU ended it (a moderator, the room closing, the call
          // ending, or a network the transport gave up on). Nothing to
          // tell the server: it either did this or its webhook already
          // knows.
          void this.#teardown({ tellServer: false, error: "The call ended" });
        }
      },
      playbackChanged: (blocked) => this.#set({ playbackBlocked: blocked }),
      encryptionError: (reason) => {
        // Counted, not surfaced as an error: a few are expected at an
        // epoch turn. The details panel shows the count, which is how a
        // key mismatch is told apart from a silent microphone.
        this.#encryptionErrors += 1;
        this.#lastEncryptionError = reason;
        this.#refreshParticipantsSoon();
        this.#nudgeGroup();
      },
    };
  }

  /**
   * A frame that would not open is the one signal that this device may be
   * behind on the group's epoch when the socket is down (the `mls_commit`
   * frame is the fast path). Ask the sweep to reconcile this conversation
   * now, at most once per KEY_NUDGE_MS -- a mismatch fails fifty frames a
   * second, and the reconcile is a network round trip.
   */
  #nudgeGroup(): void {
    const now = Date.now();
    if (now - this.#lastNudge < KEY_NUDGE_MS) return;
    this.#lastNudge = now;
    const conversationId = this.#state.conversationId;
    const session = loadSession();
    if (!conversationId || !session || !this.#state.e2ee || this.#leaving) return;
    void mlsSync
      .reconcileConversation(conversationId, {
        userId: session.user.id,
        deviceId: session.device.id,
      })
      .catch(() => {
        // The sweep will try again on its own cadence.
      });
  }

  #refreshParticipantsSoon(): void {
    if (this.#refreshTimer) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      this.#refreshParticipants();
    }, SPEAKER_REFRESH_MS);
  }

  #refreshParticipants(): void {
    const transport = this.#transport;
    if (!transport) return;
    const participants: VoiceParticipant[] = transport.participants().map((p) => ({
      userId: p.userId,
      identity: p.identity,
      name: p.name,
      speaking: p.speaking,
      micMuted: p.micMuted,
      encrypted: p.encrypted,
      volume: this.#volumes.get(p.userId) ?? 1,
      camera: p.camera,
      screen: p.screen,
      cameraMuted: p.cameraMuted,
    }));
    participants.sort((a, b) => a.name.localeCompare(b.name));
    this.#set({
      participants,
      encryptionErrors: this.#encryptionErrors,
      lastEncryptionError: this.#lastEncryptionError,
    });
  }

  // -- video subscriptions ---------------------------------------------------

  /**
   * What this viewer asks the SFU for, for one remote track. The decision
   * is `rules.ts`'s `subscriptionFor`; this is the plumbing around it.
   *
   * Skipped entirely where the transport cannot render video: the native
   * engine has no tiles, so nothing is visible, so nothing is asked for --
   * and asking would be a no-op anyway.
   */
  #applySubscription(identity: string, source: VideoSource): void {
    const transport = this.#transport;
    if (!transport || !this.#state.capabilities.renderVideo) return;
    const quality = subscriptionFor({
      visible: this.#visibleTiles.has(`${identity}/${source}`),
      pinned: this.#state.pinned === identity,
      source,
      // Everybody in the room, this device included: the layer cutoff is
      // about how many streams the SFU is fanning out, not how many other
      // people there are.
      participants: this.#state.participants.length + 1,
      topLayerCallSize: this.#state.grant?.topLayerCallSize ?? null,
    });
    transport.setVideoSubscription(identity, source, quality);
  }

  #applyAllSubscriptions(): void {
    for (const participant of this.#state.participants) {
      for (const source of ["camera", "screen"] as const) {
        this.#applySubscription(participant.identity, source);
      }
    }
  }

  /**
   * The background pause (`docs/prompts/video-plan.md` §2). Both phones
   * stop capture when the app leaves the foreground -- iOS forbids it even
   * natively -- so a camera left published while hidden is a frozen frame
   * on everybody else's screen, which is worse than an honest "camera
   * paused" tile. Screen share is not paused: it is desktop-only, and a
   * covered window still has content worth sending.
   *
   * Installed with the call and torn down with it, so nothing listens
   * between calls.
   */
  #watchVisibility(): void {
    if (this.#onVisibility || typeof document === "undefined") return;
    const handler = (): void => {
      const decision = cameraOnVisibility({
        hidden: document.visibilityState === "hidden",
        cameraOn: this.#state.camera.on,
        paused: this.#state.camera.paused,
        platformPausesCapture: capturePausesInBackground(),
      });
      if (decision === "nothing") return;
      const transport = this.#transport;
      if (!transport) return;
      if (decision === "pause") {
        void transport
          .setCameraEnabled(false, null)
          .then(() => this.#set({ camera: { on: true, paused: true } }))
          .catch(() => {});
        return;
      }
      void transport
        .setCameraEnabled(true, loadVoicePrefs().cameraDeviceId)
        .then(() => this.#set({ camera: { on: true, paused: false } }))
        .catch(() => this.#set({ camera: { on: false, paused: false } }));
    };
    document.addEventListener("visibilitychange", handler);
    this.#onVisibility = () => document.removeEventListener("visibilitychange", handler);
  }

  // -- keys over time --------------------------------------------------------

  #watchEpoch(conversationId: string, callId: string): void {
    this.#stopEpochWatch();
    this.#epochTimer = setInterval(() => {
      void this.#refreshKey(conversationId, callId);
    }, EPOCH_POLL_MS);
  }

  async #refreshKey(conversationId: string, callId: string): Promise<void> {
    const handshake = e2e.handshake;
    const transport = this.#transport;
    if (!handshake || !transport || !this.#state.e2ee || this.#leaving) return;
    try {
      const epoch = await handshake.epoch(conversationId);
      if (epoch === null || epoch === this.#state.keyEpoch) return;
      const derived = await deriveCallKey(handshake, conversationId, callId);
      if (!derived) return;
      await transport.setEpochKey(derived.secret, derived.epoch);
      this.#set({ keyEpoch: derived.epoch });
    } catch {
      // Next tick tries again; a stale key drops frames, never the call.
    }
  }

  #stopEpochWatch(): void {
    if (this.#epochTimer) clearInterval(this.#epochTimer);
    this.#epochTimer = null;
  }

  // -- the server's view -----------------------------------------------------

  #watchSync(callId: string): void {
    const handle = (event: SyncEvent): void => {
      if (event.type !== "call_state" || event.callId !== callId) return;
      if (event.error === "VIDEO_OVER_GRANT") {
        // The SFU muted the track; there is nothing to undo locally except
        // the button, which must not keep saying the camera is on.
        this.#set({
          camera: { on: false, paused: false },
          screen: { on: false },
          error: "Your video exceeds this call's limit and was stopped.",
        });
        return;
      }
      const call = this.#state.call;
      if (call) this.#set({ call: { ...call, status: event.status, endReason: event.reason } });
      if (event.status === "ended" && !this.#leaving) {
        void this.#teardown({ tellServer: false, error: null });
      } else if (event.status === "active" && this.#state.ringing) {
        this.#stopRingback();
        this.#set({ ringing: false });
      }
    };
    this.#unsubscribeSync = sync.subscribe(handle);
    this.#unsubscribeBroadcasts = subscribeToBroadcasts((message) => {
      if (message.type === "call_state") handle(message);
    });
  }

  // -- tabs ------------------------------------------------------------------

  #announce(): void {
    const active = this.#state.phase === "connected" || this.#state.phase === "connecting" || this.#state.phase === "reconnecting";
    broadcast({
      type: "voice-state",
      phase: active ? "active" : "idle",
      callId: this.#state.call?.id ?? null,
      conversationId: this.#state.conversationId,
    });
  }

  #watchTabs(): void {
    if (this.#watchingTabs) return;
    this.#watchingTabs = true;
    subscribeToBroadcasts((message) => {
      if (message.type !== "voice-state") return;
      if (this.#state.phase !== "idle" && this.#state.phase !== "elsewhere") return;
      if (message.phase === "active") {
        this.#set({ ...IDLE, phase: "elsewhere", conversationId: message.conversationId });
      } else if (this.#state.phase === "elsewhere") {
        this.#set({ ...IDLE });
      }
    });
  }

  // -- leaving ---------------------------------------------------------------

  async #teardown(input: {
    tellServer: boolean;
    error: string | null;
    /** The engine switch: the same call is about to be rejoined, so the
     *  plan and the override must survive this teardown. */
    keepPlan?: boolean;
  }): Promise<void> {
    this.#leaving = true;
    this.#micFailure = null;
    this.#encryptionErrors = 0;
    this.#lastEncryptionError = null;
    const { call, kind, conversationId } = this.#state;
    this.#stopRingback();
    this.#stopEpochWatch();
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#unsubscribeSync?.();
    this.#unsubscribeSync = null;
    this.#unsubscribeBroadcasts?.();
    this.#unsubscribeBroadcasts = null;
    this.#onVisibility?.();
    this.#onVisibility = null;
    this.#visibleTiles.clear();
    if (!input.keepPlan) this.#plan = null;

    const transport = this.#transport;
    this.#transport = null;
    if (transport) await transport.disconnect();

    if (input.tellServer && call) {
      try {
        if (kind === "room" && conversationId) await leaveVoiceRoom(conversationId);
        else await leaveCall(call.id);
      } catch {
        // The SFU's departure webhook heals a lost leave.
      }
    }

    if (!input.keepPlan) {
      this.#releaseLock?.();
      this.#releaseLock = null;
    }
    this.#set({ ...IDLE, error: input.error });
    if (!input.keepPlan) {
      this.#announce();
      if (transport) blip("leave");
    }
  }

  #stopRingback(): void {
    this.#ringback?.stop();
    this.#ringback = null;
  }

  #set(patch: Partial<VoiceState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

function micFailure(error: unknown): MicFailure {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "refused";
  if (name === "NotFoundError") return "missing";
  return "failed";
}

function micError(error: unknown): string {
  switch (micFailure(error)) {
    case "refused":
      return "Microphone access was refused. You can listen, but nobody can hear you.";
    case "missing":
      return "No microphone was found.";
    case "failed":
      return "The microphone could not be started.";
  }
}

/** transport-rules.ts already worded it; this only unwraps the Error. */
function publishError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "VOICE_UNAVAILABLE":
        return "Calls are not available on this server yet.";
      case "CALL_ENDED":
        return "That call has already ended.";
      case "RATE_LIMITED":
        return "Too many attempts. Try again in a minute.";
      default:
        return error.message;
    }
  }
  return "Could not reach the server.";
}

function connectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Could not connect to the voice server (${message}).`;
}

export const voice = new VoiceSession();
