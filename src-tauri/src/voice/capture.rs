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
// wrong on the platform in hand is not. Windows is deferred with the rest
// of native video there (video.rs's header), so nothing is lost today.
//
// The camera delivers NV12 (`420v`), and NV12 goes straight into the
// source: VideoToolbox encodes it without a conversion, which is the
// format the handoff's §3.2 hoped for.

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
  Sweep(Sweep),
  Screen(Screen),
}

impl Source {
  pub fn stop(self) {
    match self {
      #[cfg(target_os = "macos")]
      Source::Camera(camera) => camera.close(),
      Source::Sweep(sweep) => sweep.stop(),
      Source::Screen(screen) => screen.stop(),
    }
  }

  /// Frames delivered so far, for the log and the stats readout.
  pub fn frames(&self) -> u64 {
    match self {
      #[cfg(target_os = "macos")]
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

/// libwebrtc's desktop capturer on its own thread, converting each ARGB
/// frame to I420 for the source. On macOS the system picker is the
/// interface (`set_sck_system_picker`): the person picks a screen or a
/// window in the OS's own sheet, and the Screen Recording grant is the
/// bundle's. The first frame's size is reported once, because the source
/// and the publication want it and nothing knows it before the pick.
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
  /// `first` receives the first frame's `(width, height)`; the caller waits
  /// on it with a timeout that covers the picker. `target` is a size to
  /// scale every frame to before it reaches the source, set once the grant
  /// has been applied to the picked screen's size.
  pub fn start(
    fps: u32,
    slot: SourceSlot,
    target: Arc<Mutex<Option<(u32, u32)>>>,
    first: std::sync::mpsc::Sender<(u32, u32)>,
  ) -> Result<Screen, VoiceError> {
    let stop = Arc::new(AtomicBool::new(false));
    let frames = Arc::new(AtomicU64::new(0));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let join = {
      let stop = stop.clone();
      let frames = frames.clone();
      std::thread::Builder::new()
        .name("wherry-screen".into())
        .spawn(move || {
          let mut options = DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen);
          options.set_include_cursor(true);
          #[cfg(target_os = "macos")]
          options.set_sck_system_picker(true);
          let Some(mut capturer) = DesktopCapturer::new(options) else {
            let _ = ready_tx.send(Err("no desktop capturer on this platform".into()));
            return;
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
                let scaled = target.lock().unwrap().and_then(|(w, h)| {
                  (w != width as u32 || h != height as u32).then(|| buffer.scale(w as i32, h as i32))
                });
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
          capturer.start_capture(None, callback);
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
      Ok(Err(message)) => Err(VoiceError::new("screen_unsupported", message)),
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
