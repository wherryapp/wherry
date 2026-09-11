// Video on the native transport: publishing, subscribing, and the tiles
// (docs/prompts/video-next-stages-handoff.md §3, built 2026-09-08 on path
// (b) after the spike -- see render.rs for why a native view).
//
// The same rule as mod.rs: mechanism only. Which source a call may publish,
// how tall, at what frame rate, which layer a tile wants, whether a tile is
// on screen or covered -- all of that arrives decided from
// `transport-native.ts` and the session's rules, and this file opens
// devices, publishes tracks, subscribes, and puts frames on screen.
//
// **Capture and rendering are separate answers per platform, and nothing
// here knows which.** macOS does both (AVFoundation and an
// `AVSampleBufferDisplayLayer`, stage 3N). Windows shares a screen through
// its own picker (W1), draws every received tile in a child `HWND` over
// WebView2 (W3, `render_win.rs`), and still has no camera capture -- so the
// probe answers `video: false, screenCapture: true, videoRender: true`
// there and the camera button alone is the engine switch. Linux has
// neither and takes `render_stub.rs`. This file is the same code on all
// three; the `cfg` that picks a renderer is in `mod.rs` and the one that
// picks a capture is in `capture.rs`.
//
// Three shapes worth knowing:
//
// - The camera is published once and then **muted, never unpublished**,
//   the way livekit-client's `setCameraEnabled(false)` behaves, so
//   `cameraMuted` means the same thing on both transports. The capture
//   device is closed while muted so the camera light goes off.
// - The screen is **unpublished** when it stops, also matching the webview.
//   Its size is not known until the person has picked one in the OS's
//   sheet, so the publish waits on the first frame.
// - A tile is a native view bound to a track by (identity, source). It is
//   created by the page before the track may exist -- a tile for somebody
//   whose camera is still being subscribed -- and bound when the pump sees
//   the subscription; it unbinds itself when the stream ends, and rebinds
//   on the next.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use livekit::options::{AudioEncoding, TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::prelude::*;
use livekit::track::VideoQuality;
use livekit::webrtc::stats::RtcStats;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::webrtc::video_track::RtcVideoTrack;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use super::capture::{self, Source, SourceSlot, VideoDevice};
use super::render::{PageRect, Tile};
use super::screen_audio::{self, ScreenAudio};
use super::{apply_key_index, current, emit, Event, VoiceError, VoiceResult};

// -- state -------------------------------------------------------------------

struct Published {
  publication: LocalTrackPublication,
  track: LocalVideoTrack,
  source: NativeVideoSource,
  /// Whatever is putting frames in; `None` while the camera is muted.
  capture: Option<Source>,
  /// The screen's frame sink, so the capture thread finds the source once
  /// the publication exists.
  slot: Option<SourceSlot>,
  device_id: Option<String>,
  /// The share's own sound, where one was asked for and the platform has
  /// it: a second publication of its own, on purpose. Two tracks and two
  /// volumes is requirement 1 of video-plan.md §10.2 — turning a colleague
  /// down must not turn down the film they are showing you — and it is
  /// also what keeps "muted" meaning the microphone, since mute reads the
  /// microphone publication and this is not one.
  audio: Option<PublishedAudio>,
}

struct PublishedAudio {
  publication: LocalTrackPublication,
  capture: ScreenAudio,
}

struct TileEntry {
  identity: String,
  source: TrackSource,
  surface: String,
  tile: Tile,
  /// When this tile's placement was last written to the log, for the rate
  /// limit in `voice_set_video_rect`. `None` until the first line.
  placement_logged: Option<std::time::Instant>,
}

#[derive(Default)]
struct VideoState {
  /// The session these belong to; a new connect starts from empty.
  session: u64,
  camera: Option<Published>,
  screen: Option<Published>,
  tiles: HashMap<u64, TileEntry>,
  next_tile: u64,
  covered: HashSet<String>,
}

static VIDEO: Mutex<Option<VideoState>> = Mutex::new(None);

fn with_state<T>(session: u64, f: impl FnOnce(&mut VideoState) -> T) -> T {
  let mut guard = VIDEO.lock().unwrap();
  let state = guard.get_or_insert_with(VideoState::default);
  if state.session != session {
    *state = VideoState { session, ..VideoState::default() };
  }
  f(state)
}

fn source_of(word: &str) -> VoiceResult<TrackSource> {
  match word {
    "camera" => Ok(TrackSource::Camera),
    "screen" => Ok(TrackSource::Screenshare),
    other => Err(VoiceError::new("bad_source", format!("unknown video source {other}"))),
  }
}

