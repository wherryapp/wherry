// The native media transport -- stage 2 of docs/prompts/native-media-plan.md.
//
// This is the first Rust in the shell that is not a passthrough, and the
// rule it lives under is the plan's §7 rewrite of the old "no IPC, no Rust
// logic": **decisions in TypeScript, mechanism in Rust, and the boundary is
// a named interface.** The interface is `VoiceTransport`
// (client/src/voice/transport.ts); `transport-native.ts` is the TypeScript
// half of this implementation and every command here mirrors one of its
// methods. Nothing in this file decides anything: which key index an epoch
// maps to, whether a volume means silence, what an encryption state means,
// whether a device id is still valid -- all of that arrives already decided,
// and this file captures, encrypts, sends, receives and plays.
//
// Desktop only (`#[cfg(desktop)]` at the `mod` site): the phones keep the
// webview transport, and the `livekit` crate is not in their dependency
// graph at all.
//
// What stage 0 (the plan's §3.1) settled and this file keeps:
//
// - `KeyProviderOptions` must say `KeyDerivationAlgorithm::HKDF`. The Rust
//   default is PBKDF2; the JS side, given a buffer, uses HKDF. Leave the
//   default and every frame is silence.
// - `KeyProvider::set_shared_key(key, index)` stores the key but never moves
//   the *sender's* cryptor onto that index -- the JS SDK does both in one
//   call. `apply_key_index` is the walk, run after every key change, after
//   the microphone publishes (that is when the sender's cryptor exists) and
//   on every subscription for good measure.
// - `PlatformAudio` is held for the life of the process (`AUDIO`), never
//   per call: the macOS capture-thread teardown race the plan's §1.3
//   describes lives on the acquire/release path, and Settings needs the
//   handle for device enumeration when no call is running anyway.
// - `E2eeStateChanged` does not fire for frames that fail to open under a
//   wrong key (only `MissingKey`), so the encryption-error count in the
//   call details is weaker here than in the webview; the state names are
//   forwarded as-is and TypeScript decides which count.
// - Per-remote-track gain exists since stage 3 (`RtcAudioTrack::set_volume`,
//   carried on the fork -- see Cargo.toml): `voice_set_volume` applies a
//   playout gain at the receive stream, and `voice_set_playback` still
//   enables or disables the track outright. TypeScript decides what a
//   listener's 0..1 means in terms of the two.
// - The microphone's processing switches (echo cancellation, noise
//   suppression, gain control) are the audio *source's* options, fixed when
//   the track is created -- so they are configured in `voice_connect`,
//   before the microphone is published, and apply to that call. Upstream's
//   `configure_audio_processing` was a no-op on desktop until the fork's
//   commit made it store them (docs/prompts/native-media-plan.md §6).
// - The audio device module raises no hot-plug event. `voice_probe` starts
//   one poller for the life of the process that re-reads the device list
//   every two seconds and emits `voice-devices` when it changed, so the
//   page needs no timer of its own for it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use livekit::e2ee::key_provider::{KeyProvider, KeyProviderOptions};
use livekit::e2ee::{E2eeOptions, EncryptionType};
use livekit::options::{AudioEncoding, TrackPublishOptions};
use livekit::prelude::*;
use livekit::webrtc::native::frame_cryptor::KeyDerivationAlgorithm;
use livekit::webrtc::stats::RtcStats;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
#[cfg(debug_assertions)]
use tauri::Manager;
use tokio::sync::mpsc::UnboundedReceiver;

// Video (docs/prompts/video-next-stages-handoff.md §3): the sources, the
// native tiles, and the commands that publish, subscribe and place them.
pub mod capture;
#[cfg(target_os = "macos")]
pub mod render;
#[cfg(not(target_os = "macos"))]
#[path = "render_stub.rs"]
pub mod render;
pub mod video;

/// Which SDK revision this shell carries; shown by the probe so a call
/// details readout can name it. Bump with the `rev` in Cargo.toml.
pub const LIVEKIT_REV: &str = "rust-sdks dee418bb + wherryapp/rust-sdks wherry/stage-3n e75845b1 (2026-09-08)";

/// The name every per-call event from this module is emitted under.
const EVENT: &str = "voice";
/// The device list changed (not per call; carries the new `AudioDevices`).
const DEVICES_EVENT: &str = "voice-devices";
/// How often the device list is re-read for `voice-devices`.
const DEVICE_POLL_MS: u64 = 2_000;

/// Mirrors `KEYRING_SIZE` in client/src/voice/rules.ts and the
/// `keyringSize` the webview transport passes to livekit-client. The
/// *index* into the ring is computed in TypeScript and arrives with the key;
/// the ring's size is a property both sides' key providers must agree on.
const KEYRING_SIZE: i32 = 16;
/// The JS SDK's default `ratchetSalt`; the Rust default is the same bytes,
/// spelled out here so the match is visible rather than coincidental.
const RATCHET_SALT: &[u8] = b"LKFrameEncryptionKey";

// -- errors -----------------------------------------------------------------

/// What a command reports when it fails: a code the TypeScript side maps to
/// the browser error names `session.ts` already understands
/// (`transport-rules.ts`), and the SDK's own words for the details panel.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceError {
  pub code: &'static str,
  pub message: String,
}

impl VoiceError {
  pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self { code, message: message.into() }
  }
}

pub(crate) type VoiceResult<T> = Result<T, VoiceError>;

// -- the audio device module ------------------------------------------------

/// The one `PlatformAudio` handle, created on first use and never released
/// (see the header). `None` until then, or if the platform has no audio
/// devices at all -- the SDK refuses to construct it in that case.
static AUDIO: Mutex<Option<PlatformAudio>> = Mutex::new(None);

fn platform_audio() -> VoiceResult<PlatformAudio> {
  let mut held = AUDIO.lock().unwrap();
  if let Some(audio) = held.as_ref() {
    return Ok(audio.clone());
  }
  let audio = PlatformAudio::new()
    .map_err(|e| VoiceError::new("audio_unavailable", format!("PlatformAudio::new: {e:?}")))?;
  *held = Some(audio.clone());
  Ok(audio)
}

// -- the session ------------------------------------------------------------

