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
// - libwebrtc initialises its voice engine lazily, at the first
//   PeerConnection, and that init re-selects both devices and (on Windows)
//   turns the built-in echo canceller on. `voice_connect` therefore holds the
//   engine initialised (`MEDIA_ENGINE`) *before* it applies anything, so the
//   first call of a launch opens what the page chose, the same as every
//   later call does. See `hold_media_engine`.
// - libwebrtc starts and stops the device's recording from inside every
//   audio mute, judging one transceiver at a time, so muting a share's sound
//   stopped the microphone and sharing while muted opened it (rows D-68,
//   D-69). The shell gates recording on the microphone's own state and
//   restarts it after the share's sound is muted, after a share stops or
//   starts, and after a reconnect. See `set_microphone_gate`.
// - libwebrtc's Windows module resolves "the default output" only when it
//   initialises playout, once per call, so a call on the default did not
//   follow a change of the Windows default or the loss of the device it
//   played on (row D-72). The page decides when to follow, from
//   `voice-devices`; `playout.rs` is the mechanism. Windows only.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use livekit::e2ee::key_provider::{KeyProvider, KeyProviderOptions};
use livekit::e2ee::{E2eeOptions, EncryptionType};
use livekit::options::{AudioEncoding, TrackPublishOptions};
use livekit::prelude::*;
use livekit::rtc_engine::lk_runtime::LkRuntime;
use livekit::webrtc::native::frame_cryptor::KeyDerivationAlgorithm;
use livekit::webrtc::peer_connection::PeerConnection;
use livekit::webrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
use livekit::webrtc::peer_connection_factory::RtcConfiguration;
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
// Windows since 2026-09-10 (stage W3): a child HWND per tile over
// WebView2, GDI presenter. Split into its own file the way `screen_audio`
// is, rather than two platform bodies in one -- the Win32 half and the
// AppKit half share a surface and not a line of mechanism.
#[cfg(target_os = "windows")]
#[path = "render_win.rs"]
pub mod render;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[path = "render_stub.rs"]
pub mod render;
// A share's own sound (docs/prompts/screen-audio-handoff.md §4). Split the
// same way rendering is: the platform that has it, and the shape of it
// where it is still to be written. Windows first here — it is the platform
// whose browser engine cannot do this at all.
#[cfg(target_os = "windows")]
pub mod screen_audio;
#[cfg(not(target_os = "windows"))]
#[path = "screen_audio_stub.rs"]
pub mod screen_audio;
pub mod video;
// Following the Windows default output (rows D-72, D-73). Not split by
// platform at the `mod` site: the one Windows-only part is small and inside.
pub mod playout;

/// Which SDK revision this shell carries; shown by the probe so a call
/// details readout can name it. Bump with the `rev` in Cargo.toml.
pub const LIVEKIT_REV: &str = "rust-sdks dee418bb + wherryapp/rust-sdks wherry/windows-console-role 6a32ecc0 (2026-09-15)";

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

// -- the voice engine's one-time init ----------------------------------------
//
// libwebrtc's `WebRtcVoiceEngine` is reference-counted by the PeerConnections
// that use it (`ConnectionContext::MediaEngineReference` in the pinned
// libwebrtc, webrtc-89d790b): its `Init` runs when the first one is created,
// inside `create_peer_connection`, and its `Terminate` when the last one goes.
// That `Init` does two things to the audio device module that are nobody's
// choice here:
//
// 1. `adm_helpers::Init` selects both devices again -- by *role* on Windows
//    (the communications role, which the fork's `adm_proxy.cpp` maps to the
//    console default for S-16), and by a fixed index 0 elsewhere as upstream's
//    `adm_helpers.cc` reads (believed from the source; macOS has not been
//    read in a log) -- replacing a device `voice_connect` had just chosen;
// 2. it applies the engine's default options, echo cancellation on, and where
//    the module has a built-in canceller (Windows: the voice-capture DMO) that
//    is `EnableBuiltInAEC(1)`. `InitRecording` then opens the DMO at 16 kHz
//    mono instead of plain WASAPI, and once recording is initialised the
//    module refuses to turn it off again.
//
// Before 2026-09-26 the first PeerConnection was the call's own, created
// inside `Room::connect` -- *after* `voice_connect` had applied the page's
// devices and switches -- so the first call of every launch ran on the
// default pair with Windows' canceller in series with (or instead of) the
// one the Echo cancellation switch controls. Later calls in the same process
// were right, because the engine was never terminated between them. Read on
// the rig 2026-09-26 with WHERRY_WEBRTC_LOG=1: role-form `SetPlayoutDevice`
// and `SetRecordingDevice` after the index-form ones, `EnableBuiltInAEC(1) =>
// 0` at the engine's init, `Capture device index: 0, render device index: 0`
// and `SetRecordingSampleRate(16000)` at `InitRecording` -- call one only.
//
// The fix is to take that init out of the call: create one PeerConnection of
// our own before anything is applied and keep it for the life of the process.
// Creating it runs the engine's `Init` there and then; holding it keeps the
// reference count above zero, so no later PeerConnection -- the call's, a
// reconnect's -- can run `Init` again, and the engine is never terminated
// under the shell's held `PlatformAudio` either. The PeerConnection itself is
// idle: no transceivers, no description, so it gathers nothing and sends
// nothing. It is the same factory and the same public call LiveKit's own
// transports use (`LkRuntime::pc_factory().create_peer_connection`).

/// The PeerConnection that holds the voice engine initialised. `None` until
/// the first `voice_connect`, and never closed or dropped once set -- closing
/// it would be the engine's `Terminate` if it were the last reference.
static MEDIA_ENGINE: Mutex<Option<PeerConnection>> = Mutex::new(None);

enum EngineHold {
  /// Held since an earlier connect: no engine `Init` can run in this one.
  Already,
  /// Created now; the engine's `Init` (if it had not run already) has just
  /// run, before anything this connect applies.
  Now { ms: u128 },
  /// The factory would not create one. The call goes ahead, and its own first
  /// PeerConnection runs the engine's `Init` as before this fix: the device
  /// half comes back for that call, the canceller half is still repaired by
  /// `builtin_aec_off`. Tried again once the call is connected (see
  /// `voice_connect`), and on the next connect.
  Failed(String),
}

