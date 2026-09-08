// Path (b)'s z-order half: a native view over the webview
// (docs/prompts/video-next-stages-handoff.md §2.3, candidate (b)).
//
// SPIKE. Behind the `video-native-view` cargo feature, deleted with its
// answer, exactly as the stage-3N.0 capture spike was.
//
// **Why only the z-order half, and why first.** (b) is "a native view per
// tile, positioned from the tile's rect", and it has two questions. The
// CPU one is close to answered by arithmetic already: frames would go from
// the decoder to a display layer inside this process, with no IPC and no
// page paint, which is the part that made candidate (a) cost 2.4x the
// webview control. The question that can only be answered by looking is
// the one the handoff makes the gate: **a native view is on top of
// everything the page draws**, so what happens when a Popover, a profile
// card or the photo viewer opens over a face? That needs a screenshot and
// a person, not a benchmark -- so this puts a real NSView above the
// WKWebView at a rect the page reports, and nothing else.
//
// The layer is a flat colour that changes on a timer rather than decoded
// video: for a z-order reading the only thing that matters is that
// something native and obviously alive is in that rectangle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use tauri::{AppHandle, Manager};

use crate::voice::{VoiceError, VoiceResult};

static VIEW: Mutex<Option<usize>> = Mutex::new(None);
static ANIMATING: AtomicBool = AtomicBool::new(false);

/// Put a native view over the webview at a rect the page measured.
///
/// `x`/`y`/`width`/`height` are CSS pixels with the origin at the top left
/// of the web view, which is what `getBoundingClientRect()` gives. AppKit
/// puts its origin at the bottom left, so the y is flipped against the
/// content view's height here -- in Rust, because it is arithmetic about
/// AppKit's coordinate space and nothing the page should have to know.
#[tauri::command]
pub fn spike_view_show(
  app: AppHandle,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
) -> VoiceResult<String> {
  let window = app
    .webview_windows()
    .into_values()
    .next()
    .ok_or_else(|| VoiceError::new("no_window", "no window"))?;

  let ns_window = window
    .ns_window()
    .map_err(|e| VoiceError::new("no_ns_window", &e.to_string()))? as usize;

  let (tx, rx) = std::sync::mpsc::channel::<String>();
  window
    .run_on_main_thread(move || {
      // SAFETY: on the main thread, with a window Tauri owns for the life
      // of the app. Every object here is autoreleased by AppKit.
      unsafe {
        let ns_window = ns_window as *mut AnyObject;
        let content: *mut AnyObject = msg_send![ns_window, contentView];
        let bounds: objc2_foundation::NSRect = msg_send![content, bounds];
        let flipped_y = bounds.size.height - (y + height);

        let frame = objc2_foundation::NSRect::new(
          objc2_foundation::NSPoint::new(x, flipped_y),
          objc2_foundation::NSSize::new(width, height),
        );

        let mut guard = VIEW.lock().unwrap();
        if let Some(existing) = *guard {
          let view = existing as *mut AnyObject;
          let _: () = msg_send![view, setFrame: frame];
        } else {
          let view: *mut AnyObject = msg_send![class!(NSView), alloc];
          let view: *mut AnyObject = msg_send![view, initWithFrame: frame];
          let _: () = msg_send![view, setWantsLayer: true];
          let layer: *mut AnyObject = msg_send![view, layer];
          // A colour rather than frames: see the module comment.
          let colour: *mut AnyObject = msg_send![
            class!(NSColor),
            colorWithSRGBRed: 0.10f64, green: 0.85f64, blue: 0.45f64, alpha: 1.0f64
          ];
          let cg: *mut AnyObject = msg_send![colour, CGColor];
          let _: () = msg_send![layer, setBackgroundColor: cg];
          // Above every sibling, which is the whole point of the question:
          // NSWindowAbove == 1.
          let nil: *mut AnyObject = std::ptr::null_mut();
          let _: () = msg_send![content, addSubview: view, positioned: 1isize, relativeTo: nil];
          *guard = Some(view as usize);
        }

        // The z-order reading, so this is evidence rather than an
        // invitation to squint: where our view sits in the content view's
        // subview list, and what else is in it. AppKit draws that list back
        // to front, so the last entry is on top of everything before it --
        // which is the whole question candidate (b) has to answer.
        let subviews: *mut AnyObject = msg_send![content, subviews];
        let count: usize = msg_send![subviews, count];
        let mut order = Vec::new();
        let mut ours = usize::MAX;
        for index in 0..count {
          let item: *mut AnyObject = msg_send![subviews, objectAtIndex: index];
          // `(*item).class().name()`, not `msg_send![item, class]` then
          // `name`: `-name` is an NSObject *instance* method, so sending it
          // to a Class object is `+name`, which does not exist and takes the
          // whole app down with an unrecognized-selector NSException rather
          // than a Rust error. (Cost one run, 2026-09-08.)
          let label = (*item).class().name().to_string_lossy().into_owned();
          if let Some(view) = *guard {
            if item as usize == view {
              ours = index;
            }
          }
          order.push(label);
        }

        let _ = tx.send(format!(
          "content {:.0}x{:.0}; native view at ({:.0},{:.0}) {:.0}x{:.0} (page y {:.0} flipped to {:.0});            subviews back-to-front {:?}; ours at index {} of {} -- {}",
          bounds.size.width, bounds.size.height, x, flipped_y, width, height, y, flipped_y,
          order, ours, count,
          if ours + 1 == count { "ON TOP of everything the webview draws" } else { "NOT topmost" }
        ));
      }
    })
    .map_err(|e| VoiceError::new("main_thread", &e.to_string()))?;

  let text = rx
    .recv_timeout(std::time::Duration::from_secs(2))
    .unwrap_or_else(|_| "no answer from the main thread".to_string());
  ANIMATING.store(true, Ordering::SeqCst);
  log::info!("spike view: {text}");
  Ok(text)
}

#[tauri::command]
pub fn spike_view_hide(app: AppHandle) -> VoiceResult<()> {
  ANIMATING.store(false, Ordering::SeqCst);
  let window = app
    .webview_windows()
    .into_values()
    .next()
    .ok_or_else(|| VoiceError::new("no_window", "no window"))?;
  let _ = window.run_on_main_thread(move || unsafe {
    let mut guard = VIEW.lock().unwrap();
    if let Some(existing) = guard.take() {
      let view = existing as *mut AnyObject;
      let _: () = msg_send![view, removeFromSuperview];
    }
  });
  Ok(())
}