/// Counts connects for the life of the process. Every event carries the
/// session it belongs to, so a listener that outlives a call cannot mistake
/// the next call's events for its own.
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// State the event pump and the commands both touch.
#[derive(Default)]
struct Shared {
  /// The local participant's last reported connection quality, lowercased
  /// (`excellent`, `good`, `poor`, `lost`); `unknown` before the first.
  quality: Mutex<String>,
  /// Whether audio should play, keyed by `audio_kind_key` -- identity and
  /// kind, not identity alone, since 2026-09-09. Applied when a track is
  /// subscribed as well as on demand, so a participant who joins after the
  /// listener turned them down stays turned down.
  playback: Mutex<HashMap<String, bool>>,
  /// The playout gain on the same key (WebRTC's range, 1.0 is unity;
  /// TypeScript never sends above it). Applied the same way.
  volume: Mutex<HashMap<String, f64>>,
  /// The key index every cryptor should sit on; walked onto new cryptors
  /// as they appear.
  key_index: Mutex<i32>,
}

// A debug-only synthesised tone once stood in for the microphone here
// (`WHERRY_VOICE_TONE=1`), because the dev Mac had no input device while
// stages 0 and 2 were built. It was deleted on 2026-09-07 once a real
// microphone had been through this path (docs/prompts/native-media-plan.md
// §5.1). A machine without a microphone gets `no_microphone` below, the
// same answer the browser gives.

