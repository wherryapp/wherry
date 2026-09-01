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
  Room,
  RoomEvent,
  Track,
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
import type { Call, CallKind, HubVisibility, JoinResult } from "../api/types";
import { e2e } from "../crypto";
import { sync, type SyncEvent } from "../sync/engine";
import { broadcast, subscribeToBroadcasts } from "../sync/leader";
import { CallKeyProvider, deriveCallKey } from "./keys";
import { loadVoicePrefs } from "./prefs";
import { shouldJoinMuted } from "./rules";
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
};

const LOCK_NAME = "messenger.voice";
const EPOCH_POLL_MS = 2_000;
const KEY_WAIT_MS = 20_000;

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
      this.#set({ micMuted: muted, error: null });
      blip(muted ? "mute" : "unmute");
    } catch (error) {
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
      ...(keys ? { e2ee: { keyProvider: keys, worker: makeWorker() } } : {}),
    });
    this.#room = room;
    this.#keys = keys;
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
      this.#set({ micMuted: startMuted });
    } catch (error) {
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
      .on(RoomEvent.ActiveSpeakersChanged, () => this.#refreshParticipants())
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
      .on(RoomEvent.EncryptionError, () => {
        // Expected briefly at an epoch turn; persistent means the peer's
        // key differs, which the roster's `encrypted` flag also shows.
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
    this.#set({ participants });
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
    const { call, kind, conversationId } = this.#state;
    this.#stopRingback();
    this.#stopEpochWatch();
    this.#unsubscribeSync?.();
    this.#unsubscribeSync = null;
    this.#unsubscribeBroadcasts?.();
    this.#unsubscribeBroadcasts = null;

    const room = this.#room;
    this.#room = null;
    this.#keys = null;
    if (room) {
      try {
        await room.disconnect();
      } catch {
        // Already gone.
      }
    }
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

function micError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was refused. You can listen, but nobody can hear you.";
  }
  if (name === "NotFoundError") return "No microphone was found.";
  return "The microphone could not be started.";
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
