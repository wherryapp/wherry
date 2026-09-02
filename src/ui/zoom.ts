// Page pinch-zoom, off on touch.
//
// Why this file exists at all: index.html's viewport meta asks for the lock
// declaratively, and Safari has ignored `user-scalable=no` since iOS 10 on
// accessibility grounds. The Tauri iOS shell honours it (WKWebView does not
// share Safari's override) but the PWA and mobile Safari do not, so the same
// build needs both halves or the lock holds on one iPhone surface and not the
// one beside it.
//
// What is left to cancel with is WebKit's own non-standard GestureEvent --
// `gesturestart`/`gesturechange`/`gestureend`, dispatched for exactly the
// two-finger pinch and nothing else. Cancelling those is a scalpel: it does
// not touch scrolling, taps, or the pointer events every gesture in this app
// is built on, which is what makes it safe to install once at startup and
// never think about again. `touchmove` filtering would have been the
// cross-browser spelling and is deliberately not used -- it cancels the event
// pointer events are derived from, and would take the photo viewer's own
// pinch down with the page's.
//
// Nothing is exempt, including the photo viewer. An exemption there would
// hand the pinch back to the browser, and the browser zooms the *page* -- the
// photo and the app behind it together, which is the complaint this lock
// exists to answer. The viewer keeps a photo zoomable by doing it itself, on
// pointer events, over a background that no longer moves (PhotoViewer.tsx).
//
// The accessibility trade is real and is not settled by this file. Killing
// page zoom removes a way to make text bigger on a phone, and the answer to
// that is an in-app text-size control (docs/roadmap.md's tier 4), which is
// owed and not yet built. What page zoom actually did here in the meantime is
// worth being honest about: the shell is fixed-position and sized to the
// visual viewport, so zooming cropped the app rather than reflowing it --
// ui/viewport.ts has a guard whose entire job is stopping a zoomed
// measurement from being written into the layout. It was never a working
// text-size control; it was a way to look at part of the screen.

/**
 * Cancels the browser's own pinch-zoom.
 *
 * Called once at startup, never torn down. Where GestureEvent does not exist
 * -- Chrome, Firefox, everything that is not WebKit -- these listeners simply
 * never fire, and the viewport meta is doing the work instead.
 */
export function lockPageZoom(): void {
  // Only where a finger is the primary input. A trackpad pinch on a Mac and
  // ctrl+scroll on a desktop are ordinary zoom on an app that reflows fine at
  // desktop widths, and there is nothing to protect there.
  if (!window.matchMedia("(pointer: coarse)").matches) return;

  const cancel = (event: Event): void => event.preventDefault();

  // Capture phase, so this runs before anything that might stop propagation
  // on its way up -- and `passive: false`, without which preventDefault is
  // ignored and this whole file silently does nothing.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, cancel, { capture: true, passive: false });
  }
}
