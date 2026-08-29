// Pins the app to the *visual* viewport rather than the layout viewport.
//
// The problem this solves is the on-screen keyboard on iOS. Opening it does
// not resize the layout viewport -- the page stays its full height and Safari
// scrolls it up instead, which drags the header off the top of the screen
// while the composer follows the keyboard. Everything moves together, so
// nothing is gained: the timeline is the same height, just partly off-screen
// at both ends.
//
// `dvh` does not help. It tracks the browser's own chrome appearing and
// disappearing, not the keyboard, so `100dvh` is still the full screen with a
// keyboard covering half of it.
//
// `window.visualViewport` is the thing that actually knows. Its `height` is
// the part of the page a person can see -- the keyboard subtracted -- and its
// `offsetTop` is how far Safari has scrolled the layout viewport to make room.
// Publishing both as custom properties lets CSS size the shell to what is
// visible, so the header stays put, the composer sits on top of the keyboard,
// and the timeline is the thing that gets shorter. See index.css.
//
// Deliberately not React state. These events fire continuously through the
// keyboard animation, and re-rendering the tree on every frame of it would be
// a lot of work to produce the same layout CSS can produce on its own.

/**
 * Starts mirroring the visual viewport into CSS custom properties.
 *
 * Called once at startup and never torn down -- the listeners live as long as
 * the page does. Where `visualViewport` is missing this does nothing, and the
 * fallbacks in `index.css` apply.
 */
export function trackVisualViewport(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;

  const root = document.documentElement;

  const apply = (): void => {
    // A zero height is not a viewport, it is a tab that is not being composited
    // -- hidden, backgrounded, or mid-teardown. Writing it through would size
    // the shell to nothing and render a blank page, so leave the previous
    // value (or the CSS fallback) in place and wait for a real measurement.
    if (viewport.height <= 0) return;

    root.style.setProperty("--app-height", `${viewport.height}px`);
    root.style.setProperty("--app-offset", `${viewport.offsetTop}px`);
  };

  // `scroll` as well as `resize`: the height changes when the keyboard opens,
  // but the offset changes as Safari scrolls the layout viewport underneath
  // it, and a shell pinned to a stale offset drifts away from the screen.
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);

  apply();
}
