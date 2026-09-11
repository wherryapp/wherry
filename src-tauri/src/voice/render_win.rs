// Path (b) on Windows: a native child window per video tile, over
// WebView2 (docs/prompts/archive/w3-native-render-windows.md, stage W3).
//
// The argument is `render.rs`'s and is not repeated here: carrying decoded
// frames *into* the page cost 2.4x the webview transport for the same 720p
// tile (docs/prompts/video-next-stages-handoff.md §2.4), and the page's
// half alone was over the bar. Here a frame never leaves the process --
// the SDK's decoder hands it to a `NativeVideoStream`, it is converted to
// BGRA once and blitted into a child `HWND` that the desktop window
// manager composites over the web view.
//
// The window hierarchy this stands on (wry 0.55 hosts WebView2 *windowed*,
// not through the composition controller):
//
//   tao top-level HWND          the window Tauri gives us
//   +- wry child HWND           (0,0), parent-sized, WS_CHILD
//   |  +- Chrome_WidgetWin_...  WebView2's own window
//   +- WherryVideoTile          one of these per tile, ordered HWND_TOP
//
// So page CSS pixel (0,0) is client pixel (0,0) of the tao window and the
// only transform is the scale factor -- no origin flip, unlike macOS.
//
// What it costs, and it is the same bargain AppKit drove: the tile sits
// **above everything the page draws**, so the page tells the shell two
// things per tile and the shell believes both -- the rect (clipped to the
// tile's scroller, so a tile half under the header stays half under it)
// and whether the surface it belongs to is *covered* (a Popover, the photo
// viewer, the incoming-call sheet). Those are decisions in `ui/back.ts`
// and the session; this file only hides and shows. A tile is also never a
// control: `WM_NCHITTEST` answers `HTTRANSPARENT` so every click goes to
// the page underneath, which is where the pin button and the tile's own
// controls live.
//
// Threads: every `HWND` call goes through `run_on_main_thread`, because a
// window belongs to the thread that created it and the tao event-loop
// thread created all of these. The one exception is `InvalidateRect`,
// which is documented as callable from any thread (it posts), and which
// runs on the frame task -- a main-thread hop per frame at 30 fps times N
// tiles is exactly the tax path (a) paid. `UpdateWindow` is *not* an
// exception: it sends `WM_PAINT` synchronously and would deadlock against
// a main thread waiting on this tile's lock.
//
// Presenter: GDI (`StretchDIBits`) rather than D3D11, on purpose and with
// a number attached -- see the plan's §5. If D-50 reads over the 1.5x bar
// the D3D11 presenter is stage W3.2 and this path stays as the fallback
// for a machine whose driver cannot create a device.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::StreamExt;
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use livekit::webrtc::video_track::RtcVideoTrack;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
  BeginPaint, EndPaint, FillRect, GetStockObject, InvalidateRect, SetBrushOrgEx,
  SetStretchBltMode, StretchDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLACK_BRUSH,
  DIB_RGB_COLORS, HALFTONE, HBRUSH, PAINTSTRUCT, RGBQUAD, SRCCOPY,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
  CreateWindowExW, DefWindowProcW, DestroyWindow, EnumChildWindows, GetClassNameW, GetClientRect,
  GetParent, GetWindowLongPtrW, RegisterClassExW, SetWindowLongPtrW, SetWindowPos, ShowWindow,
  GWLP_USERDATA, GWL_STYLE, HTTRANSPARENT, HWND_TOP, MA_NOACTIVATE, SWP_FRAMECHANGED,
  SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE,
  SW_SHOWNA, WM_ERASEBKGND, WM_MOUSEACTIVATE, WM_NCHITTEST, WM_PAINT, WNDCLASSEXW, WS_CHILD,
  WS_CLIPSIBLINGS, WS_EX_NOACTIVATE,
};
use windows_core::PCWSTR;

use super::VoiceError;

// -- a rect, as the page reports it -------------------------------------------

/// CSS pixels, origin top-left of the web view -- `getBoundingClientRect()`'s
/// frame. On Windows the wry child fills the tao window's client area, so
/// the only transform into client pixels is the scale factor; the rounding
/// is done here rather than in the page, because it is arithmetic about
/// this window.
#[derive(serde::Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct PageRect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

// -- the window class ---------------------------------------------------------

/// The tile window class. Named rather than inlined because
/// `clip_siblings_of_tiles` has to recognise our own windows.
const TILE_CLASS: &str = "WherryVideoTile";

static CLASS_NAME: OnceLock<Vec<u16>> = OnceLock::new();
/// The registered atom, or 0 if the class already existed (which is
/// success -- a second tile in one process is the normal case).
static CLASS_ATOM: OnceLock<u16> = OnceLock::new();

fn class_name() -> PCWSTR {
  // The Vec lives in the static for the process, so the pointer is stable.
  PCWSTR(CLASS_NAME.get_or_init(|| format!("{TILE_CLASS}\0").encode_utf16().collect()).as_ptr())
}

