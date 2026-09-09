// Path (b): a native view per video tile, over the webview
// (docs/prompts/video-next-stages-handoff.md §2.3, chosen by the maintainer
// on 2026-09-08 after the spike).
//
// Why a native view at all: carrying decoded frames *into* the page cost
// 2.4x what the webview transport costs for the same 720p tile (the
// handoff's §2.4, rows 7 to 9), and the page's half of that alone was over
// the bar, so no build profile could rescue it. Here a frame never leaves
// the process: the SDK's decoder hands it to a `NativeVideoStream`, it is
// packed into an NV12 pixel buffer and enqueued on an
// `AVSampleBufferDisplayLayer`, and the window server composites it. No
// IPC, no page paint, no copy into JavaScript.
//
// What it costs, read from AppKit during the spike and true by
// construction: the view sits **above everything the page draws**, at the
// end of the content view's subview list. So the page tells the shell two
// things per tile and the shell believes both: the rect (clipped to the
// tile's scroller, so a tile half under the header stays half under it)
// and whether the surface it belongs to is *covered* -- a Popover, the
// photo viewer, the incoming-call sheet over the call page. Those are
// decisions in `ui/back.ts` and the session; this file only hides and
// shows.
//
// Threads: every AppKit call goes through `run_on_main_thread`. The one
// exception is `enqueueSampleBuffer:`, which AVFoundation documents as
// callable from any thread and which runs on the frame task, because a
// main-thread hop per frame at 30 fps times N tiles is exactly the kind of
// tax (a) paid.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_frame::VideoRotation;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use livekit::webrtc::video_track::RtcVideoTrack;
use objc2::encode::{Encode, Encoding};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::{AppHandle, Manager};

use super::VoiceError;

// -- the C side --------------------------------------------------------------

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
  static kCFTypeDictionaryKeyCallBacks: c_void;
  static kCFTypeDictionaryValueCallBacks: c_void;
  static kCFBooleanTrue: *const c_void;
  fn CFRelease(cf: *const c_void);
  fn CFDictionaryCreateMutable(
    allocator: *const c_void,
    capacity: isize,
    key_callbacks: *const c_void,
    value_callbacks: *const c_void,
  ) -> *mut c_void;
  fn CFDictionarySetValue(dict: *mut c_void, key: *const c_void, value: *const c_void);
  fn CFNumberCreate(allocator: *const c_void, kind: isize, value: *const c_void) -> *mut c_void;
  fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
}

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
  static kCVPixelBufferPixelFormatTypeKey: *const c_void;
  static kCVPixelBufferWidthKey: *const c_void;
  static kCVPixelBufferHeightKey: *const c_void;
  static kCVPixelBufferIOSurfacePropertiesKey: *const c_void;
  fn CVPixelBufferPoolCreate(
    allocator: *const c_void,
    pool_attributes: *const c_void,
    pixel_buffer_attributes: *const c_void,
    out: *mut *mut c_void,
  ) -> i32;
  fn CVPixelBufferPoolCreatePixelBuffer(
    allocator: *const c_void,
    pool: *mut c_void,
    out: *mut *mut c_void,
  ) -> i32;
  fn CVPixelBufferLockBaseAddress(buffer: *mut c_void, flags: u64) -> i32;
  fn CVPixelBufferUnlockBaseAddress(buffer: *mut c_void, flags: u64) -> i32;
  fn CVPixelBufferGetBaseAddressOfPlane(buffer: *mut c_void, plane: usize) -> *mut u8;
  fn CVPixelBufferGetBytesPerRowOfPlane(buffer: *mut c_void, plane: usize) -> usize;
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
  value: i64,
  timescale: i32,
  flags: u32,
  epoch: i64,
}

/// `kCMTimeInvalid`: flags 0 means not valid, which is what an immediate
/// display wants -- the layer is told to show the frame now, not to place
/// it on a timeline.
const CM_TIME_INVALID: CMTime = CMTime { value: 0, timescale: 0, flags: 0, epoch: 0 };

#[repr(C)]
struct CMSampleTimingInfo {
  duration: CMTime,
  presentation: CMTime,
  decode: CMTime,
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
  static kCMSampleAttachmentKey_DisplayImmediately: *const c_void;
  fn CMVideoFormatDescriptionCreateForImageBuffer(
    allocator: *const c_void,
    image: *mut c_void,
    out: *mut *mut c_void,
  ) -> i32;
  fn CMSampleBufferCreateReadyWithImageBuffer(
    allocator: *const c_void,
    image: *mut c_void,
    format: *mut c_void,
    timing: *const CMSampleTimingInfo,
    out: *mut *mut c_void,
  ) -> i32;
  fn CMSampleBufferGetSampleAttachmentsArray(sample: *mut c_void, create: u8) -> *const c_void;
}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
  static AVLayerVideoGravityResizeAspect: *const AnyObject;
}

