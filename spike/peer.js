// The browser end of the stage-0 spike: livekit-client 2.22.2 with the
// same indexed shared-key provider transport-webview.ts uses, a 440 Hz
// oscillator as the "microphone" (the pane has none), and an AnalyserNode
// on every subscribed track so the terminal can read what this end hears.
// Throwaway, with the rest of client/spike/.

import {
  BaseKeyProvider,
  createKeyMaterialFromBuffer,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";

const KEYRING_SIZE = 16;
const indexFor = (epoch) => ((epoch % KEYRING_SIZE) + KEYRING_SIZE) % KEYRING_SIZE;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** transport-webview.ts's CallKeyProvider, copied. */
class Keys extends BaseKeyProvider {
  constructor() {
    super({ sharedKey: true, ratchetWindowSize: 0, failureTolerance: -1, keyringSize: KEYRING_SIZE });
  }
  async setEpochKey(hex, epoch) {
    const material = await createKeyMaterialFromBuffer(hexToBytes(hex).buffer);
    this.onSetEncryptionKey(material, undefined, indexFor(epoch));
  }
}

const out = document.getElementById("log");
const state = {
  room: null,
  keys: null,
  worker: null,
  ctx: null,
  tone: null,
  errors: [],
  events: [],
  remote: new Map(),
};

function note(kind, detail) {
  const line = { t: Date.now(), kind, detail };
  state.events.push(line);
  out.textContent = `${new Date().toISOString().slice(11, 23)} ${kind} ${detail ?? ""}\n${out.textContent}`.slice(0, 20_000);
}

async function ensureContext() {
  if (!state.ctx) state.ctx = new AudioContext({ sampleRate: 48_000 });
  if (state.ctx.state !== "running") await state.ctx.resume();
  return state.ctx.state;
}

document.getElementById("arm").addEventListener("click", async () => {
  const status = await ensureContext();
  document.getElementById("armed").textContent = `AudioContext ${status}`;
  note("armed", status);
});

function wireAnalyser(identity) {
  const entry = state.remote.get(identity);
  if (!entry || !state.ctx) return;
  const source = state.ctx.createMediaStreamSource(new MediaStream([entry.track.mediaStreamTrack]));
  const analyser = state.ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  entry.analyser = analyser;
}

async function publishTone() {
  await ensureContext();
  const oscillator = state.ctx.createOscillator();
  oscillator.frequency.value = 440;
  const gain = state.ctx.createGain();
  gain.gain.value = 0.5;
  const destination = state.ctx.createMediaStreamDestination();
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  const track = destination.stream.getAudioTracks()[0];
  await state.room.localParticipant.publishTrack(track, {
    source: Track.Source.Microphone,
    dtx: true,
    red: true,
    audioPreset: { maxBitrate: 32_000 },
  });
  state.tone = { oscillator, gain, track };
}

window.peer = {
  state,

  async connect({ url, token, keyHex, epoch = 0, e2ee = true, tone = true }) {
    const keys = e2ee ? new Keys() : null;
    const worker = e2ee
      ? new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), { type: "module" })
      : null;
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      publishDefaults: { dtx: true, red: true, audioPreset: { maxBitrate: 32_000 } },
      ...(keys && worker ? { e2ee: { keyProvider: keys, worker } } : {}),
    });
    room
      .on(RoomEvent.EncryptionError, (error) => {
        state.errors.push(String(error?.message ?? error));
        note("encryption_error", String(error?.message ?? error));
      })
      .on(RoomEvent.ParticipantEncryptionStatusChanged, (encrypted, participant) =>
        note("encryption_status", `${participant?.identity} ${encrypted}`),
      )
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        const element = track.attach();
        element.setAttribute("data-peer", participant.identity);
        document.body.appendChild(element);
        state.remote.set(participant.identity, { track, element, analyser: null });
        wireAnalyser(participant.identity);
        note("subscribed", participant.identity);
      })
      .on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        for (const element of track.detach()) element.remove();
        state.remote.delete(participant.identity);
        note("unsubscribed", participant.identity);
      })
      .on(RoomEvent.ParticipantConnected, (p) => note("joined", p.identity))
      .on(RoomEvent.ParticipantDisconnected, (p) => note("left", p.identity))
      .on(RoomEvent.ConnectionStateChanged, (s) => note("connection", s))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => note("playback", room.canPlaybackAudio));
    state.room = room;
    state.keys = keys;
    state.worker = worker;
    const t0 = performance.now();
    if (keys) await keys.setEpochKey(keyHex, epoch);
    await room.connect(url, token);
    if (keys) await room.setE2EEEnabled(true);
    const connectMs = Math.round(performance.now() - t0);
    if (tone) await publishTone();
    await room.startAudio().catch(() => {});
    note("connected", `${room.localParticipant.identity} in ${connectMs} ms`);
    return {
      identity: room.localParticipant.identity,
      e2ee: Boolean(keys),
      connectMs,
      playback: room.canPlaybackAudio,
      context: state.ctx?.state ?? null,
    };
  },

  async setKey(hex, epoch) {
    await state.keys.setEpochKey(hex, epoch);
    return indexFor(epoch);
  },

  async startAudio() {
    await ensureContext();
    await state.room?.startAudio();
    return { playback: state.room?.canPlaybackAudio, context: state.ctx.state };
  },

  /** What this end hears right now, per remote identity. */
  rms() {
    const result = {};
    for (const [identity, entry] of state.remote) {
      if (!entry.analyser) {
        result[identity] = null;
        continue;
      }
      const buffer = new Float32Array(entry.analyser.fftSize);
      entry.analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      let peak = 0;
      for (const value of buffer) {
        sum += value * value;
        if (Math.abs(value) > peak) peak = Math.abs(value);
      }
      result[identity] = {
        rms: Math.sqrt(sum / buffer.length),
        peak,
        playing: !entry.element.paused,
      };
    }
    return result;
  },

  async stats() {
    const room = state.room;
    if (!room) return null;
    const local = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    const sender = local ? await local.getSenderStats().catch(() => null) : null;
    const peers = [];
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        const track = publication.track;
        const receiver = track ? await track.getReceiverStats().catch(() => null) : null;
        peers.push({
          identity: participant.identity,
          encrypted: participant.isEncrypted,
          muted: publication.isMuted,
          audioLevel: participant.audioLevel,
          bytesReceived: receiver?.bytesReceived ?? null,
          totalAudioEnergy: receiver?.totalAudioEnergy ?? null,
          concealedSamples: receiver?.concealedSamples ?? null,
          packetsLost: receiver?.packetsLost ?? null,
          jitter: receiver?.jitter ?? null,
        });
      }
    }
    return {
      state: room.state,
      playback: room.canPlaybackAudio,
      packetsSent: sender?.packetsSent ?? null,
      roundTripMs: sender?.roundTripTime !== undefined ? Math.round(sender.roundTripTime * 1000) : null,
      errors: state.errors.length,
      lastError: state.errors.at(-1) ?? null,
      peers,
      rms: window.peer.rms(),
    };
  },

  async disconnect() {
    const room = state.room;
    state.room = null;
    state.keys = null;
    if (room) await room.disconnect().catch(() => {});
    state.worker?.terminate();
    state.worker = null;
    state.tone?.oscillator.stop();
    state.tone = null;
    state.remote.clear();
    note("disconnected");
    return true;
  },
};

note("ready", "window.peer");