fn hold_media_engine() -> EngineHold {
  let mut held = MEDIA_ENGINE.lock().unwrap();
  if held.is_some() {
    return EngineHold::Already;
  }
  let started = Instant::now();
  // The runtime `PlatformAudio` holds (and so the one `Room::connect` will
  // use): `LkRuntime::instance()` hands back the live one while any holder
  // exists, and `AUDIO` holds it for the life of the process.
  let runtime = LkRuntime::instance();
  match runtime.pc_factory().create_peer_connection(RtcConfiguration::default()) {
    Ok(pc) => {
      *held = Some(pc);
      EngineHold::Now { ms: started.elapsed().as_millis() }
    }
    Err(error) => EngineHold::Failed(error.to_string()),
  }
}

/// Windows' built-in canceller off, at the last moment it can still be
/// changed: the call's PeerConnections exist, and recording -- which the
/// module refuses to reconfigure once initialised -- is not initialised until
/// the microphone publishes. `configure_audio_processing` already asked for
/// this before the connect; asked again here because this is the moment that
/// decides `InitRecording`'s path, and because the SDK only logs a refusal at
/// warn level, never the state. The switch itself is passed through
/// unchanged: echo cancellation stays WebRTC's own (AEC3), on or off as the
/// page decided, and never the hardware one (`prefer_hardware_processing` is
/// false in `voice_connect`). A module with no built-in canceller (macOS,
/// Linux) is left alone and says so.
///
/// `set_echo_cancellation` also re-applies the switch to the APM, which
/// matters as much as the canceller: when the send path's `ApplyOptions`
/// gets `EnableBuiltInAEC(1)` accepted, it turns AEC3 off in the same breath
/// ("built-in EC will be used instead"). This puts both halves back.
///
/// `when` names the moment in the log line; see `before_init_recording` for
/// the ones after connect.
fn builtin_aec_off(
  audio: &PlatformAudio,
  processing: ProcessingArgs,
  engine_held: bool,
  when: &str,
) {
  let aec3 = if processing.echo_cancellation { "on" } else { "off" };
  let recording = audio.is_recording_initialized();
  if !audio.is_hardware_aec_available() {
    log::info!(
      "voice: {when}, before recording -- no built-in echo canceller on this platform; AEC3 {aec3} (recording initialised {recording}, engine held {engine_held})"
    );
    return;
  }
  match audio.set_echo_cancellation(processing.echo_cancellation, false) {
    Ok(()) => log::info!(
      "voice: {when}, before recording -- built-in echo canceller off (EnableBuiltInAEC(0) accepted); AEC3 {aec3} (recording initialised {recording}, engine held {engine_held})"
    ),
    Err(error) => log::warn!(
      "voice: {when} -- built-in echo canceller NOT turned off ({error:?}; recording initialised {recording}, engine held {engine_held}): this call may capture through Windows' voice-capture DMO at 16 kHz"
    ),
  }
}

/// The same repair at every later moment recording is about to be
/// initialised again in this call, which is every `start_recording` that
/// finds it uninitialised: an unmute (mute stopped recording, and stopping
/// clears the Windows module's `_recIsInitialized`), and the start after the
/// first publish if the publish had not already initialised it.
///
/// Why once at connect is not enough: the microphone's source carries
/// `echo_cancellation` equal to the switch in its `AudioOptions` (the fork's
/// `create_device_audio_track`), and `WebRtcVoiceSendChannel` re-applies
/// those through `ApplyOptions` on every `SetSenderParameters` -- every
/// renegotiation of the publisher PeerConnection, such as starting the
/// camera or a share. With the switch on and a built-in canceller available,
/// that is `EnableBuiltInAEC(1)`, refused while recording is initialised and
/// **accepted** while it is not, i.e. while muted. The next `InitRecording`
/// would then take the voice-capture DMO path with AEC3 off. Believed from
/// upstream's `webrtc_voice_engine.cc` and the fork's own comment; not read
/// in a log (row D-67, leg C).
///
/// When recording is already initialised nothing is asked: the module would
/// refuse, and the path was decided at that `InitRecording`, which this
/// function (or the connect's call) preceded. The one other re-init, a
/// mid-call `switch_recording_device`, re-initialises only when recording
/// was initialised -- unmuted -- and nothing can have been accepted since the
/// last repair, because every `EnableBuiltInAEC` in that time was refused.
///
/// That last argument holds only while nothing but this file initialises
/// recording, which was not true before the microphone gate (below): a share
/// started while muted had libwebrtc initialise it through the DMO, and the
/// skip here then hid it (row D-69 (b), rig 2026-09-26). The skip is logged
/// now, so a reading that expects the repair can see why there was none.
fn before_init_recording(
  audio: &PlatformAudio,
  processing: ProcessingArgs,
  engine_held: bool,
  when: &str,
) {
  if audio.is_recording_initialized() {
    log::info!(
      "voice: {when} -- recording already initialised, so the built-in echo canceller was not asked again (that InitRecording chose the path)"
    );
    return;
  }
  builtin_aec_off(audio, processing, engine_held, when);
}

