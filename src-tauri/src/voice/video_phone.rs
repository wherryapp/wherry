// What a phone build's `voice` module says where the desktop's `video.rs`
// speaks (phone-calls-plan.md §8.2, stage N1).
//
// The phones carry the native engine for audio alone. Camera capture, screen
// capture and the native tile over the page all stay desktop-only, and
// `voice_probe` answers `video`, `screenCapture` and `videoRender` false, so
// the page never opens a camera or attaches a tile here: a camera press takes
// the per-call switch to the webview engine (`rules.ts`'s
// `videoNeedsSwitch`), which still works in the foreground. This file is
// `mod.rs`'s whole use of `video`, with the answers an audio-only engine
// gives: nothing is published, nothing is drawn, no tile exists.
//
// One thing is not a stub. A peer's camera or share is still *published* to
// the room, and `RoomOptions::auto_subscribe` would have the phone subscribe,
// receive and decode it for a tile that cannot be drawn: downlink and heat
// for nothing, on the very calls this engine exists to make cheap. So a
// video publication the phone holds is unsubscribed (`on_video_event`),
// which the SFU honours by not sending it. The roster still reports that the
// peer has a camera (`has_video_source` reads publications, not tracks), so
// the page knows there is video it cannot show.

use livekit::prelude::*;
use serde_json::{json, Value};
use tauri::AppHandle;

/// Every video publication a remote holds is unsubscribed. Idempotent, and
/// terminates: dropping a subscription raises `TrackUnsubscribed`, which comes
/// back here and finds nothing subscribed to drop.
///
/// Called from the event pump, which runs on Tauri's Tokio runtime; that is
/// where `set_subscribed` may spawn its signalling request (desktop's
/// `voice_set_video_subscription` is `async` for the same reason).
pub fn on_video_event(_app: &AppHandle, session: u64, room: &Room) {
  for participant in room.remote_participants().into_values() {
    for publication in participant.track_publications().into_values() {
      if publication.kind() == TrackKind::Video && publication.is_subscribed() {
        publication.set_subscribed(false);
        log::info!(
          "voice: session {session}: {}'s {:?} video unsubscribed -- this engine draws none on a phone",
          participant.identity(),
          publication.source()
        );
      }
    }
  }
}

/// No tile exists to unbind.
pub fn on_unsubscribed(_session: u64, _identity: &str, _source: TrackSource) {}

/// Nothing is published: no camera, no screen.
pub fn local_video(_session: u64) -> (bool, bool) {
  (false, false)
}

/// Nothing local to stop.
pub fn on_camera_muted_remotely(_session: u64) {}

/// A phone has no camera of its own here to tell a muted one from an absent
/// one for; a remote's camera counts as sending, as the roster's `has_camera`
/// already says.
pub fn camera_muted(_participant: &RemoteParticipant) -> bool {
  false
}

/// No tile of the old page's to destroy.
pub fn forget_page(_session: u64) -> usize {
  0
}

/// Nothing to close before the room does.
pub async fn teardown() {}

/// No video rows, because none is published or drawn.
pub async fn stats_rows(_room: &Room) -> Vec<Value> {
  Vec::new()
}

/// The same keys the desktop reports, all zero, so the page's readout does
/// not need to know which shell it is reading.
pub fn native_summary() -> Value {
  json!({
    "cameraFrames": null,
    "screenFrames": null,
    "screenAudioFrames": null,
    "tiles": 0,
    "bound": 0,
    "drawn": 0,
    "dropped": 0,
    "skipped": 0
  })
}