fn word_of(source: TrackSource) -> &'static str {
  match source {
    TrackSource::Screenshare => "screen",
    _ => "camera",
  }
}

/// The SDK's own presets, by height: what livekit-client asks for at the
/// same resolution (`VideoPresets`), so a shell and a browser at 720p cost
/// the SFU the same.
fn camera_bitrate(height: u32) -> u64 {
  match height {
    h if h <= 180 => 160_000,
    h if h <= 360 => 450_000,
    h if h <= 720 => 1_700_000,
    _ => 3_000_000,
  }
}

fn screen_bitrate(height: u32) -> u64 {
  match height {
    h if h <= 360 => 400_000,
    h if h <= 720 => 1_500_000,
    _ => 3_000_000,
  }
}

/// A 16:9 frame at `height`, even on both sides.
fn landscape(height: u32) -> (u32, u32) {
  let height = height.max(2) & !1;
  let width = ((height as f64 * 16.0 / 9.0).round() as u32) & !1;
  (width, height)
}

// -- devices -------------------------------------------------------------------

#[tauri::command]
pub fn voice_video_devices() -> VoiceResult<Vec<VideoDevice>> {
  #[cfg(target_os = "macos")]
  {
    Ok(capture::mac::devices())
  }
  #[cfg(not(target_os = "macos"))]
  {
    Ok(Vec::new())
  }
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSource {
  /// `screen:<id>` or `window:<id>`. The prefix is not decoration: the two
  /// are different capturers with different id spaces (capture.rs), and it
  /// is also what `transport-rules.ts` reads to decide the audio mode.
  pub id: String,
  pub title: String,
  /// True for a whole display, so the page can head the two groups without
  /// parsing the id.
  pub is_screen: bool,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn screen_id(kind: capture::ScreenKind, id: u64) -> String {
  match kind {
    capture::ScreenKind::Screen => format!("screen:{id}"),
    capture::ScreenKind::Window => format!("window:{id}"),
  }
}

fn parse_screen_id(id: &str) -> VoiceResult<capture::PickedSource> {
  let (word, rest) = id
    .split_once(':')
    .ok_or_else(|| VoiceError::new("bad_source", format!("unrecognised screen source {id}")))?;
  let kind = match word {
    "screen" => capture::ScreenKind::Screen,
    "window" => capture::ScreenKind::Window,
    _ => return Err(VoiceError::new("bad_source", format!("unrecognised screen source {id}"))),
  };
  let id = rest
    .parse::<u64>()
    .map_err(|_| VoiceError::new("bad_source", format!("unrecognised screen source {id}")))?;
  Ok(capture::PickedSource { kind, id })
}

/// Empty on macOS on purpose: the system picker is the interface there
/// (capture.rs), so the bar opens it directly rather than drawing a list.
/// On Windows there is no OS picker to open — not in the shell and not in
/// WebView2 either (S-00) — so this is the list our own picker draws.
#[tauri::command]
pub fn voice_screen_sources() -> VoiceResult<Vec<ScreenSource>> {
  #[cfg(target_os = "macos")]
  {
    Ok(Vec::new())
  }
  #[cfg(not(target_os = "macos"))]
  {
    Ok(
      capture::screen_sources()
        .into_iter()
        .map(|source| ScreenSource {
          id: screen_id(source.kind, source.id),
          title: source.title,
          is_screen: source.kind == capture::ScreenKind::Screen,
        })
        .collect(),
    )
  }
}

// -- the camera --------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraArgs {
  pub enabled: bool,
  pub device_id: Option<String>,
  pub max_height: u32,
  pub max_fps: u32,
}

fn open_camera(
  device_id: Option<&str>,
  max_height: u32,
  max_fps: u32,
  size: (u32, u32),
  source: NativeVideoSource,
) -> VoiceResult<Source> {
  if capture::dev_sweep_requested() {
    log::warn!("voice: WHERRY_DEV_CAMERA=sweep -- the synthetic sweep stands in for the camera");
    return Ok(Source::Sweep(capture::Sweep::start(source, size.0, size.1, max_fps)));
  }
  #[cfg(target_os = "macos")]
  {
    capture::mac::Camera::open(device_id, max_height, source).map(Source::Camera)
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = (device_id, max_height);
    Err(VoiceError::new("unsupported", "no native camera on this platform yet"))
  }
}

#[tauri::command]
pub async fn voice_set_camera(_app: AppHandle, args: CameraArgs) -> VoiceResult<()> {
  let (session, room, shared) = current()?;
  let existing = with_state(session, |state| {
    state.camera.as_ref().map(|c| (c.capture.is_some(), c.device_id.clone(), c.source.clone()))
  });

  if let Some((capturing, device, source)) = existing {
    if !args.enabled {
      let capture = with_state(session, |state| {
        state.camera.as_mut().and_then(|c| {
          c.publication.mute();
          c.capture.take()
        })
      });
      if let Some(capture) = capture {
        tauri::async_runtime::spawn_blocking(move || capture.stop()).await.ok();
      }
      log::info!("voice: camera muted, device closed");
      return Ok(());
    }
    // On, or on again: reopen the device into the same source unless it is
    // already delivering from the device asked for.
    if capturing && device == args.device_id {
      with_state(session, |state| {
        if let Some(c) = state.camera.as_ref() {
          c.publication.unmute();
        }
      });
      return Ok(());
    }
    let previous = with_state(session, |state| state.camera.as_mut().and_then(|c| c.capture.take()));
    if let Some(previous) = previous {
      tauri::async_runtime::spawn_blocking(move || previous.stop()).await.ok();
    }
    let size = landscape(args.max_height);
    let wanted = args.device_id.clone();
    let capture = tauri::async_runtime::spawn_blocking(move || {
      open_camera(wanted.as_deref(), args.max_height, args.max_fps, size, source)
    })
    .await
    .map_err(|e| VoiceError::new("camera_failed", e.to_string()))??;
    with_state(session, |state| {
      if let Some(c) = state.camera.as_mut() {
        c.capture = Some(capture);
        c.device_id = args.device_id.clone();
        c.publication.unmute();
      }
    });
    log::info!("voice: camera unmuted on {}", args.device_id.as_deref().unwrap_or("default"));
    return Ok(());
  }

  if !args.enabled {
    return Ok(());
  }

  // First time: the device, then the track, then the publication.
  let size = landscape(args.max_height);
  let source = NativeVideoSource::new(VideoResolution { width: size.0, height: size.1 }, false);
  let wanted = args.device_id.clone();
  let opened = source.clone();
  let capture = tauri::async_runtime::spawn_blocking(move || {
    open_camera(wanted.as_deref(), args.max_height, args.max_fps, size, opened)
  })
  .await
  .map_err(|e| VoiceError::new("camera_failed", e.to_string()))??;

  let track = LocalVideoTrack::create_video_track("camera", RtcVideoSource::Native(source.clone()));
  let options = TrackPublishOptions {
    source: TrackSource::Camera,
    // H.264 while frames are encrypted, for the reason transport-rules.ts's
    // videoCodecFor gives; simulcast so a viewer's `low` layer costs a
    // fraction of the pinned one.
    video_codec: VideoCodec::H264,
    simulcast: true,
    video_encoding: Some(VideoEncoding {
      max_bitrate: camera_bitrate(size.1),
      max_framerate: args.max_fps.max(1) as f64,
    }),
    ..Default::default()
  };
  let publication = match room
    .local_participant()
    .publish_track(LocalTrack::Video(track.clone()), options)
    .await
  {
    Ok(publication) => publication,
    Err(error) => {
      tauri::async_runtime::spawn_blocking(move || capture.stop()).await.ok();
      return Err(VoiceError::new("camera_failed", format!("publish: {error}")));
    }
  };
  // The sender's cryptor exists now: the same walk the microphone does.
  let index = *shared.key_index.lock().unwrap();
  let cryptors = apply_key_index(&room, index);
  log::info!(
    "voice: camera published as {} at {}x{} simulcast, {cryptors} cryptor(s) on index {index}",
    publication.sid(),
    size.0,
    size.1
  );
  with_state(session, |state| {
    state.camera = Some(Published {
      publication,
      track,
      source,
      capture: Some(capture),
      slot: None,
      device_id: args.device_id,
      audio: None,
    });
  });
  rebind_tiles(session, &room);
  Ok(())
}

// -- the screen ----------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenArgs {
  pub enabled: bool,
  pub max_height: u32,
  pub max_fps: u32,
  /// `screen:<id>` or `window:<id>` from `voice_screen_sources`; `None` on
  /// macOS, where the OS's own sheet does the choosing.
  #[serde(default)]
  pub source: Option<String>,
  /// Publish the shared thing's sound beside its picture.
  #[serde(default)]
  pub audio: bool,
  /// `exclude-self` or `include-target`, decided by `transport-rules.ts`'s
  /// `screenAudioMode` and never inferred here. Absent is treated as the
  /// safer of the two: an exclusion can never carry the call back to the
  /// far end, and an unrecognised include has no target anyway.
  #[serde(default)]
  pub audio_mode: Option<String>,
}

