// The one voice session per browser profile (docs/prompts/voice-plan.md
// §6.1): a LiveKit Room, the microphone, the remote audio, and the state
// the UI renders. The only file that imports livekit-client's Room.
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
  AudioPresets,
  ConnectionQuality,
  ConnectionState,
  isInsertableStreamSupported,
  isScriptTransformSupported,
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type Participant,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
} from "livekit-client";
import {
  ApiError,
  answerCall,
  joinVoiceRoom,
  leaveCall,
  leaveVoiceRoom,
  startCall,
} from "../api/client";
import { loadSession } from "../api/session";
import type { Call, CallKind, HubVisibility, JoinResult } from "../api/types";
import { e2e } from "../crypto";
import { sync, type SyncEvent } from "../sync/engine";
import { broadcast, subscribeToBroadcasts } from "../sync/leader";
import { mlsSync } from "../sync/mls";
import { CallKeyProvider, deriveCallKey } from "./keys";
import { loadVoicePrefs } from "./prefs";
import { micStatus, shouldJoinMuted, type MicFailure, type MicStatus } from "./rules";
import { blip, startRingback } from "./sounds";

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
};

export type VoiceQuality = "excellent" | "good" | "poor" | "lost" | "unknown";

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
  /** The browser refused to play audio until a tap (room.startAudio). */
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
   * Frames this device could not open, and the SDK's reason for the last
   * one. A few are expected at an epoch turn; a count that keeps climbing
   * while a peer speaks means their key differs from ours -- the one
   * failure the roster's `encrypted` flag cannot show, since the SFU only
   * knows that frames are sealed, not under what.
   */
  encryptionErrors: number;
  lastEncryptionError: string | null;
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
  /** The attached element is playing; null when nothing is attached. */
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
  peers: PeerDiagnostics[];
  encryptionErrors: number;
  lastEncryptionError: string | null;
  keyEpoch: number | null;
  e2ee: boolean;
  /** How this engine applies the frame transform (livekit-client picks
   *  encoded streams on Chromium and the script transform elsewhere). */
  transform: "encoded-streams" | "script-transform" | "none";
  playbackBlocked: boolean;
  quality: VoiceQuality;
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
 * The E2EE worker, one per call, terminated by #teardown.
 *
 * livekit-client never terminates it: the single `terminate()` in the
 * bundle belongs to a different manager, and the E2EE manager binds no
 * Disconnected handler -- so a room that ends leaves its worker running,
 * and whether an engine reclaims an unreferenced dedicated worker is not
 * something to rely on. Idle it costs no CPU, but a thread and its
 * context per call is exactly the kind of accumulation a phone in a long
 * session does not need. Owning the reference makes it one line to close.
 */
function makeWorker(): Worker {
  return new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), {
    type: "module",
  });
}

function userIdOf(participant: Participant): string {
  try {
    const parsed = JSON.parse(participant.metadata ?? "") as { userId?: unknown };
    if (typeof parsed.userId === "string") return parsed.userId;
  } catch {
    // Fall through: identity is the device id, a poor stand-in but never blank.
  }
  return participant.identity;
}

function qualityOf(quality: ConnectionQuality): VoiceQuality {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return "excellent";
    case ConnectionQuality.Good:
      return "good";
    case ConnectionQuality.Poor:
      return "poor";
    case ConnectionQuality.Lost:
      return "lost";
    default:
      return "unknown";
  }
}

type JoinPlan = {
  kind: CallKind;
  conversation: VoiceTarget;
  obtain: () => Promise<JoinResult>;
};

