// Where playout goes when nobody chose, or the choice went away (rows D-72,
// D-73; docs/regression/desktop.md).
//
// What was wrong, read on the rig 2026-09-26: a call left on the platform
// default kept playing on the device it opened. Changing the Windows default
// mid-call left the shell's render session on the old device, and unplugging
// the device it played on left it playing nowhere -- for the rest of the call,
// with nothing in the log but `devices changed`. A call begun with no output
// at all never played when one came back.
//
// Why: libwebrtc's Windows module (`AudioDeviceWindowsCore`) resolves "the
// default" -- a role, not a device -- only when playout is *initialised*, and
// it initialises playout once per call, when the first remote audio arrives,
// or never if that fails for want of an endpoint. It registers for no device
// notifications of its own. So following the default is a stop, a
// re-selection and a start at the moments the default moves, which is the
// sequence `PlatformAudio::switch_playout_device` already is (the one the
// person's own mid-call choice takes, which restored playout on the rig after
// an unplug). No fork change is needed.
//
// The split, as everywhere in this module: the page decides *whether* to
// follow (transport-rules.ts's `playoutAfterDeviceChange`: nothing chosen, or
// the chosen device gone), from the `voice-devices` event, which now also
// fires when only the Windows default changed and carries `defaultOutput`.
// This file is the mechanism: what the default is, and moving playout there.
//
// **Windows only.** The macOS module is left exactly as it was: `defaultOutput`
// is absent from the event there, which the page reads as "this shell does not
// steer playout", and `voice_connect`'s platform-default arm still touches
// nothing. Whether a macOS call follows the system default output is a
// separate question this change does not read or answer.
//
// **What following costs.** The shell selects the default *by id* rather than
// by role, because the SDK exposes no way to hand the module a role again
// (`set_playout_device_by_guid` is an index underneath). An index goes stale
// when the list changes, so the shell re-selects on every change it is asked
// about, and at every connect -- a call on the platform default now starts on
// the Windows default resolved there and then, where it used to inherit the
// last call's device. A device chosen by index opens no communications-role
// stream, so this does not bring back S-16's ducking (the console-role patch's
// probe table: "both, a device chosen by index (no role)" did not duck).

use std::sync::Mutex;

use livekit::prelude::*;
use livekit::rtc_engine::lk_runtime::LkRuntime;
use livekit::webrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
use serde::Serialize;

use super::{
  ensure_microphone_recording, list_devices, platform_audio, session_id, VoiceError, VoiceResult,
};

/// The render endpoint the shell last selected, with its index in the
/// module's list at the time. `None` before any selection, or after one that
/// found no endpoint. Set by every selection this shell makes -- the
/// person's choice at connect or mid-call as well as a follow -- so a follow
/// is never skipped on the strength of an older choice.
static APPLIED: Mutex<Option<(String, usize)>> = Mutex::new(None);

/// The Windows console default render endpoint's id, in the module's own id
/// space (`{0.0.0.00000000}.{guid}`: the module's device ids are
/// `IMMDevice::GetId`).
///
/// - `None`: this platform's shell does not steer playout (not Windows).
/// - `Some(None)`: Windows has no active render endpoint (D-27b's state), or
///   the question could not be answered.
/// - `Some(Some(id))`: the default.
///
/// The console role, because it is the one the fork maps every "default" to
/// (`patches/rust-sdks-windows-console-role.md`) and the one the webview
/// engine opens.
pub(crate) fn default_output() -> Option<Option<String>> {
  #[cfg(target_os = "windows")]
  {
    Some(win::default_render_id())
  }
  #[cfg(not(target_os = "windows"))]
  {
    None
  }
}

#[cfg(target_os = "windows")]
mod win {
  use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
  use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
  };

  /// `GetDefaultAudioEndpoint`'s answer when there is no active endpoint for
  /// the flow: `HRESULT_FROM_WIN32(ERROR_NOT_FOUND)`, D-27b's `0x80070490`.
  const NOT_FOUND: u32 = 0x8007_0490;

  /// On a thread of its own, so the apartment is ours to choose and to
  /// close: the callers are a Tauri command (possibly the main thread, which
  /// WebView2 has made single-threaded) and the device poller's runtime
  /// thread, neither of which this file should initialise COM on. One short
  /// thread per question, at most every poll tick.
  pub(super) fn default_render_id() -> Option<String> {
    std::thread::Builder::new()
      .name("wherry-default-output".into())
      .spawn(|| {
        // SAFETY: paired with the `CoUninitialize` below on this thread, and
        // every COM object is dropped inside `query` before it.
        unsafe {
          if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            return None;
          }
          let id = query();
          CoUninitialize();
          id
        }
      })
      .ok()?
      .join()
      .ok()
      .flatten()
  }

  /// Only on a thread where COM is initialised (`default_render_id`'s).
  fn query() -> Option<String> {
    let enumerator: IMMDeviceEnumerator =
      unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.ok()?;
    let device = match unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) } {
      Ok(device) => device,
      Err(error) => {
        if error.code().0 as u32 != NOT_FOUND {
          log::debug!(
            "voice: GetDefaultAudioEndpoint(eRender, eConsole): 0x{:08X} {}",
            error.code().0,
            error.message()
          );
        }
        return None;
      }
    };
    // SAFETY: a successful `GetId` hands back a CoTaskMem string we own.
    unsafe {
      let id = device.GetId().ok()?;
      let text = id.to_string().ok();
      CoTaskMemFree(Some(id.0 as *const _));
      text
    }
  }
}

