// Video sources for the native transport: the camera, the screen, and a
// synthetic sweep for unattended runs (docs/prompts/video-next-stages-
// handoff.md §3.2 and §3.4).
//
// Every source here does one thing: put frames into a `NativeVideoSource`
// the SDK encodes. Nothing here publishes, subscribes or decides a size --
// `video.rs` does that, with the ceilings TypeScript already resolved.
//
// **The camera is AVFoundation directly, not `nokhwa`.** The handoff
// recommended nokhwa for the Windows coverage it brings, and it was read
// before being set aside: at the revision the SDK's own example pins
// (`4923eca`), its macOS backend labels every 4:2:0 biplanar pixel format
// as `YUYV`, asks AVFoundation for a *10-bit* format when NV12 is
// requested, and copies a planar buffer as if it were one contiguous run
// (`nokhwa-bindings-macos/src/lib.rs`, `raw_fcc_to_frameformat` and
// `set_frame_format`). A camera path that cannot be tested from a session
// -- the prompt needs a person -- must at least be one whose every step is
// read and understood, and eighty lines of `msg_send!` against a framework
// whose behaviour is documented is that; a backend whose format table is
// wrong on the platform in hand is not.
//
// **The Windows camera is Media Foundation directly, for the same reason**
// (stage W4, 2026-09-14; docs/prompts/w4-native-camera-windows.md §2):
// `windows` is already in the graph, and what nokhwa would have added is
// exactly the stride and format handling this file most needs to be able to
// read. It is a source reader on one thread with a synchronous `ReadSample`
// loop, copying each NV12 frame row by row at the pitch `Lock2D` reports.
// Until it existed that platform's camera button was the per-call engine
// switch.
//
// Both deliver NV12, and NV12 goes straight into the source, which is the
// format the handoff's §3.2 hoped for: on macOS the camera's own `420v`,
// which VideoToolbox encodes without a conversion; on Windows a native NV12
// mode where the device has one, and the source reader's conversion where it
// has not -- which the open logs, so a reading can say which it got.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use livekit::webrtc::desktop_capturer::{
  CaptureError, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions, DesktopFrame,
};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_frame::{I420Buffer, VideoBuffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;

use super::VoiceError;

/// A camera as the picker lists it.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VideoDevice {
  pub device_id: String,
  pub label: String,
}

/// Something that is putting frames into a source, and can be told to stop.
pub enum Source {
  #[cfg(target_os = "macos")]
  Camera(mac::Camera),
  #[cfg(target_os = "windows")]
  Camera(win::Camera),
  Sweep(Sweep),
  Screen(Screen),
}

impl Source {
  pub fn stop(self) {
    match self {
      #[cfg(any(target_os = "macos", target_os = "windows"))]
      Source::Camera(camera) => camera.close(),
      Source::Sweep(sweep) => sweep.stop(),
      Source::Screen(screen) => screen.stop(),
    }
  }

  /// Frames delivered so far, for the log and the stats readout.
  pub fn frames(&self) -> u64 {
    match self {
      #[cfg(any(target_os = "macos", target_os = "windows"))]
      Source::Camera(camera) => camera.frames(),
      Source::Sweep(sweep) => sweep.frames.load(Ordering::Relaxed),
      Source::Screen(screen) => screen.frames.load(Ordering::Relaxed),
    }
  }
}

/// Debug builds: `WHERRY_DEV_CAMERA=sweep` substitutes the sweep for the
/// real camera, so every unattended pass can publish without a device or a
/// prompt (D-29's note). Never in a release build.
pub fn dev_sweep_requested() -> bool {
  #[cfg(debug_assertions)]
  {
    std::env::var("WHERRY_DEV_CAMERA").ok().as_deref() == Some("sweep")
  }
  #[cfg(not(debug_assertions))]
  {
    false
  }
}

// -- the sweep ---------------------------------------------------------------

/// A bright bar crossing a dark field, painted straight into I420. The
/// devtools' `?devcamera=canvas` in the shell's own colours: enough motion
/// for an encoder to have to work, and a mean luminance a peer can read to
/// tell a decode from a black frame.
pub struct Sweep {
  stop: Arc<AtomicBool>,
  frames: Arc<AtomicU64>,
  join: Option<JoinHandle<()>>,
}

impl Sweep {
  pub fn start(source: NativeVideoSource, width: u32, height: u32, fps: u32) -> Sweep {
    let stop = Arc::new(AtomicBool::new(false));
    let frames = Arc::new(AtomicU64::new(0));
    let join = {
      let stop = stop.clone();
      let frames = frames.clone();
      std::thread::Builder::new()
        .name("wherry-sweep".into())
        .spawn(move || {
          let interval = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
          let bar = (width / 8).max(8);
          let mut x = 0u32;
          let mut next = Instant::now();
          while !stop.load(Ordering::Relaxed) {
            let mut buffer = I420Buffer::new(width, height);
            let (stride_y, _, _) = buffer.strides();
            let (y, u, v) = buffer.data_mut();
            u.fill(128);
            v.fill(128);
            for row in 0..height as usize {
              let line = &mut y[row * stride_y as usize..row * stride_y as usize + width as usize];
              line.fill(24);
              if row >= 40 && row + 40 < height as usize {
                let end = (x + bar).min(width) as usize;
                line[x as usize..end].fill(235);
              }
            }
            x = (x + width / 40 + 1) % (width - bar);
            let frame = VideoFrame {
              rotation: VideoRotation::VideoRotation0,
              timestamp_us: 0,
              frame_metadata: None,
              buffer,
            };
            source.capture_frame(&frame);
            frames.fetch_add(1, Ordering::Relaxed);
            next += interval;
            if let Some(wait) = next.checked_duration_since(Instant::now()) {
              std::thread::sleep(wait);
            } else {
              next = Instant::now();
            }
          }
        })
        .expect("spawn sweep thread")
    };
    Sweep { stop, frames, join: Some(join) }
  }

  pub fn stop(mut self) {
    self.stop.store(true, Ordering::Relaxed);
    if let Some(join) = self.join.take() {
      let _ = join.join();
    }
  }
}

// -- the screen --------------------------------------------------------------

/// Which of libwebrtc's two capturers a source came from.
///
/// It is part of the identity of a pick, not a detail: screens and windows
/// are separate `DesktopCapturer`s with separate id spaces, so an id alone
/// cannot be started. The page carries the kind back as the `screen:` or
/// `window:` prefix on the id it was given.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScreenKind {
  Screen,
  Window,
}

/// One entry in our own picker's list (Windows; macOS uses the OS sheet).
///
/// The `allow` is because macOS never calls `screen_sources` — its picker
/// is the OS's — so on that target this type and that function are dead by
/// design rather than by oversight, and `mod voice` is private so the
/// compiler would say so.
#[cfg_attr(target_os = "macos", allow(dead_code))]
#[derive(Clone, Debug)]
pub struct ScreenSourceInfo {
  pub kind: ScreenKind,
  pub id: u64,
  pub title: String,
}

