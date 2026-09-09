// A screen share's own sound, captured on Windows (docs/prompts/
// screen-audio-handoff.md §4; stage W2).
//
// Mechanism only, like the rest of this directory: which loopback mode a
// share uses is decided in `transport-rules.ts` and arrives here already
// chosen. This turns that decision into a WASAPI process-loopback stream
// and pushes 10 ms frames into a `NativeAudioSource` the SDK encodes and
// the frame cryptor seals — the same seal, under the same key, as the
// voice beside it.
//
// **Why the shell and not the page.** Requirement 3 of `video-plan.md`
// §10.2 is that a share must not carry the call's own incoming audio back
// to the far end: a clean digital copy of somebody returning to them is
// worse than an acoustic echo, and no canceller is looking for it. A
// Chromium display capture on Windows takes the render endpoint's whole
// mix, our own playback included, and the constraint that would fix it is
// gated on Windows 11 (regression row S-01). The Win32 primitive
// underneath is not: `EXCLUDE_TARGET_PROCESS_TREE` naming ourselves leaves
// our output at the floor on Windows 10 build 19045 — measured 0.8 dB
// against a 110 dB self-test (row S-05).
//
// Three things the probe that measured it learned, all of which this file
// has to respect:
//
// - **`GetBufferSize` is junk on this stream.** There is no endpoint behind
//   the virtual device. Nothing here is sized from it; the packets say how
//   much arrived.
// - **`Initialize` succeeds with no render endpoint present**, and then
//   nothing flows. A machine with no output is a real state (row D-27b, on
//   this project's own box) and it must not wedge a share.
// - **COM pointers are `!Send`.** Everything is built and used on the one
//   capture thread.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use windows::Win32::Foundation::{CloseHandle, HWND, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
use windows_core::{implement, Interface, Ref, PCWSTR};

use super::VoiceError;

/// 48 kHz stereo signed 16-bit, stated to `Initialize` and matched by the
/// source. The mix format behind a process-loopback device is whatever
/// WASAPI resamples to it, and stating our own is what keeps the frame
/// arithmetic below fixed.
const RATE: u32 = 48_000;
const CHANNELS: u32 = 2;
/// What the SDK's fast path demands: exactly 10 ms per channel.
const FRAMES_PER_PACKET: usize = (RATE / 100) as usize;
/// `VT_BLOB`; the activation parameters travel as a blob PROPVARIANT and
/// the `windows` crate has no safe constructor for one.
const VT_BLOB: u16 = 65;

/// Which of the two loopback modes a share uses, decided in
/// `transport-rules.ts` and never inferred here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
  /// A whole screen: everything the machine plays **except our own process
  /// tree**, which is the call.
  ExcludeSelf,
  /// One window: that application's process tree and nothing else. The
  /// tree, not the process, because a browser renders its audio in a child
  /// (row S-05, run 3).
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

  fn loopback(self) -> PROCESS_LOOPBACK_MODE {
    match self {
      Mode::ExcludeSelf => PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
      Mode::IncludeTarget => PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    }
  }
}

/// The process whose tree the mode names.
///
/// `ExcludeSelf` is us — the shell, WebView2's helpers, everything the call
/// plays through, which is exactly the tree that must not be captured.
/// `IncludeTarget` is whoever owns the window that was picked; on Windows a
/// `CaptureSource` id for a window **is** its `HWND`.
fn target_pid(mode: Mode, window: Option<u64>) -> Result<u32, VoiceError> {
  match mode {
    Mode::ExcludeSelf => Ok(std::process::id()),
    Mode::IncludeTarget => {
      let handle = window.ok_or_else(|| {
        VoiceError::new("screen_audio_failed", "no window to take the audio of")
      })?;
      let mut pid = 0u32;
      let thread =
        unsafe { GetWindowThreadProcessId(HWND(handle as *mut std::ffi::c_void), Some(&mut pid)) };
      if thread == 0 || pid == 0 {
        return Err(VoiceError::new(
          "screen_audio_failed",
          "that window has no process any more",
        ));
      }
      Ok(pid)
    }
  }
}

