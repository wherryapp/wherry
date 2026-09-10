// The render module where there is no native view path yet -- **Linux
// only, since 2026-09-10**: the same surface as `render.rs`, every
// constructor answering "unsupported", so `video.rs` compiles once and the
// probe tells the page the truth (`videoRender: false`) rather than a
// command failing later.
//
// macOS is `render.rs` (an `AVSampleBufferDisplayLayer` per tile, stage
// 3N) and Windows is `render_win.rs` (a child `HWND` over WebView2 with a
// GDI presenter, stage W3). Linux would need a third: the window under GTK
// is not the same shape as either, and nobody has asked for it.

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use livekit::webrtc::video_track::RtcVideoTrack;
use tauri::AppHandle;

use super::VoiceError;

#[derive(serde::Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct PageRect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

pub struct Tile {
  pub frames: Arc<AtomicU64>,
  pub dropped: Arc<AtomicU64>,
  pub skipped: Arc<AtomicU64>,
  /// Rect reports received, for the log's first few.
  pub placements: Arc<AtomicU64>,
}

impl Tile {
  pub fn create(_app: &AppHandle) -> Result<Tile, VoiceError> {
    Err(VoiceError::new("unsupported", "native video tiles are macOS only for now"))
  }
  pub fn is_bound(&self) -> bool {
    false
  }
  pub fn bind(&self, _track: RtcVideoTrack) {}
  pub fn unbind(&self) {}
  pub fn set_rect(&self, _clip: PageRect, _frame: PageRect, _visible: bool) {}
  pub fn set_covered(&self, _covered: bool) {}
  pub fn destroy(self) {}
}

pub fn remember_app(_app: &AppHandle) {}