struct Session {
  id: u64,
  room: Arc<Room>,
  keys: Option<KeyProvider>,
  shared: Arc<Shared>,
  /// The microphone, once it has been published; `None` before the first
  /// `voice_set_mic(true)`.
  mic: Option<LocalTrackPublication>,
  max_bitrate: u64,
  pump: tauri::async_runtime::JoinHandle<()>,
  started: Instant,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn session_id() -> Option<u64> {
  SESSION.lock().unwrap().as_ref().map(|s| s.id)
}

/// The room and the shared state of the current session, cloned out so no
/// lock is held across an await.
fn current() -> VoiceResult<(u64, Arc<Room>, Arc<Shared>)> {
  let guard = SESSION.lock().unwrap();
  let session = guard.as_ref().ok_or_else(|| VoiceError::new("not_connected", "no call"))?;
  Ok((session.id, session.room.clone(), session.shared.clone()))
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

// -- what the webview sees --------------------------------------------------

/// One remote participant, as `TransportParticipant` wants it minus the
/// `userId`, which TypeScript parses out of `metadata` exactly as the
/// webview transport does (the server puts `{ userId }` there).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
  identity: String,
  name: String,
  metadata: String,
  speaking: bool,
  /// No audio publication, or every one of them muted -- the same reading
  /// `transport-webview.ts` takes from `audioTrackPublications`.
  mic_muted: bool,
  encrypted: bool,
  audio_level: f32,
  /// Whether their audio track is enabled for playout here.
  playing: Option<bool>,
  /// A camera publication exists for them, muted or not -- and likewise a
  /// screen. This transport can neither publish nor render video until
  /// stage 3N (docs/prompts/video-execution-handoff.md §0), so these two
  /// booleans exist for exactly one purpose: so a participant on this
  /// engine is told "Alice's camera is on -- switch engine to see it"
  /// rather than shown nothing at all.
  has_camera: bool,
  has_screen: bool,
  /// Their screen share carries a second audio track. A separate volume
  /// from their voice, never folded into `mic_muted`.
  has_screen_audio: bool,
  /// Their camera publication is muted -- camera off, or their app in the
  /// background. Read the same way the webview reads `isMuted`, since
  /// 2026-09-08 when this transport learned to render.
  camera_muted: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Roster {
  participants: Vec<RosterEntry>,
  local_level: f32,
}

/// A remote's audio publications of one source.
///
/// Split by source since 2026-09-09, and the distinction is load-bearing
/// rather than tidy: a screen share may carry a second audio track
/// (`ScreenshareAudio`), and everything this file says about "their audio"
/// meant *their microphone*. Reading the microphone's mute state from
/// "every audio publication is muted" would call somebody unmuted because
/// they are sharing a video's soundtrack, and a volume applied to every
/// publication would move their voice and the thing they are sharing
/// together. The maintainer's decision on 2026-09-09 is that those are two
/// controls, so they are two keys everywhere below.
fn audio_publications_of(
  participant: &RemoteParticipant,
  source: TrackSource,
) -> Vec<RemoteTrackPublication> {
  participant
    .track_publications()
    .into_values()
    .filter(|publication| publication.kind() == TrackKind::Audio && publication.source() == source)
    .collect()
}

fn mic_publications(participant: &RemoteParticipant) -> Vec<RemoteTrackPublication> {
  audio_publications_of(participant, TrackSource::Microphone)
}

/// The audio kind a command names, as TypeScript spells it. Unknown words
/// fall back to the microphone, which is what every caller before
/// 2026-09-09 meant.
fn audio_source_of(word: &str) -> TrackSource {
  match word {
    "screen" => TrackSource::ScreenshareAudio,
    _ => TrackSource::Microphone,
  }
}

fn audio_kind_key(identity: &str, source: TrackSource) -> String {
  match source {
    TrackSource::ScreenshareAudio => format!("{identity}/screen"),
    _ => format!("{identity}/microphone"),
  }
}

fn has_video_source(participant: &RemoteParticipant, source: TrackSource) -> bool {
  participant
    .track_publications()
    .into_values()
    .any(|publication| publication.kind() == TrackKind::Video && publication.source() == source)
}

fn roster(room: &Room) -> Roster {
  let mut participants: Vec<RosterEntry> = room
    .remote_participants()
    .into_iter()
    .map(|(identity, participant)| {
      let audio = mic_publications(&participant);
      let playing = audio.iter().find_map(|publication| match publication.track() {
        Some(RemoteTrack::Audio(track)) => Some(track.rtc_track().enabled()),
        _ => None,
      });
      RosterEntry {
        identity: identity.to_string(),
        name: participant.name(),
        metadata: participant.metadata(),
        speaking: participant.is_speaking(),
        mic_muted: audio.is_empty() || audio.iter().all(|publication| publication.is_muted()),
        encrypted: participant.is_encrypted(),
        audio_level: participant.audio_level(),
        playing,
        has_camera: has_video_source(&participant, TrackSource::Camera),
        has_screen: has_video_source(&participant, TrackSource::Screenshare),
        has_screen_audio: !audio_publications_of(&participant, TrackSource::ScreenshareAudio)
          .is_empty(),
        camera_muted: video::camera_muted(&participant),
      }
    })
    .collect();
  participants.sort_by(|a, b| a.identity.cmp(&b.identity));
  Roster { participants, local_level: room.local_participant().audio_level() }
}

/// Everything the pump tells the webview. `session` is on every variant so
/// the listener can drop what is not its own.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Event {
  /// The roster changed: somebody joined or left, a track came or went, a
  /// mute or encryption status moved. Carries the whole snapshot.
  Roster { roster: Roster },
  /// Active speakers moved; the roster's `speaking` and levels are fresh.
  Speakers { roster: Roster },
  ParticipantJoined,
  ParticipantLeft,
  /// The local connection: `connected`, `reconnecting` or `disconnected`,
  /// with the last known quality word.
  Connection { state: String, quality: String },
  /// The SDK's frame-cryption state for one participant, by name
  /// (`Ok`, `MissingKey`, `DecryptionFailed`, ...). TypeScript decides which
  /// of these count as a frame that failed to open.
  Encryption { identity: String, state: String },
  /// A video publication appeared, went, muted, or was (un)subscribed: the
  /// seam's `videoChanged`, kept apart from the roster event because a tile
  /// remounting is expensive where a name changing is not.
  VideoChanged,
}

#[derive(Serialize, Clone, Debug)]
struct Envelope {
  session: u64,
  #[serde(flatten)]
  event: Event,
}

fn emit(app: &AppHandle, session: u64, event: Event) {
  if let Err(error) = app.emit(EVENT, Envelope { session, event }) {
    log::warn!("voice: emit failed: {error}");
  }
}

fn apply_playback(shared: &Shared, participant: &RemoteParticipant) {
  for source in [TrackSource::Microphone, TrackSource::ScreenshareAudio] {
    apply_playback_of(shared, participant, source);
  }
}

fn apply_playback_of(shared: &Shared, participant: &RemoteParticipant, source: TrackSource) {
  let key = audio_kind_key(participant.identity().as_str(), source);
  let enabled = shared.playback.lock().unwrap().get(&key).copied();
  let volume = shared.volume.lock().unwrap().get(&key).copied();
  if enabled.is_none() && volume.is_none() {
    return;
  }
  for publication in audio_publications_of(participant, source) {
    if let Some(RemoteTrack::Audio(track)) = publication.track() {
      if let Some(enabled) = enabled {
        track.rtc_track().set_enabled(enabled);
      }
      if let Some(volume) = volume {
        track.rtc_track().set_volume(volume);
      }
    }
  }
}

async fn pump(
  app: AppHandle,
  session: u64,
  room: Arc<Room>,
  shared: Arc<Shared>,
  mut rx: UnboundedReceiver<RoomEvent>,
) {
  let quality = || shared.quality.lock().unwrap().clone();
  while let Some(event) = rx.recv().await {
    match event {
      RoomEvent::Connected { .. } => {
        emit(&app, session, Event::Connection { state: "connected".into(), quality: quality() });
        emit(&app, session, Event::Roster { roster: roster(&room) });
      }
      RoomEvent::ParticipantConnected(_) => {
        emit(&app, session, Event::ParticipantJoined);
        emit(&app, session, Event::Roster { roster: roster(&room) });
      }
      RoomEvent::ParticipantDisconnected(_) => {
        emit(&app, session, Event::ParticipantLeft);
        emit(&app, session, Event::Roster { roster: roster(&room) });
      }
      RoomEvent::TrackSubscribed { participant, publication, .. } => {
        log::info!(
          "voice: subscribed to {} from {} ({:?})",
          publication.sid(),
          participant.identity(),
          publication.encryption_type()
        );
        // A cryptor was just created for this track; put it on the index
        // everything else is on. Harmless for a receiver (the frame trailer
        // names its own index), and what makes the walk complete.
        let index = *shared.key_index.lock().unwrap();
        apply_key_index(&room, index);
        apply_playback(&shared, &participant);
        emit(&app, session, Event::Roster { roster: roster(&room) });
        if publication.kind() == TrackKind::Video {
          video::on_video_event(&app, session, &room);
        }
      }
      RoomEvent::TrackUnsubscribed { publication, .. }
      | RoomEvent::TrackPublished { publication, .. }
      | RoomEvent::TrackUnpublished { publication, .. } => {
        emit(&app, session, Event::Roster { roster: roster(&room) });
        if publication.kind() == TrackKind::Video {
          video::on_video_event(&app, session, &room);
        }
      }
      RoomEvent::TrackMuted { publication, .. } | RoomEvent::TrackUnmuted { publication, .. } => {
        emit(&app, session, Event::Roster { roster: roster(&room) });
        if publication.kind() == TrackKind::Video {
          video::on_video_event(&app, session, &room);
        }
      }
      RoomEvent::ParticipantEncryptionStatusChanged { .. }
      | RoomEvent::ParticipantNameChanged { .. }
      | RoomEvent::ParticipantMetadataChanged { .. } => {
        emit(&app, session, Event::Roster { roster: roster(&room) });
      }
      RoomEvent::ActiveSpeakersChanged { .. } => {
        emit(&app, session, Event::Speakers { roster: roster(&room) });
      }
      RoomEvent::ConnectionQualityChanged { quality: q, participant } => {
        if matches!(participant, Participant::Local(_)) {
          let word = format!("{q:?}").to_lowercase();
          *shared.quality.lock().unwrap() = word.clone();
          emit(&app, session, Event::Connection { state: "connected".into(), quality: word });
        }
      }
      RoomEvent::ConnectionStateChanged(state) => {
        let word = match state {
          ConnectionState::Connected => "connected",
          ConnectionState::Reconnecting => "reconnecting",
          ConnectionState::Disconnected => "disconnected",
        };
        emit(&app, session, Event::Connection { state: word.into(), quality: quality() });
      }
      RoomEvent::Reconnecting => {
        emit(&app, session, Event::Connection { state: "reconnecting".into(), quality: quality() });
      }
      RoomEvent::Reconnected => {
        emit(&app, session, Event::Connection { state: "connected".into(), quality: quality() });
        emit(&app, session, Event::Roster { roster: roster(&room) });
      }
      RoomEvent::Disconnected { reason } => {
        log::info!("voice: disconnected ({reason:?})");
        emit(&app, session, Event::Connection { state: "disconnected".into(), quality: quality() });
      }
      RoomEvent::E2eeStateChanged { participant, state } => {
        log::info!("voice: e2ee state for {} is {state:?}", participant.identity());
        emit(
          &app,
          session,
          Event::Encryption {
            identity: participant.identity().to_string(),
            state: format!("{state:?}"),
          },
        );
      }
      _ => {}
    }
  }
  log::debug!("voice: pump for session {session} ended");
}

// -- commands ---------------------------------------------------------------

/// Feature detection for the TypeScript side: the command exists only in a
/// desktop shell, so `invoke` failing is the answer on the phones and on
/// the web. Also acquires the audio device module, per the header.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
  livekit_rev: &'static str,
  recording_devices: usize,
  playout_devices: usize,
  aec: String,
  agc: String,
  ns: String,
  /// Whether this shell captures and renders video natively (video.rs):
  /// macOS since 2026-09-08, the others not yet. Feature-detected by the
  /// page from this answer, never from a platform name.
  video: bool,
}