/// What `voice_set_screen` chose, resolved back to a capturer and an id.
#[derive(Clone, Copy, Debug)]
pub struct PickedSource {
  pub kind: ScreenKind,
  pub id: u64,
}

impl ScreenKind {
  fn source_type(self) -> DesktopCaptureSourceType {
    match self {
      ScreenKind::Screen => DesktopCaptureSourceType::Screen,
      ScreenKind::Window => DesktopCaptureSourceType::Window,
    }
  }
}

/// The frame size the grant allows, from the size actually captured.
///
/// One function because two places need the same answer and they must not
/// drift: `video.rs` sizes the publication with it before any frame has
/// been scaled, and the capture callback applies it to *every* frame. That
/// second application is what a window share needs and a display share
/// never did — a window is resized while it is being shared, and a policy
/// ceiling that were read once from the first frame would be exceeded the
/// moment somebody maximised it.
pub fn fit_height(width: u32, height: u32, max_height: u32) -> (u32, u32) {
  let max_height = max_height.max(2);
  if height <= max_height {
    return (width & !1, height & !1);
  }
  let scale = max_height as f64 / height as f64;
  (((width as f64 * scale).round() as u32).max(2) & !1, max_height & !1)
}

/// Every screen and window this machine can capture, screens first.
///
/// Windows only in practice: macOS answers through the system picker
/// instead (`set_sck_system_picker`), which is why `voice_screen_sources`
/// keeps returning an empty list there and the page keeps opening the OS
/// sheet. Windows with no title are dropped — they are the invisible
/// tool and message windows every process owns, and none of them is
/// something a person meant to share.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn screen_sources() -> Vec<ScreenSourceInfo> {
  let mut out = Vec::new();
  for kind in [ScreenKind::Screen, ScreenKind::Window] {
    let mut options = DesktopCapturerOptions::new(kind.source_type());
    options.set_include_cursor(true);
    #[cfg(target_os = "macos")]
    options.set_sck_system_picker(false);
    let Some(capturer) = DesktopCapturer::new(options) else { continue };
    for source in capturer.get_source_list() {
      let title = source.title();
      if kind == ScreenKind::Window && title.trim().is_empty() {
        continue;
      }
      out.push(ScreenSourceInfo { kind, id: source.id(), title });
    }
  }
  out
}

/// libwebrtc's desktop capturer on its own thread, converting each ARGB
/// frame to I420 for the source. On macOS the system picker is the
/// interface (`set_sck_system_picker`): the person picks a screen or a
/// window in the OS's own sheet, and the Screen Recording grant is the
/// bundle's. On Windows there is no OS picker to open — WebView2 has none
/// either (regression row S-00) — so the page picks from `screen_sources`
/// and the choice arrives here already made. The first frame's size is
/// reported once, because the source and the publication want it and
/// nothing knows it before the pick.
pub struct Screen {
  stop: Arc<AtomicBool>,
  frames: Arc<AtomicU64>,
  join: Option<JoinHandle<()>>,
}

/// Where the screen's frames go once the publication exists; `None` until
/// then, so frames captured while the picker is still up are dropped rather
/// than queued.
pub type SourceSlot = Arc<Mutex<Option<NativeVideoSource>>>;

impl Screen {
  /// `first` receives the first frame's `(width, height)` as captured; the
  /// caller waits on it with a timeout that covers the picker, and applies
  /// `fit_height` to it to size the publication. `picked` is `None` where
  /// the OS's own sheet is the interface (macOS), and `Some` where the page
  /// drew the list itself (Windows).
  pub fn start(
    fps: u32,
    max_height: u32,
    picked: Option<PickedSource>,
    slot: SourceSlot,
    first: std::sync::mpsc::Sender<(u32, u32)>,
  ) -> Result<Screen, VoiceError> {
    let stop = Arc::new(AtomicBool::new(false));
    let frames = Arc::new(AtomicU64::new(0));
    // `(code, message)` rather than a message alone: "this platform has no
    // capturer" and "the window you picked has closed" are different things
    // to say to somebody, and the second is the one our own picker made
    // reachable.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), (&'static str, String)>>();
    let join = {
      let stop = stop.clone();
      let frames = frames.clone();
      std::thread::Builder::new()
        .name("wherry-screen".into())
        .spawn(move || {
          let kind = picked.map(|p| p.kind).unwrap_or(ScreenKind::Screen);
          let mut options = DesktopCapturerOptions::new(kind.source_type());
          options.set_include_cursor(true);
          // The OS sheet only where nothing was picked for us.
          #[cfg(target_os = "macos")]
          options.set_sck_system_picker(picked.is_none());
          let Some(mut capturer) = DesktopCapturer::new(options) else {
            let _ = ready_tx.send(Err(("screen_unsupported", "no desktop capturer on this platform".into())));
            return;
          };
          // A pick is resolved against a *fresh* list on this thread rather
          // than carried over from the enumeration: the window may have
          // closed between the person seeing it and choosing it, and that
          // is a sentence to show rather than a capture of nothing.
          let chosen = match picked {
            None => None,
            Some(pick) => {
              match capturer.get_source_list().into_iter().find(|s| s.id() == pick.id) {
                Some(source) => Some(source),
                None => {
                  let _ = ready_tx.send(Err(("screen_gone", "that window or screen is no longer there".into())));
                  return;
                }
              }
            }
          };
          let mut announced = false;
          let mut buffer = I420Buffer::new(2, 2);
          let callback = {
            let frames = frames.clone();
            move |result: Result<DesktopFrame, CaptureError>| {
              let frame = match result {
                Ok(frame) => frame,
                // Temporary is a frame the OS had nothing new for; permanent
                // is the picker dismissed or the grant refused, and the
                // publication side reads that as "no frame ever came".
                Err(CaptureError::Temporary) => return,
                Err(CaptureError::Permanent) => {
                  log::warn!("voice: screen capture reported a permanent error");
                  return;
                }
              };
              let (width, height) = (frame.width(), frame.height());
              if width <= 0 || height <= 0 {
                return;
              }
              if !announced {
                announced = true;
                let _ = first.send((width as u32, height as u32));
              }
              if buffer.width() as i32 != width || buffer.height() as i32 != height {
                buffer = I420Buffer::new(width as u32, height as u32);
              }
              let (stride_y, stride_u, stride_v) = buffer.strides();
              let (y, u, v) = buffer.data_mut();
              yuv_helper::argb_to_i420(
                frame.data(),
                frame.stride(),
                y,
                stride_y,
                u,
                stride_u,
                v,
                stride_v,
                width,
                height,
              );
              if let Some(source) = slot.lock().unwrap().as_ref() {
                let (w, h) = fit_height(width as u32, height as u32, max_height);
                let scaled = (w != width as u32 || h != height as u32)
                  .then(|| buffer.scale(w as i32, h as i32));
                match scaled {
                  Some(scaled) => source.capture_frame(&VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    timestamp_us: 0,
                    frame_metadata: None,
                    buffer: scaled,
                  }),
                  None => source.capture_frame(&VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    timestamp_us: 0,
                    frame_metadata: None,
                    buffer: &buffer,
                  }),
                };
                frames.fetch_add(1, Ordering::Relaxed);
              }
            }
          };
          capturer.start_capture(chosen, callback);
          let _ = ready_tx.send(Ok(()));
          let interval = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
          while !stop.load(Ordering::Relaxed) {
            capturer.capture_frame();
            std::thread::sleep(interval);
          }
        })
        .expect("spawn screen thread")
    };
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
      Ok(Ok(())) => Ok(Screen { stop, frames, join: Some(join) }),
      Ok(Err((code, message))) => Err(VoiceError::new(code, message)),
      Err(_) => Err(VoiceError::new("screen_failed", "the capturer did not start")),
    }
  }

  pub fn stop(mut self) {
    self.stop.store(true, Ordering::Relaxed);
    if let Some(join) = self.join.take() {
      let _ = join.join();
    }
  }
}