// -- the microphone gate -----------------------------------------------------
//
// The prebuilt libwebrtc (webrtc-sdk's `m150_release` at `webrtc-89d790b`)
// starts and stops the audio device module's recording **from inside every
// mute**, and counts one transceiver at a time when it decides.
// `WebRtcVoiceSendChannel::MuteStream`, which runs whenever a local audio
// track is enabled or disabled (`AudioRtpSender::OnChanged` -> `SetSend` ->
// `SetAudioSend`), ends with, where `adm()` is the one process-wide module:
//
//     if (adm->IsStopOnMuteModeEnabled()) {          // true: AdmProxy keeps
//       if (!is_all_muted && !adm->Recording()) {    // the interface default
//         adm->InitRecording(); adm->StartRecording();
//       } else if (is_all_muted && adm->Recording()) {
//         adm->StopRecording();
//       }
//     }
//
// and `is_all_muted` is taken over that channel's `send_streams_` only. Under
// unified plan every transceiver has its own channel, so the microphone and
// the share's sound (`video.rs`'s `ScreenAudioPublication`, a pushed source
// that never reads the device) are each "all the streams there are". Two
// defects follow, both read on the rig on 2026-09-26:
//
// - **Stopping a share stops the microphone (D-68).** S-18's rule mutes the
//   share's sound rather than unpublishing it; that mute is its channel's
//   last stream muted, so the module's recording stops while the microphone
//   is unmuted, and the far end hears digital silence for the rest of the
//   call.
// - **Sharing while muted opens the microphone (D-69).** Publishing or
//   unmuting the share's sound is an unmuted stream in its channel with the
//   module not recording, so libwebrtc runs `InitRecording` -- through the
//   voice-capture DMO at 16 kHz when a renegotiation while muted had the
//   built-in canceller accepted, and without `before_init_recording` in
//   front of it -- and `StartRecording`, capturing the muted microphone.
//
// **What the rig's log shows, and in what order.** The fix-build run of
// 2026-09-27 (`0812575`, `WHERRY_WEBRTC_LOG=1`, three shares with audio in
// one process) reads, at every *Stop sharing* with the microphone unmuted:
// `AudioRtpSender::OnChanged reapplying send state, enabled_changed=1`, then
// `WebRtcVoiceSendChannel::MuteStream: ADM:1` (the value printed is
// `is_all_muted`: true, under an unmuted microphone), then
// `AudioDeviceModuleImpl::StopRecording` and `total recording time:` (the
// whole call) -- all *before* the shell's `screen audio muted after N
// frame(s), kept published`, which is logged only once the capture thread
// has stopped. So the stop happens inside the mute, synchronously: `mute()`
// -> `set_enabled` -> `OnChanged` -> `SetSend` -> `MuteStream`, with the log
// sink forwarding on the calling thread. A share *started* while muted reads
// `MuteStream: ADM:0`, `InitRecording`, `StartRecording`, and those come
// **after** `screen published ... with audio`: a new sender's send state is
// applied at the publisher's next `SetLocalDescription` (`SetSsrc` ->
// `SetSend`), which the SDK runs after its 150 ms negotiation debounce, not
// inside `publish_track`. Read in that log: the order, and `is_all_muted`
// true under an unmuted microphone. Believed from the source: that the
// reason is the per-channel `send_streams_` (the log does not print which
// streams a channel holds).
//
// The right fix is libwebrtc's: a pushed source has nothing to do with the
// device, so its mute should not start or stop the device, and the decision
// should count every channel. That is outward-facing, so it is a patch note
// (`client/src-tauri/patches/libwebrtc-mutestream-stops-recording.md`), and
// the shell does three things instead, all mechanism behind `voice_set_mic`
// and `voice_set_screen`, which already carry the page's decisions:
//
// 1. **The gate.** The SDK's `AdmProxy` already has a switch that makes every
//    `InitRecording` and `StartRecording` that reaches it a no-op returning
//    success (`set_adm_recording_enabled`, exposed on the factory as
//    `PeerConnectionFactoryExt`). The shell holds it open exactly while this
//    call's microphone is published and unmuted, and closed from the connect,
//    on mute and at hang-up. So whatever libwebrtc starts while the
//    microphone is closed -- the share's unmute, a renegotiation's
//    `AddSendingStream`, a reconnect's republish -- opens nothing, and the
//    next `InitRecording` is the shell's own on unmute, with the repair in
//    front of it. Opening the gate starts nothing by itself
//    (`SwitchRecordingAdm` returns early unless the proxy was recording), so
//    the unmute's order stays: open, repair, start. The gate is also the
//    shell's record of what the page asked for, so the checks below read it
//    rather than the microphone's publication, which a reconnect replaces.
// 2. **Restarting.** The gate cannot refuse the stop: the microphone is open,
//    so the proxy passes `StopRecording` through.
//    `ensure_microphone_recording` starts recording again, with the repair in
//    front, when the microphone is open and recording was stopped. It runs
//    straight after the share's sound is muted, which is when the log above
//    says the stop happens, so the microphone loses milliseconds.
// 3. **Checking again once a renegotiation has landed.** A (re)published
//    sender's `MuteStream` comes with the next offer, so a check when a
//    command returns is too early to see it. `recheck_microphone` checks at
//    once and again at each of `RECHECK_AFTER_MS`: after a share stops (its
//    video's unpublish renegotiates), after the share's sound is published
//    or unmuted, and after `RoomEvent::Reconnected`. A full reconnect
//    republishes every local track (the SDK's `handle_restarted`), the
//    parked, muted share's sound included, and that republish's
//    `MuteStream` would stop recording under an unmuted microphone as the
//    share's stop does.
//
// Every check, and `voice_set_mic`'s mute and unmute, hold `MIC_RECORDING`,
// so a check can never start recording between a mute's stop and the gate
// closing behind it.
//
// Not yet read on Windows with the fix in. The reconnect case is believed
// from the SDK's `handle_restarted` and the order above; it has never been
// read at all.

/// Serialises the shell's own recording sequences: `voice_set_mic`'s mute and
/// unmute, `ensure_microphone_recording`, and the stop at hang-up. Each device
/// call is already serialised on libwebrtc's worker thread
/// (`AdmProxy::RunOnWorker`); this keeps a *sequence* of them whole.
static MIC_RECORDING: Mutex<()> = Mutex::new(());

fn mic_recording_lock() -> std::sync::MutexGuard<'static, ()> {
  MIC_RECORDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// When `recheck_microphone` looks again, after its first look. The SDK hands
/// a publish or an unpublish to libwebrtc at a publisher offer debounced
/// 150 ms after the call returns (`PUBLISHER_NEGOTIATION_FREQUENCY`,
/// `rtc_session.rs`). On the rig the share's `MuteStream` was logged in the
/// same second as `screen published` (the log has one-second stamps), two
/// offers later. 1 s is past that with room; 3 s covers a slower round or a
/// slower machine.
const RECHECK_AFTER_MS: [u64; 2] = [1000, 3000];

/// Opens or closes the microphone gate (see above). Idempotent in the proxy,
/// and logged only when it changes.
fn set_microphone_gate(open: bool, when: &str) {
  // The runtime `AUDIO` holds, so the proxy the call's engine uses: every
  // caller has been through `platform_audio()` first.
  let runtime = LkRuntime::instance();
  let factory = runtime.pc_factory();
  if factory.adm_recording_enabled() == open {
    return;
  }
  factory.set_adm_recording_enabled(open);
  log::info!(
    "voice: {when} -- microphone gate {} (libwebrtc's own InitRecording/StartRecording {})",
    if open { "opened" } else { "closed" },
    if open { "reach the device again" } else { "are no-ops until the microphone is unmuted" }
  );
}