#[tauri::command]
pub fn voice_probe(app: AppHandle) -> VoiceResult<Probe> {
  let audio = platform_audio()?;
  render::remember_app(&app);
  start_device_poller(app);
  Ok(Probe {
    livekit_rev: LIVEKIT_REV,
    video: cfg!(target_os = "macos"),
    recording_devices: audio.recording_devices().count(),
    playout_devices: audio.playout_devices().count(),
    aec: format!("{:?}", audio.active_aec_type()),
    agc: format!("{:?}", audio.active_agc_type()),
    ns: format!("{:?}", audio.active_ns_type()),
  })
}

/// `devices.ts`'s shape: labels are real and ids are stable, with no
/// permission grant needed -- the two things the browser's enumeration
/// cannot offer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
  device_id: String,
  label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevices {
  inputs: Vec<AudioDevice>,
  outputs: Vec<AudioDevice>,
}

fn list_devices(audio: &PlatformAudio) -> AudioDevices {
  AudioDevices {
    inputs: audio
      .recording_devices()
      .map(|d| AudioDevice { device_id: d.id.as_str().to_string(), label: d.name })
      .collect(),
    outputs: audio
      .playout_devices()
      .map(|d| AudioDevice { device_id: d.id.as_str().to_string(), label: d.name })
      .collect(),
  }
}

#[tauri::command]
pub fn voice_devices() -> VoiceResult<AudioDevices> {
  Ok(list_devices(&platform_audio()?))
}

static DEVICE_POLLER: AtomicBool = AtomicBool::new(false);