/// `CGAffineTransform`, for the rotation a phone's frame may carry.
#[repr(C)]
#[derive(Clone, Copy)]
struct CGAffineTransform {
  a: f64,
  b: f64,
  c: f64,
  d: f64,
  tx: f64,
  ty: f64,
}

// SAFETY: matches CoreGraphics' struct of six CGFloats.
unsafe impl Encode for CGAffineTransform {
  const ENCODING: Encoding = Encoding::Struct(
    "CGAffineTransform",
    &[Encoding::Double, Encoding::Double, Encoding::Double, Encoding::Double, Encoding::Double, Encoding::Double],
  );
}

fn rotation_transform(rotation: VideoRotation) -> CGAffineTransform {
  let radians = match rotation {
    VideoRotation::VideoRotation0 => 0.0,
    VideoRotation::VideoRotation90 => std::f64::consts::FRAC_PI_2,
    VideoRotation::VideoRotation180 => std::f64::consts::PI,
    VideoRotation::VideoRotation270 => -std::f64::consts::FRAC_PI_2,
  };
  let (sin, cos) = f64::sin_cos(radians);
  CGAffineTransform { a: cos, b: sin, c: -sin, d: cos, tx: 0.0, ty: 0.0 }
}

const FORMAT_420V: u32 = 0x3432_3076;
const CF_NUMBER_SINT32: isize = 3;

// -- a rect, as the page reports it --------------------------------------------

/// CSS pixels, origin top-left of the web view -- `getBoundingClientRect()`'s
/// frame. The flip into AppKit's bottom-left space happens here, against
/// the WKWebView's own frame, because that is arithmetic about the window
/// and nothing the page should know.
#[derive(serde::Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct PageRect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

/// One pixel-buffer pool per frame size, recreated when the size moves.
struct Pool {
  width: u32,
  height: u32,
  pool: *mut c_void,
  format: *mut c_void,
}

// SAFETY: the pool and the format description are CoreFoundation objects
// used from one task at a time.
unsafe impl Send for Pool {}

impl Drop for Pool {
  fn drop(&mut self) {
    // SAFETY: both were created by this struct.
    unsafe {
      if !self.pool.is_null() {
        CFRelease(self.pool);
      }
      if !self.format.is_null() {
        CFRelease(self.format);
      }
    }
  }
}

fn make_pool(width: u32, height: u32) -> Option<Pool> {
  // SAFETY: plain CoreFoundation dictionary building; every created object
  // is released here or owned by the pool.
  unsafe {
    let attrs = CFDictionaryCreateMutable(
      std::ptr::null(),
      4,
      &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks,
    );
    let format = FORMAT_420V as i32;
    let w = width as i32;
    let h = height as i32;
    let n_format = CFNumberCreate(std::ptr::null(), CF_NUMBER_SINT32, &format as *const i32 as *const c_void);
    let n_w = CFNumberCreate(std::ptr::null(), CF_NUMBER_SINT32, &w as *const i32 as *const c_void);
    let n_h = CFNumberCreate(std::ptr::null(), CF_NUMBER_SINT32, &h as *const i32 as *const c_void);
    // An empty IOSurface properties dictionary asks for IOSurface-backed
    // buffers, which is what lets the layer display without a copy.
    let surface = CFDictionaryCreateMutable(
      std::ptr::null(),
      0,
      &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks,
    );
    CFDictionarySetValue(attrs, kCVPixelBufferPixelFormatTypeKey, n_format);
    CFDictionarySetValue(attrs, kCVPixelBufferWidthKey, n_w);
    CFDictionarySetValue(attrs, kCVPixelBufferHeightKey, n_h);
    CFDictionarySetValue(attrs, kCVPixelBufferIOSurfacePropertiesKey, surface);
    let mut pool: *mut c_void = std::ptr::null_mut();
    let status = CVPixelBufferPoolCreate(std::ptr::null(), std::ptr::null(), attrs, &mut pool);
    CFRelease(n_format);
    CFRelease(n_w);
    CFRelease(n_h);
    CFRelease(surface);
    CFRelease(attrs);
    if status != 0 || pool.is_null() {
      log::warn!("voice: pixel buffer pool for {width}x{height} failed ({status})");
      return None;
    }
    Some(Pool { width, height, pool, format: std::ptr::null_mut() })
  }
}