// **A capture with no consent interface is the thing to keep impossible
// here.** libwebrtc's `DesktopCapturer` is implemented on Windows as well as
// macOS, so until 2026-09-09 this command's danger was that a Windows caller
// would start it with no source and no picker and capture a display nobody
// had chosen. That is now structural rather than guarded: off macOS the
// command **requires** `args.source`, and the only thing that produces one is
// `voice_screen_sources` feeding a list a person picked from.
#[tauri::command]
pub async fn voice_set_screen(app: AppHandle, args: ScreenArgs) -> VoiceResult<()> {
  let picked = match args.source.as_deref() {
    Some(id) => Some(parse_screen_id(id)?),
    None => {
      // macOS opens the system picker with no source; nowhere else has one
      // to open, and starting a capturer without a pick is what would take
      // a display unasked.
      #[cfg(not(target_os = "macos"))]
      if args.enabled {
        return Err(VoiceError::new(
          "bad_source",
          "a screen or window must be chosen on this platform",
        ));
      }
      None
    }
  };

  let (session, room, shared) = current()?;
  let existing = with_state(session, |state| state.screen.take());
  if let Some(published) = existing {
    // Audio first on the way out, so the last thing a viewer loses is the
    // sound of a picture that has already stopped rather than the reverse.
    if let Some(audio) = published.audio {
      if let Err(error) =
        room.local_participant().unpublish_track(&audio.publication.sid()).await
      {
        log::warn!("voice: unpublish screen audio: {error}");
      }
      let capture = audio.capture;
      tauri::async_runtime::spawn_blocking(move || capture.stop()).await.ok();
      log::info!("voice: screen audio unpublished");
    }
    if let Err(error) = room.local_participant().unpublish_track(&published.publication.sid()).await {
      log::warn!("voice: unpublish screen: {error}");
    }
    if let Some(capture) = published.capture {
      tauri::async_runtime::spawn_blocking(move || capture.stop()).await.ok();
    }
    log::info!("voice: screen unpublished");
    rebind_tiles(session, &room);
  }
  if !args.enabled {
    return Ok(());
  }

  // The picker first: nothing about the screen's size is known until the
  // person has chosen one, and that can take as long as they like.
  let slot: SourceSlot = SourceSlot::default();
  let (first_tx, first_rx) = std::sync::mpsc::channel::<(u32, u32)>();
  let max_height = args.max_height;
  let (screen, captured) = {
    let slot = slot.clone();
    tauri::async_runtime::spawn_blocking(move || {
      let screen = capture::Screen::start(args.max_fps.max(1), max_height, picked, slot, first_tx)?;
      // Our own picker has already been dismissed by the time this is
      // called, so on Windows the wait is only ever the capturer's first
      // frame; on macOS it is the person in front of the OS sheet.
      match first_rx.recv_timeout(std::time::Duration::from_secs(120)) {
        Ok(size) => Ok((screen, size)),
        Err(_) => {
          screen.stop();
          Err(VoiceError::new("screen_cancelled", "no screen was chosen"))
        }
      }
    })
    .await
    .map_err(|e| VoiceError::new("screen_failed", e.to_string()))??
  };

  // Fit the grant: a display or window taller than the ceiling is scaled by
  // the capture thread before it reaches the encoder, so the encoder never
  // sees pixels the policy did not allow. The same function runs on every
  // frame there (capture.rs's `fit_height`), which is what keeps a window
  // that is resized mid-share inside the ceiling too.
  let (width, height) = capture::fit_height(captured.0, captured.1, max_height);
  let source = NativeVideoSource::new(VideoResolution { width, height }, true);
  *slot.lock().unwrap() = Some(source.clone());
  let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
  let options = TrackPublishOptions {
    source: TrackSource::Screenshare,
    video_codec: VideoCodec::H264,
    // One layer: a screen is asked for at `high` by every viewer that can
    // read it, and simulcast would only add an encode nobody subscribes to.
    simulcast: false,
    video_encoding: Some(VideoEncoding {
      max_bitrate: screen_bitrate(height),
      max_framerate: args.max_fps.max(1) as f64,
    }),
    ..Default::default()
  };
  let publication = match room
    .local_participant()
    .publish_track(LocalTrack::Video(track.clone()), options)
    .await
  {
    Ok(publication) => publication,
    Err(error) => {
      tauri::async_runtime::spawn_blocking(move || screen.stop()).await.ok();
      return Err(VoiceError::new("screen_failed", format!("publish: {error}")));
    }
  };
  // The share's sound, if it was asked for. A failure here costs the audio
  // and never the picture: somebody who pressed Share is sharing, and a
  // platform that cannot capture sound (or a window that closed between the
  // pick and the publish) is a line in the log rather than a share that
  // did not happen.
  let audio = if args.audio {
    match publish_screen_audio(&room, &args, picked).await {
      Ok(audio) => Some(audio),
      Err(error) => {
        log::warn!("voice: screen audio not published: {}", error.message);
        None
      }
    }
  } else {
    None
  };

  // **After both publishes, never between them.** A sender's cryptor exists
  // only once `publish_track` has returned, so walking the ring before the
  // audio track is published leaves that sender with no key and the peer
  // hears silence with `MissingKey` in their log -- the same shape as the
  // microphone's first publish.
  let index = *shared.key_index.lock().unwrap();
  let cryptors = apply_key_index(&room, index);
  log::info!(
    "voice: screen published as {} at {width}x{height} (captured {}x{}){}, {cryptors} cryptor(s) on index {index}",
    publication.sid(),
    captured.0,
    captured.1,
    match &audio {
      Some(audio) => format!(" with audio as {}", audio.publication.sid()),
      None => String::new(),
    }
  );
  with_state(session, |state| {
    state.screen = Some(Published {
      publication,
      track,
      source,
      capture: Some(Source::Screen(screen)),
      slot: Some(slot),
      device_id: None,
      audio,
    });
  });
  let _ = &app;
  rebind_tiles(session, &room);
  Ok(())
}