/// Make every sibling of a tile clip around it.
///
/// **This is what makes the tile appear at all, and it was measured rather
/// than assumed** (stage W3.0, 2026-09-10). wry creates its WebView2 host
/// child with `WS_CHILD | WS_CLIPCHILDREN | WS_VISIBLE` and **no**
/// `WS_CLIPSIBLINGS`, so its painting is not clipped around siblings above
/// it in the z-order — it simply draws over them. A tile ordered
/// `HWND_TOP` was genuinely on top and genuinely painted (its own window
/// DC read magenta at every sample) and the page still won on screen.
/// Adding `WS_CLIPSIBLINGS` to that child is the whole fix; the four-way
/// isolation is in `docs/regression/desktop.md`, row D-44.
///
/// Applied to every direct child that is not one of ours, rather than to a
/// window found by class name, because the rule is about sibling z-order
/// and not about wry: anything that shares a parent with a tile has to
/// clip around it. `WS_CLIPCHILDREN` on the *top-level* window was
/// measured in the same run and makes no difference to visibility; it is
/// left to the flicker reading (R4) rather than set on spec.
fn clip_siblings_of_tiles(parent: HWND) {
  // SAFETY: main thread; read-modify-write of a style on windows owned by
  // this process, and a no-op where the bit is already set.
  unsafe {
    unsafe extern "system" fn each(child: HWND, parent: LPARAM) -> windows_core::BOOL {
      // `EnumChildWindows` walks every descendant; only a *sibling* of a
      // tile can paint over one, so the grandchildren are skipped.
      if GetParent(child).map(|p| p.0 as isize).unwrap_or(0) != parent.0 {
        return windows_core::BOOL(1);
      }
      let mut name = [0u16; 64];
      let n = GetClassNameW(child, &mut name) as usize;
      if String::from_utf16_lossy(&name[..n]) == TILE_CLASS {
        return windows_core::BOOL(1);
      }
      let style = GetWindowLongPtrW(child, GWL_STYLE);
      if style & WS_CLIPSIBLINGS.0 as isize != 0 {
        return windows_core::BOOL(1);
      }
      SetWindowLongPtrW(child, GWL_STYLE, style | WS_CLIPSIBLINGS.0 as isize);
      // The style takes effect on the next frame change, not on the write.
      let _ = SetWindowPos(
        child,
        None,
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
      );
      log::info!("voice: tile — gave sibling {} WS_CLIPSIBLINGS", String::from_utf16_lossy(&name[..n]));
      windows_core::BOOL(1)
    }
    let _ = EnumChildWindows(Some(parent), Some(each), LPARAM(parent.0 as isize));
  }
}

fn ensure_class() -> u16 {
  *CLASS_ATOM.get_or_init(|| {
    // SAFETY: a plain class registration; every pointer is either null or
    // the static name above.
    unsafe {
      let instance: HINSTANCE = GetModuleHandleW(PCWSTR::null()).map(|h| HINSTANCE(h.0)).unwrap_or_default();
      let class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(wnd_proc),
        hInstance: instance,
        lpszClassName: class_name(),
        // Null: the paint covers the whole client area itself, and a
        // background brush is one more thing that can flash.
        hbrBackground: HBRUSH(std::ptr::null_mut()),
        ..Default::default()
      };
      RegisterClassExW(&class)
    }
  })
}

// -- what the window proc and the frame task share ---------------------------

/// One converted frame, top-down BGRA, stride = width * 4.
struct Frame {
  width: u32,
  height: u32,
  bgra: Vec<u8>,
}

/// Handed to the window through `GWLP_USERDATA` as a leaked `Arc`, and
/// reclaimed at `destroy`. Everything the paint needs and nothing else, so
/// `WndProc` needs no global table.
struct Shared {
  /// The latest converted frame, waiting for a paint.
  back: Mutex<Option<Frame>>,
  /// Where the picture goes *inside* the window, physical px:
  /// (x, y, width, height). Usually (0, 0, w, h) — the window *is* the
  /// tile — and offset only when the tile pokes out of its scroller, since
  /// the window is then the visible part and the picture starts above or
  /// left of it.
  video: Mutex<(i32, i32, i32, i32)>,
  /// A frame is in `back` that no paint has consumed yet. A second frame
  /// arriving on top of it is a real drop, and this is how it is counted.
  pending: AtomicBool,
  /// Frames blitted, shared with the `Tile` that owns this. Incremented by
  /// the paint rather than by the frame task, so it counts pictures that
  /// reached the screen.
  frames: Arc<AtomicU64>,
}

impl Shared {
  fn new(frames: Arc<AtomicU64>) -> Shared {
    Shared {
      back: Mutex::new(None),
      video: Mutex::new((0, 0, 0, 0)),
      pending: AtomicBool::new(false),
      frames,
    }
  }
}