// -- a tile ----------------------------------------------------------------------

/// The view pair and the layer, as raw retained pointers: created and
/// mutated on the main thread only, enqueued to from the frame task.
struct Views {
  container: usize,
  video: usize,
  layer: usize,
}

pub struct Tile {
  views: Arc<Mutex<Option<Views>>>,
  alive: Arc<AtomicBool>,
  /// The two reasons a tile is hidden, kept apart so one cannot undo the
  /// other: the page said it is off screen, or its surface is covered.
  visible: Arc<AtomicBool>,
  covered: Arc<AtomicBool>,
  /// Bound to a track and drawing. Off while the track is unsubscribed, so
  /// the page's placeholder shows through where a stale frame would sit.
  bound: Arc<AtomicBool>,
  pub frames: Arc<AtomicU64>,
  /// Frames the layer was not ready for.
  pub dropped: Arc<AtomicU64>,
  /// Frames not converted because nothing would have shown them: the tile
  /// was off screen, or its surface covered. A hidden tile costs a decode
  /// (the SDK's, unavoidable while subscribed) and nothing more.
  pub skipped: Arc<AtomicU64>,
  /// Rect reports received, for the log's first few.
  pub placements: Arc<AtomicU64>,
  task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
  app: AppHandle,
}

fn window_of(app: &AppHandle) -> Result<tauri::WebviewWindow, VoiceError> {
  app
    .get_webview_window("main")
    .or_else(|| app.webview_windows().into_values().next())
    .ok_or_else(|| VoiceError::new("no_window", "no window"))
}

/// The WKWebView's frame inside the content view, so a page rect can be
/// placed against the view it was measured in rather than the window.
unsafe fn webview_frame(content: *mut AnyObject) -> NSRect {
  let subviews: *mut AnyObject = msg_send![content, subviews];
  let count: usize = msg_send![subviews, count];
  for index in 0..count {
    let item: *mut AnyObject = msg_send![subviews, objectAtIndex: index];
    let name = (*item).class().name().to_string_lossy();
    if name.contains("WebView") {
      return msg_send![item, frame];
    }
  }
  msg_send![content, bounds]
}