#[repr(C)]
struct PropVariantBlob {
  vt: u16,
  w1: u16,
  w2: u16,
  w3: u16,
  cb_size: u32,
  _pad: u32,
  p_blob: *mut u8,
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Handler {
  tx: Sender<()>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for Handler_Impl {
  fn ActivateCompleted(
    &self,
    _op: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
  ) -> windows_core::Result<()> {
    let _ = self.tx.send(());
    Ok(())
  }
}

fn pcm_format() -> WAVEFORMATEX {
  WAVEFORMATEX {
    wFormatTag: 1, // WAVE_FORMAT_PCM
    nChannels: CHANNELS as u16,
    nSamplesPerSec: RATE,
    nAvgBytesPerSec: RATE * 4,
    nBlockAlign: 4,
    wBitsPerSample: 16,
    cbSize: 0,
  }
}

fn activate(mode: Mode, pid: u32) -> Result<IAudioClient, String> {
  let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
    ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
      ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
        TargetProcessId: pid,
        ProcessLoopbackMode: mode.loopback(),
      },
    },
  };
  let blob = PropVariantBlob {
    vt: VT_BLOB,
    w1: 0,
    w2: 0,
    w3: 0,
    cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
    _pad: 0,
    p_blob: &mut params as *mut _ as *mut u8,
  };
  let (tx, rx) = channel();
  let handler: IActivateAudioInterfaceCompletionHandler = Handler { tx }.into();
  let op = unsafe {
    ActivateAudioInterfaceAsync(
      PCWSTR(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK.as_ptr()),
      &IAudioClient::IID,
      Some(&blob as *const _ as *const _),
      &handler,
    )
  }
  .map_err(|e| format!("ActivateAudioInterfaceAsync: 0x{:08X} {}", e.code().0, e.message()))?;
  if rx.recv_timeout(Duration::from_secs(5)).is_err() {
    return Err("the activation handler never fired".into());
  }
  let mut hr = windows_core::HRESULT(0);
  let mut unknown: Option<windows_core::IUnknown> = None;
  unsafe { op.GetActivateResult(&mut hr, &mut unknown) }.map_err(|e| e.message())?;
  if hr.is_err() {
    return Err(format!("activation HRESULT 0x{:08X}", hr.0));
  }
  unknown
    .ok_or_else(|| "activation returned no object".to_string())?
    .cast::<IAudioClient>()
    .map_err(|e| e.message())
}

/// A running process-loopback capture, pushing into an audio source.
pub struct ScreenAudio {
  stop: Arc<AtomicBool>,
  frames: Arc<AtomicU64>,
  join: Option<JoinHandle<()>>,
}

impl ScreenAudio {
  pub fn start(
    mode: Mode,
    window: Option<u64>,
    source: NativeAudioSource,
  ) -> Result<ScreenAudio, VoiceError> {
    let pid = target_pid(mode, window)?;
    let stop = Arc::new(AtomicBool::new(false));
    let frames = Arc::new(AtomicU64::new(0));
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    let join = {
      let stop = stop.clone();
      let frames = frames.clone();
      std::thread::Builder::new()
        .name("wherry-screen-audio".into())
        .spawn(move || {
          let result = capture_loop(mode, pid, source, &stop, &frames, &ready_tx);
          if let Err(message) = result {
            let _ = ready_tx.send(Err(message));
          }
        })
        .expect("spawn screen audio thread")
    };
    match ready_rx.recv_timeout(Duration::from_secs(8)) {
      Ok(Ok(())) => {
        log::info!(
          "voice: screen audio capturing, {} pid {pid}",
          match mode {
            Mode::ExcludeSelf => "excluding our own tree,",
            Mode::IncludeTarget => "including the tree of",
          }
        );
        Ok(ScreenAudio { stop, frames, join: Some(join) })
      }
      Ok(Err(message)) => Err(VoiceError::new("screen_audio_failed", message)),
      Err(_) => Err(VoiceError::new(
        "screen_audio_failed",
        "the screen audio capture never reported ready",
      )),
    }
  }

  /// 10 ms frames pushed so far, for the log and the stats readout.
  pub fn frames(&self) -> u64 {
    self.frames.load(Ordering::Relaxed)
  }

