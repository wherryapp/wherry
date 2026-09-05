// Hold-to-lift reordering: the DOM half of reorder.ts.
//
// Press and hold an item for HOLD_MS without moving and it lifts; move it
// and a drop indicator follows; release and the list is rewritten. One
// hook for the vertical hub list and the horizontal rail, told which axis
// it is on. Works for a finger, a mouse and a pen alike -- decided by
// pointer events, never the user agent -- which is what makes it a single
// mechanism on the web, the desktop app and both phones.
//
// Three things here are load-bearing and easy to break:
//
//   * **The browser's own scroll is stopped after the lift, not before.**
//     `touch-action` is read at touchstart and cannot be changed later, so
//     the only thing that still prevents a scroll from starting once the
//     item has lifted is a NON-passive `touchmove` listener that calls
//     preventDefault() -- added at lift time, on window, removed at release.
//     Before the lift nothing is prevented: a finger that moves past
//     HOLD_CANCEL_PX is scrolling, the browser takes the gesture (and fires
//     pointercancel), and the hold is simply abandoned. That ordering is
//     what makes an accidental reorder impossible from a scroll.
//
//   * **Android's long-press context menu is cancelled.** Chrome raises
//     `contextmenu` at ~500 ms of holding and, if it shows, cancels the
//     pointer. HOLD_MS is shorter, and a capture-phase window listener
//     prevents the menu for the life of the press. iOS has no menu on a
//     button, and the callout is already off under a coarse pointer
//     (index.css).
//
//   * **The click after a lifted release is swallowed.** A release fires a
//     click at the same spot, and the item under it is a button that opens
//     something. `onClickCapture` on the item eats exactly one click after a
//     lift, and a fresh press clears the flag so an abandoned hold never
//     swallows the next honest tap. Window listeners rather than pointer
//     capture, for HubsSection's original reason: capturing at pointerdown
//     retargets pointerup and swallows the click for a plain tap too.
//
// The authoritative drag lives in a ref and is mirrored to state for
// rendering -- a fast drag can deliver pointermove and pointerup in the
// same frame, and the state closure would still read the pre-drag value at
// release (the gesture-handler rule in CLAUDE.md).

import { useCallback, useEffect, useRef, useState } from "react";
import { moveItem } from "./rank";
import {
  HOLD_MS,
  insertionSlot,
  movedPastHold,
  type Extent,
} from "./reorder";

export type ReorderDrag = {
  id: string;
  fromIndex: number;
  /** The insertion slot under the pointer (moveItem's convention). */
  overIndex: number;
  /** How far the lifted item has been dragged along the axis, in px. */
  offset: number;
};

export type ReorderItemProps = {
  ref: (element: HTMLElement | null) => void;
  onPointerDown: (event: React.PointerEvent) => void;
  onClickCapture: (event: React.MouseEvent) => void;
};

export function useReorder<T extends { id: string }>({
  items,
  axis,
  onReorder,
}: {
  items: readonly T[];
  axis: "x" | "y";
  /** Called once per completed drag that changed the order. */
  onReorder: (next: T[]) => void;
}): {
  drag: ReorderDrag | null;
  /** The item being held down and not yet lifted -- for a pressed look. */
  holding: string | null;
  itemProps: (id: string, index: number) => ReorderItemProps;
} {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const elements = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<ReorderDrag | null>(null);
  const [drag, setDragView] = useState<ReorderDrag | null>(null);
  const [holding, setHolding] = useState<string | null>(null);
  const suppressClick = useRef(false);
  const session = useRef<{ cleanup: () => void } | null>(null);

  const setDrag = (next: ReorderDrag | null) => {
    dragRef.current = next;
    setDragView(next);
  };

  // A component unmounting mid-drag must not leave window listeners behind.
  useEffect(() => () => session.current?.cleanup(), []);

  const itemProps = useCallback(
    (id: string, index: number): ReorderItemProps => ({
      ref: (element) => {
        if (element) elements.current.set(id, element);
        else elements.current.delete(id);
      },
      onClickCapture: (event) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.stopPropagation();
        event.preventDefault();
      },
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        if (session.current) return;
        // A fresh press clears a stale flag, so an abandoned lift can never
        // swallow the next click.
        suppressClick.current = false;

        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startY = event.clientY;
        let lifted = false;
        // Snapshotted at lift: only the lifted item moves during a drag, and
        // reading its translated rect back would put the slot arithmetic
        // off by however far it has been dragged.
        let extents: Extent[] = [];
        let timer: number | null = null;

        const preventTouchScroll = (e: TouchEvent) => e.preventDefault();
        const preventMenu = (e: Event) => e.preventDefault();

        const cleanup = () => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onCancel);
          window.removeEventListener("touchmove", preventTouchScroll);
          window.removeEventListener("contextmenu", preventMenu, true);
          document.body.classList.remove("reordering");
          session.current = null;
          setHolding(null);
        };

        const measure = (): Extent[] =>
          itemsRef.current.map((item) => {
            const rect = elements.current.get(item.id)?.getBoundingClientRect();
            if (!rect) return { start: 0, end: 0 };
            return axis === "x"
              ? { start: rect.left, end: rect.right }
              : { start: rect.top, end: rect.bottom };
          });

        const lift = () => {
          timer = null;
          lifted = true;
          suppressClick.current = true;
          extents = measure();
          window.addEventListener("touchmove", preventTouchScroll, {
            passive: false,
          });
          document.body.classList.add("reordering");
          // A short tick where the platform offers one (Android); iOS has
          // no vibration API and the scale-up is the whole feedback there.
          try {
            navigator.vibrate?.(15);
          } catch {
            // Not everywhere, and never important.
          }
          setHolding(null);
          setDrag({ id, fromIndex: index, overIndex: index, offset: 0 });
        };

        const onMove = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return;
          try {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!lifted) {
              // Scrolling, or dragging something else: not a hold.
              if (movedPastHold(dx, dy)) cleanup();
              return;
            }
            setDrag({
              id,
              fromIndex: index,
              overIndex: insertionSlot(extents, axis === "x" ? e.clientX : e.clientY),
              offset: axis === "x" ? dx : dy,
            });
          } catch {
            // Never leave the window listeners wedged on broken state.
            cleanup();
            setDrag(null);
          }
        };
        const onUp = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return;
          const active = dragRef.current;
          cleanup();
          try {
            if (lifted && active) {
              const slot = insertionSlot(
                extents,
                axis === "x" ? e.clientX : e.clientY,
              );
              const current = itemsRef.current;
              const next = moveItem(current, active.fromIndex, slot);
              if (next.some((item, i) => item !== current[i])) {
                onReorderRef.current(next);
              }
            }
          } finally {
            setDrag(null);
          }
        };
        const onCancel = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return;
          cleanup();
          setDrag(null);
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("contextmenu", preventMenu, true);
        timer = window.setTimeout(lift, HOLD_MS);
        session.current = { cleanup };
        setHolding(id);
      },
    }),
    [axis],
  );

  return { drag, holding, itemProps };
}
