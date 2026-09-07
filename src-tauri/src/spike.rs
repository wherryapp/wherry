// Stage 0 of docs/prompts/native-media-plan.md -- the throwaway probe.
//
// Compiled only with `--features media-spike`, and deleted once the plan's
// seven rows carry numbers. Nothing here is a design: it is the least Rust
// that can join a room on the SDK the plan proposes, publish a tone (the
// dev Mac has no microphone), read what arrives, set a call key at an
// epoch's index the way transport-webview.ts does, and touch the devices
// and the screen capturer so each row gets a yes, a no or a number. The
// webview side that drives it is client/spike/native.js, and the Chrome
// peer is client/spike/peer.js.
//
// Two things learned from the crate's source that stage 2 must keep:
//
// - `KeyProviderOptions::default()` derives with PBKDF2; the JS side, given
//   a buffer, uses HKDF. Set it explicitly or every frame is silence.
// - `KeyProvider::set_shared_key(key, index)` stores the key but does NOT
//   move the sender's cryptor onto that index -- `E2eeManager` never calls
//   `set_key_index`. The JS `onSetEncryptionKey(key, undefined, index)`
//   does both. So after every key change, walk `frame_cryptors()` and set
//   the index, or the sender keeps sealing under index 0.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use livekit::e2ee::key_provider::{KeyProvider, KeyProviderOptions};
use livekit::e2ee::{E2eeOptions, EncryptionType};
use livekit::options::{AudioEncoding, TrackPublishOptions};
use livekit::prelude::*;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::AudioSourceOptions;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::desktop_capturer::{
  CaptureError, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
};
use livekit::webrtc::native::frame_cryptor::KeyDerivationAlgorithm;
use livekit::webrtc::stats::RtcStats;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio_stream::StreamExt;

pub const LIVEKIT_REV: &str = "rust-sdks dee418bb (main 2026-09-03, #1212 merged; crate 0.8.4)";

/// Mirrors rules.ts's KEYRING_SIZE and keyIndexFor.
const KEYRING_SIZE: i32 = 16;
/// The JS default `ratchetSalt`; the Rust default is the same bytes.
const RATCHET_SALT: &[u8] = b"LKFrameEncryptionKey";
const SAMPLE_RATE: u32 = 48_000;
const TONE_HZ: f64 = 440.0;
const TONE_AMPLITUDE: f64 = 0.5;

fn key_index_for(epoch: i32) -> i32 {
  ((epoch % KEYRING_SIZE) + KEYRING_SIZE) % KEYRING_SIZE
}

fn from_hex(text: &str) -> Result<Vec<u8>, String> {
  let text = text.trim();
  if text.len() % 2 != 0 {
    return Err("hex: odd length".into());
  }
  (0..text.len())
    .step_by(2)
    .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|e| format!("hex: {e}")))
    .collect()
}

#[derive(Default, Clone)]
struct Meter {
  frames: u64,
  rms: f64,
  peak: f64,
}

/// Everything the background tasks write and the stats command reads.
#[derive(Default)]
struct Shared {
  /// Per remote identity: the last one-second RMS of *decoded* audio.
  meters: Mutex<HashMap<String, Meter>>,
  /// Per identity, per EncryptionState name, how many times it was raised.
  e2ee: Mutex<HashMap<String, HashMap<String, u64>>>,
  streams: Mutex<Vec<tokio::task::JoinHandle<()>>>,
  events: Mutex<u64>,
}

struct Session {
  room: Arc<Room>,
  keys: Option<KeyProvider>,
  local: Option<LocalAudioTrack>,
  started: Instant,
  tone: Option<tokio::task::JoinHandle<()>>,
  pump: tokio::task::JoinHandle<()>,
  shared: Arc<Shared>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// Held for the life of the process, as the plan's §5 argues stage 2 should.
static AUDIO: Mutex<Option<PlatformAudio>> = Mutex::new(None);

fn emit(app: &AppHandle, shared: &Shared, started: Instant, mut payload: Value) {
  if let Some(object) = payload.as_object_mut() {
    object.insert("t".into(), json!(started.elapsed().as_millis() as u64));
  }
  *shared.events.lock().unwrap() += 1;
  let _ = app.emit("spike", payload.clone());
  // And straight to the driver, so the webview is not in the loop.
  tokio::spawn(async move {
    let _ = driver::post("/event", &payload).await;
  });
}

// -- the driver, from Rust --------------------------------------------------------
//
// client/spike/driver.mjs queues commands from the terminal. The webview
// page relayed them at first, but a page nobody can see or inspect is a
// poor instrument, so the shell polls the driver itself over a raw
// localhost socket and answers directly. Hand-rolled HTTP/1.1 with
// `Connection: close`, because a dependency for four requests is silly.

mod driver {
  use serde_json::Value;
  use tokio::io::{AsyncReadExt, AsyncWriteExt};