/// Re-read the device list every `DEVICE_POLL_MS` for the life of the
/// process and emit `voice-devices` when it differs from the last reading.
/// The device module raises no hot-plug event of its own (the plan's §5.1),
/// and a poll here costs a few Core Audio property reads rather than an IPC
/// round trip from a page timer that may be throttled. Started once, by the
/// first probe.
fn start_device_poller(app: AppHandle) {
  if DEVICE_POLLER.swap(true, Ordering::SeqCst) {
    return;
  }
  tauri::async_runtime::spawn(async move {
    let mut ticks = tokio::time::interval(std::time::Duration::from_millis(DEVICE_POLL_MS));
    let mut last: Option<Vec<(String, String)>> = None;
    loop {
      ticks.tick().await;
      let Ok(audio) = platform_audio() else { continue };
      let devices = list_devices(&audio);
      let key: Vec<(String, String)> = devices
        .inputs
        .iter()
        .map(|d| (format!("in:{}", d.device_id), d.label.clone()))
        .chain(devices.outputs.iter().map(|d| (format!("out:{}", d.device_id), d.label.clone())))
        .collect();
      // The first reading is logged as an inventory rather than skipped as
      // "not a change". Only emitting on a difference is right -- the event
      // exists to re-list the pickers -- but only *logging* on a difference
      // meant a machine where nothing is ever replugged printed no device
      // line at all, so D-27 had nothing to read and no way to tell "the
      // poller is working and the list is static" from "the poller is dead".
      let first = last.is_none();
      let changed = last.as_ref().is_some_and(|previous| previous != &key);
      last = Some(key);
      if first {
        log::info!(
          "voice: devices at start ({} input(s), {} output(s))",
          devices.inputs.len(),
          devices.outputs.len()
        );
      }
      if changed {
        log::info!(
          "voice: devices changed ({} input(s), {} output(s))",
          devices.inputs.len(),
          devices.outputs.len()
        );
        if let Err(error) = app.emit(DEVICES_EVENT, &devices) {
          log::warn!("voice: emit devices failed: {error}");
        }
      }
    }
  });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyArgs {
  /// The MLS exporter secret, 32 bytes.
  secret: Vec<u8>,
  /// Already reduced to the ring by `rules.ts`'s `keyIndexFor`.
  key_index: i32,
}

/// The microphone's processing switches, already decided (prefs.ts). They
/// are the audio source's options, so they apply to the track this call
/// publishes; the engine is WebRTC's software APM on every desktop.
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingArgs {
  echo_cancellation: bool,
  noise_suppression: bool,
  auto_gain_control: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
  url: String,
  token: String,
  e2ee: bool,
  max_bitrate: u64,
  processing: ProcessingArgs,
  /// Ids from `voice_devices`, already checked against the current list by
  /// the TypeScript side; `None` means the platform default.
  mic_device_id: Option<String>,
  speaker_device_id: Option<String>,
  key: Option<KeyArgs>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
  session: u64,
  connect_ms: u64,
  roster: Roster,
}

#[tauri::command]
pub async fn voice_connect(app: AppHandle, args: ConnectArgs) -> VoiceResult<ConnectResult> {
  if session_id().is_some() {
    return Err(VoiceError::new("already_connected", "a call is already running"));
  }
  let started = Instant::now();
  let audio = platform_audio()?;
  render::remember_app(&app);

  // Say which devices this call actually opened, by id and by name.
  //
  // Nothing used to. The id was set silently on success, the mid-call switch
  // commands logged nothing at all, and `voice: devices changed` prints two
  // integers and never fires on a first reading -- so on a machine where
  // nothing is replugged it never appears. That left "the call connects and
  // captures nothing" and "the call connects and captures from the wrong
  // device" indistinguishable, and a moving microphone level is not evidence
  // the intended device is open. Device ids are the one genuinely
  // platform-shaped part of this engine (macOS hands back a UID, Windows a
  // WASAPI endpoint string like `{0.0.1.00000000}.{guid}`), and Windows has
  // never run it, so this is the readout that makes the first pass there
  // falsifiable rather than merely observed.
  let devices = list_devices(&audio);
  log::info!(
    "voice: device inventory -- {} input(s), {} output(s)",
    devices.inputs.len(),
    devices.outputs.len()
  );
  for d in devices.inputs.iter().chain(devices.outputs.iter()) {
    log::info!("voice:   {} = {:?}", d.device_id, d.label);
  }
  let name_of = |id: &str| {
    devices
      .inputs
      .iter()
      .chain(devices.outputs.iter())
      .find(|d| d.device_id == id)
      .map(|d| d.label.clone())
      .unwrap_or_else(|| "NOT IN THE LIST".to_string())
  };

  match args.mic_device_id.as_deref() {
    Some(id) => {
      log::info!("voice: capture requested {id} ({})", name_of(id));
      audio
        .set_recording_device(&RecordingDeviceId::from_unchecked_guid(id))
        .map_err(|e| VoiceError::new("device", format!("set_recording_device: {e:?}")))?;
    }
    None => log::info!("voice: capture left at the platform default"),
  }
  match args.speaker_device_id.as_deref() {
    Some(id) => {
      log::info!("voice: playout requested {id} ({})", name_of(id));
      audio
        .set_playout_device(&PlayoutDeviceId::from_unchecked_guid(id))
        .map_err(|e| VoiceError::new("device", format!("set_playout_device: {e:?}")))?;
    }
    None => log::info!("voice: playout left at the platform default"),
  }
  // Zero outputs is not a warning about a preference, it is "nobody will hear
  // anything" -- and it is a real state: this project's Windows box enumerated
  // 0 active render endpoints out of 57 known ones on 2026-09-09.
  if devices.outputs.is_empty() {
    log::warn!("voice: no active output device -- the call will connect and play to nothing");
  }
  if devices.inputs.is_empty() {
    log::warn!("voice: no active input device -- the call will connect and capture nothing");
  }
  // Before the microphone track exists: these are its source's options.
  let processing = args.processing;
  if let Err(error) = audio.configure_audio_processing(AudioProcessingOptions {
    echo_cancellation: processing.echo_cancellation,
    noise_suppression: processing.noise_suppression,
    auto_gain_control: processing.auto_gain_control,
    prefer_hardware_processing: false,
  }) {
    // Only the hardware path can fail, and desktop has none; a call is
    // still worth having with the defaults.
    log::warn!("voice: configure_audio_processing: {error:?}");
  }
  log::info!(
    "voice: audio processing aec={:?} ns={:?} agc={:?}",
    audio.active_aec_type(),
    audio.active_ns_type(),
    audio.active_agc_type()
  );

  let shared = Arc::new(Shared::default());
  *shared.quality.lock().unwrap() = "unknown".into();

  let keys = if args.e2ee {
    let key = args
      .key
      .ok_or_else(|| VoiceError::new("key_required", "e2ee is on but no key was given"))?;
    // transport-webview.ts's CallKeyProvider, parameter for parameter, plus
    // the derivation the JS side gets for free from createKeyMaterialFromBuffer.
    let options = KeyProviderOptions {
      ratchet_window_size: 0,
      ratchet_salt: RATCHET_SALT.to_vec(),
      failure_tolerance: -1,
      key_ring_size: KEYRING_SIZE,
      key_derivation_algorithm: KeyDerivationAlgorithm::HKDF,
    };
    let provider = KeyProvider::with_shared_key(options, key.secret.clone());
    provider.set_shared_key(key.secret, key.key_index);
    *shared.key_index.lock().unwrap() = key.key_index;
    Some(provider)
  } else {
    None
  };

  let mut options = RoomOptions::default();
  options.auto_subscribe = true;
  // Dynacast: the SFU tells this sender to stop encoding a simulcast layer
  // nobody subscribes to. Adaptive stream is deliberately *off*: which
  // layer a tile wants is the session's rule (rules.ts's subscriptionFor)
  // and arrives through voice_set_video_subscription; a second mechanism
  // guessing from element sizes would fight it.
  options.dynacast = true;
  options.encryption = keys
    .clone()
    .map(|key_provider| E2eeOptions { encryption_type: EncryptionType::Gcm, key_provider });

  let (room, rx) = Room::connect(&args.url, &args.token, options)
    .await
    .map_err(|e| VoiceError::new("connect_failed", e.to_string()))?;
  let room = Arc::new(room);
  let id = NEXT_SESSION.fetch_add(1, Ordering::SeqCst);
  log::info!(
    "voice: session {id} connected to {} as {} in {} ms (e2ee {}, key index {})",
    room.name(),
    room.local_participant().identity(),
    started.elapsed().as_millis(),
    keys.is_some(),
    *shared.key_index.lock().unwrap()
  );
  let pump_task =
    tauri::async_runtime::spawn(pump(app.clone(), id, room.clone(), shared.clone(), rx));
  // Debug builds: ask the page, from the shell's side, whether it is still
  // running -- an eval runs even when the page's own timers are throttled,
  // so a pong that stops means the page itself is suspended.
  #[cfg(debug_assertions)]
  {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
      let mut ticks = tokio::time::interval(std::time::Duration::from_secs(5));
      loop {
        ticks.tick().await;
        if session_id() != Some(id) {
          break;
        }
        if let Some(window) = app.webview_windows().into_values().next() {
          let script = format!(
            "window.__TAURI_INTERNALS__.invoke('voice_pong', {{ session: {id}, sentAt: {}, visibility: document.visibilityState, focus: document.hasFocus() }})",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
          );
          if let Err(error) = window.eval(&script) {
            log::warn!("voice: ping eval failed: {error}");
          }
        }
      }
    });
  }

  let result = ConnectResult {
    session: id,
    connect_ms: started.elapsed().as_millis() as u64,
    roster: roster(&room),
  };

  // Another connect could not have raced in: the command runs on the one
  // webview's calls in order, and `session_id()` was None above.
  *SESSION.lock().unwrap() = Some(Session {
    id,
    room,
    keys,
    shared,
    mic: None,
    max_bitrate: args.max_bitrate,
    pump: pump_task,
    started,
  });
  Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectResult {
  close_ms: u64,
  lifetime_ms: u64,
}

/// Idempotent: a second call, or one with no session, answers zeros.
#[tauri::command]
pub async fn voice_disconnect() -> VoiceResult<DisconnectResult> {
  let Some(session) = SESSION.lock().unwrap().take() else {
    return Ok(DisconnectResult { close_ms: 0, lifetime_ms: 0 });
  };
  let Session { room, keys, mic, pump, started, .. } = session;
  log::info!("voice: disconnect requested after {} ms", started.elapsed().as_millis());
  // Video first: devices closed and tiles gone before the room closes
  // under their tracks.
  video::teardown().await;
  // The microphone first, so the sender's channel is torn down through the
  // SDK's own unpublish path before the peer connection closes under it.
  if let Some(publication) = mic {
    if let Err(error) = room.local_participant().unpublish_track(&publication.sid()).await {
      log::warn!("voice: unpublish on disconnect: {error}");
    }
    log::info!("voice: microphone unpublished");
  }
  if let Ok(audio) = platform_audio() {
    if let Err(error) = audio.stop_recording() {
      log::debug!("voice: stop_recording on disconnect: {error:?}");
    }
  }
  log::info!("voice: closing room");
  let t0 = Instant::now();
  if let Err(error) = room.close().await {
    log::warn!("voice: close: {error}");
  }
  let close_ms = t0.elapsed().as_millis() as u64;
  log::info!("voice: session closed in {close_ms} ms after {} ms", started.elapsed().as_millis());
  pump.abort();
  drop(keys);
  drop(room);
  Ok(DisconnectResult { close_ms, lifetime_ms: started.elapsed().as_millis() as u64 })
}