/// The share's own sound as a second publication.
///
/// The three publish numbers are `transport-rules.ts`'s `screenAudioPublish`
/// mirrored by hand, the way `rules.ts` mirrors the SDK's audio presets: no
/// DTX, because silence suppression audibly clips a soundtrack's quiet
/// passages and the tails of notes; no RED, because redundancy is for a
/// voice on a lossy link and pure overhead here; and 128 kbps stereo, which
/// is four times a speech bitrate because music needs it. They are
/// **copied**, not derived — this file must not become a second place the
/// webview's numbers live — and they have to be changed together.
async fn publish_screen_audio(
  room: &Room,
  args: &ScreenArgs,
  picked: Option<capture::PickedSource>,
) -> VoiceResult<PublishedAudio> {
  let mode = args
    .audio_mode
    .as_deref()
    .and_then(screen_audio::Mode::parse)
    .unwrap_or(screen_audio::Mode::ExcludeSelf);
  // Only a window has a process tree to follow; a display share is the
  // exclusion, and the id is not a window handle.
  let window = picked
    .filter(|p| p.kind == capture::ScreenKind::Window)
    .map(|p| p.id);

  // Requirement 2 is met by construction: a pushed source never passes
  // through the ADM's processing path, so there is no canceller,
  // suppressor or gain control between the shared sound and the encoder.
  let source = NativeAudioSource::new(
    AudioSourceOptions {
      echo_cancellation: false,
      noise_suppression: false,
      auto_gain_control: false,
    },
    48_000,
    2,
    0,
  );
  let capture = ScreenAudio::start(mode, window, source.clone())?;
  let track =
    LocalAudioTrack::create_audio_track("screen-audio", RtcAudioSource::Native(source));
  let options = TrackPublishOptions {
    source: TrackSource::ScreenshareAudio,
    dtx: false,
    red: false,
    audio_encoding: Some(AudioEncoding { max_bitrate: 128_000 }),
    ..Default::default()
  };
  match room.local_participant().publish_track(LocalTrack::Audio(track), options).await {
    Ok(publication) => Ok(PublishedAudio { publication, capture }),
    Err(error) => {
      tauri::async_runtime::spawn_blocking(move || capture.stop()).await.ok();
      Err(VoiceError::new("screen_audio_failed", format!("publish: {error}")))
    }
  }
}