fn microphone_gate_open() -> bool {
  LkRuntime::instance().pc_factory().adm_recording_enabled()
}

/// Put the microphone back where the page left it, after something that
/// libwebrtc answers by starting or stopping the device's recording from one
/// transceiver's view (see the gate above).
///
/// - Microphone open and recording stopped: the D-68 case. Start it again,
///   with `before_init_recording` in front, as an unmute would.
/// - Microphone open and recording running: nothing happened to it -- unless
///   the shell's last start failed (`Session::mic_start_failed`): then
///   "initialised" may be D-74's initialised-but-not-started, and it is asked
///   to start again.
/// - Microphone muted or never published: the gate kept libwebrtc's start
///   from reaching the device, and this only says so.
///
/// "Open" is the gate (published, then unmuted, by `voice_set_mic`) with a
/// microphone publication in the session. Not `publication.is_muted()`: a
/// full reconnect republishes the track under a new publication and leaves
/// the session's copy without one.
///
/// The log line carries whether recording was still initialised at this
/// point, which is the reading that tells the mechanism above from anything
/// else: `false` right after `screen audio muted` with the microphone open.
pub(crate) fn ensure_microphone_recording(when: &str) {
  // Before the snapshot, so a hang-up or a mute is either wholly before this
  // or wholly after it.
  let _sequence = mic_recording_lock();
  let snapshot = SESSION.lock().unwrap().as_ref().map(|session| {
    (
      session.id,
      session.mic.is_some(),
      session.processing,
      session.engine_held,
      session.mic_start_failed,
    )
  });
  let Some((id, published, processing, engine_held, start_failed)) = snapshot else { return };
  let Ok(audio) = platform_audio() else { return };
  let recording = audio.is_recording_initialized();
  let open = published && microphone_gate_open();
  if !open {
    log::info!(
      "voice: {when} -- microphone {}, left closed (recording initialised {recording})",
      if published { "muted" } else { "not published" }
    );
    return;
  }
  if recording && !start_failed {
    log::info!("voice: {when} -- microphone open, recording still initialised: nothing to restart");
    return;
  }
  if recording {
    // D-74's state: `InitRecording` succeeded and `StartRecording` was
    // refused. Initialised, so there is nothing to repair in front of it (the
    // path was chosen at that init) and `start_recording` goes straight to
    // `StartRecording`, which returns at once if something else has started
    // recording since -- so asking again is safe either way.
    log::info!(
      "voice: {when} -- microphone open, recording initialised but its last start failed: starting it again"
    );
  } else {
    log::info!(
      "voice: {when} -- microphone open but its recording was stopped (recording initialised false): starting it again"
    );
    before_init_recording(&audio, processing, engine_held, when);
  }
  let started = match audio.start_recording() {
    Ok(()) => {
      log::info!(
        "voice: {when} -- microphone recording restarted (recording initialised {})",
        audio.is_recording_initialized()
      );
      true
    }
    Err(error) => {
      log::warn!("voice: start_recording {when}: {error:?}");
      false
    }
  };
  set_mic_start_failed(id, !started);
}

/// Records whether the shell's last start of the open microphone failed
/// (`Session::mic_start_failed`), for the call `id` only.
fn set_mic_start_failed(id: u64, failed: bool) {
  if let Some(session) = SESSION.lock().unwrap().as_mut() {
    if session.id == id {
      session.mic_start_failed = failed;
    }
  }
}

/// `ensure_microphone_recording` now, and again at each of `RECHECK_AFTER_MS`
/// while the same call lasts: for anything whose effect on the device arrives
/// with the publisher's next offer rather than inside the command (point 3
/// above).
pub(crate) fn recheck_microphone(when: &'static str) {
  ensure_microphone_recording(when);
  let Some(id) = session_id() else { return };
  tauri::async_runtime::spawn(async move {
    let mut waited = 0;
    for at in RECHECK_AFTER_MS {
      tokio::time::sleep(std::time::Duration::from_millis(at - waited)).await;
      waited = at;
      if session_id() != Some(id) {
        return;
      }
      ensure_microphone_recording(&format!("{when} (+{at} ms)"));
    }
  });
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
  /// The call's newest SFU token: the join token, then each refresh. Kept
  /// for a page that picks the call up after a reload (`voice_current`),
  /// which asks the SFU about the room with it as the page before it did.
  /// Never logged.
  token: Mutex<String>,
  /// The SDK's reason for `RoomEvent::Disconnected`, once the room has ended:
  /// a page loaded after that reads it from `voice_current`, since the event
  /// itself went to the page that is gone.
  disconnect_reason: Mutex<Option<String>>,
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
  /// The call's processing switches and whether the engine was held, kept so
  /// `voice_set_mic` can repair the built-in canceller before every
  /// `InitRecording` (`before_init_recording`).
  processing: ProcessingArgs,
  engine_held: bool,
  /// The shell's last `start_recording` for the open microphone failed and
  /// nothing has started it since. Read by `ensure_microphone_recording`,
  /// which otherwise takes "recording initialised" to mean "recording": a
  /// start refused *after* `InitRecording` succeeded (row D-74, "Playout
  /// must be started before recording") leaves the module initialised and
  /// not recording, and nothing the SDK exposes tells those apart. Cleared by
  /// a start that succeeds and by a mute, which stops recording and makes the
  /// next unmute a whole init-and-start.
  mic_start_failed: bool,
  pump: tauri::async_runtime::JoinHandle<()>,
  started: Instant,
  /// The SFU this call is on, for `voice_current`.
  url: String,
  /// The page's opaque note about this call (`ConnectArgs::handoff`), handed
  /// back to whichever page asks `voice_current`. Held here only, for the
  /// session's life; never logged or written anywhere.
  handoff: Option<String>,
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
  /// Their screen share carries a second audio track, unmuted. A separate
  /// volume from their voice, never folded into `mic_muted`. Unmuted because
  /// this engine keeps a share's sound published but muted after the share
  /// stops (video.rs, row S-18), and a muted one has nothing to turn down.
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
        has_screen_audio: audio_publications_of(&participant, TrackSource::ScreenshareAudio)
          .iter()
          .any(|publication| !publication.is_muted()),
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
  /// with the last known quality word. `reason` is the SDK's
  /// `DisconnectReason` by name, on `disconnected` only: whether it means
  /// somebody already knows the call is over is TypeScript's decision
  /// (transport-rules.ts's `disconnectWasTold`).
  Connection {
    state: String,
    quality: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
  },
  /// The SDK's frame-cryption state for one participant, by name
  /// (`Ok`, `MissingKey`, `DecryptionFailed`, ...). TypeScript decides which
  /// of these count as a frame that failed to open.
  Encryption { identity: String, state: String },
  /// A video publication appeared, went, muted, or was (un)subscribed: the
  /// seam's `videoChanged`, kept apart from the roster event because a tile
  /// remounting is expensive where a name changing is not.
  VideoChanged,
  /// The SFU refreshed this call's token, as it does every few minutes. The
  /// page asks the SFU's `rtc/validate` whether a room still exists
  /// (transport-native.ts), and the join token it started with expires after
  /// 15 minutes, which would make every longer call's answer a 401. Never
  /// logged.
  Token { token: String },
}