  const ADDR: &str = "127.0.0.1:5199";

  async fn exchange(request: String) -> Result<(u16, String), String> {
    let mut stream = tokio::net::TcpStream::connect(ADDR).await.map_err(|e| e.to_string())?;
    stream.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("no header end")?;
    let status: u16 = head
      .split_whitespace()
      .nth(1)
      .and_then(|s| s.parse().ok())
      .ok_or("no status")?;
    Ok((status, body.to_string()))
  }

  pub async fn get(path: &str) -> Result<(u16, String), String> {
    exchange(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")).await
  }

  pub async fn post(path: &str, body: &Value) -> Result<(u16, String), String> {
    let text = body.to_string();
    exchange(format!(
      "POST {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}",
      text.len()
    ))
    .await
  }
}

async fn run_job(app: AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
  let str_arg = |key: &str| -> Result<String, String> {
    args[key].as_str().map(str::to_string).ok_or(format!("{key} missing"))
  };
  match cmd {
    "spike_info" => Ok(spike_info().await),
    "spike_connect" => {
      let parsed: ConnectArgs =
        serde_json::from_value(args["args"].clone()).map_err(|e| e.to_string())?;
      spike_connect(app, parsed).await
    }
    "spike_set_key" => spike_set_key(
      str_arg("keyHex")?,
      args["epoch"].as_i64().ok_or("epoch missing")? as i32,
    ),
    "spike_disconnect" => spike_disconnect().await,
    "spike_stats" => spike_stats().await,
    "spike_devices" => spike_devices(),
    "spike_audio_release" => Ok(spike_audio_release()),
    "spike_switch_playout" => spike_switch_playout(str_arg("id")?),
    "spike_switch_recording" => spike_switch_recording(str_arg("id")?),
    "spike_start_recording" => spike_start_recording(),
    "spike_stop_recording" => spike_stop_recording(),
    "spike_capture" => spike_capture(str_arg("kind")?).await,
    other => Err(format!("unknown command {other}")),
  }
}

/// Started once from lib.rs's setup; runs for the life of the process.
pub fn start_driver_loop(app: AppHandle) {
  tauri::async_runtime::spawn(async move {
    let _ = driver::post("/event", &json!({ "kind": "shell", "note": "driver loop started", "pid": std::process::id() })).await;
    loop {
      let job = match driver::get("/next").await {
        Ok((200, body)) => match serde_json::from_str::<Value>(&body) {
          Ok(job) => job,
          Err(_) => continue,
        },
        Ok(_) => continue,
        Err(_) => {
          tokio::time::sleep(Duration::from_secs(1)).await;
          continue;
        }
      };
      let id = job["id"].clone();
      let cmd = job["cmd"].as_str().unwrap_or("").to_string();
      let outcome = run_job(app.clone(), &cmd, job["args"].clone()).await;
      let result = match outcome {
        Ok(value) => json!({ "id": id, "ok": true, "value": value }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
      };
      let _ = driver::post("/result", &result).await;
    }
  });
}

fn platform_audio() -> Result<PlatformAudio, String> {
  let mut held = AUDIO.lock().unwrap();
  if let Some(audio) = held.as_ref() {
    return Ok(audio.clone());
  }
  let audio = PlatformAudio::new().map_err(|e| format!("PlatformAudio::new: {e:?}"))?;
  *held = Some(audio.clone());
  Ok(audio)
}

/// The JS twin is `onSetEncryptionKey(key, undefined, index)`, which also
/// moves every cryptor onto the index; here that is a separate walk.
fn apply_key_index(room: &Room, index: i32) -> usize {
  let cryptors = room.e2ee_manager().frame_cryptors();
  for cryptor in cryptors.values() {
    cryptor.set_key_index(index);
  }
  cryptors.len()
}

// -- the tone ------------------------------------------------------------------

async fn tone_loop(source: NativeAudioSource) {
  let samples_per_frame = (SAMPLE_RATE / 100) as usize;
  let step = 2.0 * std::f64::consts::PI * TONE_HZ / SAMPLE_RATE as f64;
  let mut phase = 0.0f64;
  let mut interval = tokio::time::interval(Duration::from_millis(10));
  loop {
    interval.tick().await;
    let mut data = Vec::with_capacity(samples_per_frame);
    for _ in 0..samples_per_frame {
      data.push((phase.sin() * TONE_AMPLITUDE * i16::MAX as f64) as i16);
      phase += step;
      if phase > 2.0 * std::f64::consts::PI {
        phase -= 2.0 * std::f64::consts::PI;
      }
    }
    let frame = AudioFrame {
      data: data.into(),
      sample_rate: SAMPLE_RATE,
      num_channels: 1,
      samples_per_channel: samples_per_frame as u32,
    };
    if source.capture_frame(&frame).await.is_err() {
      break;
    }
  }
}

// -- what arrives --------------------------------------------------------------

async fn meter_loop(
  app: AppHandle,
  shared: Arc<Shared>,
  started: Instant,
  identity: String,
  track: RemoteAudioTrack,
) {
  let mut stream = NativeAudioStream::new(track.rtc_track(), SAMPLE_RATE as i32, 1);
  let mut sum_squares = 0.0f64;
  let mut samples = 0u64;
  let mut peak = 0.0f64;
  let mut frames = 0u64;
  while let Some(frame) = stream.next().await {
    for &sample in frame.data.iter() {
      let value = sample as f64 / 32768.0;
      sum_squares += value * value;
      samples += 1;
      if value.abs() > peak {
        peak = value.abs();
      }
    }
    frames += 1;
    if frames % 100 == 0 {
      let rms = (sum_squares / samples.max(1) as f64).sqrt();
      shared
        .meters
        .lock()
        .unwrap()
        .insert(identity.clone(), Meter { frames, rms, peak });
      emit(
        &app,
        &shared,
        started,
        json!({ "kind": "rms", "identity": identity, "rms": rms, "peak": peak, "frames": frames }),
      );
      sum_squares = 0.0;
      samples = 0;
      peak = 0.0;
    }
  }
  emit(&app, &shared, started, json!({ "kind": "stream_ended", "identity": identity }));
}

async fn pump(
  app: AppHandle,
  shared: Arc<Shared>,
  started: Instant,
  mut rx: tokio::sync::mpsc::UnboundedReceiver<RoomEvent>,
) {
  while let Some(event) = rx.recv().await {
    let payload = match event {
      RoomEvent::TrackSubscribed { track, publication, participant } => {
        let identity = participant.identity().to_string();
        if let RemoteTrack::Audio(audio) = track {
          let task = tokio::spawn(meter_loop(
            app.clone(),
            shared.clone(),
            started,
            identity.clone(),
            audio,
          ));
          shared.streams.lock().unwrap().push(task);
        }
        json!({
          "kind": "track_subscribed",
          "identity": identity,
          "sid": publication.sid().to_string(),
          "encryption": format!("{:?}", publication.encryption_type()),
        })
      }
      RoomEvent::TrackUnsubscribed { participant, publication, .. } => json!({
        "kind": "track_unsubscribed",
        "identity": participant.identity().to_string(),
        "sid": publication.sid().to_string(),
      }),
      RoomEvent::E2eeStateChanged { participant, state } => {
        let identity = participant.identity().to_string();
        let name = format!("{state:?}");
        *shared
          .e2ee
          .lock()
          .unwrap()
          .entry(identity.clone())
          .or_default()
          .entry(name.clone())
          .or_default() += 1;
        json!({ "kind": "e2ee", "identity": identity, "state": name })
      }
      RoomEvent::ParticipantEncryptionStatusChanged { participant, is_encrypted } => json!({
        "kind": "encryption_status",
        "identity": participant.identity().to_string(),
        "encrypted": is_encrypted,
      }),
      RoomEvent::ParticipantConnected(p) => {
        json!({ "kind": "participant_joined", "identity": p.identity().to_string() })
      }
      RoomEvent::ParticipantDisconnected(p) => {
        json!({ "kind": "participant_left", "identity": p.identity().to_string() })
      }
      RoomEvent::TrackMuted { participant, .. } => {
        json!({ "kind": "muted", "identity": participant.identity().to_string() })
      }
      RoomEvent::TrackUnmuted { participant, .. } => {
        json!({ "kind": "unmuted", "identity": participant.identity().to_string() })
      }
      RoomEvent::ConnectionQualityChanged { quality, participant } => json!({
        "kind": "quality",
        "identity": participant.identity().to_string(),
        "quality": format!("{quality:?}"),
      }),
      RoomEvent::ActiveSpeakersChanged { speakers } => json!({
        "kind": "speakers",
        "identities": speakers.iter().map(|p| p.identity().to_string()).collect::<Vec<_>>(),
      }),
      RoomEvent::ConnectionStateChanged(state) => {
        json!({ "kind": "connection", "state": format!("{state:?}") })
      }
      RoomEvent::Connected { .. } => json!({ "kind": "connected" }),
      RoomEvent::Reconnecting => json!({ "kind": "reconnecting" }),
      RoomEvent::Reconnected => json!({ "kind": "reconnected" }),
      RoomEvent::Disconnected { reason } => {
        json!({ "kind": "disconnected", "reason": format!("{reason:?}") })
      }
      other => {
        let text = format!("{other:?}");
        json!({ "kind": "other", "event": text.chars().take(120).collect::<String>() })
      }
    };
    emit(&app, &shared, started, payload);
  }
  emit(&app, &shared, started, json!({ "kind": "pump_ended" }));
}

// -- commands ------------------------------------------------------------------

#[tauri::command]
pub async fn spike_info() -> Value {
  let tokio = tokio::runtime::Handle::try_current()
    .map(|handle| format!("{:?}", handle.runtime_flavor()))
    .unwrap_or_else(|e| format!("no runtime: {e}"));
  json!({
    "livekitRev": LIVEKIT_REV,
    "pid": std::process::id(),
    "tokio": tokio,
    "thread": std::thread::current().name(),
    "connected": SESSION.lock().unwrap().is_some(),
    "platformAudioHeld": AUDIO.lock().unwrap().is_some(),
  })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
  url: String,
  token: String,
  e2ee: bool,
  key_hex: Option<String>,
  epoch: i32,
  /// Publish a synthesised 440 Hz tone through a NativeAudioSource.
  tone: bool,
  /// Publish the platform microphone through PlatformAudio instead.
  mic: bool,
}

#[tauri::command]
pub async fn spike_connect(app: AppHandle, args: ConnectArgs) -> Result<Value, String> {
  if SESSION.lock().unwrap().is_some() {
    return Err("already connected".into());
  }
  let started = Instant::now();
  let shared = Arc::new(Shared::default());

  let keys = if args.e2ee {
    let secret = from_hex(args.key_hex.as_deref().ok_or("keyHex is required when e2ee is on")?)?;
    // transport-webview.ts's CallKeyProvider, parameter for parameter, plus
    // the one the JS side gets for free from createKeyMaterialFromBuffer.
    let options = KeyProviderOptions {
      ratchet_window_size: 0,
      ratchet_salt: RATCHET_SALT.to_vec(),
      failure_tolerance: -1,
      key_ring_size: KEYRING_SIZE,
      key_derivation_algorithm: KeyDerivationAlgorithm::HKDF,
    };
    let provider = KeyProvider::with_shared_key(options, secret.clone());
    provider.set_shared_key(secret, key_index_for(args.epoch));
    Some(provider)
  } else {
    None
  };

  let mut options = RoomOptions::default();
  options.auto_subscribe = true;
  options.encryption = keys
    .clone()
    .map(|key_provider| E2eeOptions { encryption_type: EncryptionType::Gcm, key_provider });

  let (room, rx) = Room::connect(&args.url, &args.token, options)
    .await
    .map_err(|e| format!("connect: {e}"))?;
  let connect_ms = started.elapsed().as_millis() as u64;
  let room = Arc::new(room);

  let pump_task = tokio::spawn(pump(app.clone(), shared.clone(), started, rx));

  let publish_options = TrackPublishOptions {
    source: TrackSource::Microphone,
    dtx: true,
    red: true,
    audio_encoding: Some(AudioEncoding { max_bitrate: 32_000 }),
    ..Default::default()
  };
  let mut local = None;
  let mut tone = None;
  let mut mic_error = None;
  let mut publish_ms = None;
  if args.tone {
    let source = NativeAudioSource::new(AudioSourceOptions::default(), SAMPLE_RATE, 1, 0);
    let track = LocalAudioTrack::create_audio_track("tone", RtcAudioSource::Native(source.clone()));
    let t0 = Instant::now();
    room
      .local_participant()
      .publish_track(LocalTrack::Audio(track.clone()), publish_options.clone())
      .await
      .map_err(|e| format!("publish tone: {e}"))?;
    publish_ms = Some(t0.elapsed().as_millis() as u64);
    tone = Some(tokio::spawn(tone_loop(source)));
    local = Some(track);
  } else if args.mic {
    match platform_audio() {
      Ok(audio) => {
        let track = LocalAudioTrack::create_audio_track("microphone", audio.rtc_source());
        let t0 = Instant::now();
        match room
          .local_participant()
          .publish_track(LocalTrack::Audio(track.clone()), publish_options.clone())
          .await
        {
          Ok(_) => {
            publish_ms = Some(t0.elapsed().as_millis() as u64);
            local = Some(track);
          }
          Err(e) => mic_error = Some(format!("publish mic: {e}")),
        }
      }
      Err(e) => mic_error = Some(e),
    }
  }

  let cryptors = keys.as_ref().map(|_| apply_key_index(&room, key_index_for(args.epoch)));

  let result = json!({
    "room": room.name(),
    "identity": room.local_participant().identity().to_string(),
    "connectMs": connect_ms,
    "publishMs": publish_ms,
    "published": local.is_some(),
    "micError": mic_error,
    "e2ee": keys.is_some(),
    "keyIndex": keys.as_ref().map(|_| key_index_for(args.epoch)),
    "cryptors": cryptors,
  });

  *SESSION.lock().unwrap() = Some(Session {
    room,
    keys,
    local,
    started,
    tone,
    pump: pump_task,
    shared,
  });
  Ok(result)
}

#[tauri::command]
pub fn spike_set_key(key_hex: String, epoch: i32) -> Result<Value, String> {
  let guard = SESSION.lock().unwrap();
  let session = guard.as_ref().ok_or("not connected")?;
  let keys = session.keys.as_ref().ok_or("frame encryption is off")?;
  let index = key_index_for(epoch);
  keys.set_shared_key(from_hex(&key_hex)?, index);
  let cryptors = apply_key_index(&session.room, index);
  let read_back: Vec<Value> = session
    .room
    .e2ee_manager()
    .frame_cryptors()
    .iter()
    .map(|((identity, _), c)| json!({ "identity": identity.to_string(), "keyIndex": c.key_index() }))
    .collect();
  Ok(json!({ "index": index, "cryptors": cryptors, "readBack": read_back, "latest": keys.get_latest_key_index() }))
}

#[tauri::command]
pub async fn spike_disconnect() -> Result<Value, String> {
  let session = SESSION.lock().unwrap().take().ok_or("not connected")?;
  let Session { room, keys, local, started, tone, pump, shared } = session;
  if let Some(task) = tone {
    task.abort();
  }
  for task in shared.streams.lock().unwrap().drain(..) {
    task.abort();
  }
  let t0 = Instant::now();
  let closed = room.close().await.map_err(|e| format!("close: {e}"));
  let close_ms = t0.elapsed().as_millis() as u64;
  pump.abort();
  let events = *shared.events.lock().unwrap();
  drop(local);
  drop(keys);
  drop(room);
  Ok(json!({
    "closeMs": close_ms,
    "closed": closed.is_ok(),
    "error": closed.err(),
    "lifetimeMs": started.elapsed().as_millis() as u64,
    "events": events,
  }))
}

fn summarize_local(stats: &[RtcStats]) -> Value {
  let mut out = json!({});
  for entry in stats {
    match entry {
      RtcStats::OutboundRtp(s) => {
        out["packetsSent"] = json!(s.sent.packets_sent);
        out["bytesSent"] = json!(s.sent.bytes_sent);
      }
      RtcStats::RemoteInboundRtp(s) => {
        out["roundTripMs"] = json!((s.remote_inbound.round_trip_time * 1000.0).round());
        out["packetsLost"] = json!(s.received.packets_lost);
        out["jitter"] = json!(s.received.jitter);
      }
      RtcStats::MediaSource(s) => {
        out["audioLevel"] = json!(s.audio.audio_level);
        out["totalAudioEnergy"] = json!(s.audio.total_audio_energy);
        out["echoReturnLoss"] = json!(s.audio.echo_return_loss);
        out["echoReturnLossEnhancement"] = json!(s.audio.echo_return_loss_enhancement);
        out["totalSamplesCaptured"] = json!(s.audio.total_samples_captured);
      }
      _ => {}
    }
  }
  out
}

fn summarize_inbound(stats: &[RtcStats]) -> Value {
  let mut out = json!({});
  for entry in stats {
    if let RtcStats::InboundRtp(s) = entry {
      out["packetsReceived"] = json!(s.received.packets_received);
      out["packetsLost"] = json!(s.received.packets_lost);
      out["jitter"] = json!(s.received.jitter);
      out["audioLevel"] = json!(s.inbound.audio_level);
      out["totalAudioEnergy"] = json!(s.inbound.total_audio_energy);
      out["concealedSamples"] = json!(s.inbound.concealed_samples);
      out["silentConcealedSamples"] = json!(s.inbound.silent_concealed_samples);
    }
  }
  out
}

#[tauri::command]
pub async fn spike_stats() -> Result<Value, String> {
  let (room, local, shared, started) = {
    let guard = SESSION.lock().unwrap();
    let session = guard.as_ref().ok_or("not connected")?;
    (session.room.clone(), session.local.clone(), session.shared.clone(), session.started)
  };
  let cryptors: Vec<Value> = room
    .e2ee_manager()
    .frame_cryptors()
    .iter()
    .map(|((identity, sid), cryptor)| {
      json!({
        "identity": identity.to_string(),
        "sid": sid.to_string(),
        "participantId": cryptor.participant_id(),
        "keyIndex": cryptor.key_index(),
        "enabled": cryptor.enabled(),
      })
    })
    .collect();
  let mut out = json!({
    "t": started.elapsed().as_millis() as u64,
    "connection": format!("{:?}", room.connection_state()),
    "e2eeEnabled": room.e2ee_manager().enabled(),
    "cryptors": cryptors,
    "events": *shared.events.lock().unwrap(),
  });
  if let Some(track) = local {
    match track.get_stats().await {
      Ok(stats) => out["local"] = summarize_local(&stats),
      Err(e) => out["localError"] = json!(e.to_string()),
    }
  }
  let mut peers = Vec::new();
  for (identity, participant) in room.remote_participants() {
    for (sid, publication) in participant.track_publications() {
      if publication.kind() != TrackKind::Audio {
        continue;
      }
      let mut peer = json!({
        "identity": identity.to_string(),
        "sid": sid.to_string(),
        "muted": publication.is_muted(),
        "encryption": format!("{:?}", publication.encryption_type()),
        "audioLevel": participant.audio_level(),
        "speaking": participant.is_speaking(),
      });
      if let Some(RemoteTrack::Audio(track)) = publication.track() {
        match track.get_stats().await {
          Ok(stats) => peer["inbound"] = summarize_inbound(&stats),
          Err(e) => peer["error"] = json!(e.to_string()),
        }
      }
      peers.push(peer);
    }
  }
  out["peers"] = json!(peers);
  out["meters"] = json!(shared
    .meters
    .lock()
    .unwrap()
    .iter()
    .map(|(k, m)| (k.clone(), json!({ "frames": m.frames, "rms": m.rms, "peak": m.peak })))
    .collect::<HashMap<_, _>>());
  out["e2eeStates"] = json!(*shared.e2ee.lock().unwrap());
  Ok(out)
}

fn describe_audio(audio: &PlatformAudio) -> Value {
  json!({
    "recording": audio
      .recording_devices()
      .map(|d| json!({ "id": d.id.as_str(), "name": d.name, "index": d.index }))
      .collect::<Vec<_>>(),
    "playout": audio
      .playout_devices()
      .map(|d| json!({ "id": d.id.as_str(), "name": d.name, "index": d.index }))
      .collect::<Vec<_>>(),
    "aec": format!("{:?}", audio.active_aec_type()),
    "agc": format!("{:?}", audio.active_agc_type()),
    "ns": format!("{:?}", audio.active_ns_type()),
    "hardwareAec": audio.is_hardware_aec_available(),
    "refCount": audio.ref_count(),
    "recordingInitialized": audio.is_recording_initialized(),
  })
}

#[tauri::command]
pub fn spike_devices() -> Result<Value, String> {
  let t0 = Instant::now();
  let audio = platform_audio()?;
  let mut out = describe_audio(&audio);
  out["ms"] = json!(t0.elapsed().as_millis() as u64);
  Ok(out)
}

#[tauri::command]
pub fn spike_audio_release() -> Value {
  let held = AUDIO.lock().unwrap().take();
  let was_held = held.is_some();
  let t0 = Instant::now();
  drop(held);
  json!({ "released": was_held, "ms": t0.elapsed().as_millis() as u64 })
}

#[tauri::command]
pub fn spike_switch_playout(id: String) -> Result<Value, String> {
  let audio = platform_audio()?;
  let t0 = Instant::now();
  audio
    .switch_playout_device(&PlayoutDeviceId::from_unchecked_guid(&id))
    .map_err(|e| format!("switch_playout_device: {e:?}"))?;
  Ok(json!({ "id": id, "ms": t0.elapsed().as_millis() as u64 }))
}

#[tauri::command]
pub fn spike_switch_recording(id: String) -> Result<Value, String> {
  let audio = platform_audio()?;
  let t0 = Instant::now();
  audio
    .switch_recording_device(&RecordingDeviceId::from_unchecked_guid(&id))
    .map_err(|e| format!("switch_recording_device: {e:?}"))?;
  Ok(json!({ "id": id, "ms": t0.elapsed().as_millis() as u64 }))
}

#[tauri::command]
pub fn spike_start_recording() -> Result<Value, String> {
  let audio = platform_audio()?;
  let t0 = Instant::now();
  let result = audio.start_recording().map_err(|e| format!("{e:?}"));
  Ok(json!({ "ok": result.is_ok(), "error": result.err(), "ms": t0.elapsed().as_millis() as u64, "initialized": audio.is_recording_initialized() }))
}

#[tauri::command]
pub fn spike_stop_recording() -> Result<Value, String> {
  let audio = platform_audio()?;
  let result = audio.stop_recording().map_err(|e| format!("{e:?}"));
  Ok(json!({ "ok": result.is_ok(), "error": result.err() }))
}

fn capture_once(kind: &str) -> Result<Value, String> {
  let source_type = match kind {
    "screen" => DesktopCaptureSourceType::Screen,
    "window" => DesktopCaptureSourceType::Window,
    other => return Err(format!("kind must be screen or window, not {other}")),
  };
  let t0 = Instant::now();
  let mut options = DesktopCapturerOptions::new(source_type);
  // The system picker is a UI nobody can click from here; a direct source
  // list is what a "share this window" panel would use anyway.
  #[cfg(target_os = "macos")]
  options.set_sck_system_picker(false);
  options.set_include_cursor(false);
  let mut capturer =
    DesktopCapturer::new(options).ok_or("DesktopCapturer::new returned None")?;
  let sources = capturer.get_source_list();
  let list: Vec<Value> = sources
    .iter()
    .take(8)
    .map(|s| json!({ "id": s.id(), "title": s.title(), "displayId": s.display_id() }))
    .collect();
  let (tx, rx) = std::sync::mpsc::channel::<Result<Value, String>>();
  capturer.start_capture(sources.first().cloned(), move |result| {
    let _ = tx.send(match result {
      Ok(frame) => Ok(json!({
        "width": frame.width(),
        "height": frame.height(),
        "stride": frame.stride(),
        "bytes": frame.data().len(),
        "nonZero": frame.data().iter().any(|&b| b != 0),
      })),
      Err(CaptureError::Temporary) => Err("temporary".into()),
      Err(CaptureError::Permanent) => Err("permanent".into()),
    });
  });
  let deadline = Instant::now() + Duration::from_secs(5);
  let mut attempts = 0u32;
  let mut last_error = None;
  let mut frame = None;
  while Instant::now() < deadline {
    capturer.capture_frame();
    attempts += 1;
    match rx.recv_timeout(Duration::from_millis(100)) {
      Ok(Ok(value)) => {
        frame = Some(value);
        break;
      }
      Ok(Err(error)) => {
        let permanent = error == "permanent";
        last_error = Some(error);
        if permanent {
          break;
        }
      }
      Err(_) => {}
    }
  }
  Ok(json!({
    "kind": kind,
    "sources": sources.len(),
    "list": list,
    "frame": frame,
    "error": last_error,
    "attempts": attempts,
    "ms": t0.elapsed().as_millis() as u64,
  }))
}

#[tauri::command]
pub async fn spike_capture(kind: String) -> Result<Value, String> {
  tokio::task::spawn_blocking(move || capture_once(&kind))
    .await
    .map_err(|e| format!("capture task: {e}"))?
}