class VoiceSession {
  #state: VoiceState = IDLE;
  #listeners = new Set<() => void>();
  #room: Room | null = null;
  #keys: CallKeyProvider | null = null;
  #releaseLock: (() => void) | null = null;
  #epochTimer: ReturnType<typeof setInterval> | null = null;
  #unsubscribeSync: (() => void) | null = null;
  #unsubscribeBroadcasts: (() => void) | null = null;
  #ringback: { stop: () => void } | null = null;
  #audioHost: HTMLDivElement | null = null;
  #volumes = new Map<string, number>();
  #leaving = false;
  /** How getUserMedia failed, if it did, for the details' mic row. */
  #micFailure: MicFailure | null = null;
  /** When a frame last sent the group to reconcile (see #nudgeGroup). */
  #lastNudge = 0;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** This call's frame-encryption worker; ours to terminate (see above). */
  #worker: Worker | null = null;
  /** Frames that failed to open, counted here and flushed to state on the
   *  roster's throttle: a mismatch fails every frame, fifty a second. */
  #encryptionErrors = 0;
  #lastEncryptionError: string | null = null;
  /** Set once at import: another tab's "I hold the session" claim. */
  #watchingTabs = false;

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
    const room = this.#room;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!muted);
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
    const room = this.#room;
    if (!room) return;
    try {
      await room.switchActiveDevice("audioinput", deviceId);
    } catch (error) {
      this.#set({ error: micError(error) });
    }
  }

  async setSpeakerDevice(deviceId: string): Promise<void> {
    const room = this.#room;
    if (!room) return;
    try {
      await room.switchActiveDevice("audiooutput", deviceId);
    } catch {
      // No setSinkId here (Safari): the picker is hidden there anyway.
    }
  }

  setVolume(userId: string, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.#volumes.set(userId, clamped);
    const room = this.#room;
    if (room) {
      for (const participant of room.remoteParticipants.values()) {
        if (userIdOf(participant) !== userId) continue;
        for (const publication of participant.audioTrackPublications.values()) {
          const track = publication.track as RemoteAudioTrack | undefined;
          track?.setVolume(clamped);
        }
      }
    }
    this.#refreshParticipants();
  }

  /** From a tap: the browser's autoplay policy needs one. */
  async startAudio(): Promise<void> {
    const room = this.#room;
    if (!room) return;
    try {
      await room.startAudio();
      this.#set({ playbackBlocked: !room.canPlaybackAudio });
    } catch {
      this.#set({ playbackBlocked: true });
    }
  }

  /**
   * One reading of where the sound is, for the bar's details. Stats come
   * from the SDK's per-track getStats wrappers; everything else is flags
   * the room already holds. Null when there is no room to read. Never
   * throws: a stats call that fails leaves its numbers null.
   */
  async sampleDiagnostics(): Promise<VoiceDiagnostics | null> {
    const room = this.#room;
    if (!room) return null;
    const state = this.#state;

    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const local = publication?.track as LocalAudioTrack | undefined;
    const mediaTrack = local?.mediaStreamTrack;
    const mic = micStatus({
      published: local !== undefined,
      muted: publication?.isMuted ?? state.micMuted,
      systemMuted: mediaTrack?.muted ?? false,
      ended: mediaTrack?.readyState === "ended",
      failure: this.#micFailure,
    });
    let packetsSent: number | null = null;
    let roundTripMs: number | null = null;
    if (local) {
      try {
        const stats = await local.getSenderStats();
        packetsSent = stats?.packetsSent ?? null;
        roundTripMs =
          stats?.roundTripTime !== undefined ? Math.round(stats.roundTripTime * 1000) : null;
      } catch {
        // Stats are a reading, never a requirement.
      }
    }

    const speaking = new Set(room.activeSpeakers.map((p) => p.identity));
    const peers: PeerDiagnostics[] = [];
    for (const participant of room.remoteParticipants.values()) {
      const audio =
        participant.getTrackPublication(Track.Source.Microphone) ??
        [...participant.audioTrackPublications.values()][0];
      const track = audio?.track as RemoteAudioTrack | undefined;
      let bytesReceived: number | null = null;
      let audioEnergy: number | null = null;
      let concealedSamples: number | null = null;
      if (track) {
        try {
          const stats = await track.getReceiverStats();
          bytesReceived = stats?.bytesReceived ?? null;
          audioEnergy = stats?.totalAudioEnergy ?? null;
          concealedSamples = stats?.concealedSamples ?? null;
        } catch {
          // As above.
        }
      }
      const element = track?.attachedElements[0];
      peers.push({
        identity: participant.identity,
        name: participant.name || userIdOf(participant),
        level: participant.audioLevel,
        speaking: speaking.has(participant.identity),
        encrypted: participant.isEncrypted,
        bytesReceived,
        audioEnergy,
        concealedSamples,
        playing: element ? !element.paused : null,
      });
    }
    peers.sort((a, b) => a.name.localeCompare(b.name));

    return {
      at: Date.now(),
      mic,
      micLevel: room.localParticipant.audioLevel,
      packetsSent,
      roundTripMs,
      peers,
      encryptionErrors: this.#encryptionErrors,
      lastEncryptionError: this.#lastEncryptionError,
      keyEpoch: state.keyEpoch,
      e2ee: state.e2ee,
      transform: isInsertableStreamSupported()
        ? "encoded-streams"
        : isScriptTransformSupported()
          ? "script-transform"
          : "none",
      playbackBlocked: state.playbackBlocked,
      quality: state.quality,
    };
  }

  // -- joining -------------------------------------------------------------

  async #join(plan: JoinPlan): Promise<void> {
    if (this.#state.phase !== "idle" && this.#state.phase !== "elsewhere") {
      if (this.#state.conversationId === plan.conversation.id) return;
      // Switching rooms: out of the old one first, then in.
      await this.#teardown({ tellServer: true, error: null });
    }

    const locked = await this.#acquireLock();
    if (!locked) {
      this.#set({ ...IDLE, phase: "elsewhere" });
      return;
    }

    const e2ee = plan.conversation.hubVisibility !== "public";
    this.#leaving = false;
    this.#set({
      ...IDLE,
      phase: "connecting",
      conversationId: plan.conversation.id,
      kind: plan.kind,
      e2ee,
    });

    let result: JoinResult;
    try {
      result = await plan.obtain();
    } catch (error) {
      await this.#teardown({ tellServer: false, error: joinError(error) });
      return;
    }
    this.#set({ call: result.call });

    let keys: CallKeyProvider | null = null;
    let keyEpoch: number | null = null;
    if (e2ee) {
      const derived = await this.#deriveKeyWithPatience(
        plan.conversation.id,
        result.call.id,
      );
      if (!derived) {
        await this.#teardown({
          tellServer: true,
          error: "Encryption for this conversation is not ready on this device yet. Try again in a moment.",
        });
        return;
      }
      keys = new CallKeyProvider();
      await keys.setEpochKey(derived.secret, derived.epoch);
      keyEpoch = derived.epoch;
    }

    const prefs = loadVoicePrefs();
    // Built before the Room so teardown can terminate exactly the one this
    // call used, even if constructing the Room throws.
    const worker = keys ? makeWorker() : null;
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(prefs.micDeviceId ? { deviceId: prefs.micDeviceId } : {}),
      },
      ...(prefs.speakerDeviceId
        ? { audioOutput: { deviceId: prefs.speakerDeviceId } }
        : {}),
      publishDefaults: { dtx: true, red: true, audioPreset: AudioPresets.speech },
      ...(keys && worker ? { e2ee: { keyProvider: keys, worker } } : {}),
    });
    this.#room = room;
    this.#keys = keys;
    this.#worker = worker;
    this.#wire(room);

    try {
      await room.connect(result.url, result.token);
      if (keys) await room.setE2EEEnabled(true);
    } catch (error) {
      await this.#teardown({ tellServer: true, error: connectError(error) });
      return;
    }

    this.#set({
      phase: "connected",
      connectedAt: Date.now(),
      keyEpoch,
      playbackBlocked: !room.canPlaybackAudio,
      ringing: plan.kind === "call" && result.call.status === "ringing",
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
      await room.localParticipant.setMicrophoneEnabled(true);
      if (startMuted) await room.localParticipant.setMicrophoneEnabled(false);
      this.#micFailure = null;
      this.#set({ micMuted: startMuted });
    } catch (error) {
      this.#micFailure = micFailure(error);
      this.#set({ micMuted: true, error: micError(error) });
    }

    if (keys) this.#watchEpoch(plan.conversation.id, result.call.id);
    this.#watchSync(result.call.id);
    blip("join");
  }

  async #acquireLock(): Promise<boolean> {
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

  // -- the room's events -----------------------------------------------------

  #wire(room: Room): void {
    room
      .on(RoomEvent.ParticipantConnected, () => {
        this.#stopRingback();
        this.#set({ ringing: false });
        this.#refreshParticipants();
        blip("join");
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        this.#refreshParticipants();
        blip("leave");
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        this.#attach(track as RemoteAudioTrack, participant);
        this.#refreshParticipants();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const element of track.detach()) element.remove();
        this.#refreshParticipants();
      })
      .on(RoomEvent.TrackMuted, () => this.#refreshParticipants())
      .on(RoomEvent.TrackUnmuted, () => this.#refreshParticipants())
      .on(RoomEvent.ActiveSpeakersChanged, () => this.#refreshParticipantsSoon())
      .on(RoomEvent.ParticipantEncryptionStatusChanged, () => this.#refreshParticipants())
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant.isLocal) this.#set({ quality: qualityOf(quality) });
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        this.#set({ playbackBlocked: !room.canPlaybackAudio });
      })
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        if (this.#leaving) return;
        if (state === ConnectionState.Reconnecting) this.#set({ phase: "reconnecting" });
        else if (state === ConnectionState.Connected) this.#set({ phase: "connected" });
      })
      .on(RoomEvent.Disconnected, () => {
        if (this.#leaving) return;
        // The SFU ended it (a moderator, the room closing, the call
        // ending, or a network the SDK gave up on). Nothing to tell the
        // server: it either did this or its webhook already knows.
        void this.#teardown({ tellServer: false, error: "The call ended" });
      })
      .on(RoomEvent.EncryptionError, (error) => {
        // Counted, not surfaced as an error: a few are expected at an
        // epoch turn. The details panel shows the count, which is how a
        // key mismatch is told apart from a silent microphone.
        this.#encryptionErrors += 1;
        this.#lastEncryptionError = error instanceof Error ? error.message : String(error);
        this.#refreshParticipantsSoon();
        this.#nudgeGroup();
      });
  }

  /**
   * A frame this device could not open is evidence the group moved --
   * a peer joined or rejoined and turned the epoch, and their frames now
   * carry an index this keyring has no key for. Reconciling this one
   * conversation now is the same repair the outbox runs on EPOCH_STALE;
   * once the commit is applied, the 2-second epoch poll re-keys. Rate
   * limited, because a device that is *ahead* also sees errors (its
   * peer's frames are under the older key) and its reconcile finds
   * nothing to do.
   *
   * The socket's `mls_commit` frame is the primary path now and arrives
   * before any frame fails; this is the fallback for the case it cannot
   * cover -- a socket that is down, so the client is polling and learns
   * of the commit only from the sweep 30 seconds later. Keep both: the
   * one that matters here is whichever runs when the network is worst.
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

  #attach(track: RemoteAudioTrack, participant: RemoteParticipant): void {
    const host = this.#host();
    const element = track.attach();
    element.setAttribute("data-voice-participant", participant.identity);
    host.appendChild(element);
    const volume = this.#volumes.get(userIdOf(participant));
    if (volume !== undefined) track.setVolume(volume);
    const speaker = loadVoicePrefs().speakerDeviceId;
    if (speaker && "setSinkId" in element) {
      void (element as HTMLMediaElement & { setSinkId(id: string): Promise<void> })
        .setSinkId(speaker)
        .catch(() => {});
    }
  }

  #host(): HTMLDivElement {
    if (!this.#audioHost) {
      const host = document.createElement("div");
      host.setAttribute("data-voice-audio", "");
      host.hidden = true;
      // hidden would pause nothing -- audio elements play regardless of
      // display -- but keep the host out of layout and out of a11y.
      host.style.display = "none";
      document.body.appendChild(host);
      this.#audioHost = host;
    }
    return this.#audioHost;
  }

  #refreshParticipantsSoon(): void {
    if (this.#refreshTimer) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      this.#refreshParticipants();
    }, SPEAKER_REFRESH_MS);
  }

  #refreshParticipants(): void {
    const room = this.#room;
    if (!room) return;
    const speaking = new Set(room.activeSpeakers.map((p) => p.identity));
    const participants: VoiceParticipant[] = [];
    for (const participant of room.remoteParticipants.values()) {
      const userId = userIdOf(participant);
      const audio = [...participant.audioTrackPublications.values()];
      participants.push({
        userId,
        identity: participant.identity,
        name: participant.name || userId,
        speaking: speaking.has(participant.identity),
        micMuted: audio.length === 0 || audio.every((pub) => pub.isMuted),
        encrypted: participant.isEncrypted,
        volume: this.#volumes.get(userId) ?? 1,
      });
    }
    participants.sort((a, b) => a.name.localeCompare(b.name));
    this.#set({
      participants,
      encryptionErrors: this.#encryptionErrors,
      lastEncryptionError: this.#lastEncryptionError,
    });
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
    const keys = this.#keys;
    if (!handshake || !keys || this.#leaving) return;
    try {
      const epoch = await handshake.epoch(conversationId);
      if (epoch === null || epoch === this.#state.keyEpoch) return;
      const derived = await deriveCallKey(handshake, conversationId, callId);
      if (!derived) return;
      await keys.setEpochKey(derived.secret, derived.epoch);
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

  async #teardown(input: { tellServer: boolean; error: string | null }): Promise<void> {
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

    const room = this.#room;
    const worker = this.#worker;
    this.#room = null;
    this.#keys = null;
    this.#worker = null;
    if (room) {
      try {
        await room.disconnect();
      } catch {
        // Already gone.
      }
    }
    // After the disconnect, never before: the teardown's own last frames
    // still go through the transform.
    worker?.terminate();
    this.#audioHost?.replaceChildren();

    if (input.tellServer && call) {
      try {
        if (kind === "room" && conversationId) await leaveVoiceRoom(conversationId);
        else await leaveCall(call.id);
      } catch {
        // The SFU's departure webhook heals a lost leave.
      }
    }

    this.#releaseLock?.();
    this.#releaseLock = null;
    this.#set({ ...IDLE, error: input.error });
    this.#announce();
    if (room) blip("leave");
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
