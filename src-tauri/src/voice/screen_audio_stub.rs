// The shape of screen-share audio on the platforms that do not have it yet
// (docs/prompts/screen-audio-handoff.md §6). The Windows implementation is
// `screen_audio.rs`; this compiles in its place elsewhere so `video.rs`
// needs no `cfg` around the publish path.
//
// macOS is a real piece of work rather than a missing one, and the handoff
// names it stage M: `SCStreamConfiguration.capturesAudio` with a filter
// that excludes our own bundle, which is requirement 3 applied by the OS.
// It is not written here because today's macOS screen capture is
// libwebrtc's `desktop_capturer` behind the system picker, which owns its
// own `SCStream` and exposes no audio — so the audio needs either a second
// capture session beside it or our own `SCStream` doing both, and which of
// those is right is a spike that needs a hand at the keyboard.

use livekit::webrtc::audio_source::native::NativeAudioSource;

use super::VoiceError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
  ExcludeSelf,
  IncludeTarget,
}

impl Mode {
  pub fn parse(word: &str) -> Option<Mode> {
    match word {
      "exclude-self" => Some(Mode::ExcludeSelf),
      "include-target" => Some(Mode::IncludeTarget),
      _ => None,
    }
  }
}

pub struct ScreenAudio;

impl ScreenAudio {
  pub fn start(
    _mode: Mode,
    _window: Option<u64>,
    _source: NativeAudioSource,
  ) -> Result<ScreenAudio, VoiceError> {
    Err(VoiceError::new(
      "screen_audio_unsupported",
      "this platform cannot share a screen's sound yet",
    ))
  }

  pub fn frames(&self) -> u64 {
    0
  }

  pub fn stop(self) {}
}
