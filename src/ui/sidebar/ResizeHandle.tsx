// The divider between the hubs section and the DM list: an 8px invisible
// hit strip whose negative margins overlap the hubs wrapper's border, so the
// border stays the visible line and the strip only tints on hover or focus.
// Pointer-captured drag with the clamps computed once at drag start; commit
// happens on pointerup only, so a drag in progress never writes storage.
// Also a real separator to the keyboard: arrows resize, double-click resets
// to auto. One unconditional class list -- pointer-events never appears here
// (the same-specificity trap in CLAUDE.md).

import { useRef } from "react";
import type { RefObject } from "react";

export const MIN_HUBS_PX = 64;
const MIN_DM_PX = 96;
const KEY_STEP_PX = 16;

type DragState = {
  pointerId: number;
  startY: number;
  startHeight: number;
  min: number;
  max: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function ResizeHandle({
  asideRef,
  hubsRef,
  height,
  onLiveResize,
  onCommit,
  onReset,
}: {
  asideRef: RefObject<HTMLElement | null>;
  hubsRef: RefObject<HTMLDivElement | null>;
  /** The persisted height, for the separator's accessible value; null = auto. */
  height: number | null;
  /** Fires per pointermove with the clamped height; null clears a reverted drag. */
  onLiveResize: (px: number | null) => void;
  /** Fires once on pointerup (or per keypress) with the height to persist. */
  onCommit: (px: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<DragState | null>(null);

  // Measured at interaction time, not render time -- the aside's height is
  // the window's business and the clamps must reflect it as it is now.
  const bounds = () => {
    const aside = asideRef.current;
    const hubs = hubsRef.current;
    if (!aside || !hubs) return null;
    const asideRect = aside.getBoundingClientRect();
    const hubsRect = hubs.getBoundingClientRect();
    const max = Math.max(
      MIN_HUBS_PX,
      asideRect.bottom - hubsRect.top - MIN_DM_PX,
    );
    return { min: MIN_HUBS_PX, max, current: hubsRect.height };
  };

  const endDrag = () => {
    drag.current = null;
    document.body.style.cursor = "";
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize hubs section"
      aria-valuenow={height ?? undefined}
      aria-valuemin={MIN_HUBS_PX}
      tabIndex={0}
      className="relative z-10 -my-1 h-2 shrink-0 cursor-row-resize touch-none select-none hover:bg-accent-500/20 focus-visible:bg-accent-500/20"
      onPointerDown={(event) => {
        if (drag.current) return;
        const b = bounds();
        if (!b) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startHeight: b.current,
          min: b.min,
          max: b.max,
        };
        // Capture routes the events here but does not change the cursor the
        // rest of the page shows while the pointer crosses it.
        document.body.style.cursor = "row-resize";
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d || event.pointerId !== d.pointerId) return;
        onLiveResize(
          clamp(d.startHeight + event.clientY - d.startY, d.min, d.max),
        );
      }}
      onPointerUp={(event) => {
        const d = drag.current;
        if (!d || event.pointerId !== d.pointerId) return;
        endDrag();
        onCommit(clamp(d.startHeight + event.clientY - d.startY, d.min, d.max));
      }}
      onPointerCancel={() => {
        if (!drag.current) return;
        endDrag();
        onLiveResize(null);
      }}
      onLostPointerCapture={() => {
        // Fires after pointerup too, but endDrag has already cleared the
        // state by then; this branch only catches a capture lost mid-drag.
        if (!drag.current) return;
        endDrag();
        onLiveResize(null);
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        const b = bounds();
        if (!b) return;
        event.preventDefault();
        const delta = event.key === "ArrowUp" ? -KEY_STEP_PX : KEY_STEP_PX;
        onCommit(clamp(b.current + delta, b.min, b.max));
      }}
    />
  );
}