/// The window proc. Four messages; everything else is the default.
///
/// SAFETY: called by the window manager on the thread that created the
/// window. `GWLP_USERDATA` holds an `Arc<Shared>` pointer that outlives
/// every message, because `destroy` reclaims it only after `DestroyWindow`.
unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  match msg {
    // Never erase: the paint below covers the whole client area, and an
    // erase is what makes a child flicker under a resizing parent.
    WM_ERASEBKGND => LRESULT(1),
    // A tile is a picture, not a control. The click belongs to the page.
    WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
    // **Refuse activation explicitly, or a click wedges the whole window.**
    //
    // Measured 2026-09-11: clicking a tile left the desktop with *no*
    // foreground window at all -- a sampler caught the active window
    // dropping to none, twice -- after which the shell took no input of any
    // kind. Buttons, title bar and keyboard all dead, while the process
    // answered messages in single-digit milliseconds, reported itself
    // unhung, held no capture and went on drawing at 30 fps. Alt+Tab
    // restored it every time; clicking the window never did.
    //
    // Both halves were already here. The window is created
    // `WS_EX_NOACTIVATE`, so it must not become active; but without this
    // arm `DefWindowProcW` answers `WM_MOUSEACTIVATE` with `MA_ACTIVATE`,
    // so the click takes activation away from whatever held it and hands
    // it to a window that refuses it. Nothing ends up active and the app
    // cannot recover itself, because recovering would need a click it can
    // no longer receive. `MA_NOACTIVATE` stops the attempt being made:
    // the message is not passed up the parent chain, no activation is
    // tried, and whatever was active stays active.
    //
    // Not `MA_NOACTIVATEANDEAT`, which would also swallow the mouse
    // message. This window already answers `HTTRANSPARENT`, so the click
    // should carry on to whatever is underneath rather than be eaten here.
    //
    // macOS cannot have this defect: `render.rs`'s tile is an `NSView`
    // inside the app's own window, not a window with its own activation.
    WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
    WM_PAINT => {
      let shared = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
      let mut ps = PAINTSTRUCT::default();
      let hdc = BeginPaint(hwnd, &mut ps);
      let mut client = RECT::default();
      let _ = GetClientRect(hwnd, &mut client);
      let black = HBRUSH(GetStockObject(BLACK_BRUSH).0);
      FillRect(hdc, &client, black);
      if shared != 0 {
        let shared = &*(shared as *const Shared);
        let mut blitted = false;
        let (vx, vy, vw, vh) = *shared.video.lock().unwrap();
        if let Some(frame) = shared.back.lock().unwrap().as_ref() {
          if vw > 0 && vh > 0 && frame.width > 0 && frame.height > 0 {
            // Aspect fit, letterboxed -- the `AVLayerVideoGravityResizeAspect`
            // equivalent. The bars are already black from the fill above.
            let fw = frame.width as f64;
            let fh = frame.height as f64;
            let scale = (vw as f64 / fw).min(vh as f64 / fh);
            let dw = (fw * scale).round().max(1.0) as i32;
            let dh = (fh * scale).round().max(1.0) as i32;
            let dx = vx + (vw - dw) / 2;
            let dy = vy + (vh - dh) / 2;
            // HALFTONE is the good downscale; COLORONCOLOR is the cheap one
            // and the single-identifier lever if D-50 reads over the bar.
            SetStretchBltMode(hdc, HALFTONE);
            let _ = SetBrushOrgEx(hdc, 0, 0, None);
            let info = bitmap_info(frame.width, frame.height);
            blitted = StretchDIBits(
              hdc,
              dx,
              dy,
              dw,
              dh,
              0,
              0,
              frame.width as i32,
              frame.height as i32,
              Some(frame.bgra.as_ptr() as *const c_void),
              &info,
              DIB_RGB_COLORS,
              SRCCOPY,
            ) > 0;
          }
        }
        // `frames` is counted **here**, not on the frame task, and only when
        // a blit really ran and consumed a frame no paint had taken yet. It
        // then means what macOS's does -- pictures that reached the screen,
        // disjoint from `dropped` -- so `native_summary`'s `drawn` and rows
        // D-30/D-47 read the same quantity on both platforms. Counting on
        // the task instead would report 30/s while the screen held one
        // frozen picture, which is the failure the number exists to catch.
        if blitted && shared.pending.swap(false, Ordering::Relaxed) {
          shared.frames.fetch_add(1, Ordering::Relaxed);
        }
      }
      let _ = EndPaint(hwnd, &ps);
      LRESULT(0)
    }
    _ => DefWindowProcW(hwnd, msg, wparam, lparam),
  }
}

/// Top-down 32-bit BGRA: a negative height is how `BI_RGB` is told the
/// first row in memory is the top row, which is the order libyuv writes.
fn bitmap_info(width: u32, height: u32) -> BITMAPINFO {
  BITMAPINFO {
    bmiHeader: BITMAPINFOHEADER {
      biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
      biWidth: width as i32,
      biHeight: -(height as i32),
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB.0,
      ..Default::default()
    },
    bmiColors: [RGBQUAD::default(); 1],
  }
}

// -- a tile ------------------------------------------------------------------

/// The child window, as a raw handle: created and mutated on the main
/// thread only, invalidated from the frame task. `usize` rather than
/// `HWND` because the closures that carry it must be `Send`.
struct Views {
  hwnd: usize,
  /// The leaked `Arc<Shared>` given to the window, reclaimed at destroy.
  shared_ptr: usize,
}