// -- the camera (macOS) -------------------------------------------------------

#[cfg(target_os = "macos")]
pub mod mac {
  use std::ffi::c_void;
  use std::sync::atomic::{AtomicU64, Ordering};
  use std::sync::{Arc, Mutex};
  use std::time::Duration;

  use block2::RcBlock;
  use livekit::webrtc::video_frame::{NV12Buffer, VideoFrame, VideoRotation};
  use livekit::webrtc::video_source::native::NativeVideoSource;
  use objc2::rc::Retained;
  use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol};
  use objc2::{class, define_class, msg_send, AnyThread, DefinedClass};
  use objc2_foundation::NSString;

  use super::VideoDevice;
  use crate::voice::VoiceError;

  #[link(name = "AVFoundation", kind = "framework")]
  extern "C" {
    static AVMediaTypeVideo: *const AnyObject;
    static AVCaptureSessionPreset640x480: *const AnyObject;
    static AVCaptureSessionPreset1280x720: *const AnyObject;
    static AVCaptureSessionPreset1920x1080: *const AnyObject;
  }

  #[link(name = "CoreVideo", kind = "framework")]
  extern "C" {
    static kCVPixelBufferPixelFormatTypeKey: *const AnyObject;
    fn CVPixelBufferLockBaseAddress(buffer: *mut c_void, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(buffer: *mut c_void, flags: u64) -> i32;
    fn CVPixelBufferGetWidth(buffer: *mut c_void) -> usize;
    fn CVPixelBufferGetHeight(buffer: *mut c_void) -> usize;
    fn CVPixelBufferGetPixelFormatType(buffer: *mut c_void) -> u32;
    fn CVPixelBufferGetPlaneCount(buffer: *mut c_void) -> usize;
    fn CVPixelBufferGetBaseAddressOfPlane(buffer: *mut c_void, plane: usize) -> *mut u8;
    fn CVPixelBufferGetBytesPerRowOfPlane(buffer: *mut c_void, plane: usize) -> usize;
  }

  #[link(name = "CoreMedia", kind = "framework")]
  extern "C" {
    fn CMSampleBufferGetImageBuffer(sample: *mut c_void) -> *mut c_void;
  }

  extern "C" {
    fn dispatch_queue_create(label: *const std::ffi::c_char, attr: *const c_void) -> *mut c_void;
  }

  /// `kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange` ('420v') and the
  /// full-range twin ('420f'): both are NV12 as far as the planes go.
  const FORMAT_420V: u32 = 0x3432_3076;
  const FORMAT_420F: u32 = 0x3432_3066;
  const LOCK_READ_ONLY: u64 = 1;

  struct SinkShared {
    source: NativeVideoSource,
    frames: AtomicU64,
    /// The first frame's size and format, for one log line.
    seen: Mutex<Option<(usize, usize, u32)>>,
  }

  struct SinkIvars {
    shared: Arc<SinkShared>,
  }

  define_class!(
    // SAFETY: NSObject has no subclassing requirements, and the sink holds
    // nothing it must do at dealloc -- the Arc drops with the ivars.
    #[unsafe(super(NSObject))]
    #[name = "WherryCameraSink"]
    #[ivars = SinkIvars]
    struct CameraSink;

    // A plain impl rather than a protocol block, on purpose: objc2 checks a
    // protocol method against a protocol it knows at registration time,
    // and this build binds no AVFoundation headers. The selector is
    // AVCaptureVideoDataOutputSampleBufferDelegate's, and the output calls
    // it through respondsToSelector:, which this satisfies.
    impl CameraSink {
      #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
      fn did_output(&self, _output: &AnyObject, sample: *mut c_void, _connection: &AnyObject) {
        let shared = &self.ivars().shared;
        // SAFETY: AVFoundation hands a valid sample buffer for the duration
        // of the callback; the pixel buffer is locked for reading while its
        // planes are copied and unlocked before returning.
        unsafe {
          let pixels = CMSampleBufferGetImageBuffer(sample);
          if pixels.is_null() {
            return;
          }
          let format = CVPixelBufferGetPixelFormatType(pixels);
          let width = CVPixelBufferGetWidth(pixels);
          let height = CVPixelBufferGetHeight(pixels);
          {
            let mut seen = shared.seen.lock().unwrap();
            if seen.is_none() {
              *seen = Some((width, height, format));
              log::info!(
                "voice: camera delivering {width}x{height} format {} ({})",
                fourcc(format),
                CVPixelBufferGetPlaneCount(pixels)
              );
            }
          }
          if (format != FORMAT_420V && format != FORMAT_420F)
            || CVPixelBufferGetPlaneCount(pixels) != 2
            || width == 0
            || height == 0
          {
            return;
          }
          if CVPixelBufferLockBaseAddress(pixels, LOCK_READ_ONLY) != 0 {
            return;
          }
          let src_y = CVPixelBufferGetBaseAddressOfPlane(pixels, 0);
          let src_uv = CVPixelBufferGetBaseAddressOfPlane(pixels, 1);
          let src_stride_y = CVPixelBufferGetBytesPerRowOfPlane(pixels, 0);
          let src_stride_uv = CVPixelBufferGetBytesPerRowOfPlane(pixels, 1);
          if !src_y.is_null() && !src_uv.is_null() {
            let mut buffer = NV12Buffer::new(width as u32, height as u32);
            let (dst_stride_y, dst_stride_uv) = buffer.strides();
            let (dst_y, dst_uv) = buffer.data_mut();
            for row in 0..height {
              let src = std::slice::from_raw_parts(src_y.add(row * src_stride_y), width);
              let dst = &mut dst_y[row * dst_stride_y as usize..][..width];
              dst.copy_from_slice(src);
            }
            let chroma_rows = (height + 1) / 2;
            let chroma_bytes = ((width + 1) / 2) * 2;
            for row in 0..chroma_rows {
              let src = std::slice::from_raw_parts(src_uv.add(row * src_stride_uv), chroma_bytes);
              let dst = &mut dst_uv[row * dst_stride_uv as usize..][..chroma_bytes];
              dst.copy_from_slice(src);
            }
            CVPixelBufferUnlockBaseAddress(pixels, LOCK_READ_ONLY);
            shared.source.capture_frame(&VideoFrame {
              rotation: VideoRotation::VideoRotation0,
              timestamp_us: 0,
              frame_metadata: None,
              buffer,
            });
            shared.frames.fetch_add(1, Ordering::Relaxed);
          } else {
            CVPixelBufferUnlockBaseAddress(pixels, LOCK_READ_ONLY);
          }
        }
      }
    }

    unsafe impl NSObjectProtocol for CameraSink {}
  );

  fn fourcc(code: u32) -> String {
    code.to_be_bytes().iter().map(|b| *b as char).collect()
  }

  /// An open camera: the capture session, its delegate, and the queue the
  /// frames arrive on. Raw retained pointers rather than `Retained<_>`,
  /// because this lives in the session state behind a `Mutex` and is
  /// dropped from whichever thread the disconnect command runs on;
  /// AVCaptureSession is documented safe to stop from any thread.
  pub struct Camera {
    session: usize,
    sink: usize,
    shared: Arc<SinkShared>,
  }

  // SAFETY: see the struct comment -- every AVFoundation object here is
  // retained by this struct and only ever messaged, never dereferenced as
  // Rust data.
  unsafe impl Send for Camera {}

  fn string_of(object: *mut AnyObject) -> String {
    if object.is_null() {
      return String::new();
    }
    // SAFETY: the caller passes an NSString.
    unsafe { (*(object as *const NSString)).to_string() }
  }

  /// What the picker lists: every video device AVFoundation knows, by its
  /// stable unique id. No permission is needed to list; names are real.
  pub fn devices() -> Vec<VideoDevice> {
    // SAFETY: class methods on AVFoundation, autoreleased results read
    // immediately.
    unsafe {
      let list: *mut AnyObject =
        msg_send![class!(AVCaptureDevice), devicesWithMediaType: AVMediaTypeVideo];
      if list.is_null() {
        return Vec::new();
      }
      let count: usize = msg_send![list, count];
      (0..count)
        .map(|index| {
          let device: *mut AnyObject = msg_send![list, objectAtIndex: index];
          let id: *mut AnyObject = msg_send![device, uniqueID];
          let name: *mut AnyObject = msg_send![device, localizedName];
          VideoDevice { device_id: string_of(id), label: string_of(name) }
        })
        .collect()
    }
  }

  /// `AVAuthorizationStatus`: 0 not determined, 1 restricted, 2 denied,
  /// 3 authorized.
  fn authorization() -> isize {
    // SAFETY: a class method with a constant argument.
    unsafe { msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: AVMediaTypeVideo] }
  }

  /// Asks for the camera if nobody has yet, and waits for the answer. The
  /// prompt is the OS's, in the bundle's name, and it can sit for as long
  /// as the person takes; a session driving the shell unattended uses the
  /// sweep instead (`dev_sweep_requested`).
  fn ensure_authorized() -> Result<(), VoiceError> {
    match authorization() {
      3 => return Ok(()),
      1 | 2 => return Err(VoiceError::new("camera_denied", "camera access is not allowed")),
      _ => {}
    }
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    let block = RcBlock::new(move |granted: Bool| {
      let _ = tx.send(granted.as_bool());
    });
    // SAFETY: the block outlives the call; AVFoundation copies it.
    unsafe {
      let _: () = msg_send![
        class!(AVCaptureDevice),
        requestAccessForMediaType: AVMediaTypeVideo,
        completionHandler: &*block
      ];
    }
    match rx.recv_timeout(Duration::from_secs(120)) {
      Ok(true) => Ok(()),
      Ok(false) => Err(VoiceError::new("camera_denied", "camera access was refused")),
      Err(_) => Err(VoiceError::new("camera_denied", "the camera prompt was not answered")),
    }
  }

  fn preset_for(max_height: u32) -> *const AnyObject {
    // SAFETY: reading framework string constants.
    unsafe {
      if max_height <= 480 {
        AVCaptureSessionPreset640x480
      } else if max_height <= 720 {
        AVCaptureSessionPreset1280x720
      } else {
        AVCaptureSessionPreset1920x1080
      }
    }
  }

  impl Camera {
    /// Opens `device_id` (or the default camera) into `source`, at the
    /// preset nearest `max_height`. Blocks for the permission prompt and
    /// for `startRunning`, so call it from a blocking task.
    pub fn open(
      device_id: Option<&str>,
      max_height: u32,
      source: NativeVideoSource,
    ) -> Result<Camera, VoiceError> {
      ensure_authorized()?;
      let shared = Arc::new(SinkShared {
        source,
        frames: AtomicU64::new(0),
        seen: Mutex::new(None),
      });
      // SAFETY: plain AVFoundation setup, every object retained by the
      // session or by this struct; failures are checked at each step.
      unsafe {
        let device: *mut AnyObject = match device_id {
          Some(id) => {
            let id = NSString::from_str(id);
            let found: *mut AnyObject = msg_send![class!(AVCaptureDevice), deviceWithUniqueID: &*id];
            if found.is_null() {
              msg_send![class!(AVCaptureDevice), defaultDeviceWithMediaType: AVMediaTypeVideo]
            } else {
              found
            }
          }
          None => msg_send![class!(AVCaptureDevice), defaultDeviceWithMediaType: AVMediaTypeVideo],
        };
        if device.is_null() {
          return Err(VoiceError::new("no_camera", "no camera on this device"));
        }
        let mut error: *mut AnyObject = std::ptr::null_mut();
        let input: *mut AnyObject =
          msg_send![class!(AVCaptureDeviceInput), deviceInputWithDevice: device, error: &mut error];
        if input.is_null() {
          let description: *mut AnyObject =
            if error.is_null() { std::ptr::null_mut() } else { msg_send![error, localizedDescription] };
          return Err(VoiceError::new("camera_failed", string_of(description)));
        }

        let session: *mut AnyObject = msg_send![class!(AVCaptureSession), new];
        let _: () = msg_send![session, beginConfiguration];
        let preset = preset_for(max_height);
        let can_preset: bool = msg_send![session, canSetSessionPreset: preset];
        if can_preset {
          let _: () = msg_send![session, setSessionPreset: preset];
        }
        let can_input: bool = msg_send![session, canAddInput: input];
        if !can_input {
          let _: () = msg_send![session, commitConfiguration];
          return Err(VoiceError::new("camera_failed", "the camera cannot be added to a session"));
        }
        let _: () = msg_send![session, addInput: input];

        let output: *mut AnyObject = msg_send![class!(AVCaptureVideoDataOutput), new];
        let format: *mut AnyObject = msg_send![class!(NSNumber), numberWithUnsignedInt: FORMAT_420V];
        let settings: *mut AnyObject = msg_send![
          class!(NSDictionary),
          dictionaryWithObject: format,
          forKey: kCVPixelBufferPixelFormatTypeKey
        ];
        let _: () = msg_send![output, setVideoSettings: settings];
        let _: () = msg_send![output, setAlwaysDiscardsLateVideoFrames: true];

        let sink = CameraSink::alloc().set_ivars(SinkIvars { shared: shared.clone() });
        let sink: Retained<CameraSink> = msg_send![super(sink), init];
        let queue = dispatch_queue_create(c"app.wherry.camera".as_ptr(), std::ptr::null());
        let _: () = msg_send![output, setSampleBufferDelegate: &*sink, queue: queue];
        let can_output: bool = msg_send![session, canAddOutput: output];
        if !can_output {
          let _: () = msg_send![session, commitConfiguration];
          return Err(VoiceError::new("camera_failed", "the output cannot be added to a session"));
        }
        let _: () = msg_send![session, addOutput: output];
        let _: () = msg_send![session, commitConfiguration];
        let _: () = msg_send![session, startRunning];
        let running: bool = msg_send![session, isRunning];
        if !running {
          return Err(VoiceError::new("camera_failed", "the capture session did not start"));
        }
        log::info!(
          "voice: camera opened ({}), preset for {max_height}p",
          device_id.unwrap_or("default")
        );
        Ok(Camera {
          session: session as usize,
          sink: Retained::into_raw(sink) as usize,
          shared,
        })
      }
    }

    pub fn frames(&self) -> u64 {
      self.shared.frames.load(Ordering::Relaxed)
    }

    /// Stops the session -- the camera light goes off -- and releases it.
    pub fn close(self) {
      // SAFETY: the pointers were retained in `open`; stopRunning is safe
      // from any thread, and the session drops its input and output.
      unsafe {
        let session = self.session as *mut AnyObject;
        let _: () = msg_send![session, stopRunning];
        let _: () = msg_send![session, release];
        drop(Retained::from_raw(self.sink as *mut CameraSink));
      }
      log::info!("voice: camera closed after {} frame(s)", self.frames());
    }
  }
}

