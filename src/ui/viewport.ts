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

  // What the keyboard was worth last time, in pixels of lost height.
  //
  // Remembered because of what a readout from a real phone showed: through the
  // whole keyboard animation `scrollY`, `offsetTop`, the shell's top and the
  // header's top were all flat zero, and only the height changed. Nothing in
  // the DOM moved, and yet the top of the UI visibly did.
  //
  // That is Safari's own doing, below the level any of this can see. As the
  // keyboard rises it translates the web view to keep the focused input
  // visible, then unwinds that translation once the shell has shrunk and the
  // composer is above the keyboard on its own. Up, and back to the same place.
  // No API reports it, so no correction can be written against it.
  //
  // The only lever left is to remove the *reason* for it: if the composer is
  // already above where the keyboard is about to be, Safari has nothing to
  // reveal and never translates. That means shrinking on focus, before the
  // keyboard exists -- which needs a number that can only come from having
  // watched it open before.
  const INSET_KEY = "viewport.keyboardInset";
  const MIN_INSET = 120;
  const HOLD_MS = 900;

  let predictedHeight = 0;
  let predictUntil = 0;

  const rememberedInset = (): number => {
    try {
      const stored = Number(window.localStorage.getItem(INSET_KEY));
      // A plausible keyboard, not a stale value from a rotated device or a
      // number that would leave the app a sliver tall.
      if (!Number.isFinite(stored)) return 0;
      if (stored < MIN_INSET) return 0;
      if (stored > window.innerHeight * 0.75) return 0;
      return stored;
    } catch {
      // Private browsing can throw on read. Not worth failing a layout over.
      return 0;
    }
  };

  const apply = (): void => {
    // A zero height is not a viewport, it is a tab that is not being composited
    // -- hidden, backgrounded, or mid-teardown. Writing it through would size
    // the shell to nothing and render a blank page, so leave the previous
    // value (or the CSS fallback) in place and wait for a real measurement.
    if (viewport.height <= 0) return;

    // `innerHeight` is the layout viewport and the keyboard does not change it
    // -- it stayed at 796 on the phone while the visual viewport went to 449.
    // That makes it the stable thing to measure the keyboard against.
    const inset = Math.round(window.innerHeight - viewport.height);

    if (inset >= MIN_INSET) {
      // The keyboard is really open, so this is a measurement rather than a
      // guess. Record it for next time and stop predicting.
      try {
        window.localStorage.setItem(INSET_KEY, String(inset));
      } catch {
        // Storage being unavailable costs a smooth first open, nothing more.
      }
      predictedHeight = 0;
    } else if (predictedHeight > 0) {
      if (performance.now() < predictUntil) {
        // Focused, keyboard not up yet. Hold the predicted height rather than
        // writing the full one, or the prediction is undone on the very next
        // frame and Safari gets its reason back.
        root.style.setProperty("--app-height", `${predictedHeight}px`);
        return;
      }
      // Focus without a keyboard -- a hardware one, or a device that does not
      // show it. Fall back to what is actually there.
      predictedHeight = 0;
    }

    // Undo the document scroll, which is the actual displacement.
    //
    // iOS reveals a focused input by scrolling the *document*, and it does
    // this even here, where the body cannot scroll and the shell is fixed --
    // the fixed layer is dragged up with the page, taking the header off the
    // top of the screen and leaving the composer stranded in the middle with
    // blank space beneath it.
    //
    // `offsetTop` does not describe that. It is the visual viewport's offset
    // within the *layout* viewport, and it stays 0 throughout, which is why
    // compensating against it changed nothing. The displacement is
    // `window.scrollY` on a document that is not supposed to scroll at all,
    // so the cure is to put it back -- every frame, until the keyboard has
    // finished animating and Safari stops trying.
    if (window.scrollY !== 0) window.scrollTo(0, 0);

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

  // `focusin` is the earliest signal there is -- earlier than any viewport
  // event, because the keyboard is a consequence of focus rather than the other
  // way round. It is also the only moment at which the prediction is any use:
  // Safari decides whether to translate the page as the keyboard opens, so the
  // shell has to already be short by then.
  window.addEventListener("focusin", (event) => {
    // Only for things that actually summon a keyboard. Focus lands on buttons
    // and links too, and shrinking the app when somebody taps "Send" would be a
    // bug in its own right.
    const target = event.target;
    const summonsKeyboard =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);

    if (summonsKeyboard) {
      const inset = rememberedInset();
      if (inset > 0) {
        predictedHeight = window.innerHeight - inset;
        predictUntil = performance.now() + HOLD_MS;
      }
    }

    startFollowing();
  });

  window.addEventListener("focusout", () => {
    // The prediction must not outlive the keyboard, or the app stays short
    // against a screen with nothing covering it.
    predictedHeight = 0;
    startFollowing();
  });

  // `scroll` as well as `resize`: the height changes when the keyboard opens,
  // but the offset changes as Safari scrolls the layout viewport underneath
  // it, and a shell pinned to a stale offset drifts away from the screen.
  viewport.addEventListener("resize", startFollowing);
  viewport.addEventListener("scroll", startFollowing);

  apply();
}