/// The index of `id` in the module's playout list now, compared without
/// case (the module and Core Audio both hand back lower case; nothing
/// promises it).
fn playout_index(audio: &PlatformAudio, id: &str) -> Option<(String, usize)> {
  audio
    .playout_devices()
    .find(|device| device.id.as_str().eq_ignore_ascii_case(id))
    .map(|device| (device.id.as_str().to_string(), device.index))
}

/// Select `id` for playout with the stop/select/init/start sequence, and
/// remember it. Every playout selection in this module goes through here.
///
/// The module's own spelling of the id is what is handed on, and an id not
/// in its list is refused here: the C++ under `switch_playout_device`
/// answers an id it cannot match by selecting device *index 0* and reporting
/// success (the comment above `voice_set_input_device`).
pub(crate) fn apply(audio: &PlatformAudio, id: &str) -> VoiceResult<()> {
  let Some((module_id, index)) = playout_index(audio, id) else {
    return Err(VoiceError::new(
      "device",
      format!("switch_playout_device: {id} is not an active playout device"),
    ));
  };
  audio
    .switch_playout_device(&PlayoutDeviceId::from_unchecked_guid(&module_id))
    .map_err(|e| VoiceError::new("device", format!("switch_playout_device: {e:?}")))?;
  *APPLIED.lock().unwrap() = Some((module_id, index));
  Ok(())
}

/// At connect, for a call left on the platform default: on Windows, the
/// default resolved now (see the header for why not the role); elsewhere
/// nothing, as before.
pub(crate) fn at_connect(audio: &PlatformAudio) -> VoiceResult<()> {
  match default_output() {
    None => {
      log::info!("voice: playout left at the platform default");
      Ok(())
    }
    Some(None) => {
      *APPLIED.lock().unwrap() = None;
      log::info!(
        "voice: playout left at the platform default -- Windows has no default output now; playout follows one when it appears"
      );
      Ok(())
    }
    Some(Some(id)) => {
      let name = name_of(audio, &id);
      log::info!("voice: playout follows the Windows default {id} ({name})");
      apply(audio, &id)
    }
  }
}

fn name_of(audio: &PlatformAudio, id: &str) -> String {
  audio
    .playout_devices()
    .find(|device| device.id.as_str().eq_ignore_ascii_case(id))
    .map(|device| device.name)
    .unwrap_or_else(|| "NOT IN THE LIST".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowResult {
  /// The default playout is on now; `None` when there is none to follow.
  device_id: Option<String>,
  /// Whether playout was moved (false: it was already there, or there was
  /// nowhere to go).
  moved: bool,
}

/// Move playout to the Windows default, if it is not already there. The page
/// calls this when it has decided to follow (nothing chosen, or the chosen
/// device gone), on every `voice-devices` event during a call.
///
/// Skipped when the default is the endpoint last selected *at the same
/// index* and playout is initialised: a list change that shifted the index
/// re-selects, because the module re-resolves the index at its next
/// `InitPlayout`. When a call is running and playout is not initialised --
/// the call began with no output (D-73's state) -- it is initialised and
/// started here, since libwebrtc tried once, when the first remote audio
/// arrived, and does not try again.
///
/// Then the microphone is checked (`ensure_microphone_recording`): if its
/// recording had failed to start for want of an endpoint, as D-73 read on
/// the build before the built-in canceller was kept off, this is when it can.
#[tauri::command]
pub fn voice_follow_default_output() -> VoiceResult<FollowResult> {
  let Some(default) = default_output() else {
    return Err(VoiceError::new(
      "unsupported",
      "this shell leaves playout to the platform's own default",
    ));
  };
  let audio = platform_audio()?;
  let Some(id) = default else {
    let was = APPLIED.lock().unwrap().take();
    if was.is_some() {
      log::warn!("voice: playout has no default output to follow -- the call plays to nothing until one appears");
    }
    return Ok(FollowResult { device_id: None, moved: false });
  };
  let now = playout_index(&audio, &id);
  let initialised = audio_playout_initialised();
  let same = {
    let applied = APPLIED.lock().unwrap();
    match (applied.as_ref(), now.as_ref()) {
      (Some((was_id, was_index)), Some((now_id, now_index))) => {
        was_id.eq_ignore_ascii_case(now_id) && was_index == now_index
      }
      _ => false,
    }
  };
  if same && initialised {
    log::info!("voice: playout already on the Windows default {id}, nothing to follow");
    return Ok(FollowResult { device_id: Some(id), moved: false });
  }
  let name = name_of(&audio, &id);
  log::info!(
    "voice: playout follows the Windows default to {id} ({name}) (playout initialised {initialised})"
  );
  if let Err(error) = apply(&audio, &id) {
    log::warn!("voice: playout could not follow the default: {}", error.message);
    return Err(error);
  }
  if session_id().is_some() && !audio_playout_initialised() {
    let runtime = LkRuntime::instance();
    let factory = runtime.pc_factory();
    let started = factory.init_playout() && factory.start_playout();
    log::info!(
      "voice: playout started on {id} after the call had none (init and start {})",
      if started { "succeeded" } else { "FAILED" }
    );
  }
  ensure_microphone_recording("after playout followed the default");
  Ok(FollowResult { device_id: Some(id), moved: true })
}

/// Whether the module's playout is initialised, through the same factory the
/// microphone gate uses (`PlatformAudio` does not expose it).
fn audio_playout_initialised() -> bool {
  LkRuntime::instance().pc_factory().playout_is_initialized()
}

/// The page's view of the list for `voice_devices` and the `voice-devices`
/// event: the module's list plus the default, where this shell steers
/// playout.
pub(crate) fn devices_with_default(audio: &PlatformAudio) -> super::AudioDevices {
  let mut devices = list_devices(audio);
  devices.default_output = default_output();
  devices
}