#[derive(Serialize, Clone, Debug)]
struct Envelope {
  session: u64,
  #[serde(flatten)]
  event: Event,
}

/// A connection word with no disconnect reason: everything but `disconnected`.
fn connection(state: &str, quality: String) -> Event {
  Event::Connection { state: state.into(), quality, reason: None }
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
        emit(&app, session, connection("connected", quality()));
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
      RoomEvent::TrackUnsubscribed { publication, participant, .. } => {
        log::info!("voice: unsubscribed from {} from {}", publication.sid(), participant.identity());
        emit(&app, session, Event::Roster { roster: roster(&room) });
        if publication.kind() == TrackKind::Video {
          video::on_unsubscribed(session, participant.identity().as_str(), publication.source());
          video::on_video_event(&app, session, &room);
        }
      }
      RoomEvent::TrackPublished { publication, .. }
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
          emit(&app, session, connection("connected", word));
        }
      }
      RoomEvent::ConnectionStateChanged(state) => {
        let word = match state {
          ConnectionState::Connected => "connected",
          ConnectionState::Reconnecting => "reconnecting",
          // Said by `RoomEvent::Disconnected` below, which the SDK dispatches
          // straight after this one and which alone carries the reason.
          ConnectionState::Disconnected => continue,
        };
        emit(&app, session, connection(word, quality()));
      }
      RoomEvent::Reconnecting => {
        emit(&app, session, connection("reconnecting", quality()));
      }
      RoomEvent::Reconnected => {
        emit(&app, session, connection("connected", quality()));
        emit(&app, session, Event::Roster { roster: roster(&room) });
        // A full reconnect has just republished every local track, a parked
        // share's sound (muted) included, and the new senders' `MuteStream`
        // comes with the next offer: see point 3 above
        // `set_microphone_gate`. After a resume this finds nothing to do.
        recheck_microphone("after a reconnect");
      }
      RoomEvent::Disconnected { reason } => {
        log::info!("voice: disconnected ({reason:?})");
        *shared.disconnect_reason.lock().unwrap() = Some(format!("{reason:?}"));
        emit(
          &app,
          session,
          Event::Connection {
            state: "disconnected".into(),
            quality: quality(),
            reason: Some(format!("{reason:?}")),
          },
        );
      }
      RoomEvent::TokenRefreshed { token } => {
        shared.token.lock().unwrap().clone_from(&token);
        emit(&app, session, Event::Token { token });
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
  /// Whether this shell both captures **and** renders video natively
  /// (video.rs): macOS since 2026-09-08, Windows since stage W4 opened its
  /// camera (capture.rs's `win`). Kept as one boolean because a shell older
  /// than the split answers only this, and a page reading it alone still
  /// gets a true answer. Feature-detected by the page, never derived from a
  /// platform name.
  video: bool,
  /// The shell can capture a screen or window with a picker of its own
  /// (Windows since 2026-09-09; stage W1). Split from `video` because
  /// Windows captures long before it can draw a received tile, and the
  /// page has to be able to offer the screen button while the camera
  /// button is still the engine switch.
  screen_capture: bool,
  /// The shell can draw received tiles natively (macOS; Windows after W3).
  video_render: bool,
}