pub struct Tile {
  views: Arc<Mutex<Option<Views>>>,
  shared: Arc<Shared>,
  alive: Arc<AtomicBool>,
  /// The two reasons a tile is hidden, kept apart so one cannot undo the
  /// other: the page said it is off screen, or its surface is covered.
  visible: Arc<AtomicBool>,
  covered: Arc<AtomicBool>,
  /// Bound to a track and drawing. Off while the track is unsubscribed, so
  /// the page's placeholder shows through where a stale frame would sit.
  bound: Arc<AtomicBool>,
  pub frames: Arc<AtomicU64>,
  /// Frames that arrived on top of one no paint had taken yet, plus any
  /// the conversion could not use.
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

/// The three reasons a tile is hidden, kept apart so one cannot undo
/// another: the page said it is off screen (or its visible area is empty),
/// its surface is covered, or it is bound to nothing. Free-standing so
/// both `set_rect` and `apply_hidden` can evaluate it on the thread that
/// acts on the answer rather than on the thread that asked.
fn hidden_from(visible: &AtomicBool, covered: &AtomicBool, bound: &AtomicBool) -> bool {
  !visible.load(Ordering::Relaxed) || covered.load(Ordering::Relaxed) || !bound.load(Ordering::Relaxed)
}

fn window_of(app: &AppHandle) -> Result<tauri::WebviewWindow, VoiceError> {
  app
    .get_webview_window("main")
    .or_else(|| app.webview_windows().into_values().next())
    .ok_or_else(|| VoiceError::new("no_window", "no window"))
}

impl Tile {
  /// Creates the child window on the main thread, hidden, bound to nothing.
  pub fn create(app: &AppHandle) -> Result<Tile, VoiceError> {
    let window = window_of(app)?;
    let parent = window
      .hwnd()
      .map_err(|e| VoiceError::new("no_window", e.to_string()))?
      .0 as usize;
    let frames = Arc::new(AtomicU64::new(0));
    let shared = Arc::new(Shared::new(frames.clone()));
    let views: Arc<Mutex<Option<Views>>> = Arc::new(Mutex::new(None));
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let slot = views.clone();
    let for_window = shared.clone();
    window
      .run_on_main_thread(move || {
        // SAFETY: on the thread that owns the parent window; the created
        // window is owned by this tile until `destroy`.
        unsafe {
          let atom = ensure_class();
          // Before the first tile and cheap after it: a sibling without
          // WS_CLIPSIBLINGS paints straight over us (see the fn's note).
          clip_siblings_of_tiles(HWND(parent as *mut c_void));
          let instance: HINSTANCE =
            GetModuleHandleW(PCWSTR::null()).map(|h| HINSTANCE(h.0)).unwrap_or_default();
          // `WS_EX_NOACTIVATE` so a click that somehow does reach the tile
          // never takes focus off the page. No `WS_VISIBLE`: the first
          // `set_rect` shows it, and a window shown before it has been
          // placed flashes at (0,0).
          let created = CreateWindowExW(
            WS_EX_NOACTIVATE,
            class_name(),
            PCWSTR::null(),
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            Some(HWND(parent as *mut c_void)),
            None,
            Some(instance),
            None,
          );
          let hwnd = match created {
            Ok(hwnd) if !hwnd.0.is_null() => hwnd,
            Ok(_) => {
              let _ = tx.send(Err("CreateWindowExW returned null".into()));
              return;
            }
            Err(e) => {
              let _ = tx.send(Err(format!("CreateWindowExW failed (class atom {atom}): {e}")));
              return;
            }
          };
          let shared_ptr = Arc::into_raw(for_window) as usize;
          SetWindowLongPtrW(hwnd, GWLP_USERDATA, shared_ptr as isize);
          // Above the wry child, which is its sibling.
          let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
          );
          *slot.lock().unwrap() = Some(Views { hwnd: hwnd.0 as usize, shared_ptr });
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
      shared,
      alive: Arc::new(AtomicBool::new(true)),
      visible: Arc::new(AtomicBool::new(false)),
      covered: Arc::new(AtomicBool::new(false)),
      bound: Arc::new(AtomicBool::new(false)),
      frames,
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

  /// Starts drawing `track`'s frames. A tile already bound is rebound: the
  /// old task ends when its stream is dropped.
  pub fn bind(&self, track: RtcVideoTrack) {
    self.unbind();
    self.bound.store(true, Ordering::Relaxed);
    self.apply_hidden();
    let views = self.views.clone();
    let shared = self.shared.clone();
    let alive = self.alive.clone();
    let bound = self.bound.clone();
    let visible = self.visible.clone();
    let covered = self.covered.clone();
    let frames = self.frames.clone();
    let dropped = self.dropped.clone();
    let skipped = self.skipped.clone();
    let generation = Arc::new(AtomicBool::new(true));
    let mine = generation.clone();
    let task = tauri::async_runtime::spawn(async move {
      let mut stream = NativeVideoStream::new(track);
      // Scratch NV12, reused across frames of the same size. The SDK
      // exposes no I420->BGRA in one pass (`VideoBuffer::to_argb` is
      // sealed and `yuv_helper` has no `i420_to_argb`), so NV12 is the
      // intermediate -- which is also the format a hardware decoder
      // already hands us, in which case the first pass is skipped.
      let mut nv12: Vec<u8> = Vec::new();
      let mut offered = 0u64;
      let mut logged_kind = false;
      let mut logged_render = false;
      let mut logged_rotation = false;
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
        if !logged_rotation && frame.rotation != livekit::webrtc::video_frame::VideoRotation::VideoRotation0 {
          logged_rotation = true;
          // Ignored in W3.1 on purpose: desktop cameras do not rotate, and
          // a rotated tile is regression row D-53, not a feature yet.
          log::info!("voice: tile frame rotation {:?} ignored", frame.rotation);
        }
        let hwnd = match views.lock().unwrap().as_ref() {
          Some(views) => views.hwnd,
          None => break,
        };
        let (width, height) = (frame.buffer.width(), frame.buffer.height());
        if width == 0 || height == 0 {
          continue;
        }
        let stride = width as usize * 4;
        let mut bgra = vec![0u8; stride * height as usize];
        let converted = convert(&frame.buffer, width, height, &mut nv12, &mut bgra, stride as u32);
        if !converted {
          dropped.fetch_add(1, Ordering::Relaxed);
          continue;
        }
        // A frame landing on one no paint has taken is a real drop; the
        // newer picture is the right one to keep.
        if shared.pending.swap(true, Ordering::Relaxed) {
          dropped.fetch_add(1, Ordering::Relaxed);
        }
        *shared.back.lock().unwrap() = Some(Frame { width, height, bgra });
        offered += 1;
        // SAFETY: documented as callable from any thread -- it posts to
        // the owning thread rather than sending.
        unsafe {
          let _ = InvalidateRect(Some(HWND(hwnd as *mut c_void)), None, false);
        }
        // The picture is on screen when a *blit* has happened, which only
        // the paint knows -- the macOS twin reads the layer's own status
        // for the same reason.
        if !logged_render && frames.load(Ordering::Relaxed) > 0 {
          logged_render = true;
          log::info!("voice: tile rendering {width}x{height} natively");
        }
        if offered == 300 && !logged_render {
          log::warn!("voice: tile has offered {offered} frame(s) and none has been drawn; the window is not being served");
        }
      }
      bound.store(false, Ordering::Relaxed);
      log::debug!(
        "voice: tile frame task ended after {} offered, {} drawn",
        offered,
        frames.load(Ordering::Relaxed)
      );
    });
    let previous = self.task.lock().unwrap().replace(task);
    if let Some(previous) = previous {
      previous.abort();
    }
    drop(generation);
  }

  /// Stops drawing; the window hides so the page's placeholder shows.
  pub fn unbind(&self) {
    if let Some(task) = self.task.lock().unwrap().take() {
      task.abort();
    }
    self.bound.store(false, Ordering::Relaxed);
    self.apply_hidden();
  }

  /// The page's report: where the tile is (`frame`), what it is clipped to
  /// (`clip`, its scroller), and whether it is on screen at all.
  ///
  /// **The window is `frame` ∩ `clip`, not `clip`** — the visible part of
  /// this one tile. macOS can afford a clip-sized container because an
  /// `NSView` is transparent where nothing is drawn; an `HWND` is not, so a
  /// window the size of the scroller would paint its letterbox black over
  /// every other tile in the grid, and every tile would be placed at the
  /// same rect and `HWND_TOP` with only the last one visible. The
  /// intersection gives the same clipping — a tile half under the header
  /// stays half under it, because the window simply ends there — and each
  /// tile occupies only its own area.
  pub fn set_rect(&self, clip: PageRect, frame: PageRect, visible: bool) {
    // The physical rects are computed here rather than in the closure so
    // "is there anything to show?" is part of `visible`, and so a hidden
    // window is still *placed* (a show would otherwise flash it at its old
    // rect for one frame).
    let scale = window_of(&self.app).ok().and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
    // Round the tile's own edges rather than an offset from the clip, so
    // the picture lands on the same physical pixel as the page's
    // placeholder whatever the clip's fractional origin is.
    let fx = (frame.x * scale).round() as i32;
    let fy = (frame.y * scale).round() as i32;
    let fw = (frame.width.max(0.0) * scale).round() as i32;
    let fh = (frame.height.max(0.0) * scale).round() as i32;
    // The clip rounds outward: a tile never loses a row to rounding and
    // then shows a line of page through the gap.
    let cx0 = (clip.x * scale).floor() as i32;
    let cy0 = (clip.y * scale).floor() as i32;
    let cx1 = ((clip.x + clip.width.max(0.0)) * scale).ceil() as i32;
    let cy1 = ((clip.y + clip.height.max(0.0)) * scale).ceil() as i32;
    let left = fx.max(cx0);
    let top = fy.max(cy0);
    let width = (fx + fw).min(cx1) - left;
    let height = (fy + fh).min(cy1) - top;
    let empty = width <= 0 || height <= 0;
    // A tile scrolled entirely out of its scroller is off screen as surely
    // as one the page called invisible, and folding it in here is what
    // keeps `hidden()` the only place three reasons are combined.
    self.visible.store(visible && !empty, Ordering::Relaxed);
    let views = self.views.clone();
    let shared = self.shared.clone();
    let (vis, cov, bound) = (self.visible.clone(), self.covered.clone(), self.bound.clone());
    let _ = self.app.run_on_main_thread(move || {
      let Some(hwnd) = views.lock().unwrap().as_ref().map(|v| v.hwnd) else {
        return;
      };
      // The picture's origin relative to the window: zero unless the tile
      // pokes out of its scroller, in which case it starts off the window.
      *shared.video.lock().unwrap() = (fx - left, fy - top, fw, fh);
      // Read the three reasons *here*, not on the calling thread: a hide
      // decided on the main thread can otherwise be overwritten by an
      // older show a tokio worker queued before it.
      let hidden = hidden_from(&vis, &cov, &bound);
      // SAFETY: on the thread that created the window.
      unsafe {
        let hwnd = HWND(hwnd as *mut c_void);
        // `HWND_TOP` on every placement is the cheap insurance against
        // WebView2 re-asserting its own child on focus or resize, and the
        // page reports a rect on resize and scroll anyway.
        let show = if hidden { SWP_HIDEWINDOW } else { SWP_SHOWWINDOW };
        let _ = SetWindowPos(
          hwnd,
          Some(HWND_TOP),
          left,
          top,
          width.max(0),
          height.max(0),
          SWP_NOACTIVATE | show,
        );
        let _ = InvalidateRect(Some(hwnd), None, false);
      }
    });
  }

  pub fn set_covered(&self, covered: bool) {
    self.covered.store(covered, Ordering::Relaxed);
    self.apply_hidden();
  }

  fn apply_hidden(&self) {
    let views = self.views.clone();
    let (vis, cov, bound) = (self.visible.clone(), self.covered.clone(), self.bound.clone());
    let _ = self.app.run_on_main_thread(move || {
      let Some(hwnd) = views.lock().unwrap().as_ref().map(|v| v.hwnd) else {
        return;
      };
      // Decided on the thread that will act on it. `run_on_main_thread`
      // runs inline from the main thread and *posts* from a tokio worker,
      // so a snapshot taken by the caller can be applied out of order --
      // a worker's stale "show" landing after the main thread's "hide"
      // would leave a tile over the Popover that hid it.
      let hidden = hidden_from(&vis, &cov, &bound);
      // SAFETY: on the thread that created the window.
      unsafe {
        let hwnd = HWND(hwnd as *mut c_void);
        if !hidden {
          // Re-assert the z-order on the way back up: a show is the only
          // path that does not go through `set_rect`, and the page sends
          // no fresh rect when a Popover merely opens and closes.
          let _ =
            SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
        let _ = ShowWindow(hwnd, if hidden { SW_HIDE } else { SW_SHOWNA });
      }
    });
  }

  /// Tears the window down on the main thread and ends the frame task.
  pub fn destroy(self) {
    self.alive.store(false, Ordering::Relaxed);
    if let Some(task) = self.task.lock().unwrap().take() {
      task.abort();
    }
    let views = self.views.clone();
    let _ = self.app.run_on_main_thread(move || {
      let Some(views) = views.lock().unwrap().take() else {
        return;
      };
      // SAFETY: destroyed by the thread that created it, which is the only
      // thread that can. The shared pointer is reclaimed *after* the
      // window is gone, so no window proc can be running against it.
      unsafe {
        let hwnd = HWND(views.hwnd as *mut c_void);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        let _ = DestroyWindow(hwnd);
        drop(Arc::from_raw(views.shared_ptr as *const Shared));
      }
    });
  }
}

/// I420 or NV12 in, top-down BGRA out. `false` means the frame could not
/// be used, which the caller counts as dropped.
///
/// libyuv names by register order and GDI by memory order, so libyuv's
/// "ARGB" *is* BGRA in memory on a little-endian machine, which is exactly
/// what a 32-bit `BI_RGB` bitmap expects. If faces come out blue, the
/// answer is `nv12_to_abgr` -- one identifier, and not the bitmap header.
fn convert(
  buffer: &livekit::webrtc::video_frame::BoxVideoBuffer,
  width: u32,
  height: u32,
  nv12: &mut Vec<u8>,
  bgra: &mut [u8],
  stride: u32,
) -> bool {
  if let Some(source) = buffer.as_nv12() {
    let (src_y, src_uv) = source.data();
    let (sy, suv) = source.strides();
    yuv_helper::nv12_to_argb(src_y, sy, src_uv, suv, bgra, stride, width as i32, height as i32);
    return true;
  }
  let i420 = buffer.to_i420();
  let (src_y, src_u, src_v) = i420.data();
  let (sy, su, sv) = i420.strides();
  let rows = height as usize;
  let chroma_rows = (height as usize + 1) / 2;
  let stride_y = width as usize;
  // NV12's UV plane is interleaved, so its stride is the full width
  // rounded up to an even number of samples.
  let stride_uv = ((width as usize + 1) / 2) * 2;
  let needed = stride_y * rows + stride_uv * chroma_rows;
  if nv12.len() != needed {
    nv12.clear();
    nv12.resize(needed, 0);
  }
  let (plane_y, plane_uv) = nv12.split_at_mut(stride_y * rows);
  yuv_helper::i420_to_nv12(
    src_y,
    sy,
    src_u,
    su,
    src_v,
    sv,
    plane_y,
    stride_y as u32,
    plane_uv,
    stride_uv as u32,
    width as i32,
    height as i32,
  );
  yuv_helper::nv12_to_argb(
    plane_y,
    stride_y as u32,
    plane_uv,
    stride_uv as u32,
    bgra,
    stride,
    width as i32,
    height as i32,
  );
  true
}

/// The app handle, for helpers that cannot capture one. Set once at setup.
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

pub fn remember_app(app: &AppHandle) {
  *APP.lock().unwrap() = Some(app.clone());
}

// -- the W3.0 spike ----------------------------------------------------------

/// `WHERRY_DEV_TILE=1`: one magenta tile at boot, no call, no track. It
/// answers the five readings the plan's §3 asks for (R1 to R5) before any
/// frame path stands on them, and it is the production path apart from the
/// picture -- the same class, the same placement, the same hit testing.
///
/// Debug builds only, like every other `WHERRY_*` knob.
#[cfg(debug_assertions)]
pub fn dev_tile(app: &AppHandle) {
  use windows::Win32::Graphics::Gdi::ClientToScreen;
  use windows::Win32::UI::HiDpi::GetDpiForWindow;
  use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW as GetStyle, GetWindowRect, IsWindowVisible,
  };

  let app = app.clone();
  // Off the main thread and after the event loop is running: `create`
  // waits on a main-thread closure, so calling it *from* setup would time
  // out against an event loop that has not started.
  std::thread::spawn(move || {
    std::thread::sleep(std::time::Duration::from_secs(2));
    let Ok(window) = window_of(&app) else {
      log::warn!("voice: dev tile has no window");
      return;
    };
    let Ok(parent) = window.hwnd() else {
      log::warn!("voice: dev tile has no hwnd");
      return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let parent_raw = parent.0 as usize;
    // SAFETY: read-only window queries; `EnumChildWindows` calls back on
    // this thread.
    unsafe {
      let parent = HWND(parent_raw as *mut c_void);
      let style = GetStyle(parent, GWL_STYLE);
      let dpi = GetDpiForWindow(parent);
      let mut client = RECT::default();
      let _ = GetClientRect(parent, &mut client);
      log::info!(
        "voice: dev tile -- tao style 0x{style:x} (WS_CLIPCHILDREN {}), client (0,0)-({},{}) dpi {dpi} scale {scale}",
        if style & 0x0200_0000 != 0 { "set" } else { "absent" },
        client.right,
        client.bottom
      );
      unsafe extern "system" fn each(child: HWND, parent: LPARAM) -> windows_core::BOOL {
        let parent = HWND(parent.0 as *mut c_void);
        let direct = GetParent(child).map(|p| p.0 as isize).unwrap_or(0) == parent.0 as isize;
        let mut name = [0u16; 128];
        let n = GetClassNameW(child, &mut name) as usize;
        let class = String::from_utf16_lossy(&name[..n]);
        let mut rect = RECT::default();
        let _ = GetWindowRect(child, &mut rect);
        // Into the parent's *client* space, which is the space a PageRect
        // is in. The two matching is what makes "no origin offset" true.
        let mut origin = windows::Win32::Foundation::POINT { x: 0, y: 0 };
        let _ = ClientToScreen(parent, &mut origin);
        let style = GetWindowLongPtrW(child, GWL_STYLE);
        log::info!(
          "voice: dev tile -- {} {class} at client ({},{})-({},{}) style 0x{style:x} (WS_CLIPSIBLINGS {})",
          if direct { "child" } else { "descendant" },
          rect.left - origin.x,
          rect.top - origin.y,
          rect.right - origin.x,
          rect.bottom - origin.y,
          if style & WS_CLIPSIBLINGS.0 as isize != 0 { "set" } else { "absent" }
        );
        windows_core::BOOL(1)
      }
      let _ = EnumChildWindows(Some(parent), Some(each), LPARAM(parent_raw as isize));
    }

    let tile = match Tile::create(&app) {
      Ok(tile) => tile,
      Err(e) => {
        log::warn!("voice: dev tile failed: {}", e.message);
        return;
      }
    };
    // Magenta, 320x180 CSS px at (40,120) -- the plan's coordinates, so a
    // screenshot can be compared against a page element at the same place.
    let (w, h) = (320u32, 180u32);
    let mut bgra = vec![0u8; (w * h * 4) as usize];
    for pixel in bgra.chunks_exact_mut(4) {
      pixel[0] = 255; // B
      pixel[1] = 0; // G
      pixel[2] = 255; // R
      pixel[3] = 255;
    }
    *tile.shared.back.lock().unwrap() = Some(Frame { width: w, height: h, bgra });
    tile.shared.pending.store(true, Ordering::Relaxed);
    tile.bound.store(true, Ordering::Relaxed);
    let rect = PageRect { x: 40.0, y: 120.0, width: w as f64, height: h as f64 };
    tile.set_rect(rect, rect, true);
    log::info!("voice: dev tile -- magenta 320x180 at CSS (40,120), HWND_TOP, HTTRANSPARENT");
    // A second later, what actually happened: the placement, whether the
    // window is visible, and whether a paint has been served. Painting and
    // *appearing* are two different readings on this platform, which is
    // the whole finding of W3.0 -- so log both.
    std::thread::sleep(std::time::Duration::from_secs(1));
    let hwnd = tile.views.lock().unwrap().as_ref().map(|v| v.hwnd).unwrap_or(0);
    // SAFETY: read-only queries on a window this process owns.
    unsafe {
      let hwnd = HWND(hwnd as *mut c_void);
      let mut rect = RECT::default();
      let _ = GetWindowRect(hwnd, &mut rect);
      let mut origin = windows::Win32::Foundation::POINT { x: 0, y: 0 };
      let _ = ClientToScreen(HWND(parent_raw as *mut c_void), &mut origin);
      log::info!(
        "voice: dev tile -- placed at client ({},{})-({},{}), visible {}, {} frame(s) drawn",
        rect.left - origin.x,
        rect.top - origin.y,
        rect.right - origin.x,
        rect.bottom - origin.y,
        IsWindowVisible(hwnd).as_bool(),
        tile.frames.load(Ordering::Relaxed)
      );
    }
    // `WHERRY_DEV_TILE=sweep` goes further: a real `RtcVideoTrack` fed by
    // capture.rs's synthetic sweep, bound to the tile through the same
    // `NativeVideoStream` a peer's camera arrives on. No room, no network,
    // nobody else's account — so the whole frame path (I420 in, NV12,
    // BGRA, `StretchDIBits`, the counters) can be exercised on a machine
    // with one person at it. The picture is a bright bar crossing a dark
    // field, moving, which is what tells a live decode from a stuck frame.
    if std::env::var("WHERRY_DEV_TILE").ok().as_deref() == Some("sweep") {
      use livekit::track::LocalVideoTrack;
      use livekit::webrtc::video_source::native::NativeVideoSource;
      use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};

      let (w, h) = (640u32, 360u32);
      // `NativeVideoSource::new` calls `tokio::spawn` and panics outside a
      // runtime; this thread has none, so borrow Tauri's. In the product
      // every source is made from an async command and never meets this.
      let (sweep, track) = tauri::async_runtime::block_on(async move {
        let source = NativeVideoSource::new(VideoResolution { width: w, height: h }, true);
        let sweep = super::capture::Sweep::start(source.clone(), w, h, 30);
        let track = LocalVideoTrack::create_video_track("dev-tile", RtcVideoSource::Native(source));
        (sweep, track)
      });
      tile.bind(track.rtc_track());
      tile.set_rect(rect, rect, true);
      log::info!("voice: dev tile -- bound to a {w}x{h} synthetic sweep at 30 fps");
      // A second tile beside the first, **sharing one clip**, which is the
      // shape a call page's grid has and the shape that caught the first
      // cut of this file: a window sized to the clip rather than the tile
      // paints its letterbox over every neighbour, and every tile lands at
      // the same rect at HWND_TOP so only the last one drawn survives. Two
      // pictures here is the whole reading.
      let clip = PageRect { x: 40.0, y: 120.0, width: 700.0, height: 200.0 };
      let second = PageRect { x: 400.0, y: 130.0, width: 320.0, height: 180.0 };
      tile.set_rect(clip, rect, true);
      let neighbour = match Tile::create(&app) {
        Ok(neighbour) => {
          neighbour.bind(track.rtc_track());
          neighbour.set_rect(clip, second, true);
          log::info!("voice: dev tile -- a second tile at CSS (400,130) shares the same clip");
          Some(neighbour)
        }
        Err(e) => {
          log::warn!("voice: dev tile -- second tile failed: {}", e.message);
          None
        }
      };
      std::thread::sleep(std::time::Duration::from_secs(6));
      log::info!(
        "voice: dev tile -- after 6 s: {} drawn, {} dropped, {} skipped",
        tile.frames.load(Ordering::Relaxed),
        tile.dropped.load(Ordering::Relaxed),
        tile.skipped.load(Ordering::Relaxed)
      );
      // Then hide it the way a covered surface would, and read that the
      // frames stop being converted rather than merely stop being seen.
      let (drawn, skipped) =
        (tile.frames.load(Ordering::Relaxed), tile.skipped.load(Ordering::Relaxed));
      tile.set_covered(true);
      std::thread::sleep(std::time::Duration::from_secs(3));
      log::info!(
        "voice: dev tile -- 3 s covered: +{} drawn, +{} skipped",
        tile.frames.load(Ordering::Relaxed) - drawn,
        tile.skipped.load(Ordering::Relaxed) - skipped
      );
      tile.set_covered(false);
      if let Some(neighbour) = neighbour {
        log::info!(
          "voice: dev tile -- neighbour drew {} frame(s), dropped {}, skipped {}",
          neighbour.frames.load(Ordering::Relaxed),
          neighbour.dropped.load(Ordering::Relaxed),
          neighbour.skipped.load(Ordering::Relaxed)
        );
        std::mem::forget(neighbour);
      }
      std::mem::forget(sweep);
      std::mem::forget(track);
    }
    // The tile owns a window for the life of the process; nothing takes it
    // down and nothing should.
    std::mem::forget(tile);
  });
}