// -- subscriptions -------------------------------------------------------------

fn find_participant(room: &Room, identity: &str) -> Option<RemoteParticipant> {
  room
    .remote_participants()
    .into_iter()
    .find(|(id, _)| id.as_str() == identity)
    .map(|(_, participant)| participant)
}

fn video_publication(participant: &RemoteParticipant, source: TrackSource) -> Option<RemoteTrackPublication> {
  participant
    .track_publications()
    .into_values()
    .find(|publication| publication.kind() == TrackKind::Video && publication.source() == source)
}

/// `quality` is the session's word: `off`, `low` or `high` (rules.ts's
/// `subscriptionFor`), already decided.
///
/// `async` although nothing here awaits: a sync command runs on the main
/// thread, and `set_subscribed` spawns the signalling request with
/// `tokio::spawn`, which panics outside a runtime -- the whole shell went
/// down the first time a tile asked for a layer (2026-09-08). An async
/// command runs on Tauri's Tokio runtime, where the spawn is legal.
#[tauri::command]
pub async fn voice_set_video_subscription(identity: String, source: String, quality: String) -> VoiceResult<()> {
  let (_, room, _) = current()?;
  let source = source_of(&source)?;
  let Some(participant) = find_participant(&room, &identity) else { return Ok(()) };
  let Some(publication) = video_publication(&participant, source) else { return Ok(()) };
  let subscribed = quality != "off";
  publication.set_subscribed(subscribed);
  if subscribed {
    publication.set_video_quality(if quality == "high" { VideoQuality::High } else { VideoQuality::Low });
  }
  log::debug!("voice: {identity}/{} subscription -> {quality}", word_of(source));
  Ok(())
}