#[tauri::command]
pub fn voice_probe(app: AppHandle) -> VoiceResult<Probe> {
  let audio = platform_audio()?;
  render::remember_app(&app);
  start_device_poller(app);
  let probe = Probe {
    livekit_rev: LIVEKIT_REV,
    video: cfg!(any(target_os = "macos", target_os = "windows")),
    // libwebrtc's `DesktopCapturer` is implemented on both, and off macOS
    // `voice_set_screen` now refuses to start without a source the person
    // chose (video.rs), which is what makes offering it safe.
    screen_capture: cfg!(any(target_os = "macos", target_os = "windows")),
    video_render: cfg!(any(target_os = "macos", target_os = "windows")),
    recording_devices: audio.recording_devices().count(),
    playout_devices: audio.playout_devices().count(),
    aec: format!("{:?}", audio.active_aec_type()),
    agc: format!("{:?}", audio.active_agc_type()),
    ns: format!("{:?}", audio.active_ns_type()),
  };
  // Regression row D-43 reads the three capability booleans, and until
  // 2026-09-09 the only place they existed was the page's own devtools --
  // which this shell does not relay. Logged from the struct rather than
  // from the `cfg!`s again, so the line cannot come to disagree with the
  // answer the page was actually given.
  log::info!(
    "voice: probe video={} screenCapture={} videoRender={} ({} input(s), {} output(s))",
    probe.video,
    probe.screen_capture,
    probe.video_render,
    probe.recording_devices,
    probe.playout_devices
  );
  // `WHERRY_DEV_SCREEN_SOURCES=1`, debug builds only: log what our own
  // picker would list, at boot, so row S-09's "is there anything to show"
  // half can be read without a call and without a second person. Deliberately
  // the *same* call the picker makes rather than a probe of its own -- a
  // separate instrument would be testing a copy. Off unless asked, because
  // enumerating windows is not free and nothing else needs it at boot.
  #[cfg(debug_assertions)]
  if std::env::var("WHERRY_DEV_SCREEN_SOURCES").ok().as_deref() == Some("1") {
    let sources = capture::screen_sources();
    log::info!("voice: screen sources ({} found)", sources.len());
    for source in &sources {
      log::info!("voice:   {:?} {} = {:?}", source.kind, source.id, source.title);
    }
  }
  // `WHERRY_DEV_CAMERAS=1`, debug builds only: log what the camera picker
  // would list, at boot, so row D-58 can be read without opening Settings.
  // `=open` (or `=open:<height>`) goes on to open the first camera for five
  // seconds and close it, so D-61's log half, D-63's pitch and D-64's branch
  // can be read without a call. The same two calls the picker and a call
  // make, for the same reason as the knob above.
  #[cfg(debug_assertions)]
  if let Ok(knob) = std::env::var("WHERRY_DEV_CAMERAS") {
    let cameras = video::voice_video_devices().unwrap_or_default();
    log::info!("voice: cameras ({} found)", cameras.len());
    for camera in &cameras {
      log::info!("voice:   {:?} = {:?}", camera.label, camera.device_id);
    }
    if let Some(rest) = knob.strip_prefix("open") {
      let height = rest.strip_prefix(':').and_then(|h| h.parse().ok()).unwrap_or(720);
      // A blocking task on Tauri's runtime, never a bare thread:
      // `NativeVideoSource::new` calls `tokio::spawn` and panics without one
      // (render_win.rs's dev tile says the same), and a call's camera is
      // opened from exactly this kind of task.
      tauri::async_runtime::spawn_blocking(move || video::dev_open_camera(height));
    }
  }
  Ok(probe)
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
  /// The Windows default output's id, `null` when Windows has none; absent
  /// where this shell leaves playout to the platform (`playout.rs`). The
  /// page reads its presence as "this shell can follow the default".
  #[serde(skip_serializing_if = "Option::is_none")]
  default_output: Option<Option<String>>,
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
    default_output: None,
  }
}

#[tauri::command]
pub fn voice_devices() -> VoiceResult<AudioDevices> {
  Ok(playout::devices_with_default(&platform_audio()?))
}

static DEVICE_POLLER: AtomicBool = AtomicBool::new(false);

