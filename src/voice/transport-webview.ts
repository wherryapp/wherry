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
  ScreenSharePresets,
  Track,
  VideoPresets,
  VideoQuality,
  type LocalAudioTrack,
  type LocalVideoTrack,
  type Participant,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  type TrackPublication,
  type VideoCodec,
  type VideoEncoding,
  type VideoPreset,
} from "livekit-client";
import { keyIndexFor, KEYRING_SIZE, type EchoReport, type VideoQualityRequest, type VideoSource } from "./rules";
import {
  publishErrorMessage,
  screenAudioCapture,
  screenAudioPublish,
  screenOptionsFor,
  userIdFromMetadata,
  volumeKey,
} from "./transport-rules";
import type {
  FrameTransformKind,
  ScreenSource,
  TransportCapabilities,
  TransportConnectOptions,
  TransportEvents,
  TransportParticipant,
  TransportPeerStats,
  TransportStats,
  TransportVideoOptions,
  AudioKind,
  TransportVideoStats,
  VideoSurface,
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
  return userIdFromMetadata(participant.metadata, participant.identity);
}

function sourceOf(source: VideoSource): Track.Source {
  return source === "camera" ? Track.Source.Camera : Track.Source.ScreenShare;
}

/**
 * The camera resolution asked for at publish. The SDK's presets are named
 * by height, so the ceiling picks the tallest one that fits rather than
 * inventing a constraint -- an exact `height` the camera cannot produce is
 * an OverconstrainedError, a preset is a request.
 */
function presetFor(ceiling: { maxHeight: number; maxFps: number }): VideoPreset {
  const ladder: VideoPreset[] = [
    VideoPresets.h180,
    VideoPresets.h360,
    VideoPresets.h540,
    VideoPresets.h720,
    VideoPresets.h1080,
  ];
  let chosen = ladder[0]!;
  for (const preset of ladder) {
    if (preset.height <= ceiling.maxHeight) chosen = preset;
  }
  return chosen;
}

/**
 * The simulcast ladder under a camera ceiling. Under 720 the SDK's own
 * default table would publish layers taller than the grant, so the two
 * low rungs are named explicitly; at 720 and above its defaults are
 * already right and are left alone (an empty array means "use them").
 */
function simulcastLayersFor(
  ceiling: { maxHeight: number; maxFps: number } | null,
): VideoPreset[] {
  if (!ceiling || ceiling.maxHeight > 720) return [];
  return [VideoPresets.h180, VideoPresets.h360].filter(
    (preset) => preset.height <= ceiling.maxHeight,
  );
}

function screenPresetFor(ceiling: { maxHeight: number; maxFps: number }): VideoPreset {
  const ladder: VideoPreset[] = [
    ScreenSharePresets.h360fps15,
    ScreenSharePresets.h720fps15,
    ScreenSharePresets.h1080fps15,
  ];
  let chosen = ladder[0]!;
  for (const preset of ladder) {
    if (preset.height <= ceiling.maxHeight) chosen = preset;
  }
  return chosen;
}

/**
 * A screen's encoding: the preset's bitrate at the granted height, with
 * the granted frame rate on top. The frame rate is the cap that matters --
 * a still screen costs almost nothing at any rate and a video playing in a
 * shared window costs all of it, so the cap is what bounds the worst case
 * rather than what shapes the common one.
 */
