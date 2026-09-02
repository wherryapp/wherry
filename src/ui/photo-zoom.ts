// The photo viewer's zoom arithmetic, kept pure so it can be tested without a
// gesture. PhotoViewer.tsx owns the pointers; this owns what they mean.
//
// The model is one CSS transform, `translate(x, y) scale(s)`, applied to an
// element that is already laid out centred at its fitted size. Everything
// here is in CSS pixels of the *untransformed* layout, and `x`/`y` are
// offsets of the element's centre from where it sits at rest. Two operations
// are all the viewer needs, and both are easy to get subtly wrong by hand:
// scaling about a point that is not the centre, and refusing to pan the
// picture off its own edge.

export type Transform = {
  scale: number;
  /** Horizontal offset of the content's centre, in CSS pixels. */
  x: number;
  /** Vertical offset of the content's centre, in CSS pixels. */
  y: number;
};

export const RESET: Transform = { scale: 1, x: 0, y: 0 };

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;

/** A box, in CSS pixels. Both the viewport and the content are described this way. */
export type Box = { width: number; height: number };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Scales about a fixed point, so whatever was under two fingers stays under
 * them.
 *
 * `originX`/`originY` are that point as an offset from the *viewport* centre,
 * which is the frame the gesture arrives in -- a midpoint measured against
 * `getBoundingClientRect` of the surface, minus its centre. Scaling about the
 * element's own centre instead is the version that feels wrong without
 * looking wrong: the picture zooms correctly and slides out from under the
 * fingers as it goes.
 */
export function scaleAbout(
  current: Transform,
  nextScale: number,
  originX: number,
  originY: number,
): Transform {
  const scale = clampScale(nextScale);
  // The point's position in the content's own coordinates, then where the new
  // scale would put it, then the offset that puts it back.
  const ratio = scale / current.scale;
  return {
    scale,
    x: originX - (originX - current.x) * ratio,
    y: originY - (originY - current.y) * ratio,
  };
}

/**
 * Holds the content over the viewport: no panning an axis whose scaled extent
 * still fits (it stays centred), and no dragging an edge inside the frame on
 * an axis that does not.
 *
 * Applied after every change rather than only after a pan, because a pinch
 * that shrinks back towards 1 also has to walk the offsets home -- otherwise
 * zooming out leaves the picture stuck against a corner.
 */
export function clampPan(
  transform: Transform,
  viewport: Box,
  content: Box,
): Transform {
  const limit = (view: number, extent: number, offset: number): number => {
    // Half the overhang: how far the content can move before its edge would
    // come inside the frame. Negative means it does not fill the frame at
    // all, and `max(0, ...)` turns that into "centred, no panning".
    const slack = Math.max(0, (extent * transform.scale - view) / 2);
    const clamped = Math.min(slack, Math.max(-slack, offset));
    // Clamping a negative offset against a zero slack yields -0, which is a
    // perfectly good CSS pixel and a surprising thing to find in a test or an
    // Object.is. Normalised here so "at rest" has one spelling.
    return clamped === 0 ? 0 : clamped;
  };
  return {
    scale: transform.scale,
    x: limit(viewport.width, content.width, transform.x),
    y: limit(viewport.height, content.height, transform.y),
  };
}

/** Whether the content is at rest -- what decides if a tap closes the viewer. */
export function isReset(transform: Transform): boolean {
  return transform.scale <= MIN_SCALE;
}

// ---------------------------------------------------------------------------
// Swipe to dismiss
// ---------------------------------------------------------------------------
//
// A drag on the picture while it is at rest is a request to leave. It cannot
// be expressed through the transform above: `clampPan` forces the offset back
// to zero whenever the content fits its viewport, which at scale 1 it always
// does (`object-contain`). So the viewer tracks this offset separately and
// only the decision lives here.

/** How far a deliberate drag has to travel before letting go dismisses. */
export const DISMISS_DISTANCE_PX = 100;

/** A flick counts sooner, but still has to be a real one. */
const FLICK_MIN_PX = 40;
const FLICK_SPEED_PX_PER_MS = 0.6;

export type DragGesture = {
  /** Travel from the gesture's start. Sign is direction; only size matters. */
  dx: number;
  dy: number;
  /** Speed of the last movement, px per ms. */
  speed: number;
};

/**
 * Whether letting go here should close the viewer.
 *
 * Vertical-dominant on purpose. A mostly-horizontal drag is somebody moving
 * across the picture, and dismissing on it would make the viewer feel like it
 * closes at random -- which is the complaint this whole change exists to fix,
 * so trading one version of it for another would be no progress at all.
 *
 * Both directions dismiss. Up and down are equally natural once the gesture
 * is "throw it away", and refusing one of them only produces a swipe that
 * silently does nothing.
 *
 * The flick branch is what stops the threshold feeling heavy: a fast short
 * throw reads as a dismiss to the person making it, and requiring the full
 * 100px would make them do it twice.
 */
export function shouldDismissOnDrag(gesture: DragGesture): boolean {
  if (Math.abs(gesture.dy) <= Math.abs(gesture.dx)) return false;
  if (Math.abs(gesture.dy) >= DISMISS_DISTANCE_PX) return true;
  return (
    Math.abs(gesture.dy) >= FLICK_MIN_PX &&
    gesture.speed >= FLICK_SPEED_PX_PER_MS
  );
}

/** 0 at rest, 1 at the dismiss threshold. Drives the fade and the shrink. */
export function dismissProgress(dy: number): number {
  return Math.min(1, Math.abs(dy) / DISMISS_DISTANCE_PX);
}

// ---------------------------------------------------------------------------
// The click that arrives after a pointer gesture has already closed the viewer
// ---------------------------------------------------------------------------

const GHOST_CLICK_WINDOW_MS = 500;
const GHOST_CLICK_SLOP_PX = 24;

export type ClickPoint = { x: number; y: number; t: number };

/**
 * Whether a click is the compatibility click trailing the tap that dismissed
 * the viewer, rather than a new one somebody meant.
 *
 * This is the reported bug, and it is worth being precise about the
 * mechanism. The viewer dismisses on `pointerup`; the browser then
 * synthesises a `click` at the same coordinates. By the time it dispatches,
 * the viewer has unmounted -- so the click lands on whatever is now under the
 * finger, and if that is the photo in the timeline it is a `<button>` whose
 * handler opens the viewer again. Dismissing therefore *reopened*, but only
 * when the tap happened to be over that photo's rect, which is exactly the
 * "sometimes it comes back up" shape of the report.
 *
 * Matching on position and time rather than swallowing the next click
 * unconditionally: a click somewhere else is somebody doing something new and
 * must not be eaten. The slop is for the pointer drift between `pointerup`
 * and the synthesised click, which is small but not zero.
 */
export function isGhostClick(dismissedAt: ClickPoint, click: ClickPoint): boolean {
  if (click.t - dismissedAt.t > GHOST_CLICK_WINDOW_MS) return false;
  return (
    Math.hypot(click.x - dismissedAt.x, click.y - dismissedAt.y) <=
    GHOST_CLICK_SLOP_PX
  );
}
