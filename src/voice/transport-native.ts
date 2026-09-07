// The native media transport, TypeScript half: `VoiceTransport` over the
// shell's `voice_*` commands and its `voice` event (src-tauri/src/voice.rs
// is the other half; docs/prompts/native-media-plan.md §5 is the plan).
// Chosen in index.ts when the desktop shell has the engine and this device
// turned it on; every other platform keeps `transport-webview.ts`.
//
// What lives on which side of the boundary: the shell captures, encrypts,
// sends, receives and plays, and reports facts (a roster, a state word, a
// stats reading). Everything that is a decision -- which ring index an
// epoch maps to, whether a volume is silence, what an encryption state
// means, whether a saved device id is still real -- is made here or in
// `transport-rules.ts`, and crosses the IPC already decided.
//
// No DOM at all: playback is the audio device module's, so `startPlayback`
// is a no-op and `playbackBlocked` never becomes true.

import { keyIndexFor } from "./rules";
import type {
  FrameTransformKind,
  TransportConnectOptions,
  TransportEvents,
  TransportParticipant,
  TransportStats,
  VoiceQuality,
  VoiceTransport,
} from "./transport";
import {
  connectionFromWord,
  isEncryptionFailure,
  knownDeviceId,
  micErrorName,
  playbackEnabledFor,
  qualityFromWord,
  userIdFromMetadata,
} from "./transport-rules";

/** One remote participant as the shell reports them (voice.rs `RosterEntry`). */
type NativeEntry = {
  identity: string;
  name: string;
  metadata: string;
  speaking: boolean;
  micMuted: boolean;
  encrypted: boolean;
  audioLevel: number;
  playing: boolean | null;
};

type NativeRoster = { participants: NativeEntry[]; localLevel: number };

type NativeEvent = { session: number } & (
  | { kind: "roster"; roster: NativeRoster }
  | { kind: "speakers"; roster: NativeRoster }
  | { kind: "participant_joined" }
  | { kind: "participant_left" }
  | { kind: "connection"; state: string; quality: string }
  | { kind: "encryption"; identity: string; state: string }
);

type NativeDevices = {
  inputs: { deviceId: string; label: string }[];
  outputs: { deviceId: string; label: string }[];
};

type ConnectResult = { session: number; connectMs: number; roster: NativeRoster };

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
  /** Identities whose playback flag has been sent to the shell. */
  #playbackSent = new Set<string>();

  async connect(options: TransportConnectOptions, events: TransportEvents): Promise<void> {
    this.#events = events;
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

  setParticipantVolume(userId: string, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.#volumes.set(userId, clamped);
    for (const entry of this.#roster.participants) {
      if (userIdFromMetadata(entry.metadata, entry.identity) !== userId) continue;
      this.#sendPlayback(entry.identity, clamped);
    }
  }

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
      return await invoke<TransportStats>("voice_stats");
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
    }
  }

  /** A volume set before somebody's device appeared reaches it now. */
  #applyVolumes(): void {
    for (const entry of this.#roster.participants) {
      if (this.#playbackSent.has(entry.identity)) continue;
      const volume = this.#volumes.get(userIdFromMetadata(entry.metadata, entry.identity));
      if (volume !== undefined) this.#sendPlayback(entry.identity, volume);
    }
  }

  #sendPlayback(identity: string, volume: number): void {
    const invoke = this.#invoke;
    if (!invoke || this.#session === null) return;
    this.#playbackSent.add(identity);
    void invoke("voice_set_playback", { identity, enabled: playbackEnabledFor(volume) }).catch(
      () => {
        // The next roster event tries again.
        this.#playbackSent.delete(identity);
      },
    );
  }
}