impl Tile {
  /// Creates the views on the main thread, hidden, and binds nothing yet.
  pub fn create(app: &AppHandle) -> Result<Tile, VoiceError> {
    let window = window_of(app)?;
    let views: Arc<Mutex<Option<Views>>> = Arc::new(Mutex::new(None));
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let slot = views.clone();
    window
      .run_on_main_thread(move || {
        // SAFETY: on the main thread; AppKit objects created here are
        // retained by the hierarchy and by the raw pointers kept in `Views`.
        unsafe {
          let content = match content_view() {
            Some(view) => view,
            None => {
              let _ = tx.send(Err("no content view".into()));
              return;
            }
          };
          let zero = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
          let container: *mut AnyObject = msg_send![class!(NSView), alloc];
          let container: *mut AnyObject = msg_send![container, initWithFrame: zero];
          // macOS 14 made NSView stop clipping its subviews by default.
          let clips_selector = objc2::sel!(setClipsToBounds:);
          let responds: bool = msg_send![container, respondsToSelector: clips_selector];
          if responds {
            let _: () = msg_send![container, setClipsToBounds: true];
          }
          let _: () = msg_send![container, setHidden: true];

          let video: *mut AnyObject = msg_send![class!(NSView), alloc];
          let video: *mut AnyObject = msg_send![video, initWithFrame: zero];
          let layer: *mut AnyObject = msg_send![class!(AVSampleBufferDisplayLayer), new];
          let _: () = msg_send![layer, setVideoGravity: AVLayerVideoGravityResizeAspect];
          let black: *mut AnyObject = msg_send![class!(NSColor), blackColor];
          let cg: *mut AnyObject = msg_send![black, CGColor];
          let _: () = msg_send![layer, setBackgroundColor: cg];
          // Layer-hosting: the layer is set *before* wantsLayer, which is
          // what makes AppKit treat it as ours rather than its own backing.
          let _: () = msg_send![video, setLayer: layer];
          let _: () = msg_send![video, setWantsLayer: true];
          let _: () = msg_send![container, addSubview: video];
          let nil: *mut AnyObject = std::ptr::null_mut();
          // NSWindowAbove == 1: at the end of the list, above the webview.
          let _: () = msg_send![content, addSubview: container, positioned: 1isize, relativeTo: nil];
          *slot.lock().unwrap() = Some(Views {
            container: container as usize,
            video: video as usize,
            layer: layer as usize,
          });
          let _ = tx.send(Ok(()));
        }
      })
      .map_err(|e| VoiceError::new("main_thread", e.to_string()))?;
    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
      Ok(Ok(())) => {}
      Ok(Err(message)) => return Err(VoiceError::new("tile_failed", message)),
      Err(_) => return Err(VoiceError::new("tile_failed", "the main thread did not answer")),
    }
    Ok(Tile {
      views,
      alive: Arc::new(AtomicBool::new(true)),
      visible: Arc::new(AtomicBool::new(false)),
      covered: Arc::new(AtomicBool::new(false)),
      bound: Arc::new(AtomicBool::new(false)),
      frames: Arc::new(AtomicU64::new(0)),
      dropped: Arc::new(AtomicU64::new(0)),
      skipped: Arc::new(AtomicU64::new(0)),
      placements: Arc::new(AtomicU64::new(0)),
      task: Mutex::new(None),
      app: app.clone(),
    })
  }

  pub fn is_bound(&self) -> bool {
    self.bound.load(Ordering::Relaxed)
  }

  /// Starts drawing `track`'s frames. A tile already bound is rebound:
  /// the old task ends when its stream is dropped.
  pub fn bind(&self, track: RtcVideoTrack) {
    self.unbind();
    self.bound.store(true, Ordering::Relaxed);
    self.apply_hidden();
    let views = self.views.clone();
    let alive = self.alive.clone();
    let bound = self.bound.clone();
    let visible = self.visible.clone();
    let covered = self.covered.clone();
    let frames = self.frames.clone();
    let dropped = self.dropped.clone();
    let skipped = self.skipped.clone();
    let app = self.app.clone();
    let generation = Arc::new(AtomicBool::new(true));
    let mine = generation.clone();
    let task = tauri::async_runtime::spawn(async move {
      // Two frames of queue: a late frame is dropped rather than shown late.
      let mut stream = NativeVideoStream::new(track);
      let mut pool: Option<Pool> = None;
      let mut rotation = VideoRotation::VideoRotation0;
      let mut logged_status = false;
      let mut logged_kind = false;
      while let Some(frame) = stream.next().await {
        if !alive.load(Ordering::Relaxed) || !mine.load(Ordering::Relaxed) {
          break;
        }
        if !visible.load(Ordering::Relaxed) || covered.load(Ordering::Relaxed) {
          skipped.fetch_add(1, Ordering::Relaxed);
          continue;
        }
        if !logged_kind {
          logged_kind = true;
          log::info!("voice: tile frames arrive as {:?}", frame.buffer.buffer_type());
        }
        let layer = match views.lock().unwrap().as_ref() {
          Some(views) => views.layer,
          None => break,
        };
        if frame.rotation != rotation {
          rotation = frame.rotation;
          let transform = rotation_transform(rotation);
          let _ = app.run_on_main_thread(move || unsafe {
            let layer = layer as *mut AnyObject;
            let _: () = msg_send![layer, setAffineTransform: transform];
          });
        }
        // SAFETY: the layer pointer is retained for the tile's life and
        // enqueueSampleBuffer: is documented safe from any thread.
        unsafe {
          let layer = layer as *mut AnyObject;
          let ready: bool = msg_send![layer, isReadyForMoreMediaData];
          if !ready {
            dropped.fetch_add(1, Ordering::Relaxed);
            continue;
          }
          let (width, height) = (frame.buffer.width(), frame.buffer.height());
          if width == 0 || height == 0 {
            continue;
          }
          if pool.as_ref().map_or(true, |p| p.width != width || p.height != height) {
            pool = make_pool(width, height);
          }
          let Some(pool) = pool.as_mut() else { continue };
          let mut pixels: *mut c_void = std::ptr::null_mut();
          if CVPixelBufferPoolCreatePixelBuffer(std::ptr::null(), pool.pool, &mut pixels) != 0
            || pixels.is_null()
          {
            dropped.fetch_add(1, Ordering::Relaxed);
            continue;
          }
          if CVPixelBufferLockBaseAddress(pixels, 0) == 0 {
            let dst_y = CVPixelBufferGetBaseAddressOfPlane(pixels, 0);
            let dst_uv = CVPixelBufferGetBaseAddressOfPlane(pixels, 1);
            let stride_y = CVPixelBufferGetBytesPerRowOfPlane(pixels, 0);
            let stride_uv = CVPixelBufferGetBytesPerRowOfPlane(pixels, 1);
            let rows = height as usize;
            let chroma_rows = (height as usize + 1) / 2;
            let y_out = std::slice::from_raw_parts_mut(dst_y, stride_y * rows);
            let uv_out = std::slice::from_raw_parts_mut(dst_uv, stride_uv * chroma_rows);
            if let Some(nv12) = frame.buffer.as_nv12() {
              // Already the layer's format: two plane copies, no conversion.
              let (src_y, src_uv) = nv12.data();
              let (sy, suv) = nv12.strides();
              let w = width as usize;
              let cw = ((width as usize + 1) / 2) * 2;
              for row in 0..rows {
                y_out[row * stride_y..row * stride_y + w]
                  .copy_from_slice(&src_y[row * sy as usize..row * sy as usize + w]);
              }
              for row in 0..chroma_rows {
                uv_out[row * stride_uv..row * stride_uv + cw]
                  .copy_from_slice(&src_uv[row * suv as usize..row * suv as usize + cw]);
              }
            } else {
              let i420 = frame.buffer.to_i420();
              let (src_y, src_u, src_v) = i420.data();
              let (sy, su, sv) = i420.strides();
              yuv_helper::i420_to_nv12(
                src_y,
                sy,
                src_u,
                su,
                src_v,
                sv,
                y_out,
                stride_y as u32,
                uv_out,
                stride_uv as u32,
                width as i32,
                height as i32,
              );
            }
            CVPixelBufferUnlockBaseAddress(pixels, 0);
          }
          if pool.format.is_null() {
            let mut format: *mut c_void = std::ptr::null_mut();
            if CMVideoFormatDescriptionCreateForImageBuffer(std::ptr::null(), pixels, &mut format) == 0 {
              pool.format = format;
            }
          }
          if pool.format.is_null() {
            CFRelease(pixels);
            dropped.fetch_add(1, Ordering::Relaxed);
            continue;
          }
          let timing = CMSampleTimingInfo {
            duration: CM_TIME_INVALID,
            presentation: CM_TIME_INVALID,
            decode: CM_TIME_INVALID,
          };
          let mut sample: *mut c_void = std::ptr::null_mut();
          let status = CMSampleBufferCreateReadyWithImageBuffer(
            std::ptr::null(),
            pixels,
            pool.format,
            &timing,
            &mut sample,
          );
          CFRelease(pixels);
          if status != 0 || sample.is_null() {
            dropped.fetch_add(1, Ordering::Relaxed);
            continue;
          }
          let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, 1);
          if !attachments.is_null() {
            let first = CFArrayGetValueAtIndex(attachments, 0) as *mut c_void;
            if !first.is_null() {
              CFDictionarySetValue(first, kCMSampleAttachmentKey_DisplayImmediately, kCFBooleanTrue);
            }
          }
          let _: () = msg_send![layer, enqueueSampleBuffer: sample as *mut AnyObject];
          CFRelease(sample);
          let n = frames.fetch_add(1, Ordering::Relaxed) + 1;
          // AVQueuedSampleBufferRenderingStatus: 0 unknown, 1 rendering,
          // 2 failed. One line when it first renders, and a flush on failure
          // so a decoder hiccup does not wedge the layer for the call.
          let layer_status: isize = msg_send![layer, status];
          if layer_status == 2 {
            let error: *mut AnyObject = msg_send![layer, error];
            let description: *mut AnyObject =
              if error.is_null() { std::ptr::null_mut() } else { msg_send![error, localizedDescription] };
            let text = if description.is_null() {
              String::new()
            } else {
              (*(description as *const objc2_foundation::NSString)).to_string()
            };
            log::warn!("voice: tile layer failed after {n} frame(s): {text}; flushing");
            let _: () = msg_send![layer, flush];
          } else if layer_status == 1 && !logged_status {
            logged_status = true;
            log::info!("voice: tile rendering {width}x{height} natively");
          }
        }
      }
      bound.store(false, Ordering::Relaxed);
      log::debug!("voice: tile frame task ended after {} frame(s)", frames.load(Ordering::Relaxed));
    });
    let previous = self.task.lock().unwrap().replace(task);
    if let Some(previous) = previous {
      previous.abort();
    }
    // `generation` belongs to the new task; `unbind` above already ended
    // the previous one, and `abort` covers a frame that was mid-await.
    drop(generation);
  }

  /// Stops drawing; the view hides so the page's placeholder shows.
  pub fn unbind(&self) {
    if let Some(task) = self.task.lock().unwrap().take() {
      task.abort();
    }
    self.bound.store(false, Ordering::Relaxed);
    self.apply_hidden();
  }

  /// The page's report: where the tile is (`frame`), what it is clipped to
  /// (`clip`, its scroller), and whether it is on screen at all.
  pub fn set_rect(&self, clip: PageRect, frame: PageRect, visible: bool) {
    self.visible.store(visible, Ordering::Relaxed);
    let views = self.views.clone();
    let hidden = self.hidden();
    let _ = self.app.run_on_main_thread(move || unsafe {
      let Some(views) = views.lock().unwrap().as_ref().map(|v| (v.container, v.video, v.layer)) else {
        return;
      };
      let (container, video, layer) = views;
      let Some(content) = content_view() else { return };
      let web = webview_frame(content);
      // AppKit's origin is the bottom left of the content view; the page's
      // is the top left of the web view.
      let container_frame = NSRect::new(
        NSPoint::new(web.origin.x + clip.x, web.origin.y + web.size.height - (clip.y + clip.height)),
        NSSize::new(clip.width.max(0.0), clip.height.max(0.0)),
      );
      // The video view sits inside the container, offset by however much
      // the tile pokes out of its clip.
      let video_frame = NSRect::new(
        NSPoint::new(frame.x - clip.x, clip.height - (frame.y - clip.y + frame.height)),
        NSSize::new(frame.width.max(0.0), frame.height.max(0.0)),
      );
      let container = container as *mut AnyObject;
      let _: () = msg_send![container, setFrame: container_frame];
      let _: () = msg_send![video as *mut AnyObject, setFrame: video_frame];
      let _: () = msg_send![container, setHidden: hidden];
      // Sharp on a Retina display: the layer draws at the backing scale.
      let window: *mut AnyObject = msg_send![container, window];
      if !window.is_null() {
        let scale: f64 = msg_send![window, backingScaleFactor];
        let _: () = msg_send![layer as *mut AnyObject, setContentsScale: scale];
      }
    });
  }

  pub fn set_covered(&self, covered: bool) {
    self.covered.store(covered, Ordering::Relaxed);
    self.apply_hidden();
  }

  fn hidden(&self) -> bool {
    !self.visible.load(Ordering::Relaxed)
      || self.covered.load(Ordering::Relaxed)
      || !self.bound.load(Ordering::Relaxed)
  }

  fn apply_hidden(&self) {
    let views = self.views.clone();
    let hidden = self.hidden();
    let _ = self.app.run_on_main_thread(move || unsafe {
      if let Some(views) = views.lock().unwrap().as_ref() {
        let _: () = msg_send![views.container as *mut AnyObject, setHidden: hidden];
      }
    });
  }

  /// Tears the views down on the main thread and ends the frame task.
  pub fn destroy(self) {
    self.alive.store(false, Ordering::Relaxed);
    if let Some(task) = self.task.lock().unwrap().take() {
      task.abort();
    }
    let views = self.views.clone();
    let _ = self.app.run_on_main_thread(move || unsafe {
      if let Some(views) = views.lock().unwrap().take() {
        let container = views.container as *mut AnyObject;
        let layer = views.layer as *mut AnyObject;
        let _: () = msg_send![layer, flushAndRemoveImage];
        let _: () = msg_send![container, removeFromSuperview];
        // Balance the allocs in `create`: the hierarchy held its own
        // references and has let go; these are ours.
        let _: () = msg_send![views.video as *mut AnyObject, release];
        let _: () = msg_send![container, release];
        let _: () = msg_send![layer, release];
      }
    });
  }
}

/// The main window's content view. Main thread only.
unsafe fn content_view() -> Option<*mut AnyObject> {
  let app = slot_app();
  let window = window_of(&app).ok()?;
  let ns_window = window.ns_window().ok()? as *mut AnyObject;
  let content: *mut AnyObject = msg_send![ns_window, contentView];
  if content.is_null() {
    None
  } else {
    Some(content)
  }
}

/// The app handle, for main-thread closures that cannot capture one
/// through `run_on_main_thread`'s `Send` bound cleanly. Set once at setup.
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

pub fn remember_app(app: &AppHandle) {
  *APP.lock().unwrap() = Some(app.clone());
}

fn slot_app() -> AppHandle {
  APP.lock().unwrap().clone().expect("render::remember_app before any tile")
}