/// Re-read the device list every `DEVICE_POLL_MS` for the life of the
/// process and emit `voice-devices` when it differs from the last reading.
/// On Windows the reading includes the default output, so a change of the
/// Windows default is a change here too: nothing else would tell the page
/// (row D-72 -- the list is the same, only the default moved).
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
      let devices = playout::devices_with_default(&audio);
      let default_output = match &devices.default_output {
        Some(Some(id)) => Some(id.clone()),
        Some(None) => Some("none".to_string()),
        None => None,
      };
      let key: Vec<(String, String)> = devices
        .inputs
        .iter()
        .map(|d| (format!("in:{}", d.device_id), d.label.clone()))
        .chain(devices.outputs.iter().map(|d| (format!("out:{}", d.device_id), d.label.clone())))
        .chain(default_output.iter().map(|id| ("default-out".to_string(), id.clone())))
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
      // The default only where this shell reads one, so a macOS line is
      // byte-for-byte what it was.
      let default_note =
        default_output.as_deref().map(|id| format!(", default output {id}")).unwrap_or_default();
      if first {
        log::info!(
          "voice: devices at start ({} input(s), {} output(s){default_note})",
          devices.inputs.len(),
          devices.outputs.len()
        );
      }
      if changed {
        log::info!(
          "voice: devices changed ({} input(s), {} output(s){default_note})",
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
  /// Opaque to the shell: what the page wants back if it is reloaded while
  /// this call runs (client/src/voice/handoff.ts). Absent from a page built
  /// before 2026-09-27, whose calls cannot be picked up and are closed by
  /// the next page instead.
  #[serde(default)]
  handoff: Option<String>,
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

  // The engine's one-time init first, so that nothing below is undone by it
  // (see `hold_media_engine`). Every line below this one in the log is then a
  // choice that stands for the call.
  let engine_held = match hold_media_engine() {
    EngineHold::Now { ms } => {
      log::info!(
        "voice: media engine initialised and held in {ms} ms, before this call's devices and echo settings"
      );
      true
    }
    EngineHold::Already => {
      log::info!("voice: media engine already held -- no engine init in this call");
      true
    }
    EngineHold::Failed(error) => {
      log::warn!(
        "voice: could not hold the media engine ({error}); unless an earlier PeerConnection still holds it, the engine's init in the connect will replace this call's devices with the defaults (the built-in echo canceller is still turned off after the connect, and the hold is tried again once connected)"
      );
      false
    }
  };
  // Nothing may record until this call's microphone is published: a share
  // with audio started before that would otherwise open it (row D-69; the
  // gate is described above `set_microphone_gate`). `voice_set_mic(true)`
  // opens it.
  set_microphone_gate(false, "at connect");

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

  // `switch_*` rather than `set_*`, and it is not a preference -- it is what
  // makes the **second** call in a process work.
  //
  // Measured on Windows 2026-09-10, twice from a cold start: call one
  // connects, call two fails outright with `set_playout_device:
  // DeviceNotFound` and the person sees "Could not connect to the voice
  // server". The device is still in the shell's own inventory a line
  // earlier, so it is not gone; what has changed is that WebRTC started
  // playout during the first call and never stopped it, and the ADM
  // refuses a device change while playout is initialised. The SDK's
  // `set_playout_device` says in its own comment that it deliberately does
  // not init or start, so it has no idea it has to stop first;
  // `switch_playout_device` is the sibling that does the
  // stop/change/init/start sequence, and on a first call
  // (`playout_is_initialized()` false) it does exactly what `set_` did.
  //
  // Only bites somebody who has *chosen* a device -- the `None` arms below
  // leave the platform default alone and never call either -- which is why
  // it survived the 2026-09-09 pass. The recording side is switched for the
  // same reason rather than because it was seen to fail.
  match args.mic_device_id.as_deref() {
    Some(id) => {
      log::info!("voice: capture requested {id} ({})", name_of(id));
      audio
        .switch_recording_device(&RecordingDeviceId::from_unchecked_guid(id))
        .map_err(|e| VoiceError::new("device", format!("switch_recording_device: {e:?}")))?;
    }
    None => log::info!("voice: capture left at the platform default"),
  }
  match args.speaker_device_id.as_deref() {
    // The page checked the id against the list a moment ago; if the device
    // went in between, the call falls back to the default rather than
    // failing (the same decision the page makes mid-call).
    Some(id) if devices.outputs.iter().any(|d| d.device_id == id) => {
      log::info!("voice: playout requested {id} ({})", name_of(id));
      playout::apply(&audio, id)?;
    }
    Some(id) => {
      log::warn!("voice: playout requested {id}, which is no longer in the list -- using the default");
      if let Err(error) = playout::at_connect(&audio) {
        log::warn!("voice: playout could not be put on the default: {}", error.message);
      }
    }
    // On Windows, the default resolved now and selected by id, so a call no
    // longer inherits whatever device the last call's playout was moved to
    // (`playout.rs`); elsewhere nothing, as before. A failure here is not
    // worth failing the call over: the module's own default still stands.
    None => {
      if let Err(error) = playout::at_connect(&audio) {
        log::warn!("voice: playout could not be put on the default: {}", error.message);
      }
    }
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
  // Before the microphone track exists: these are its source's options. With
  // `prefer_hardware_processing` false this also turns a built-in canceller
  // off where the module has one (Windows' DMO; `BuiltInAECIsAvailable` is 1
  // even on the rig's VM), and after `hold_media_engine` nothing turns it back
  // on before `builtin_aec_off` checks it after the connect. The
  // `aec=Hardware` in the line below means only that one is *available*.
  let processing = args.processing;
  if let Err(error) = audio.configure_audio_processing(AudioProcessingOptions {
    echo_cancellation: processing.echo_cancellation,
    noise_suppression: processing.noise_suppression,
    auto_gain_control: processing.auto_gain_control,
    prefer_hardware_processing: false,
  }) {
    // Only the hardware path can fail; a call is still worth having with
    // the defaults, and `builtin_aec_off` reports the canceller's state.
    log::warn!("voice: configure_audio_processing: {error:?}");
  }
  log::info!(
    "voice: audio processing aec={:?} ns={:?} agc={:?}",
    audio.active_aec_type(),
    audio.active_ns_type(),
    audio.active_agc_type()
  );

  let shared = Arc::new(Shared::default());
  shared.token.lock().unwrap().clone_from(&args.token);
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
  // A hold that failed before the connect is tried again now. The call's own
  // PeerConnection has initialised the engine and is still alive, so creating
  // the hold cannot run the engine's `Init` again -- it only adds a
  // reference. What it buys is the
  // hang-up: without a hold, the call's PeerConnection is the engine's last
  // reference, and once PeerConnections are really destroyed at hang-up
  // (patches/rust-sdks-room-session-release.md) dropping it would run the
  // engine's `Terminate` into the `PlatformAudio` this shell keeps, and the
  // next call's `Init` would repeat this call's device defect. Taken now,
  // the defect stays with this one call, as it always did. Until that fork
  // change lands no PeerConnection is ever released, so this changes nothing
  // today. `engine_held` keeps its meaning: whether the init ran before this
  // call's choices.
  if !engine_held {
    match hold_media_engine() {
      EngineHold::Failed(error) => log::warn!(
        "voice: could not hold the media engine after connect either ({error}); if this call's PeerConnection is the engine's last reference, hanging up terminates the engine and the next call's init replaces its devices again"
      ),
      EngineHold::Now { ms } => log::info!(
        "voice: media engine held after connect in {ms} ms -- this call ran the engine's init, the next will not"
      ),
      EngineHold::Already => log::info!("voice: media engine already held after connect"),
    }
  }
  // Before `SESSION` is set, so before `voice_set_mic` can publish and
  // initialise recording.
  builtin_aec_off(&audio, processing, engine_held, "after connect");
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
    processing,
    engine_held,
    mic_start_failed: false,
    pump: pump_task,
    started,
    url: args.url,
    handoff: args.handoff,
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
    // After any check already under way, which read the session before it
    // was taken above; every later one finds no session.
    let _sequence = mic_recording_lock();
    if let Err(error) = audio.stop_recording() {
      log::debug!("voice: stop_recording on disconnect: {error:?}");
    }
    // After the stop, so the stop reaches the device (a closed gate turns
    // the proxy's `StopRecording` into bookkeeping only).
    set_microphone_gate(false, "at hang-up");
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
  let (existing, max_bitrate, processing, engine_held) = {
    let guard = SESSION.lock().unwrap();
    let session = guard.as_ref().ok_or_else(|| VoiceError::new("not_connected", "no call"))?;
    (session.mic.clone(), session.max_bitrate, session.processing, session.engine_held)
  };
  let audio = platform_audio()?;

  if let Some(publication) = existing {
    // Whole, against `ensure_microphone_recording`: a check that started
    // recording between the mute's stop and the gate closing would leave a
    // muted microphone open.
    let _sequence = mic_recording_lock();
    if enabled {
      // The gate first: opening it starts nothing, and a closed one would
      // turn the start below into a no-op that reports success.
      set_microphone_gate(true, "on unmute");
      // Mute stopped recording, so this start initialises it again: repair
      // anything a renegotiation while muted turned on (`before_init_recording`).
      // With the gate, nothing else can have initialised it while muted --
      // a share's sound included (row D-69 (b)).
      before_init_recording(&audio, processing, engine_held, "on unmute");
      let start_failed = match audio.start_recording() {
        Ok(()) => false,
        Err(error) => {
          log::warn!("voice: start_recording on unmute: {error:?}");
          true
        }
      };
      set_mic_start_failed(id, start_failed);
      publication.unmute();
      if start_failed {
        // After the lock is released: the recheck takes it itself.
        drop(_sequence);
        recheck_microphone("after a failed start on unmute");
      }
    } else {
      publication.mute();
      if let Err(error) = audio.stop_recording() {
        log::debug!("voice: stop_recording on mute: {error:?}");
      }
      // Stopped on purpose: a failed start before this is moot, and the
      // unmute initialises and starts afresh.
      set_mic_start_failed(id, false);
      // After the stop, which has to reach the device; from here until the
      // unmute, libwebrtc's own starts (a share's sound being published or
      // unmuted, a renegotiation) open nothing.
      set_microphone_gate(false, "on mute");
    }
    return Ok(());
  }

  if !enabled {
    // Muted before it was ever published: nothing to publish silence from,
    // and the gate stays as the connect left it, closed.
    return Ok(());
  }
  if audio.recording_devices().next().is_none() {
    return Err(VoiceError::new("no_microphone", "no recording device"));
  }
  // Before the publish, whose `AddSendingStream` is what initialises
  // recording for a device track (the connect's `builtin_aec_off` has already
  // run in front of it).
  set_microphone_gate(true, "before the microphone's publish");
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
  let published = room
    .local_participant()
    .publish_track(LocalTrack::Audio(track), options)
    .await;
  let publication = match published {
    Ok(publication) => publication,
    Err(error) => {
      // No microphone to be open for; a share's sound must not open it.
      set_microphone_gate(false, "after a failed microphone publish");
      return Err(VoiceError::new("mic_failed", format!("publish: {error}")));
    }
  };
  // On the rig's pre-fix reading the publish had initialised recording by
  // this point (status §3.3), so this should ask nothing; it is here so that no `start_recording` in this file can
  // initialise recording without the repair in front of it.
  before_init_recording(&audio, processing, engine_held, "after publish");
  let start_failed = match audio.start_recording() {
    Ok(()) => false,
    Err(error) => {
      // Publishing a device-sourced track initialises recording on its own;
      // an explicit start that then fails is worth a log line, not a
      // failed call -- and a second look once the publication is recorded
      // below, because nothing else would ever start it (row D-73: a
      // failed start at publish left the microphone silent for the call).
      log::warn!("voice: start_recording after publish: {error:?}");
      true
    }
  };
  // The sender's cryptor exists now: put it on the current index.
  let index = *shared.key_index.lock().unwrap();
  let cryptors = apply_key_index(&room, index);
  log::info!(
    "voice: microphone published as {} (recording {}), {cryptors} cryptor(s) on index {index}",
    publication.sid(),
    audio.is_recording_initialized()
  );

  let stored = {
    let mut guard = SESSION.lock().unwrap();
    match guard.as_mut() {
      Some(session) if session.id == id => {
        session.mic = Some(publication);
        session.mic_start_failed = start_failed;
        true
      }
      _ => {
        // The call ended while the publish was in flight; the room is closed
        // or closing and the publication goes with it.
        false
      }
    }
  };
  if stored && start_failed {
    // After the publication is in the session, which is what makes
    // `ensure_microphone_recording` count the microphone as open, and with
    // `mic_start_failed` set, which is what makes it ask again even though
    // the publish left recording initialised (D-74's state: the log line
    // above reads `recording true` right after the refusal).
    recheck_microphone("after a failed start at publish");
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
  playout::apply(&audio, &device_id)
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

/// The call this shell is running, as a page that did not start it needs to
/// know it: `voice_current`'s answer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentCall {
  session: u64,
  /// `ConnectArgs::handoff`, as the page that connected left it.
  handoff: Option<String>,
  /// The room's own connection state: `connected`, `reconnecting` or
  /// `disconnected` (the SFU or the network ended it while no page listened).
  state: &'static str,
  /// `RoomEvent::Disconnected`'s reason, once there was one.
  reason: Option<String>,
  quality: String,
  roster: Roster,
  url: String,
  token: String,
  /// The microphone is published, and whether it is open (unmuted).
  mic_published: bool,
  mic_open: bool,
  /// The processing switch the call was joined with, which the readout needs.
  echo_cancellation: bool,
  /// A camera is publishing and capturing (a muted camera reads false), and a
  /// screen share is published.
  camera: bool,
  screen: bool,
}

/// The call that is running, or `None`.
///
/// For a page loaded while the shell held a call -- a reload, which destroys
/// the page and none of this -- so it can take the call over or close it
/// (client/src/voice/handoff.ts decides which). A reading only: nothing about
/// the session changes, and events keep going out under its id as before.
#[tauri::command]
pub fn voice_current() -> VoiceResult<Option<CurrentCall>> {
  let snapshot = SESSION.lock().unwrap().as_ref().map(|session| {
    (
      session.id,
      session.room.clone(),
      session.shared.clone(),
      session.handoff.clone(),
      session.url.clone(),
      session.mic.is_some(),
      session.processing.echo_cancellation,
    )
  });
  let Some((id, room, shared, handoff, url, mic_published, echo_cancellation)) = snapshot else {
    return Ok(None);
  };
  let state = match room.connection_state() {
    ConnectionState::Connected => "connected",
    ConnectionState::Reconnecting => "reconnecting",
    ConnectionState::Disconnected => "disconnected",
  };
  let (camera, screen) = video::local_video(id);
  let reason = shared.disconnect_reason.lock().unwrap().clone();
  let quality = shared.quality.lock().unwrap().clone();
  let token = shared.token.lock().unwrap().clone();
  log::info!(
    "voice: session {id} read by a page that did not start it ({state}, microphone {}, camera {camera}, screen {screen}, handoff {})",
    if !mic_published { "not published" } else if microphone_gate_open() { "open" } else { "muted" },
    if handoff.is_some() { "present" } else { "absent" }
  );
  Ok(Some(CurrentCall {
    session: id,
    handoff,
    state,
    reason,
    quality,
    roster: roster(&room),
    url,
    token,
    mic_published,
    mic_open: mic_published && microphone_gate_open(),
    echo_cancellation,
    camera,
    screen,
  }))
}

/// The page that talked to this call is gone and another has taken it over:
/// forget what the old one told the shell about itself.
///
/// Its tiles are destroyed -- they were placed against a document that no
/// longer exists and would otherwise go on drawing over the new one at the
/// old rects -- and so are the surfaces it said were covered. The listener's
/// per-participant playback and gain choices are dropped too, so that a
/// participant who joins later plays at the default; the page resets the
/// tracks already playing (transport-native.ts). Returns how many tiles went.
#[tauri::command]
pub fn voice_forget_page() -> VoiceResult<usize> {
  let (id, _, shared) = current()?;
  shared.playback.lock().unwrap().clear();
  shared.volume.lock().unwrap().clear();
  let tiles = video::forget_page(id);
  log::info!("voice: session {id} taken over by a new page; {tiles} tile(s) of the old one destroyed");
  Ok(tiles)
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
