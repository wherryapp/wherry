// The decisions behind hold-to-lift reordering, as pure functions.
//
// The DOM half is useReorder.ts. This file holds the arithmetic and the
// thresholds so the test beside it runs under bare node:test, and so the
// vertical hub list and the horizontal rail -- one axis each -- share
// exactly one notion of "which slot is the pointer over".
//
// Why a hold rather than an immediate drag: the ask was reordering that
// "definitely can't be done by accident", on every platform. A drag that
// starts on movement can start from a click that wobbled, and on a phone it
// competes with the scroll that starts the same way. A hold cannot happen by
// accident on either -- nobody rests a finger or a mouse button on a row for
// half a second without meaning it -- and it is the gesture every home
// screen already taught. The threshold is the same on a mouse as on a
// finger on purpose: one mechanism, decided by pointer events and never by
// the user agent (CLAUDE.md's pointerType rule).

/**
 * How long a press must stay put before the item lifts. Under the ~500 ms
 * at which Android raises its own long-press context menu, so the lift
 * happens first and the menu is what gets cancelled (useReorder prevents
 * it), and under iOS's callout the same way. Long enough that a slow tap
 * is still a tap.
 */
export const HOLD_MS = 400;

/**
 * Movement past this during the hold cancels the lift -- the pointer is
 * scrolling or dragging something else, not holding. Measured from the
 * press, never from the previous event (the tap-versus-drag rule in
 * CLAUDE.md: a slow crossing is a run of small moves).
 */
export const HOLD_CANCEL_PX = 8;

/** One item's extent along the drag axis, in viewport pixels. */
export type Extent = { start: number; end: number };

/** True when the pointer has moved far enough from the press to cancel. */
export function movedPastHold(
  dx: number,
  dy: number,
  threshold = HOLD_CANCEL_PX,
): boolean {
  return Math.hypot(dx, dy) > threshold;
}

/**
 * The insertion slot the pointer is over: the number of items whose
 * midpoint is before it along the axis. 0 is before the first item, and
 * `extents.length` is after the last -- moveItem's slot convention, so the
 * two slots hugging the lifted item are the no-op positions.
 */
export function insertionSlot(
  extents: readonly Extent[],
  coordinate: number,
): number {
  let slot = 0;
  for (const extent of extents) {
    if (coordinate > (extent.start + extent.end) / 2) slot++;
  }
  return slot;
}

/**
 * Where to draw the drop indicator, or null when the drop would put the
 * item back where it is. The rail and the list both hide the line at the
 * two no-op slots rather than draw one that promises a move that will not
 * happen.
 */
export function indicatorSlot(
  fromIndex: number,
  overIndex: number,
): number | null {
  if (overIndex === fromIndex || overIndex === fromIndex + 1) return null;
  return overIndex;
}
