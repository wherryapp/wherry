// Full-screen viewing of a photo somebody sent, over the timeline.
//
// Reads the bytes from the store and nowhere else. That is not a
// convenience: the server holds attachment ciphertext it cannot open, so
// there is no "fetch the full-size original" path to reach for, and there
// must never be one. Attachment.tsx has already downloaded, verified,
// decrypted and cached the plaintext by the time a photo is on screen to
// tap; this reads that cache. Missing or terminal means the viewer simply
// closes -- a viewer that starts its own download would be a second network
// path to bytes that only differ from the timeline's by being bigger.
//
// Pinch-zoom and pan ARE here, as of 2026-09-02, and the note that used to
// sit in this spot said they were deliberately not -- on the reasoning that
// two-pointer tracking is a gesture surface of its own and the browser's own
// zoom was better than a fake. What changed is that the browser's own zoom
// stopped being available: page pinch-zoom is now locked off across the app
// (ui/zoom.ts), because zooming a fixed-position shell crops the app instead
// of reflowing it. That took the background with the photo, which is the
// complaint. So the gesture had to be built rather than borrowed, and the
// arithmetic that is easy to get wrong -- scaling about the point under the
// fingers, and not letting an edge be dragged inside the frame -- is pure and
// tested in photo-zoom.ts. Momentum is still not here, and is not missed:
// this is a picture being held still to look at, not a map.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import type { AttachmentRef } from "../api/payload";
import { store } from "../store";
import { DownloadIcon, XIcon } from "./kit";
import {
  RESET,
  clampPan,
  clampScale,
  isReset,
  scaleAbout,
  type Transform,
} from "./photo-zoom";

/**
 * How far a finger may travel and still have been a tap. Generous, because
 * the alternative failure -- a tap read as a drag, so the viewer does not
 * close -- is the one people report as the app being stuck.
 */
const TAP_SLOP_PX = 10;

