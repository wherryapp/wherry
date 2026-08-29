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

  // Following the animation frame by frame, rather than only when told.
  //
  // Safari moves the layout viewport *before* it dispatches the event that
  // says so. The shell is pinned to `--app-offset`, so for however many frames
  // separate the two, it is drawn against a stale offset -- the whole app
  // shoots up the screen and snaps back once the event lands. Intermittently,
  // because it depends on where in the frame the keyboard animation starts.
  //
  // An event listener alone cannot fix that; it is always at least a frame
  // late. So an event starts a short rAF loop that rewrites the geometry every
  // frame until things stop moving, which puts the correction in the same
  // frame as the movement it is correcting.
  let frame = 0;
  let followUntil = 0;

  const follow = (): void => {
    apply();
    frame =
      performance.now() < followUntil ? requestAnimationFrame(follow) : 0;
  };

  // Comfortably longer than the keyboard animation (~250-350ms), because
  // stopping early is the bug coming back at the end of the transition instead
  // of the start. It is a handful of style writes on an idle main thread.
  const FOLLOW_MS = 600;

  const startFollowing = (): void => {
    // Synchronously as well as on the next frame. The rAF loop is what keeps
    // up with the animation, but it does not run at all in a hidden tab and is
    // throttled in a backgrounded one, and a geometry update that only ever
    // arrives via rAF would simply be lost there. This keeps the pre-existing
    // behaviour -- apply on the event -- and adds the following on top.
    apply();

    followUntil = performance.now() + FOLLOW_MS;
    if (frame === 0) frame = requestAnimationFrame(follow);
  };

  // `focusin` is the earliest signal there is. The keyboard is a consequence of
  // something being focused, so this starts following before the first frame
  // of the animation rather than after it -- which is the flash people
  // actually see, at the moment the composer is tapped.
  window.addEventListener("focusin", startFollowing);
  window.addEventListener("focusout", startFollowing);

  // `scroll` as well as `resize`: the height changes when the keyboard opens,
  // but the offset changes as Safari scrolls the layout viewport underneath
  // it, and a shell pinned to a stale offset drifts away from the screen.
  viewport.addEventListener("resize", startFollowing);
  viewport.addEventListener("scroll", startFollowing);

  apply();
}