// -- the camera (Windows) -----------------------------------------------------

#[cfg(target_os = "windows")]
pub mod win {
  use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
  use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
  use std::sync::Arc;
  use std::time::{Duration, Instant};

  use livekit::webrtc::video_frame::{NV12Buffer, VideoFrame, VideoRotation};
  use livekit::webrtc::video_source::native::NativeVideoSource;
  use windows::Win32::Foundation::{E_ACCESSDENIED, E_FAIL};
  use windows::Win32::Media::MediaFoundation::*;
  use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED,
  };
  use windows_core::{Interface, GUID, PWSTR};

  use super::{fit_height, VideoDevice};
  use crate::voice::VoiceError;

  /// Every reader method's index for "the first video stream".
  const VIDEO_STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
  /// How long `open` waits for the first read to answer; a camera takes a
  /// second or two to settle its exposure before the first frame.
  const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
  /// How long `close` waits for the device to be released.
  const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
  /// The frame rate a mode is chosen towards: what the macOS presets deliver
  /// and what the camera tiers ask the encoder for, with room for 30000/1001.
  /// A faster device mode would only be encoded down again.
  const PREFERRED_FPS: f64 = 30.5;

  /// Media Foundation on the current thread, for as long as this lives.
  ///
  /// COM first and MF inside it, released in reverse by `Drop`. So every MF
  /// object a function holds must be a local declared **after** the guard,
  /// which Rust drops before it -- and never a temporary in a block's tail
  /// expression, which in this edition outlives the block's locals.
  /// Multithreaded, as screen_audio.rs is: COM pointers are `!Send`, so
  /// everything is made and used on the thread that initialised it.
  struct MediaFoundation;

  impl MediaFoundation {
    fn start() -> windows_core::Result<MediaFoundation> {
      // SAFETY: paired by `Drop`, on a thread this module created.
      unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) {
          CoUninitialize();
          return Err(error);
        }
      }
      Ok(MediaFoundation)
    }
  }

  impl Drop for MediaFoundation {
    fn drop(&mut self) {
      // SAFETY: `start` succeeded on this thread, and what was made under it
      // has already been dropped (see the struct comment).
      unsafe {
        let _ = MFShutdown();
        CoUninitialize();
      }
    }
  }

  fn describe(error: &windows_core::Error) -> String {
    format!("0x{:08X} {}", error.code().0, error.message())
  }

  /// A failure as the page will read it.
  ///
  /// **Windows has no camera prompt.** A desktop app the privacy setting
  /// refuses gets a failure from the source instead, and `E_ACCESSDENIED` is
  /// its usual shape. That has to arrive as `camera_denied` -- "Camera access
  /// was refused." -- rather than as the generic sentence, because on a
  /// machine with the setting off it is not the rare path but the only one
  /// (the work order's §4; row D-62).
  fn camera_error(stage: &str, error: &windows_core::Error) -> VoiceError {
    if error.code() == E_ACCESSDENIED {
      return VoiceError::new("camera_denied", format!("camera access is not allowed ({stage})"));
    }
    VoiceError::new("camera_failed", format!("{stage}: {}", describe(error)))
  }

  /// Every video capture device Media Foundation knows, as owned activation
  /// objects: each is moved out of the array the call allocated, and the
  /// array is then freed.
  fn enumerate() -> windows_core::Result<Vec<IMFActivate>> {
    // SAFETY: the out-pointers are valid, a successful call initialises
    // `count` elements of `array`, and each is read exactly once.
    unsafe {
      let mut attributes: Option<IMFAttributes> = None;
      MFCreateAttributes(&mut attributes, 1)?;
      let attributes = attributes.ok_or_else(|| windows_core::Error::from(E_FAIL))?;
      attributes.SetGUID(
        &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
        &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
      )?;
      let mut array: *mut Option<IMFActivate> = std::ptr::null_mut();
      let mut count = 0u32;
      MFEnumDeviceSources(&attributes, &mut array, &mut count)?;
      let mut devices = Vec::with_capacity(count as usize);
      if !array.is_null() {
        for index in 0..count as usize {
          if let Some(activate) = std::ptr::read(array.add(index)) {
            devices.push(activate);
          }
        }
        CoTaskMemFree(Some(array as *const _));
      }
      Ok(devices)
    }
  }

  fn string_attribute(attributes: &IMFAttributes, key: &GUID) -> Option<String> {
    // SAFETY: a successful call hands back a CoTaskMem string we own.
    unsafe {
      let mut value = PWSTR::null();
      let mut length = 0u32;
      attributes.GetAllocatedString(key, &mut value, &mut length).ok()?;
      let text = value.to_string().ok();
      CoTaskMemFree(Some(value.0 as *const _));
      text
    }
  }

  /// What the picker lists: every camera, by its symbolic link.
  ///
  /// The link and not the enumeration index, because the page keeps the
  /// chosen id in its prefs and an index moves when a camera is plugged in;
  /// the macOS side keys on `uniqueID` for the same reason. On a thread of
  /// its own because the command arrives on Tauri's main thread, which tao
  /// has already made a single-threaded apartment.
  pub fn devices() -> Vec<VideoDevice> {
    let listed = std::thread::Builder::new()
      .name("wherry-camera-list".into())
      .spawn(|| -> windows_core::Result<Vec<VideoDevice>> {
        let _mf = MediaFoundation::start()?;
        let activates = enumerate()?;
        let devices: Vec<VideoDevice> = activates
          .iter()
          .filter_map(|activate| {
            Some(VideoDevice {
              device_id: string_attribute(
                activate,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
              )?,
              label: string_attribute(activate, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME)
                .unwrap_or_default(),
            })
          })
          .collect();
        Ok(devices)
      })
      .map(|thread| thread.join());
    match listed {
      Ok(Ok(Ok(devices))) => devices,
      Ok(Ok(Err(error))) => {
        log::warn!("voice: camera list could not be read: {}", describe(&error));
        Vec::new()
      }
      _ => {
        log::warn!("voice: camera list thread failed");
        Vec::new()
      }
    }
  }

  /// One of the device's own modes, as `GetNativeMediaType` lists it.
  #[derive(Clone, Copy)]
  struct Mode {
    index: u32,
    subtype: GUID,
    width: u32,
    height: u32,
    fps: f64,
  }

  fn frame_size(media_type: &IMFMediaType) -> Option<(u32, u32)> {
    // SAFETY: an attribute read.
    let size = unsafe { media_type.GetUINT64(&MF_MT_FRAME_SIZE) }.ok()?;
    Some(((size >> 32) as u32, size as u32))
  }

  /// The stride a media type states, for a buffer that cannot report its own;
  /// the width where it states none.
  fn default_stride(media_type: &IMFMediaType, width: u32) -> u32 {
    // SAFETY: an attribute read.
    unsafe { media_type.GetUINT32(&MF_MT_DEFAULT_STRIDE) }
      .map(|stride| (stride as i32).unsigned_abs())
      .unwrap_or(width)
      .max(width)
  }

  fn native_modes(reader: &IMFSourceReader) -> windows_core::Result<Vec<Mode>> {
    let mut modes = Vec::new();
    for index in 0u32.. {
      // SAFETY: plain reader calls; the index runs until the reader says
      // there are no more types.
      let media_type = match unsafe { reader.GetNativeMediaType(VIDEO_STREAM, index) } {
        Ok(media_type) => media_type,
        Err(error) if error.code() == MF_E_NO_MORE_TYPES => break,
        Err(error) => return Err(error),
      };
      let Ok(subtype) = (unsafe { media_type.GetGUID(&MF_MT_SUBTYPE) }) else { continue };
      let Some((width, height)) = frame_size(&media_type) else { continue };
      let rate = unsafe { media_type.GetUINT64(&MF_MT_FRAME_RATE) }.unwrap_or(0);
      let (numerator, denominator) = ((rate >> 32) as u32, rate as u32);
      let fps = if denominator == 0 { 0.0 } else { numerator as f64 / denominator as f64 };
      modes.push(Mode { index, subtype, width, height, fps });
    }
    Ok(modes)
  }

  /// The mode to open, and whether the reader has to convert it.
  ///
  /// A native NV12 mode wins whenever one exists, as the work order's §3
  /// asks; one taller than the ceiling is scaled on the way out (`deliver`).
  /// Among the candidates: the tallest at or under the ceiling, else the
  /// shortest over it; then the fastest at or under thirty frames a second,
  /// else the slowest over; then the widest.
  fn choose(modes: &[Mode], max_height: u32) -> Option<(Mode, bool)> {
    let fit = |mode: &&Mode| {
      let tall_enough = mode.height <= max_height;
      let slow_enough = mode.fps <= PREFERRED_FPS;
      let millis = (mode.fps * 1000.0) as i64;
      (
        tall_enough,
        if tall_enough { mode.height as i64 } else { -(mode.height as i64) },
        slow_enough,
        if slow_enough { millis } else { -millis },
        mode.width,
      )
    };
    if let Some(mode) = modes.iter().filter(|m| m.subtype == MFVideoFormat_NV12).max_by_key(fit) {
      return Some((*mode, false));
    }
    modes.iter().max_by_key(fit).map(|mode| (*mode, true))
  }

  /// The source reader, allowed to convert.
  ///
  /// Permission to convert is given when the reader is created or not at
  /// all, so it is given here before anyone knows whether the device needs
  /// it; with a native NV12 mode selected there is nothing for it to insert.
  /// **`ENABLE_ADVANCED_VIDEO_PROCESSING`, not `ENABLE_VIDEO_PROCESSING`**:
  /// the plain one converts YUV to RGB-32 and deinterlaces, and nothing else,
  /// so it could never produce NV12.
  fn open_reader(media_source: &IMFMediaSource) -> windows_core::Result<IMFSourceReader> {
    // SAFETY: plain calls on objects we own.
    unsafe {
      let mut attributes: Option<IMFAttributes> = None;
      MFCreateAttributes(&mut attributes, 1)?;
      let attributes = attributes.ok_or_else(|| windows_core::Error::from(E_FAIL))?;
      attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)?;
      let reader = MFCreateSourceReaderFromMediaSource(media_source, &attributes)?;
      reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
      reader.SetStreamSelection(VIDEO_STREAM, true)?;
      Ok(reader)
    }
  }

  /// Selects `mode` on the device and, where it is not NV12, asks the reader
  /// for NV12 at the same size and rate.
  ///
  /// The native mode is selected first on purpose: an output type set on its
  /// own leaves the reader free to pick whichever native mode it can convert
  /// from, a larger one included, and the size chosen here would be lost.
  fn set_mode(reader: &IMFSourceReader, mode: Mode, converted: bool) -> windows_core::Result<()> {
    // SAFETY: plain reader and attribute calls on objects we own.
    unsafe {
      let native = reader.GetNativeMediaType(VIDEO_STREAM, mode.index)?;
      reader.SetCurrentMediaType(VIDEO_STREAM, None, &native)?;
      if converted {
        let output = MFCreateMediaType()?;
        output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        output.SetUINT64(&MF_MT_FRAME_SIZE, native.GetUINT64(&MF_MT_FRAME_SIZE)?)?;
        if let Ok(rate) = native.GetUINT64(&MF_MT_FRAME_RATE) {
          output.SetUINT64(&MF_MT_FRAME_RATE, rate)?;
        }
        reader.SetCurrentMediaType(VIDEO_STREAM, None, &output)?;
      }
      Ok(())
    }
  }

  /// A subtype's FOURCC (`YUY2`, `MJPG`) where it has one -- the first field
  /// of every FOURCC-based subtype GUID -- and the number otherwise.
  fn fourcc(subtype: &GUID) -> String {
    let bytes = subtype.data1.to_le_bytes();
    if bytes.iter().all(|b| b.is_ascii_graphic()) {
      bytes.iter().map(|b| *b as char).collect()
    } else {
      format!("{:#010x}", subtype.data1)
    }
  }

  /// NV12 from a first scanline and a signed pitch: the luma rows, then the
  /// interleaved chroma rows, each `pitch` bytes on from the row above it. A
  /// negative pitch is a bottom-up buffer whose first scanline is still the
  /// top row, and the same arithmetic walks it -- handled at the copy, as the
  /// work order's §4 asks, rather than flipped downstream.
  ///
  /// # Safety
  /// `scanline0` must address a locked `width`x`height` NV12 frame laid out
  /// at `pitch`.
  unsafe fn copy_nv12(scanline0: *const u8, pitch: isize, width: u32, height: u32, buffer: &mut NV12Buffer) {
    let (width, height) = (width as usize, height as usize);
    let (stride_y, stride_uv) = buffer.strides();
    let (dst_y, dst_uv) = buffer.data_mut();
    for row in 0..height {
      let src = std::slice::from_raw_parts(scanline0.offset(row as isize * pitch), width);
      dst_y[row * stride_y as usize..][..width].copy_from_slice(src);
    }
    let chroma_bytes = width.div_ceil(2) * 2;
    for row in 0..height.div_ceil(2) {
      let src = std::slice::from_raw_parts(scanline0.offset((height + row) as isize * pitch), chroma_bytes);
      dst_uv[row * stride_uv as usize..][..chroma_bytes].copy_from_slice(src);
    }
  }

  /// One sample into an NV12 buffer at the real pitch, scaled under the
  /// ceiling where the mode is taller than it, and into the source. False
  /// when there was nothing to deliver.
  fn deliver(
    sample: &IMFSample,
    (width, height): (u32, u32),
    stride: u32,
    max_height: u32,
    source: &NativeVideoSource,
    announced: &mut bool,
  ) -> bool {
    let mut buffer = NV12Buffer::new(width, height);
    // SAFETY: every lock is paired with its unlock before the block ends, and
    // the copy reads only rows inside the locked frame.
    let (via, pitch) = unsafe {
      let Ok(media) = sample.GetBufferByIndex(0) else { return false };
      // `Lock2D` wherever the buffer has it, because it is the one call that
      // states the pitch. `ConvertToContiguousBuffer` hands back a packed
      // copy with no stride at all, and a frame copied at the wrong stride is
      // a sheared picture rather than an error (row D-63).
      if let Ok(two_d) = media.cast::<IMF2DBuffer>() {
        let mut scanline0 = std::ptr::null_mut();
        let mut pitch = 0i32;
        if two_d.Lock2D(&mut scanline0, &mut pitch).is_err() || scanline0.is_null() {
          return false;
        }
        copy_nv12(scanline0, pitch as isize, width, height, &mut buffer);
        let _ = two_d.Unlock2D();
        ("Lock2D", pitch as i64)
      } else {
        // No 2D interface: a plain lock at the stride the media type states,
        // and only when the buffer is long enough to hold the frame at it.
        let mut data = std::ptr::null_mut();
        let mut length = 0u32;
        if media.Lock(&mut data, None, Some(&mut length as *mut u32)).is_err() || data.is_null() {
          return false;
        }
        let rows = height as usize + (height as usize).div_ceil(2);
        let needed = stride as usize * (rows - 1) + (width as usize).div_ceil(2) * 2;
        if (length as usize) < needed {
          let _ = media.Unlock();
          if !*announced {
            *announced = true;
            log::warn!(
              "voice: camera buffer of {length} bytes is short of {needed} for {width}x{height} at stride {stride}; frames dropped"
            );
          }
          return false;
        }
        copy_nv12(data, stride as isize, width, height, &mut buffer);
        let _ = media.Unlock();
        ("a plain lock", stride as i64)
      }
    };
    let scaled = (height > max_height).then(|| fit_height(width, height, max_height));
    if !*announced {
      *announced = true;
      log::info!(
        "voice: camera delivering {width}x{height} NV12 at pitch {pitch} via {via}{}",
        match scaled {
          Some((w, h)) => format!(", scaled to {w}x{h} for the {max_height}p ceiling"),
          None => String::new(),
        }
      );
    }
    let buffer = match scaled {
      Some((w, h)) => buffer.scale(w as i32, h as i32),
      None => buffer,
    };
    source.capture_frame(&VideoFrame {
      rotation: VideoRotation::VideoRotation0,
      timestamp_us: 0,
      frame_metadata: None,
      buffer,
    });
    true
  }

  /// An open camera: the thread reading it, and how to stop it.
  pub struct Camera {
    stop: Arc<AtomicBool>,
    frames: Arc<AtomicU64>,
    /// Disconnected when the capture thread exits, so `close` can wait for
    /// the source to be shut down without trusting a join to return.
    done: Receiver<()>,
  }

  impl Camera {
    /// Opens `device_id` (or the first camera) into `source`, in the mode
    /// `choose` picks for `max_height`. Blocks until the first read has
    /// answered -- on Windows a refusal can arrive there as well as at
    /// activation -- so call it from a blocking task.
    pub fn open(
      device_id: Option<&str>,
      max_height: u32,
      source: NativeVideoSource,
    ) -> Result<Camera, VoiceError> {
      let stop = Arc::new(AtomicBool::new(false));
      let frames = Arc::new(AtomicU64::new(0));
      let (ready_tx, ready_rx) = channel::<Result<(), VoiceError>>();
      let (done_tx, done_rx) = channel::<()>();
      let wanted = device_id.map(str::to_owned);
      {
        let stop = stop.clone();
        let frames = frames.clone();
        std::thread::Builder::new()
          .name("wherry-camera".into())
          .spawn(move || {
            let _done = done_tx;
            if let Err(error) = run(wanted.as_deref(), max_height, source, &stop, &frames, &ready_tx) {
              let _ = ready_tx.send(Err(error));
            }
          })
          .map_err(|error| VoiceError::new("camera_failed", error.to_string()))?;
      }
      match ready_rx.recv_timeout(OPEN_TIMEOUT) {
        Ok(Ok(())) => Ok(Camera { stop, frames, done: done_rx }),
        Ok(Err(error)) => Err(error),
        Err(_) => {
          stop.store(true, Ordering::Relaxed);
          Err(VoiceError::new("camera_failed", "the camera did not answer its first read"))
        }
      }
    }

    pub fn frames(&self) -> u64 {
      self.frames.load(Ordering::Relaxed)
    }

    /// Stops the read loop and waits for the thread to shut the source down,
    /// which is what turns the camera light off. The wait is bounded: a
    /// `ReadSample` that never returns -- a device that hung rather than
    /// failed -- would otherwise hold a call's teardown forever, and a loud
    /// line saying the device may still be open is the better failure.
    pub fn close(self) {
      self.stop.store(true, Ordering::Relaxed);
      if let Err(RecvTimeoutError::Timeout) = self.done.recv_timeout(CLOSE_TIMEOUT) {
        log::warn!(
          "voice: camera did not release within {} s; its read is still blocked and the device may still be open",
          CLOSE_TIMEOUT.as_secs()
        );
      }
      log::info!("voice: camera closed after {} frame(s)", self.frames());
    }
  }

  /// The capture thread's whole life. An error is returned only before the
  /// first read has answered, which is what `open` waits on; after that a
  /// failure is a log line and the loop ends.
  fn run(
    device_id: Option<&str>,
    max_height: u32,
    source: NativeVideoSource,
    stop: &AtomicBool,
    frames: &AtomicU64,
    ready: &Sender<Result<(), VoiceError>>,
  ) -> Result<(), VoiceError> {
    let _mf = MediaFoundation::start().map_err(|error| camera_error("starting Media Foundation", &error))?;
    let activates = enumerate().map_err(|error| camera_error("listing cameras", &error))?;
    let Some(first) = activates.first() else {
      return Err(VoiceError::new("no_camera", "no camera on this device"));
    };
    // The stored id, or the first camera when it has gone -- unplugged since
    // it was chosen -- which is what the macOS side does with a `uniqueID` it
    // no longer finds.
    let activate = device_id
      .and_then(|id| {
        activates.iter().find(|activate| {
          string_attribute(activate, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK).as_deref()
            == Some(id)
        })
      })
      .unwrap_or(first);
    let label = string_attribute(activate, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME).unwrap_or_default();
    // SAFETY: activating an object the enumeration handed us.
    let media_source: IMFMediaSource = unsafe { activate.ActivateObject() }
      .map_err(|error| camera_error("opening the camera", &error))?;
    let result = read(&media_source, &label, max_height, source, stop, frames, ready);
    // Every way out shuts the source down, success or failure, because that
    // is the light going off (row D-61). Releasing the reader inside `read`
    // has normally done it already, and a second `Shutdown` only answers
    // MF_E_SHUTDOWN.
    // SAFETY: a plain call on an object we own.
    unsafe {
      let _ = media_source.Shutdown();
    }
    result
  }

  fn read(
    media_source: &IMFMediaSource,
    label: &str,
    max_height: u32,
    source: NativeVideoSource,
    stop: &AtomicBool,
    frames: &AtomicU64,
    ready: &Sender<Result<(), VoiceError>>,
  ) -> Result<(), VoiceError> {
    let reader =
      open_reader(media_source).map_err(|error| camera_error("creating the source reader", &error))?;
    let modes = native_modes(&reader).map_err(|error| camera_error("listing the camera's modes", &error))?;
    let Some((mode, converted)) = choose(&modes, max_height) else {
      return Err(VoiceError::new("camera_failed", "the camera offers no video mode"));
    };
    set_mode(&reader, mode, converted).map_err(|error| camera_error("setting the camera's mode", &error))?;
    // What the reader will actually deliver, which is what every copy is
    // sized from.
    // SAFETY: a plain reader call.
    let current = unsafe { reader.GetCurrentMediaType(VIDEO_STREAM) }
      .map_err(|error| camera_error("reading the mode back", &error))?;
    let Some((mut width, mut height)) = frame_size(&current) else {
      return Err(VoiceError::new("camera_failed", "the camera's mode has no frame size"));
    };
    let mut stride = default_stride(&current, width);
    drop(current);
    // The line row D-64 reads: which branch, once per open.
    log::info!(
      "voice: camera opened ({label}), {width}x{height} at {:.1} fps, {}",
      mode.fps,
      if converted {
        format!("{} converted to NV12 by the source reader", fourcc(&mode.subtype))
      } else {
        "native NV12".to_string()
      }
    );

    // **A software camera may not pace itself.** A hardware camera blocks each
    // read until its next frame; VCamSample generates one whenever it is asked
    // and read 842 frames in five seconds from a 30 fps mode (2026-09-15),
    // every one of them copied, scaled and handed to an encoder that keeps
    // thirty. So reads are held to the mode's rate: the wait lands between
    // reads, where a paced device would have blocked anyway, and a device that
    // is already on time never waits at all.
    let interval = (mode.fps > 0.0).then(|| Duration::from_secs_f64(1.0 / mode.fps));
    let mut next = Instant::now();
    let mut answered = false;
    let mut announced = false;
    while !stop.load(Ordering::Relaxed) {
      let mut flags = 0u32;
      let mut sample: Option<IMFSample> = None;
      // SAFETY: synchronous mode -- this blocks until a sample, a tick or a
      // failure, which is why `stop` is only seen between reads.
      let result = unsafe {
        reader.ReadSample(
          VIDEO_STREAM,
          0,
          None,
          Some(&mut flags as *mut u32),
          None,
          Some(&mut sample as *mut Option<IMFSample>),
        )
      };
      let ended =
        flags & (MF_SOURCE_READERF_ERROR.0 | MF_SOURCE_READERF_ENDOFSTREAM.0) as u32 != 0;
      if !answered {
        if let Err(error) = &result {
          return Err(camera_error("the first read", error));
        }
        if ended {
          return Err(VoiceError::new(
            "camera_failed",
            format!("the first read ended the stream (flags 0x{flags:X})"),
          ));
        }
        answered = true;
        let _ = ready.send(Ok(()));
      }
      if let Err(error) = &result {
        log::warn!(
          "voice: camera read failed after {} frame(s): {}",
          frames.load(Ordering::Relaxed),
          describe(error)
        );
        break;
      }
      if ended {
        log::warn!(
          "voice: camera stream ended after {} frame(s) (flags 0x{flags:X})",
          frames.load(Ordering::Relaxed)
        );
        break;
      }
      if flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
        // SAFETY: a plain reader call.
        if let Ok(changed) = unsafe { reader.GetCurrentMediaType(VIDEO_STREAM) } {
          if let Some(size) = frame_size(&changed) {
            (width, height) = size;
            stride = default_stride(&changed, width);
            announced = false;
            log::info!("voice: camera mode changed to {width}x{height}");
          }
        }
      }
      let Some(sample) = sample else { continue };
      if deliver(&sample, (width, height), stride, max_height, &source, &mut announced) {
        frames.fetch_add(1, Ordering::Relaxed);
      }
      if let Some(interval) = interval {
        next += interval;
        match next.checked_duration_since(Instant::now()) {
          Some(wait) => std::thread::sleep(wait),
          None => next = Instant::now(),
        }
      }
    }
    Ok(())
  }
}
