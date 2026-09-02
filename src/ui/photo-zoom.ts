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