function screenEncodingFor(
  ceiling: { maxHeight: number; maxFps: number } | null,
): VideoEncoding | undefined {
  if (!ceiling) return undefined;
  const preset = screenPresetFor(ceiling);
  return { ...preset.encoding, maxFramerate: ceiling.maxFps };
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
  /** Whether this call asked the browser for echo cancellation. */
  #echoCancellation = true;
  /** The publish ceilings this call was connected with. */
  #video: TransportVideoOptions = { codec: "h264", camera: null, screen: null };
  /**
   * Every element a tile has handed over, keyed `identity/source`.
   *
   * Attaching is not a one-shot: a tile mounts as soon as it knows a
   * publication *exists*, and the track itself arrives one subscribe
   * later -- so an attach that only looked once would bind nothing and
   * the tile would sit black with no error anywhere. It is also what
   * makes a republish work: a camera turned off and on again, which is
   * exactly what the background pause does, is a NEW track, and the
   * element the tile handed over on mount is still the right element.
   */
  #elements = new Map<string, Set<HTMLVideoElement>>();

  async connect(options: TransportConnectOptions, events: TransportEvents): Promise<void> {
    this.#events = events;
    this.#speakerDeviceId = options.speakerDeviceId;
    this.#echoCancellation = options.processing.echoCancellation;
    // Built before the Room so disconnect can terminate exactly the one
    // this call used, even if constructing the Room throws.
    const keys = options.e2ee ? new CallKeyProvider() : null;
    const worker = keys ? makeWorker() : null;
    this.#video = options.video;
    const room = new Room({
      // Both true since video (they were false while calls were audio and
      // neither did anything): adaptiveStream is what makes a tile scrolled
      // out of view stop costing anybody bandwidth, and dynacast is what
      // turns "nobody asked for the top layer" into "the sender stops
      // encoding it" -- which is the whole enforcement of
      // topLayerCallSize, at no cost to the publisher.
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: options.processing.echoCancellation,
        noiseSuppression: options.processing.noiseSuppression,
        autoGainControl: options.processing.autoGainControl,
        ...(options.micDeviceId ? { deviceId: options.micDeviceId } : {}),
      },
      ...(options.speakerDeviceId ? { audioOutput: { deviceId: options.speakerDeviceId } } : {}),
      // dtx and red stay on at every tier -- silence suppression and the
      // redundant frame are about loss, not fidelity. Fixed for the life
      // of the publication: the SDK sets encodings at publish time.
      publishDefaults: {
        dtx: true,
        red: true,
        audioPreset: { maxBitrate: options.maxBitrate },
        // H.264, always, and never a backupCodec. The backup exists for a
        // VP9 or AV1 primary; H.264 has no shipped browser that cannot
        // decode it, and a backup is inert under encryption anyway (the
        // plan's §10.1). AV1 is not merely unsupported here, it is refused
        // -- see transport-rules.ts's videoCodecFor.
        videoCodec: options.video.codec satisfies "h264" as VideoCodec,
        simulcast: true,
        videoSimulcastLayers: simulcastLayersFor(options.video.camera),
        screenShareEncoding: screenEncodingFor(options.video.screen),
      },
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
    this.#elements.clear();
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

  capabilities(): TransportCapabilities {
    return {
      camera:
        typeof navigator !== "undefined" &&
        typeof navigator.mediaDevices?.getUserMedia === "function",
      // Feature detection, never a platform name: both phone webviews and
      // the macOS shell's WebKit lack getDisplayMedia, and each for its own
      // reason (docs/prompts/video-plan.md §8).
      screen:
        typeof navigator !== "undefined" &&
        typeof navigator.mediaDevices?.getDisplayMedia === "function",
      renderVideo: true,
    };
  }

  async setCameraEnabled(on: boolean, deviceId: string | null): Promise<void> {
    const room = this.#room;
    if (!room) return;
    const ceiling = this.#video.camera;
    try {
      await room.localParticipant.setCameraEnabled(on, {
        ...(deviceId ? { deviceId } : {}),
        ...(ceiling ? { resolution: presetFor(ceiling) } : {}),
      });
    } catch (error) {
      throw new Error(publishErrorMessage(error, "camera"));
    }
    this.#reattach("self", "camera");
  }

  /**
   * Always empty, on every platform this transport runs on: the picker is
   * inside `getDisplayMedia` and there is nothing for a list to add. The
   * one platform where the browser has no picker is Windows under WebView2
   * (S-00) — and there this transport is not the one sharing, because the
   * shell captures instead.
   */
  async screenSources(): Promise<ScreenSource[]> {
    return [];
  }

  async setScreenShareEnabled(on: boolean, audience = 1): Promise<void> {
    const room = this.#room;
    if (!room) return;
    // The audience step, read now and never re-applied: see
    // transport-rules.ts's screenOptionsFor for why a republish mid-share
    // would be worse than the bandwidth it saved.
    const ceiling = screenOptionsFor(this.#video.screen, audience);
    const audioPublish = screenAudioPublish();
    try {
      await room.localParticipant.setScreenShareEnabled(
        on,
        {
        // Audio is **always requested**, so the option to share it is
        // always in front of the person sharing (the maintainer,
        // 2026-09-09). Asking is not taking: on Chromium the request is
        // what puts the "also share audio" checkbox in the system picker,
        // and the person ticks it or does not. Asking for nothing is what
        // would remove the choice.
        //
        // The three processing switches are off by requirement, not
        // preference -- see transport-rules.ts's screenAudioCapture.
        //
        // THIS PATH DOES NOT MEET REQUIREMENT 3, and since 2026-09-09 that
        // is measured rather than suspected: Chromium's loopback capture
        // takes the render endpoint's whole mix, our own playback with it,
        // so a share on this transport returns the far end their own voice
        // (regression rows S-01 and S-11, the second of which watched both
        // engines do opposite things in one sitting). The constraint that
        // would fix it, `restrictOwnAudio`, is gated on Windows 11.
        //
        // It ships anyway, by the maintainer's decision the same day: the
        // people on the system are testing rather than relying on it. An
        // earlier version of this comment said the dark `video` flag was
        // what made that harmless -- the flag has been ON globally in
        // production since some unrecorded date, so it was never the
        // reason. What actually closes this is capturing in the shell,
        // which Windows has (voice/screen_audio.rs) and macOS does not yet
        // (stage M, docs/prompts/screen-audio-handoff.md §6).
        audio: screenAudioCapture(),
        // "detail" is what tells the encoder this is text and not motion;
        // it is the difference between a readable shared window and a
        // smear.
          contentHint: "detail",
          ...(ceiling ? { resolution: screenPresetFor(ceiling) } : {}),
        },
        // Publish options for the *audio* track that share carries. The
        // room's defaults are speech settings and wrong for a soundtrack;
        // transport-rules.ts's screenAudioPublish says why each one moves.
        {
          dtx: audioPublish.dtx,
          red: audioPublish.red,
          forceStereo: audioPublish.forceStereo,
          audioPreset: { maxBitrate: audioPublish.maxBitrate },
        },
      );
    } catch (error) {
      throw new Error(publishErrorMessage(error, "screen"));
    }
    this.#reattach("self", "screen");
  }

  attachVideo(
    identity: string,
    source: VideoSource,
    element: HTMLVideoElement,
    _surface: VideoSurface,
  ): () => void {
    const key = `${identity}/${source}`;
    const set = this.#elements.get(key) ?? new Set();
    set.add(element);
    this.#elements.set(key, set);
    // Now if there is a track, and again from #reattach whenever one
    // appears -- see the field's comment for why once is not enough.
    this.#videoTrack(identity, source)?.attach(element);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.#elements.get(key)?.delete(element);
      // Read the track again rather than closing over the one attached: a
      // republish between mount and unmount would otherwise leave the new
      // track attached to an element that is going away.
      this.#videoTrack(identity, source)?.detach(element);
    };
  }

  setSurfaceCovered(): void {
    // The `<video>` is in the document, under whatever the document draws
    // over it; nothing to hide.
  }

  setVideoSubscription(
    identity: string,
    source: VideoSource,
    quality: VideoQualityRequest,
  ): void {
    const room = this.#room;
    if (!room) return;
    const participant = room.remoteParticipants.get(identity);
    const publication = participant?.getTrackPublication(sourceOf(source)) as
      | RemoteTrackPublication
      | undefined;
    if (!publication) return;
    publication.setSubscribed(quality !== "off");
    if (quality === "off") return;
    // MEDIUM is deliberately never asked for: two tiers keep the sender's
    // three encodings meaningful (a request for a layer nobody publishes
    // is silently rounded), and "the pinned one and everything else" is
    // the only distinction the stage actually draws.
    publication.setVideoQuality(quality === "high" ? VideoQuality.HIGH : VideoQuality.LOW);
  }

  setParticipantVolume(userId: string, volume: number, kind: AudioKind): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.#volumes.set(volumeKey(userId, kind), clamped);
    const room = this.#room;
    if (!room) return;
    const source =
      kind === "screen" ? Track.Source.ScreenShareAudio : Track.Source.Microphone;
    for (const participant of room.remoteParticipants.values()) {
      if (userIdOf(participant) !== userId) continue;
      // That source only: their voice and the sound of what they are
      // sharing are two controls (transport.ts's `AudioKind`).
      const publication = participant.getTrackPublication(source);
      (publication?.track as RemoteAudioTrack | undefined)?.setVolume(clamped);
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
      // The *microphone*, not "any audio": a screen share's soundtrack is
      // an audio publication too, and counting it here would report
      // somebody as unmuted because a video they are sharing has sound.
      const mic = participant.getTrackPublication(Track.Source.Microphone);
      list.push({
        identity: participant.identity,
        userId: userIdOf(participant),
        name: participant.name || userIdOf(participant),
        speaking: speaking.has(participant.identity),
        micMuted: mic === undefined || mic.isMuted,
        encrypted: participant.isEncrypted,
        screenAudio:
          participant.getTrackPublication(Track.Source.ScreenShareAudio) !== undefined,
        audioLevel: participant.audioLevel,
        camera: participant.getTrackPublication(Track.Source.Camera) !== undefined,
        screen: participant.getTrackPublication(Track.Source.ScreenShare) !== undefined,
        cameraMuted: participant.getTrackPublication(Track.Source.Camera)?.isMuted ?? false,
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
    const echo: EchoReport = {
      echoReturnLoss: null,
      echoReturnLossEnhancement: null,
      ...(this.#echoCancellation ? {} : { disabled: true }),
    };
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
      // No fallback to "whatever audio track is first": with a screen
      // share carrying sound that is a coin flip, and this readout exists
      // to answer "is their *voice* reaching me".
      const audio = participant.getTrackPublication(Track.Source.Microphone);
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
    return { mic, packetsSent, roundTripMs, echo, peers, video: await this.#videoStats(room) };
  }

  /**
   * Per video track: what the encoder or decoder is doing with it. Read
   * straight off the RTCPeerConnection reports rather than the SDK's
   * per-track wrappers, which carry the audio fields only.
   *
   * Every number here is a courtesy and several came back null from the
   * Chromium the stage-0 spike ran in -- both implementation strings, in
   * particular -- so nothing may be required for the row to say something
   * useful (rules.ts's `videoLine` degrades to what it has).
   */
  async #videoStats(room: Room): Promise<TransportVideoStats[]> {
    const out: TransportVideoStats[] = [];
    const read = async (
      identity: string,
      source: VideoSource,
      direction: "sent" | "received",
      report: RTCStatsReport | undefined,
    ): Promise<void> => {
      if (!report) return;
      const codecs = new Map<string, string>();
      report.forEach((entry: RTCStats & { mimeType?: string }) => {
        if (entry.type === "codec" && typeof entry.mimeType === "string") {
          codecs.set(entry.id, entry.mimeType.replace(/^video\//i, ""));
        }
      });
      const wanted = direction === "sent" ? "outbound-rtp" : "inbound-rtp";
      report.forEach(
        (
          entry: RTCStats & {
            kind?: string;
            frameWidth?: number;
            frameHeight?: number;
            framesPerSecond?: number;
            codecId?: string;
            rid?: string;
            encoderImplementation?: string;
            decoderImplementation?: string;
            qualityLimitationReason?: string;
          },
        ) => {
          if (entry.type !== wanted || entry.kind !== "video") return;
          out.push({
            identity,
            source,
            direction,
            width: entry.frameWidth ?? null,
            height: entry.frameHeight ?? null,
            fps: entry.framesPerSecond ?? null,
            codec: (entry.codecId ? codecs.get(entry.codecId) : undefined) ?? null,
            layer: entry.rid ?? null,
            implementation:
              (direction === "sent" ? entry.encoderImplementation : entry.decoderImplementation) ??
              null,
            limitedBy: direction === "sent" ? (entry.qualityLimitationReason ?? null) : null,
          });
        },
      );
    };

    for (const source of ["camera", "screen"] as const) {
      const local = room.localParticipant.getTrackPublication(sourceOf(source))?.track as
        | LocalVideoTrack
        | undefined;
      if (local?.sender) {
        try {
          await read("self", source, "sent", await local.sender.getStats());
        } catch {
          // A reading, never a requirement.
        }
      }
    }
    for (const participant of room.remoteParticipants.values()) {
      for (const source of ["camera", "screen"] as const) {
        const track = participant.getTrackPublication(sourceOf(source))?.track as
          | RemoteVideoTrack
          | undefined;
        if (!track?.receiver) continue;
        try {
          await read(participant.identity, source, "received", await track.receiver.getStats());
        } catch {
          // As above.
        }
      }
    }
    return out;
  }

  // -- the room's events -----------------------------------------------------

  #wire(room: Room): void {
    const ev = (): TransportEvents => this.#events;
    room
      .on(RoomEvent.ParticipantConnected, () => ev().participantJoined?.())
      .on(RoomEvent.ParticipantDisconnected, () => ev().participantLeft?.())
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
        // Video is deliberately NOT attached here: the tile owns its own
        // element, and adaptiveStream measures the element that is
        // attached -- an element this transport created and never showed
        // would read as 0x0 and ask for the lowest layer forever.
        if (track.kind !== Track.Kind.Audio) {
          // The track a tile has been waiting for since it mounted.
          this.#reattachAll();
          ev().videoChanged?.();
          return;
        }
        this.#attach(track as RemoteAudioTrack, participant);
        ev().rosterChanged?.();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) {
          ev().videoChanged?.();
          return;
        }
        for (const element of track.detach()) element.remove();
        ev().rosterChanged?.();
      })
      .on(RoomEvent.TrackPublished, (publication: TrackPublication) => {
        if (publication.kind !== Track.Kind.Audio) {
          this.#reattachAll();
          ev().videoChanged?.();
        }
        ev().rosterChanged?.();
      })
      .on(RoomEvent.TrackUnpublished, (publication: TrackPublication) => {
        if (publication.kind !== Track.Kind.Audio) ev().videoChanged?.();
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

  /** The live track for one tile, local or remote; null when not (yet)
   *  published or not subscribed. */
  #videoTrack(identity: string, source: VideoSource): RemoteVideoTrack | LocalVideoTrack | null {
    const room = this.#room;
    if (!room) return null;
    if (identity === "self") {
      const publication = room.localParticipant.getTrackPublication(sourceOf(source));
      return (publication?.track as LocalVideoTrack | undefined) ?? null;
    }
    const participant = room.remoteParticipants.get(identity);
    const publication = participant?.getTrackPublication(sourceOf(source));
    return (publication?.track as RemoteVideoTrack | undefined) ?? null;
  }

  /** Bind every element waiting on one track, if that track now exists. */
  #reattach(identity: string, source: VideoSource): void {
    const elements = this.#elements.get(`${identity}/${source}`);
    if (!elements || elements.size === 0) return;
    const track = this.#videoTrack(identity, source);
    if (!track) return;
    for (const element of elements) track.attach(element);
  }

  /** Every waiting element, after a subscribe or a publish. */
  #reattachAll(): void {
    for (const key of this.#elements.keys()) {
      const slash = key.lastIndexOf("/");
      const identity = key.slice(0, slash);
      const source = key.slice(slash + 1) as VideoSource;
      this.#reattach(identity, source);
    }
  }

  #attach(track: RemoteAudioTrack, participant: RemoteParticipant): void {
    const host = this.#host();
    const element = track.attach();
    element.setAttribute("data-voice-participant", participant.identity);
    host.appendChild(element);
    const kind: AudioKind =
      track.source === Track.Source.ScreenShareAudio ? "screen" : "microphone";
    const volume = this.#volumes.get(volumeKey(userIdOf(participant), kind));
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