// -- tiles ---------------------------------------------------------------------

/// The webview asks for a tile before it knows whether the track exists;
/// the answer is an id it reports rects against and detaches with.
#[tauri::command]
pub fn voice_attach_video(
  app: AppHandle,
  identity: String,
  source: String,
  surface: String,
) -> VoiceResult<u64> {
  let (session, room, _) = current()?;
  let source = source_of(&source)?;
  let tile = Tile::create(&app)?;
  let covered = with_state(session, |state| state.covered.contains(&surface));
  tile.set_covered(covered);
  let id = with_state(session, |state| {
    state.next_tile += 1;
    let id = state.next_tile;
    state.tiles.insert(
      id,
      TileEntry { identity: identity.clone(), source, surface, tile, placement_logged: None },
    );
    id
  });
  rebind_tiles(session, &room);
  log::debug!("voice: tile {id} for {identity}/{}", word_of(source));
  Ok(id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectArgs {
  pub tile: u64,
  pub clip: PageRect,
  pub frame: PageRect,
  pub visible: bool,
}

#[tauri::command]
pub fn voice_set_video_rect(args: RectArgs) -> VoiceResult<()> {
  let session = super::session_id().ok_or_else(|| VoiceError::new("not_connected", "no call"))?;
  with_state(session, |state| {
    if let Some(entry) = state.tiles.get_mut(&args.tile) {
      // Where the view went, so an unattended run can read it without a
      // screenshot. The first three placements, and then **at most one
      // line every five seconds** for as long as the tile keeps moving.
      //
      // It was the first three and nothing after, which made a tile
      // geometrically invisible in the log the moment it had settled: a
      // window resize, a sidebar collapse, a chrome relayout, or entering
      // the featured slot all reported nothing, and the failure mode was
      // silence rather than a wrong number — the kind that reads as
      // "nothing happened". The cap existed to stop a drag-resize flooding
      // the log, and a time limit does that job without giving up the
      // capability. Note the page only calls this when the rect or the
      // visibility actually *changed* (transport-native.ts dedupes against
      // its last report), so a still tile writes nothing at all.
      let n = entry.tile.placements.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
      let due = entry
        .placement_logged
        .is_none_or(|at| at.elapsed() >= std::time::Duration::from_secs(5));
      if n < 3 || due {
        entry.placement_logged = Some(std::time::Instant::now());
        log::info!(
          "voice: tile {} at ({:.0},{:.0}) {:.0}x{:.0} clipped to ({:.0},{:.0}) {:.0}x{:.0}, visible={}",
          args.tile, args.frame.x, args.frame.y, args.frame.width, args.frame.height,
          args.clip.x, args.clip.y, args.clip.width, args.clip.height, args.visible
        );
      }
      entry.tile.set_rect(args.clip, args.frame, args.visible);
    }
  });
  Ok(())
}

/// `surface` is the page's name for a layer that hosts tiles (`page`,
/// `bar`); covered means something is drawn over it, and every tile on it
/// hides until it is not. Remembered, so a tile created while covered
/// starts hidden.
#[tauri::command]
pub fn voice_set_video_covered(surface: String, covered: bool) -> VoiceResult<()> {
  let session = super::session_id().ok_or_else(|| VoiceError::new("not_connected", "no call"))?;
  with_state(session, |state| {
    if covered {
      state.covered.insert(surface.clone());
    } else {
      state.covered.remove(&surface);
    }
    let mut affected = 0;
    for entry in state.tiles.values() {
      if entry.surface == surface {
        entry.tile.set_covered(covered);
        affected += 1;
      }
    }
    log::info!("voice: surface {surface} {} ({affected} tile(s))", if covered { "covered" } else { "uncovered" });
  });
  Ok(())
}

#[tauri::command]
pub fn voice_detach_video(tile: u64) -> VoiceResult<()> {
  if let Some(session) = super::session_id() {
    let entry = with_state(session, |state| state.tiles.remove(&tile));
    if let Some(entry) = entry {
      entry.tile.destroy();
    }
  }
  Ok(())
}

/// The track a tile should draw, if it exists right now.
fn track_for(state: &VideoState, room: &Room, identity: &str, source: TrackSource) -> Option<RtcVideoTrack> {
  if identity == "self" {
    let published = match source {
      TrackSource::Screenshare => state.screen.as_ref(),
      _ => state.camera.as_ref(),
    }?;
    return Some(published.track.rtc_track());
  }
  let participant = find_participant(room, identity)?;
  let publication = video_publication(&participant, source)?;
  match publication.track()? {
    RemoteTrack::Video(track) => Some(track.rtc_track()),
    _ => None,
  }
}

/// Binds every tile whose track has appeared. Called on attach, on every
/// video-shaped room event, and after a local publish. A tile whose stream
/// ended unbound itself and is simply bound again here when the track is
/// back.
fn rebind_tiles(session: u64, room: &Room) {
  with_state(session, |state| {
    let mut to_bind = Vec::new();
    for (id, entry) in &state.tiles {
      if entry.tile.is_bound() {
        continue;
      }
      if let Some(track) = track_for(state, room, &entry.identity, entry.source) {
        to_bind.push((*id, track));
      }
    }
    for (id, track) in to_bind {
      if let Some(entry) = state.tiles.get(&id) {
        entry.tile.bind(track);
        log::info!("voice: tile {id} bound to {}/{}", entry.identity, word_of(entry.source));
      }
    }
  });
}

// -- what the pump and the roster ask ------------------------------------------

/// A video-shaped room event: rebind what can be bound, and tell the page.
pub fn on_video_event(app: &AppHandle, session: u64, room: &Room) {
  rebind_tiles(session, room);
  emit(app, session, Event::VideoChanged);
}

/// The roster's `cameraMuted`, read the way the webview reads it.
pub fn camera_muted(participant: &RemoteParticipant) -> bool {
  video_publication(participant, TrackSource::Camera).map(|p| p.is_muted()).unwrap_or(false)
}

/// The stats readout's video rows, in `TransportVideoStats`'s shape.
pub async fn stats_rows(room: &Room) -> Vec<Value> {
  let mut rows = Vec::new();
  let session = super::session_id().unwrap_or(0);
  let local: Vec<(TrackSource, LocalVideoTrack)> = with_state(session, |state| {
    let mut out = Vec::new();
    if let Some(c) = state.camera.as_ref() {
      out.push((TrackSource::Camera, c.track.clone()));
    }
    if let Some(s) = state.screen.as_ref() {
      out.push((TrackSource::Screenshare, s.track.clone()));
    }
    out
  });
  for (source, track) in local {
    if let Ok(stats) = track.get_stats().await {
      let codecs = codec_names(&stats);
      for entry in &stats {
        if let RtcStats::OutboundRtp(s) = entry {
          if s.stream.kind != "video" {
            continue;
          }
          rows.push(json!({
            "identity": "self",
            "source": word_of(source),
            "direction": "sent",
            "width": nullable(s.outbound.frame_width),
            "height": nullable(s.outbound.frame_height),
            "fps": s.outbound.frames_per_second,
            "codec": codecs.get(&s.stream.codec_id),
            "layer": if s.outbound.rid.is_empty() { Value::Null } else { json!(s.outbound.rid) },
            "implementation": if s.outbound.encoder_implementation.is_empty() { Value::Null } else { json!(s.outbound.encoder_implementation) },
            "limitedBy": format!("{:?}", s.outbound.quality_limitation_reason).to_lowercase(),
          }));
        }
      }
    }
  }
  for (identity, participant) in room.remote_participants() {
    for source in [TrackSource::Camera, TrackSource::Screenshare] {
      let Some(publication) = video_publication(&participant, source) else { continue };
      let Some(RemoteTrack::Video(track)) = publication.track() else { continue };
      let Ok(stats) = track.get_stats().await else { continue };
      let codecs = codec_names(&stats);
      for entry in &stats {
        if let RtcStats::InboundRtp(s) = entry {
          if s.stream.kind != "video" {
            continue;
          }
          rows.push(json!({
            "identity": identity.to_string(),
            "source": word_of(source),
            "direction": "received",
            "width": nullable(s.inbound.frame_width),
            "height": nullable(s.inbound.frame_height),
            "fps": s.inbound.frames_per_second,
            "codec": codecs.get(&s.stream.codec_id),
            "layer": Value::Null,
            "implementation": if s.inbound.decoder_implementation.is_empty() { Value::Null } else { json!(s.inbound.decoder_implementation) },
            "limitedBy": Value::Null,
          }));
        }
      }
    }
  }
  rows
}

/// The shell's own counters beside the RTC rows, for the log and D-30:
/// frames captured per local source, and the tiles' bound/drawn/dropped.
pub fn native_summary() -> Value {
  let guard = VIDEO.lock().unwrap();
  let Some(state) = guard.as_ref() else {
    return json!({ "cameraFrames": null, "screenFrames": null, "screenAudioFrames": null, "tiles": 0, "bound": 0, "drawn": 0, "dropped": 0, "skipped": 0 });
  };
  let frames = |p: &Option<Published>| p.as_ref().and_then(|p| p.capture.as_ref()).map(|c| c.frames());
  let bound = state.tiles.values().filter(|e| e.tile.is_bound()).count();
  let drawn: u64 =
    state.tiles.values().map(|e| e.tile.frames.load(std::sync::atomic::Ordering::Relaxed)).sum();
  let dropped: u64 =
    state.tiles.values().map(|e| e.tile.dropped.load(std::sync::atomic::Ordering::Relaxed)).sum();
  let skipped: u64 =
    state.tiles.values().map(|e| e.tile.skipped.load(std::sync::atomic::Ordering::Relaxed)).sum();
  json!({
    "cameraFrames": frames(&state.camera),
    "screenFrames": frames(&state.screen),
    // 10 ms frames pushed into the share's audio source. Null where no
    // audio was published, and **zero is the reading that matters**: the
    // capture activated and initialised but nothing is flowing, which is
    // exactly what a machine with no active render endpoint does (D-27b).
    "screenAudioFrames": state.screen.as_ref().and_then(|s| s.audio.as_ref()).map(|a| a.capture.frames()),
    "tiles": state.tiles.len(),
    "bound": bound,
    "drawn": drawn,
    "dropped": dropped,
    "skipped": skipped,
  })
}

fn nullable(value: u32) -> Value {
  if value == 0 {
    Value::Null
  } else {
    json!(value)
  }
}

fn codec_names(stats: &[RtcStats]) -> HashMap<String, String> {
  stats
    .iter()
    .filter_map(|entry| match entry {
      RtcStats::Codec(c) => Some((
        c.rtc.id.clone(),
        c.codec.mime_type.trim_start_matches("video/").to_string(),
      )),
      _ => None,
    })
    .collect()
}

/// On disconnect: devices closed, tiles gone. The room's close unpublishes
/// the tracks.
pub async fn teardown() {
  let state = VIDEO.lock().unwrap().take();
  let Some(state) = state else { return };
  for entry in state.tiles.into_values() {
    entry.tile.destroy();
  }
  let mut captures = Vec::new();
  if let Some(camera) = state.camera {
    if let Some(capture) = camera.capture {
      captures.push(capture);
    }
    drop(camera.publication);
    drop(camera.source);
    drop(camera.slot);
  }
  if let Some(screen) = state.screen {
    if let Some(capture) = screen.capture {
      captures.push(capture);
    }
  }
  if !captures.is_empty() {
    let _ = tauri::async_runtime::spawn_blocking(move || {
      for capture in captures {
        capture.stop();
      }
    })
    .await;
  }
}