/** What a saved file is called. The id makes it unique; the type comes from
 *  the payload, since the server never learned it. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function fileNameFor(attachment: AttachmentRef): string {
  return `photo-${attachment.id}.${EXTENSIONS[attachment.mediaType] ?? "bin"}`;
}

export function PhotoViewer({
  attachment,
  onClose,
}: {
  attachment: AttachmentRef;
  onClose: () => void;
}) {
  const [shown, setShown] = useState<{ url: string; file: File } | null>(null);
  const [shareable, setShareable] = useState(false);
  /**
   * The transform, twice: a ref that is always current and a state that
   * renders it.
   *
   * The ref is the authority, and it is not an optimisation. A handler that
   * reads `transform` from its render closure reads whatever the last
   * *committed* render held, and several pointer or wheel events can be
   * delivered before React commits anything -- so each one computes its step
   * from the same stale base and all but the last are thrown away. It is
   * exactly the kind of bug that hides at 60 Hz, where events do arrive one
   * per frame, and appears the moment a trackpad or a fast pinch delivers
   * two in a tick. Measured here, not theorised: a burst of synthetic wheel
   * events moved the picture once and then stopped.
   */
  const latest = useRef<Transform>(RESET);
  const [transform, setTransform] = useState<Transform>(RESET);

  // Through a ref, because the caller's onClose is an inline arrow: taking
  // it as an effect dependency directly would re-run the load -- and rebuild
  // and revoke the object URL -- on every render of the timeline underneath.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    // A different photo starts at rest. Today the viewer is only ever
    // mounted for one attachment at a time, so this cannot fire in
    // practice; it costs one line and means a caller that swaps the prop
    // does not inherit the last picture's zoom.
    latest.current = RESET;
    setTransform(RESET);

    void (async () => {
      const blob = await store.getBlob(attachment.id);
      if (cancelled) return;
      if (!blob || blob.state !== "ok") {
        // No bytes, or a terminal verdict there will never be any. Nothing
        // to show and nothing to fetch, so this closes rather than
        // explaining -- the bubble underneath already says why.
        close.current();
        return;
      }

      // A copy, for the same reason Attachment.tsx takes one: the object URL
      // outlives this call and a view onto a larger buffer would pin all of
      // it. One File serves both the URL and the share sheet.
      const file = new File([blob.bytes.slice()], fileNameFor(attachment), {
        type: blob.mediaType,
      });
      objectUrl = URL.createObjectURL(file);
      setShown({ url: objectUrl, file });
      setShareable(navigator.canShare?.({ files: [file] }) === true);
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment]);

  // Escape closes the viewer and must not also close whatever is underneath
  // it -- the same capture-phase-and-stop shape useConfirm uses, and for the
  // same reason: the panel below listens on the document's bubble phase.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () =>
      document.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // -------------------------------------------------------------------------
  // The gesture
  // -------------------------------------------------------------------------

  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);


  // Live pointers, in the order they went down. A Map because two fingers is
  // the interesting case and a third arriving must not disturb the two
  // already driving the pinch -- iteration order gives that for free.
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  // The baseline a pinch is measured against: the finger separation when the
  // second pointer landed, and the midpoint as of the last frame (which the
  // picture is dragged by, so a pinch can also move the photo).
  const pinch = useRef<{ distance: number; midX: number; midY: number } | null>(
    null,
  );

  // Whether this gesture has travelled far enough to stop being a tap, and
  // where it began.
  //
  // The travel is measured from the *start* of the gesture, never from the
  // previous event. Per-event deltas are the version that looks right and is
  // wrong: a finger crossing the whole screen slowly delivers a long run of
  // 4px moves, not one 400px move, so every step compares under the slop and
  // the drag ends up dismissing the viewer. Timeline.tsx's press handling
  // measures from its start point for the same reason; this follows it.
  //
  // Once false it stays false for the rest of the gesture -- a drag that
  // happens to finish where it started is still a drag.
  const wasTap = useRef(true);
  const origin = useRef<{ x: number; y: number } | null>(null);

  /**
   * The two boxes the clamp needs, in CSS pixels.
   *
   * `offsetWidth`, not `getBoundingClientRect`, for the content: the rect is
   * the *transformed* box, so measuring the thing we are about to transform
   * with it feeds the scale back into its own input and the clamp drifts.
   */
  const measure = (): {
    viewport: { width: number; height: number };
    content: { width: number; height: number };
    centreX: number;
    centreY: number;
  } | null => {
    const host = surface.current;
    const el = image.current;
    if (!host || !el) return null;
    const rect = host.getBoundingClientRect();
    return {
      viewport: { width: rect.width, height: rect.height },
      content: { width: el.offsetWidth, height: el.offsetHeight },
      centreX: rect.left + rect.width / 2,
      centreY: rect.top + rect.height / 2,
    };
  };

  /**
   * Applies a change and re-clamps. Every write to the transform goes here,
   * and every read of the current one comes from the ref this maintains.
   */
  const apply = (compute: (current: Transform) => Transform): void => {
    const boxes = measure();
    const next = compute(latest.current);
    latest.current = boxes
      ? clampPan(next, boxes.viewport, boxes.content)
      : next;
    setTransform(latest.current);
  };

  /** Zooms about a point given in client coordinates. Shared by pinch and wheel. */
  const zoomAt = (
    current: Transform,
    nextScale: number,
    clientX: number,
    clientY: number,
  ): Transform => {
    const boxes = measure();
    if (!boxes) return current;
    return scaleAbout(
      current,
      nextScale,
      clientX - boxes.centreX,
      clientY - boxes.centreY,
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // The control row is a lid over the gesture surface, not part of it.
    if ((event.target as Element).closest("[data-photo-controls]")) return;
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointers.current.size === 1) {
      wasTap.current = true;
      origin.current = { x: event.clientX, y: event.clientY };
    }
    // A second finger arriving restarts the pinch baseline rather than
    // continuing an old one, so lifting one finger and putting it back does
    // not jump the picture.
    pinch.current = null;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const tracked = pointers.current.get(event.pointerId);
    if (!tracked) return;
    const previous = { ...tracked };
    tracked.x = event.clientX;
    tracked.y = event.clientY;

    const from = origin.current;
    if (
      from &&
      Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP_PX
    ) {
      wasTap.current = false;
    }

    const live = [...pointers.current.values()];

    if (live.length >= 2) {
      wasTap.current = false;
      const [a, b] = live as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;

      const baseline = pinch.current;
      pinch.current = { distance, midX, midY };
      // The first frame of a pinch only establishes the baseline. Acting on
      // it would divide by a separation nobody has moved yet.
      if (!baseline || baseline.distance === 0) return;

      apply((current) => {
        const zoomed = zoomAt(
          current,
          clampScale(current.scale * (distance / baseline.distance)),
          midX,
          midY,
        );
        // Two fingers sliding together move the picture as well as scale it,
        // which is what makes a pinch feel attached to the hand rather than
        // pinned to the middle of the screen.
        return {
          scale: zoomed.scale,
          x: zoomed.x + (midX - baseline.midX),
          y: zoomed.y + (midY - baseline.midY),
        };
      });
      return;
    }

    // One finger pans, but only when there is something to pan. At rest the
    // picture fits, so a drag would be a tap that wandered -- and swallowing
    // it here is what keeps the dismiss from firing on a scroll-like flick.
    if (isReset(latest.current)) return;
    apply((current) => ({
      scale: current.scale,
      x: current.x + (event.clientX - previous.x),
      y: current.y + (event.clientY - previous.y),
    }));
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const wasTracked = pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!wasTracked || pointers.current.size > 0) return;
    origin.current = null;

    // A tap dismisses, but only from rest. While zoomed the same tap is much
    // more likely to be a missed pan than a request to leave, and closing
    // out from under somebody who is looking at detail is the worse mistake.
    if (wasTap.current && isReset(latest.current)) close.current();
  };

  /**
   * Wheel and trackpad zoom, which is the whole gesture on a desktop -- there
   * is no pinch to read from a mouse, and the page zoom that used to serve
   * here is exactly what got taken away. macOS reports a trackpad pinch as a
   * ctrl-wheel, so this covers that too.
   */
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    // A modal photo has nothing to scroll, so every wheel event is a zoom.
    const factor = Math.exp(-event.deltaY / 300);
    apply((current) =>
      zoomAt(
        current,
        clampScale(current.scale * factor),
        event.clientX,
        event.clientY,
      ),
    );
  };

  if (!shown) return null;

  const share = async (): Promise<void> => {
    try {
      await navigator.share({ files: [shown.file] });
    } catch {
      // A dismissed share sheet rejects. That is somebody changing their
      // mind, not a failure worth saying anything about.
    }
  };

  // The kit has no button variant for a dark overlay and this is the only
  // surface that wants one, so these three are styled here rather than
  // adding a variant with one caller.
  const control =
    "rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20";

  return (
    <div
      ref={surface}
      role="dialog"
      aria-modal="true"
      aria-label="Photo"
      // Pointer events rather than a click handler on the backdrop, for two
      // reasons. The gesture needs them anyway, and a click that has to be
      // told apart from the end of a drag is not a click. The second is iOS:
      // a bubbled click from a plain, non-interactive element is not
      // guaranteed to be delivered there at all, which makes "tap the
      // background to dismiss" a dismiss that works everywhere except the
      // place it was reported broken.
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onWheel={onWheel}
      // touch-none hands every finger to the handlers above: without it the
      // browser claims the second one for its own pinch, and select-none
      // stops a drag across the photo from selecting the page behind it.
      className="fixed inset-0 z-50 flex touch-none select-none items-center justify-center overflow-hidden bg-black/90"
    >
      <div
        data-photo-controls
        // Below the notch and the status bar, not under them. `fixed inset-0`
        // escapes #root's safe-area padding by design -- that is what lets the
        // black reach the edges -- so this row has to re-apply the inset for
        // itself or the close button sits in the one strip of an iPhone
        // screen that does not deliver taps to the page.
        style={{ top: "max(0.75rem, env(safe-area-inset-top, 0px))" }}
        className="absolute right-3 z-10 flex items-center gap-2"
      >
        <a
          href={shown.url}
          download={fileNameFor(attachment)}
          aria-label="Download photo"
          className={control}
        >
          <DownloadIcon />
        </a>
        {shareable && (
          <button
            type="button"
            onClick={() => void share()}
            aria-label="Share photo"
            className={control}
          >
            <ShareIcon />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close photo"
          className={control}
        >
          <XIcon />
        </button>
      </div>
      <img
        ref={image}
        src={shown.url}
        alt=""
        // draggable off: the desktop drag-image gesture starts on the same
        // pointer-down a pan does, and wins.
        draggable={false}
        style={{
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
        }}
        className="max-h-full max-w-full object-contain will-change-transform"
      />
    </div>
  );
}

// Local to this file: the kit's icon set is what the app's own chrome uses,
// and neither of these appears anywhere else.

function ShareIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5" />
      <path d="M5 10H4v7h12v-7h-1" />
    </svg>
  );
}
