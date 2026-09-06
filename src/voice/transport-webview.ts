// The webview media transport: livekit-client's Room, the microphone, the
// remote audio elements and the E2EE worker. The only file in the client
// that imports livekit-client's `Room` (docs/prompts/native-media-plan.md
// §4) -- everything that used to be spread through session.ts about the
// SDK now lives here, behind `VoiceTransport`, and session.ts holds only
// the decisions: when to join, which key, what to tell the server.
//
// Every platform uses this today. On desktop the native transport in the
// Tauri shell replaces it (stage 2 of the plan); the web, the PWA and
// both phones keep it.

import {
  ConnectionQuality,
  ConnectionState,
  BaseKeyProvider,
  createKeyMaterialFromBuffer,
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
import { keyIndexFor, KEYRING_SIZE, type EchoReport } from "./rules";
import type {
  FrameTransformKind,
  TransportConnectOptions,
  TransportEvents,
  TransportParticipant,
  TransportPeerStats,
  TransportStats,
  VoiceQuality,
  VoiceTransport,
} from "./transport";

/**
 * A shared key set by index. The SDK's own ExternalE2EEKeyProvider takes
 * no index (one passphrase for the room's life), which is one key short of
 * what an epoch turn needs; this subclass uses the same shared-key mode
 * and reaches the protected setter with the epoch's index. Ratcheting is
 * off -- MLS is the ratchet -- and failure tolerance is disabled so a frame
 * under a key this device does not (yet) hold is dropped rather than
 * triggering a blind ratchet attempt. The buffer goes through HKDF inside
 * the SDK (`createKeyMaterialFromBuffer`); the native transport must set
 * the same derivation explicitly, see the plan's §1.2.
 */
class CallKeyProvider extends BaseKeyProvider {
  constructor() {
    super({
      sharedKey: true,
      ratchetWindowSize: 0,
      failureTolerance: -1,
      keyringSize: KEYRING_SIZE,
    });
  }

  async setEpochKey(secret: Uint8Array, epoch: number): Promise<void> {
    // A copy, so the SDK owns a buffer that is exactly the key and nothing
    // else shares it.
    const material = new Uint8Array(secret);
    const key = await createKeyMaterialFromBuffer(material.buffer);
    this.onSetEncryptionKey(key, undefined, keyIndexFor(epoch));
  }
}

/**
 * The E2EE worker, one per call, terminated by disconnect.
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

export class WebviewTransport implements VoiceTransport {
  #room: Room | null = null;
  #keys: CallKeyProvider | null = null;
  #worker: Worker | null = null;
  #audioHost: HTMLDivElement | null = null;
  #volumes = new Map<string, number>();
  #speakerDeviceId: string | null = null;
  #quality: VoiceQuality = "unknown";
  #events: TransportEvents = {};

  async connect(options: TransportConnectOptions, events: TransportEvents): Promise<void> {
    this.#events = events;
    this.#speakerDeviceId = options.speakerDeviceId;
    // Built before the Room so disconnect can terminate exactly the one
    // this call used, even if constructing the Room throws.
    const keys = options.e2ee ? new CallKeyProvider() : null;
    const worker = keys ? makeWorker() : null;
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(options.micDeviceId ? { deviceId: options.micDeviceId } : {}),
      },
      ...(options.speakerDeviceId ? { audioOutput: { deviceId: options.speakerDeviceId } } : {}),
      // dtx and red stay on at every tier -- silence suppression and the
      // redundant frame are about loss, not fidelity. Fixed for the life
      // of the publication: the SDK sets encodings at publish time.
      publishDefaults: { dtx: true, red: true, audioPreset: { maxBitrate: options.maxBitrate } },
      ...(keys && worker ? { e2ee: { keyProvider: keys, worker } } : {}),
    });
    this.#room = room;
    this.#keys = keys;
    this.#worker = worker;
    this.#wire(room);
    try {
      if (keys && options.key) await keys.setEpochKey(options.key.secret, options.key.epoch);
      await room.connect(options.url, options.token);
      if (keys) await room.setE2EEEnabled(true);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const room = this.#room;
    const worker = this.#worker;
    this.#room = null;
    this.#keys = null;
    this.#worker = null;
    this.#events = {};
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
  }

  async setMicrophoneEnabled(on: boolean): Promise<void> {
    const room = this.#room;
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(on);
  }

  async setInputDevice(deviceId: string): Promise<void> {
    await this.#room?.switchActiveDevice("audioinput", deviceId);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.#speakerDeviceId = deviceId;
    await this.#room?.switchActiveDevice("audiooutput", deviceId);
  }

  async setEpochKey(secret: Uint8Array, epoch: number): Promise<void> {
    const keys = this.#keys;
    if (!keys) throw new Error("frame encryption is off for this transport");
    await keys.setEpochKey(secret, epoch);
  }

  setParticipantVolume(userId: string, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.#volumes.set(userId, clamped);
    const room = this.#room;
    if (!room) return;
    for (const participant of room.remoteParticipants.values()) {
      if (userIdOf(participant) !== userId) continue;
      for (const publication of participant.audioTrackPublications.values()) {
        (publication.track as RemoteAudioTrack | undefined)?.setVolume(clamped);
      }
    }
  }

  async startPlayback(): Promise<void> {
    await this.#room?.startAudio();
  }

  playbackBlocked(): boolean {
    const room = this.#room;
    return room ? !room.canPlaybackAudio : false;
  }

  participants(): TransportParticipant[] {
    const room = this.#room;
    if (!room) return [];
    const speaking = new Set(room.activeSpeakers.map((p) => p.identity));
    const list: TransportParticipant[] = [];
    for (const participant of room.remoteParticipants.values()) {
      const audio = [...participant.audioTrackPublications.values()];
      list.push({
        identity: participant.identity,
        userId: userIdOf(participant),
        name: participant.name || userIdOf(participant),
        speaking: speaking.has(participant.identity),
        micMuted: audio.length === 0 || audio.every((pub) => pub.isMuted),
        encrypted: participant.isEncrypted,
        audioLevel: participant.audioLevel,
      });
    }
    return list;
  }

  localAudioLevel(): number {
    return this.#room?.localParticipant.audioLevel ?? 0;
  }

  quality(): VoiceQuality {
    return this.#quality;
  }

  frameTransform(): FrameTransformKind {
    return isInsertableStreamSupported()
      ? "encoded-streams"
      : isScriptTransformSupported()
        ? "script-transform"
        : "none";
  }

  /**
   * Stats come from the SDK's per-track getStats wrappers where they
   * exist; the echo canceller's numbers live on the media-source entry of
   * the sender's own report, which the wrapper skips, so that is read
   * straight off the sender. Never throws: a stats call that fails leaves
   * its numbers null.
   */
  async sampleStats(): Promise<TransportStats | null> {
    const room = this.#room;
    if (!room) return null;
    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const local = publication?.track as LocalAudioTrack | undefined;
    const mediaTrack = local?.mediaStreamTrack;
    const mic = {
      published: local !== undefined,
      muted: publication?.isMuted ?? true,
      systemMuted: mediaTrack?.muted ?? false,
      ended: mediaTrack?.readyState === "ended",
    };
    let packetsSent: number | null = null;
    let roundTripMs: number | null = null;
    const echo: EchoReport = { echoReturnLoss: null, echoReturnLossEnhancement: null };
    if (local) {
      try {
        const stats = await local.getSenderStats();
        packetsSent = stats?.packetsSent ?? null;
        roundTripMs =
          stats?.roundTripTime !== undefined ? Math.round(stats.roundTripTime * 1000) : null;
      } catch {
        // Stats are a reading, never a requirement.
      }
      try {
        const report = await local.sender?.getStats();
        report?.forEach(
          (entry: RTCStats & { kind?: string; echoReturnLoss?: number; echoReturnLossEnhancement?: number }) => {
            if (entry.type !== "media-source" || entry.kind !== "audio") return;
            echo.echoReturnLoss = typeof entry.echoReturnLoss === "number" ? entry.echoReturnLoss : null;
            echo.echoReturnLossEnhancement =
              typeof entry.echoReturnLossEnhancement === "number" ? entry.echoReturnLossEnhancement : null;
          },
        );
      } catch {
        // As above.
      }
    }

    const peers: TransportPeerStats[] = [];
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
        bytesReceived,
        audioEnergy,
        concealedSamples,
        playing: element ? !element.paused : null,
      });
    }
    return { mic, packetsSent, roundTripMs, echo, peers };
  }

  // -- the room's events -----------------------------------------------------

  #wire(room: Room): void {
    const ev = (): TransportEvents => this.#events;
    room
      .on(RoomEvent.ParticipantConnected, () => ev().participantJoined?.())
      .on(RoomEvent.ParticipantDisconnected, () => ev().participantLeft?.())
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        this.#attach(track as RemoteAudioTrack, participant);
        ev().rosterChanged?.();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const element of track.detach()) element.remove();
        ev().rosterChanged?.();
      })
      .on(RoomEvent.TrackMuted, () => ev().rosterChanged?.())
      .on(RoomEvent.TrackUnmuted, () => ev().rosterChanged?.())
      .on(RoomEvent.ActiveSpeakersChanged, () => ev().speakersChanged?.())
      .on(RoomEvent.ParticipantEncryptionStatusChanged, () => ev().rosterChanged?.())
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (!participant.isLocal) return;
        this.#quality = qualityOf(quality);
        ev().connection?.("connected", this.#quality);
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        ev().playbackChanged?.(!room.canPlaybackAudio);
      })
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        if (state === ConnectionState.Reconnecting) ev().connection?.("reconnecting", this.#quality);
        else if (state === ConnectionState.Connected) ev().connection?.("connected", this.#quality);
      })
      .on(RoomEvent.Disconnected, () => ev().connection?.("disconnected", this.#quality))
      .on(RoomEvent.EncryptionError, (error) => {
        ev().encryptionError?.(error instanceof Error ? error.message : String(error));
      });
  }

  #attach(track: RemoteAudioTrack, participant: RemoteParticipant): void {
    const host = this.#host();
    const element = track.attach();
    element.setAttribute("data-voice-participant", participant.identity);
    host.appendChild(element);
    const volume = this.#volumes.get(userIdOf(participant));
    if (volume !== undefined) track.setVolume(volume);
    const speaker = this.#speakerDeviceId;
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
}
