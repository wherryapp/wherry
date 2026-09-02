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

import { useCallback, useSyncExternalStore } from "react";

import { SHELL } from "../api/shell";

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

    // Pinch-zoom resizes the visual viewport exactly like the keyboard does
    // -- `scale` is the only thing that tells them apart. Publishing through
    // while zoomed would size the fixed shell to the zoomed-in height and the
    // layout comes apart under it. Skipping the publish leaves the last
    // unzoomed values in place, which is what makes zoom harmless: the shell
    // stays put (now visually cropped by the browser's own zoom, the normal
    // and expected result of zooming a fixed-position page) rather than
    // resizing itself into a broken layout. It is not what makes zoom
    // *usable* -- an in-app text-size control is the real answer to that
    // (roadmap's backlog intake, tier 4) -- only what stops it from breaking
    // the shell. The resize that returns to scale 1 republishes normally,
    // since it is not skipped by this guard.
    if (viewport.scale !== 1) return;

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

    // How much of the screen the keyboard is covering, for index.css to
    // subtract from the bottom safe-area inset. `innerHeight` is the layout
    // viewport and the keyboard does not change it, which is what makes the
    // difference between the two the keyboard's own height.
    const keyboard = Math.max(0, Math.round(window.innerHeight - viewport.height));
    root.style.setProperty("--app-keyboard", `${keyboard}px`);
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

// Tailwind's `md` breakpoint, expressed in JS because two things depend on the
// answer that CSS cannot express: which pane is *rendered*, and whether a
// conversation is auto-selected on load. Auto-selecting on a phone would drop
// somebody into a thread when they were expecting the list they last saw.
//
// Keep this number in step with the `md:` classes below. Tailwind's default
// md is 768px; there is no config file to read it from, by choice.
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribeToQuery(query: string, onChange: () => void): () => void {
  const list = window.matchMedia(query);
  list.addEventListener("change", onChange);

  // Resize as well as the media query, which looks redundant and is not. The
  // change event does not fire in every environment that can alter a viewport
  // -- an emulated one caught this during testing, where the query read as
  // matching while the layout was still in its phone shape. Re-reading on
  // resize means the value cannot disagree with what `matchMedia` says now.
  window.addEventListener("resize", onChange);

  return () => {
    list.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
}

function useMediaQuery(query: string): boolean {
  // useSyncExternalStore rather than state-plus-effect: the value is read
  // fresh on every notification, so there is no copy to fall out of step, and
  // no first render that shows the wrong layout before an effect corrects it.
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToQuery(query, onChange),
    [query],
  );
  const read = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, read);
}

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}

// Whether a pointing device precise enough to drag a file onto the window
// exists.
//
// `any-pointer` rather than `pointer`: the question is whether such a
// device is *present*, not whether it is the primary one. A Windows laptop
// with a touchscreen reports a coarse primary pointer while still having
// the mouse -- and the Explorer window a drag would come from -- and
// gating on the primary pointer would take drag and drop away from exactly
// the machines the desktop app is aimed at.
//
// Erring generous costs nothing, which is what makes this the right shape
// of gate. Nothing is drawn because the query is true; the overlay is
// raised by a real drag that is really carrying files. So the query only
// decides whether to attach listeners and offer the affordance at all --
// on a phone, where a file drag cannot happen, neither should.
const DRAG_QUERY = "(any-pointer: fine)";

/**
 * Whether to offer drag and drop.
 *
 * The desktop shell is admitted outright rather than through the query:
 * dropping a file from the OS is the main way anything gets attached in an
 * installed app, and that must not hinge on how a media query reads on
 * somebody's convertible. `SHELL` is baked at build time, so this is a
 * constant, not a sniff -- see api/shell.ts for why the two notions of
 * shell are kept apart.
 */
export function useCanDropFiles(): boolean {
  const fine = useMediaQuery(DRAG_QUERY);
  return fine || SHELL === "desktop";
}