/// The microphone: published on the first `true`, then muted and unmuted
/// in place. Recording is stopped while muted so the OS privacy indicator
/// tells the truth (the SDK's own documented pattern), and started again
/// on unmute.
#[tauri::command]
pub async fn voice_set_mic(enabled: bool) -> VoiceResult<()> {
  let (id, room, shared) = current()?;
  let (existing, max_bitrate) = {
    let guard = SESSION.lock().unwrap();
    let session = guard.as_ref().ok_or_else(|| VoiceError::new("not_connected", "no call"))?;
    (session.mic.clone(), session.max_bitrate)
  };
  let audio = platform_audio()?;

  if let Some(publication) = existing {
    if enabled {
      if let Err(error) = audio.start_recording() {
        log::warn!("voice: start_recording on unmute: {error:?}");
      }
      publication.unmute();
    } else {
      publication.mute();
      if let Err(error) = audio.stop_recording() {
        log::debug!("voice: stop_recording on mute: {error:?}");
      }
    }
    return Ok(());
  }

  if !enabled {
    // Muted before it was ever published: nothing to publish silence from.
    return Ok(());
  }
  if audio.recording_devices().next().is_none() {
    return Err(VoiceError::new("no_microphone", "no recording device"));
  }
  let track = LocalAudioTrack::create_audio_track("microphone", audio.rtc_source());
  let options = TrackPublishOptions {
    source: TrackSource::Microphone,
    // dtx and red stay on at every tier, as in the webview transport:
    // silence suppression and the redundant frame are about loss, not
    // fidelity.
    dtx: true,
    red: true,
    audio_encoding: Some(AudioEncoding { max_bitrate }),
    ..Default::default()
  };
  let publication = room
    .local_participant()
    .publish_track(LocalTrack::Audio(track), options)
    .await
    .map_err(|e| VoiceError::new("mic_failed", format!("publish: {e}")))?;
  if let Err(error) = audio.start_recording() {
    // Publishing a device-sourced track initialises recording on its own;
    // an explicit start that then fails is worth a log line, not a
    // failed call.
    log::warn!("voice: start_recording after publish: {error:?}");
  }
  // The sender's cryptor exists now: put it on the current index.
  let index = *shared.key_index.lock().unwrap();
  let cryptors = apply_key_index(&room, index);
  log::info!(
    "voice: microphone published as {} (recording {}), {cryptors} cryptor(s) on index {index}",
    publication.sid(),
    audio.is_recording_initialized()
  );

  let mut guard = SESSION.lock().unwrap();
  match guard.as_mut() {
    Some(session) if session.id == id => {
      session.mic = Some(publication);
    }
    _ => {
      // The call ended while the publish was in flight; the room is closed
      // or closing and the publication goes with it.
    }
  }
  Ok(())
}

// The mid-call switches, unlike `voice_connect`'s pair, do NOT validate the id
// against the live list upstream in the SDK -- and the C++ under them
// (`webrtc-sys/src/audio_device_controller.cpp`) answers a guid it cannot find
// by selecting device *index 0* and returning success. So an id from the wrong
// id space does not fail here, it quietly opens some other device. Checking the
// id against the list first turns that into an error with a name in it, which
// is the same thing `voice_connect` gets for free by being handed an id the
// TypeScript side already filtered through `knownDeviceId`.
#[tauri::command]
pub fn voice_set_input_device(device_id: String) -> VoiceResult<()> {
  let audio = platform_audio()?;
  let devices = list_devices(&audio);
  let Some(found) = devices.inputs.iter().find(|d| d.device_id == device_id) else {
    log::warn!("voice: capture switch refused, {device_id} is not in the list");
    return Err(VoiceError::new(
      "device",
      format!("switch_recording_device: {device_id} is not an active capture device"),
    ));
  };
  log::info!("voice: capture switched to {device_id} ({})", found.label);
  audio
    .switch_recording_device(&RecordingDeviceId::from_unchecked_guid(&device_id))
    .map_err(|e| VoiceError::new("device", format!("switch_recording_device: {e:?}")))
}