  pub fn stop(mut self) {
    self.stop.store(true, Ordering::Relaxed);
    if let Some(join) = self.join.take() {
      let _ = join.join();
    }
  }
}

fn capture_loop(
  mode: Mode,
  pid: u32,
  source: NativeAudioSource,
  stop: &AtomicBool,
  frames: &AtomicU64,
  ready_tx: &Sender<Result<(), String>>,
) -> Result<(), String> {
  // MTA on this thread, and every COM object below built on it: they are
  // `!Send` and cannot be handed anywhere else.
  unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }.map_err(|e| e.message())?;
  let client = activate(mode, pid)?;
  let format = pcm_format();
  // Nothing is sized from `GetBufferSize` on this stream -- it reports junk,
  // there being no endpoint behind the virtual device. Two seconds is the
  // requested buffer duration, and the packets say what actually arrived.
  unsafe {
    client.Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
      2_000_000,
      0,
      &format,
      None,
    )
  }
  .map_err(|e| format!("screen audio Initialize: 0x{:08X} {}", e.code().0, e.message()))?;
  let event = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }
    .map_err(|e| e.message())?;
  unsafe { client.SetEventHandle(event) }.map_err(|e| e.message())?;
  let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(|e| e.message())?;
  unsafe { client.Start() }.map_err(|e| format!("screen audio Start: {}", e.message()))?;
  let _ = ready_tx.send(Ok(()));

  // The SDK's fast path takes exactly 10 ms and rejects anything else, and
  // WASAPI's packets are 10 ms *in practice* rather than by promise -- so
  // they are accumulated and whole frames pushed, which costs one copy and
  // cannot desynchronise.
  let mut pending: Vec<i16> = Vec::with_capacity(FRAMES_PER_PACKET * CHANNELS as usize * 2);
  let full = FRAMES_PER_PACKET * CHANNELS as usize;
  let mut logged_error = false;

  while !stop.load(Ordering::Relaxed) {
    // A 200 ms wait rather than an infinite one: with no active render
    // endpoint the event never fires at all, and the loop still has to
    // notice `stop`.
    let _ = unsafe { WaitForSingleObject(event, 200) } == WAIT_OBJECT_0;
    loop {
      let next = unsafe { capture.GetNextPacketSize() }.unwrap_or(0);
      if next == 0 {
        break;
      }
      let mut data: *mut u8 = std::ptr::null_mut();
      let mut count: u32 = 0;
      let mut flags: u32 = 0;
      if unsafe { capture.GetBuffer(&mut data, &mut count, &mut flags, None, None) }.is_err() {
        break;
      }
      let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
      let samples = (count as usize) * CHANNELS as usize;
      // A SILENT packet is zeros pushed like any other, so the encoder's
      // clock never starves while the shared thing happens to be quiet.
      if silent || data.is_null() {
        pending.resize(pending.len() + samples, 0);
      } else {
        pending.extend_from_slice(unsafe {
          std::slice::from_raw_parts(data as *const i16, samples)
        });
      }
      let _ = unsafe { capture.ReleaseBuffer(count) };

      let mut offset = 0;
      while pending.len() - offset >= full {
        let frame = AudioFrame {
          data: std::borrow::Cow::Borrowed(&pending[offset..offset + full]),
          sample_rate: RATE,
          num_channels: CHANNELS,
          samples_per_channel: FRAMES_PER_PACKET as u32,
        };
        // Synchronous underneath on the fast path (queue size 0), so this
        // blocks for as long as the copy takes and no longer.
        match futures_executor::block_on(source.capture_frame(&frame)) {
          Ok(()) => {
            frames.fetch_add(1, Ordering::Relaxed);
          }
          Err(error) => {
            if !logged_error {
              logged_error = true;
              log::warn!("voice: screen audio frame refused: {error}");
            }
          }
        }
        offset += full;
      }
      if offset > 0 {
        pending.drain(..offset);
      }
    }
  }

  let _ = unsafe { client.Stop() };
  let _ = unsafe { CloseHandle(event) };
  Ok(())
}