#[tauri::command]
pub fn voice_set_output_device(device_id: String) -> VoiceResult<()> {
  let audio = platform_audio()?;
  let devices = list_devices(&audio);
  let Some(found) = devices.outputs.iter().find(|d| d.device_id == device_id) else {
    log::warn!("voice: playout switch refused, {device_id} is not in the list");
    return Err(VoiceError::new(
      "device",
      format!("switch_playout_device: {device_id} is not an active playout device"),
    ));
  };
  log::info!("voice: playout switched to {device_id} ({})", found.label);
  audio
    .switch_playout_device(&PlayoutDeviceId::from_unchecked_guid(&device_id))
    .map_err(|e| VoiceError::new("device", format!("switch_playout_device: {e:?}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyResult {
  key_index: i32,
  cryptors: usize,
}

#[tauri::command]
pub fn voice_set_epoch_key(key: KeyArgs) -> VoiceResult<KeyResult> {
  let guard = SESSION.lock().unwrap();
  let session = guard.as_ref().ok_or_else(|| VoiceError::new("not_connected", "no call"))?;
  let keys = session
    .keys
    .as_ref()
    .ok_or_else(|| VoiceError::new("encryption_off", "frame encryption is off for this call"))?;
  keys.set_shared_key(key.secret, key.key_index);
  *session.shared.key_index.lock().unwrap() = key.key_index;
  let cryptors = apply_key_index(&session.room, key.key_index);
  log::info!("voice: key set at index {}, {cryptors} cryptor(s) walked", key.key_index);
  Ok(KeyResult { key_index: key.key_index, cryptors })
}

/// Enable or disable one participant's audio at the WebRTC track level.
/// Remembered for tracks that arrive later.
#[tauri::command]
pub fn voice_set_playback(identity: String, source: String, enabled: bool) -> VoiceResult<()> {
  let (_, room, shared) = current()?;
  let source = audio_source_of(&source);
  shared.playback.lock().unwrap().insert(audio_kind_key(&identity, source), enabled);
  if let Some(participant) = room.remote_participants().get(&ParticipantIdentity::from(identity)) {
    apply_playback_of(&shared, participant, source);
  }
  Ok(())
}

/// Playout gain for one participant's audio, in WebRTC's range (1.0 is
/// unity; TypeScript clamps to it). Applied at the receive stream, so only
/// this listener hears the difference. Remembered for tracks that arrive
/// later, like the enable flag.
#[tauri::command]
pub fn voice_set_volume(identity: String, source: String, volume: f64) -> VoiceResult<()> {
  let (_, room, shared) = current()?;
  let source = audio_source_of(&source);
  shared.volume.lock().unwrap().insert(audio_kind_key(&identity, source), volume);
  if let Some(participant) = room.remote_participants().get(&ParticipantIdentity::from(identity)) {
    apply_playback_of(&shared, participant, source);
  }
  Ok(())
}

/// The page's answer to the shell's ping (see `voice_connect`). The ping
/// itself runs only in debug builds; the command is always there so the
/// handler list is one list.
#[tauri::command]
pub fn voice_pong(session: u64, sent_at: f64, visibility: String, focus: bool) {
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as f64)
    .unwrap_or(0.0);
  log::info!("voice: pong session {session} after {:.0} ms, visibility={visibility} focus={focus}", now - sent_at);
}

#[tauri::command]
pub fn voice_roster() -> VoiceResult<Roster> {
  let (_, room, _) = current()?;
  Ok(roster(&room))
}

fn summarize_local(stats: &[RtcStats], out: &mut Value) {
  for entry in stats {
    match entry {
      RtcStats::OutboundRtp(s) => {
        out["packetsSent"] = json!(s.sent.packets_sent);
      }
      RtcStats::RemoteInboundRtp(s) => {
        out["roundTripMs"] = json!((s.remote_inbound.round_trip_time * 1000.0).round());
      }
      RtcStats::MediaSource(s) => {
        out["echo"] = json!({
          "echoReturnLoss": s.audio.echo_return_loss,
          "echoReturnLossEnhancement": s.audio.echo_return_loss_enhancement,
        });
      }
      _ => {}
    }
  }
}

fn summarize_inbound(stats: &[RtcStats], out: &mut Value) {
  for entry in stats {
    if let RtcStats::InboundRtp(s) = entry {
      out["bytesReceived"] = json!(s.inbound.bytes_received);
      out["audioEnergy"] = json!(s.inbound.total_audio_energy);
      out["concealedSamples"] = json!(s.inbound.concealed_samples);
    }
  }
}

/// One reading in `TransportStats`'s shape (transport.ts). Numbers a stats
/// call cannot produce are left null; nothing here throws for a missing
/// number.
#[tauri::command]
pub async fn voice_stats() -> VoiceResult<Value> {
  let (_, room, _) = current()?;
  let (mic, audio_ok) = {
    let guard = SESSION.lock().unwrap();
    let session = guard.as_ref().ok_or_else(|| VoiceError::new("not_connected", "no call"))?;
    (session.mic.clone(), true)
  };
  let recording = if audio_ok {
    platform_audio().map(|audio| audio.is_recording_initialized()).unwrap_or(false)
  } else {
    false
  };
  let muted = mic.as_ref().map(|p| p.is_muted()).unwrap_or(true);
  let mut out = json!({
    "mic": {
      "published": mic.is_some(),
      "muted": muted,
      // The browser's `track.muted`: the source is not delivering. Here
      // that is a published, unmuted microphone whose device is not
      // recording.
      "systemMuted": mic.is_some() && !muted && !recording,
      "ended": false,
    },
    "packetsSent": null,
    "roundTripMs": null,
    "echo": { "echoReturnLoss": null, "echoReturnLossEnhancement": null },
    "peers": [],
  });
  if let Some(LocalTrack::Audio(track)) = mic.as_ref().and_then(|p| p.track()) {
    if let Ok(stats) = track.get_stats().await {
      summarize_local(&stats, &mut out);
    }
  }
  let mut peers = Vec::new();
  for (identity, participant) in room.remote_participants() {
    let mut peer = json!({
      "identity": identity.to_string(),
      "bytesReceived": null,
      "audioEnergy": null,
      "concealedSamples": null,
      "playing": null,
    });
    if let Some(publication) = mic_publications(&participant).into_iter().next() {
      if let Some(RemoteTrack::Audio(track)) = publication.track() {
        peer["playing"] = json!(track.rtc_track().enabled());
        if let Ok(stats) = track.get_stats().await {
          summarize_inbound(&stats, &mut peer);
        }
      }
    }
    peers.push(peer);
  }
  out["peers"] = json!(peers);
  out["video"] = json!(video::stats_rows(&room).await);
  out["native"] = video::native_summary();
  log::debug!("voice: stats sampled ({} peer(s))", peers.len());
  Ok(out)
}

// -- the page probe (debug builds only) --------------------------------------
//
// Gate 2 of the plan's §5.1: a hidden shell page's timers have been seen to
// stop -- three times mid-call, and later at boot with no call placed at all
// -- while the page process sat idle at 0% and its main thread waited in the
// run loop. The per-session ping in `voice_connect` starts only once a call
// is up, so a boot that dies before placing its call is invisible to it.
// This probe runs from `setup` for the life of the process and asks the
// page four questions every five seconds, each answered by `page_pulse`
// with how it was reached:
//
//   eval       the script itself ran -- the process still handles IPC
//   microtask  a promise queued by it drained -- the JS event loop turned
//   timeout    a zero-delay setTimeout fired -- DOM timers are scheduled
//   raf        a requestAnimationFrame fired -- the page is being painted
//              (expected to be missing while hidden; that is the spec)
//
// plus whatever the page can say about itself (`extra`: the dev trace
// buffer's length and last entry, the voice session's phase). Which answers
// go missing is what tells a suspended page from a throttled one from a
// frozen process. Nothing here decides anything -- it reports.
//
// One thing to know before reading its output: **the probe is itself a
// keepalive.** Measured 2026-09-07 (the plan's §5.1): WebKit on macOS 26
// suspends the WebContent process of a hidden view about eight seconds
// after its last activity, and an eval from the shell is an activity that
// resumes it. So a page under this probe is woken every five seconds and
// cannot show the dead-boot signature; what it shows instead is the page
// running only in the seconds after each pulse.

#[cfg(debug_assertions)]
mod probe {
  use std::collections::{BTreeMap, BTreeSet};
  use std::sync::Mutex;

  #[derive(Default)]
  pub struct Answers {
    pub eval: Option<f64>,
    pub microtask: Option<f64>,
    pub timeout: Option<f64>,
    pub raf: Option<f64>,
    pub visibility: String,
    pub focus: bool,
    pub ready: String,
    pub uptime_ms: f64,
    /// Whatever else the page could say about itself, as JSON built there.
    pub extra: String,
  }

  /// Answers for pulses not yet reported, by pulse number.
  pub static PENDING: Mutex<BTreeMap<u64, Answers>> = Mutex::new(BTreeMap::new());
  /// Pulses already reported, so a late answer is logged as late.
  pub static REPORTED: Mutex<BTreeSet<u64>> = Mutex::new(BTreeSet::new());
  /// Five seconds unless `WHERRY_PROBE_SECS` says otherwise -- a longer
  /// interval is how to watch the page *without* the probe keeping it
  /// awake (see the module note).
  pub fn interval_secs() -> u64 {
    std::env::var("WHERRY_PROBE_SECS").ok().and_then(|s| s.parse().ok()).filter(|&n| n > 0).unwrap_or(5)
  }

  pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_millis() as f64)
      .unwrap_or(0.0)
  }
}

/// The page's answer to the boot-time probe. The command exists in every
/// build so the handler list is one list; only debug builds send pulses.
#[tauri::command]
#[allow(unused_variables)]
pub fn page_pulse(
  pulse: u64,
  sent_at: f64,
  via: String,
  visibility: String,
  focus: bool,
  ready: String,
  uptime: f64,
  extra: String,
) {
  #[cfg(debug_assertions)]
  {
    let after = probe::now_ms() - sent_at;
    if probe::REPORTED.lock().unwrap().contains(&pulse) {
      log::warn!("page: pulse #{pulse} LATE {via} after {after:.0} ms (visibility={visibility} focus={focus})");
      return;
    }
    let mut pending = probe::PENDING.lock().unwrap();
    let answers = pending.entry(pulse).or_default();
    match via.as_str() {
      "eval" => answers.eval = Some(after),
      "microtask" => answers.microtask = Some(after),
      "timeout" => answers.timeout = Some(after),
      "raf" => answers.raf = Some(after),
      _ => {}
    }
    answers.visibility = visibility;
    answers.focus = focus;
    answers.ready = ready;
    answers.uptime_ms = uptime;
    answers.extra = extra;
  }
}

/// Start the probe. Debug builds only, from `setup`; see the module note.
#[cfg(debug_assertions)]
pub fn start_page_probe(app: AppHandle) {
  tauri::async_runtime::spawn(async move {
    let mut ticks = tokio::time::interval(std::time::Duration::from_secs(probe::interval_secs()));
    let mut pulse: u64 = 0;
    loop {
      ticks.tick().await;
      if pulse > 0 {
        report_pulse(&app, pulse);
      }
      pulse += 1;
      let Some(window) = app.webview_windows().into_values().next() else {
        log::warn!("page: pulse #{pulse} not sent -- no window");
        continue;
      };
      let sent_at = probe::now_ms();
      let script = format!(
        r#"(function () {{
  var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!inv) return;
  var extra = function () {{
    try {{
      var t = window.__cryptoTrace || [];
      var last = t.length ? t[t.length - 1] : null;
      var v = window.__voice ? window.__voice.getState() : null;
      return {{
        trace: t.length,
        last: last ? (last.detail.method || last.kind) + "@" + last.at.slice(11, 19) : null,
        voice: v ? v.phase + (v.error ? " (" + v.error + ")" : "") : null
      }};
    }} catch (e) {{ return {{ err: String(e) }}; }}
  }};
  var base = {{ pulse: {pulse}, sentAt: {sent_at}, visibility: document.visibilityState,
    focus: document.hasFocus(), ready: document.readyState, uptime: performance.now(),
    extra: JSON.stringify(extra()) }};
  var send = function (via) {{ inv('page_pulse', Object.assign({{ via: via }}, base)).catch(function () {{}}); }};
  send('eval');
  Promise.resolve().then(function () {{ send('microtask'); }});
  setTimeout(function () {{ send('timeout'); }}, 0);
  requestAnimationFrame(function () {{ send('raf'); }});
}})()"#
      );
      if let Err(error) = window.eval(&script) {
        log::warn!("page: pulse #{pulse} eval failed: {error}");
      }
    }
  });
}

#[cfg(debug_assertions)]
fn report_pulse(app: &AppHandle, pulse: u64) {
  let answers = probe::PENDING.lock().unwrap().remove(&pulse);
  {
    let mut reported = probe::REPORTED.lock().unwrap();
    reported.insert(pulse);
    reported.retain(|p| pulse.saturating_sub(*p) < 50);
  }
  let window = app
    .webview_windows()
    .into_values()
    .next()
    .map(|w| {
      format!(
        "window visible={} focused={} minimized={} occluded={}",
        w.is_visible().unwrap_or(false),
        w.is_focused().unwrap_or(false),
        w.is_minimized().unwrap_or(false),
        window_occluded(&w)
      )
    })
    .unwrap_or_else(|| "no window".to_string());
  let Some(a) = answers else {
    log::warn!("page: pulse #{pulse} UNANSWERED -- the eval did not run in {} s ({window})", probe::interval_secs());
    return;
  };
  let show = |v: Option<f64>| v.map(|ms| format!("{ms:.0}ms")).unwrap_or_else(|| "MISSING".to_string());
  let line = format!(
    "page: pulse #{pulse} eval={} microtask={} timeout={} raf={} visibility={} focus={} ready={} uptime={:.0}s {} ({window})",
    show(a.eval),
    show(a.microtask),
    show(a.timeout),
    show(a.raf),
    a.visibility,
    a.focus,
    a.ready,
    a.uptime_ms / 1000.0,
    a.extra
  );
  if a.eval.is_none() || a.microtask.is_none() || a.timeout.is_none() {
    log::warn!("{line}");
  } else {
    log::info!("{line}");
  }
}

/// Ground truth for the probe's line: is the window on screen at all, by the
/// window server's own account (`NSWindow.occlusionState`)? WebKit's log
/// stops reporting occlusion once detection is switched off, so this is the
/// only reading left that says whether the switch is being exercised.
#[cfg(debug_assertions)]
fn window_occluded(window: &tauri::WebviewWindow) -> String {
  #[cfg(target_os = "macos")]
  {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let Ok(ns_window) = window.ns_window() else {
      return "?".to_string();
    };
    if ns_window.is_null() {
      return "?".to_string();
    }
    // NSWindowOcclusionStateVisible == 1 << 1.
    let state: usize = unsafe { msg_send![ns_window as *mut AnyObject, occlusionState] };
    return if state & 2 == 0 { "yes".to_string() } else { "no".to_string() };
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = window;
    "n/a".to_string()
  }
}
