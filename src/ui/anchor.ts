// Where a conversation lands when you open it, as a pure state machine.
//
// Its own file, and pure, for the same reason `unread.ts` is: the rules are
// small, the consequences are visible on every single open, and the bug this
// replaces was invisible in review because it lived in the *interaction*
// between two refs rather than in either one of them.
//
// ---------------------------------------------------------------------------
// The bug this file exists to make impossible
// ---------------------------------------------------------------------------
//
// The open anchor used to re-apply itself through the same `nearBottom` gate
// that arrivals use. `nearBottom` is sampled from the scroll container's
// `scroll` event -- which fires for our *own* programmatic scrolls too, and is
// dispatched a frame later, so the geometry it samples is whatever the layout
// happens to be at dispatch time. During an open that is mid-settle:
//
//   1. the open pins to the bottom;                     scrollTop = max
//   2. notices land from their own store read and       max grows by ~200px
//      insert above the anchor;                         (measured: 364px in a
//                                                        40-message group)
//   3. the queued scroll event finally dispatches and
//      samples the *grown* geometry;                    nearBottom := false
//   4. the re-anchor runs, consults nearBottom, and     no-op
//      declines to move.
//
// The growth the anchor exists to correct is the same growth that switches the
// anchor off. Whether steps 3 and 4 land in that order is a race, which is why
// the same conversation opened twice lands in two different places. It only
// showed in conversations that grow *after* first paint -- a run of membership
// notices, an image bubble -- and never in plain text, where everything lands
// in one commit and there is nothing to correct.
//
// The rule that falls out, and the reason the gate is gone here:
//
//   **Re-applying the open anchor is not an arrival.** Until the reader takes
//   the scroll over, the position is ours to assert; `nearBottom` is a fact
//   about the *reader*, and there is no reader input to read yet. It is
//   consulted only after hand-over, which is exactly what `settled` marks.
//
// The caller's other half of the contract: do not sample `nearBottom` from
// scroll events while `settled` is false, and take one sample at hand-over.
// See `Timeline.tsx`.

/** Which of the two the open aimed at, so a re-apply repeats the decision
 *  rather than re-deriving it from a timeline that is still filling in. */
export type AnchorTarget = "divider" | "bottom";

export type AnchorAction =
  | "centre-divider"
  | "pin-bottom"
  /** Keep the row the reader is looking at where it is, absorbing whatever
   *  was inserted above it. Scroll anchoring, which Safari does not do. */
  | "hold-position"
  | "none";

export type AnchorState = {
  /** The open's one shot has been taken, and `target` records what it chose. */
  anchored: boolean;
  target: AnchorTarget;
  /** The reader owns the scroll now. Everything after this is an arrival. */
  settled: boolean;
  /** Whether the reader is parked at the bottom. Meaningful only once
   *  `settled` -- before that nobody has scrolled anything but us. */
  nearBottom: boolean;
};

export function freshAnchor(): AnchorState {
  return { anchored: false, target: "bottom", settled: false, nearBottom: true };
}

export type AnchorSignal =
  /** A commit landed. `dividerIndex` is the rendered row the divider sits
   *  above (-1 for none); `dividerPending` is true while its existence is
   *  still undecided -- hold the bottom, but do not spend the one shot. */
  | { kind: "render"; dividerIndex: number; dividerPending: boolean }
  /** The content box changed height without the item list changing: an image
   *  decoding, a font swapping, a receipt line appearing. */
  | { kind: "resize" }
  /** The reader touched something, or the settle window ran out. */
  | { kind: "handover" };

/**
 * The whole decision. Returns the next state and what the caller should do to
 * the scroll container -- never both a mutation and a state change to keep in
 * step, which is how the old version drifted.
 */
export function planAnchor(
  state: AnchorState,
  signal: AnchorSignal,
): { state: AnchorState; action: AnchorAction } {
  if (signal.kind === "handover") {
    return { state: { ...state, settled: true }, action: "none" };
  }

  // The reader is driving.
  if (state.settled) {
    // A bare height change is not an arrival, and this is the case that was
    // still landing people mid-conversation: the open window closes after
    // about 700ms, and a photo coming off the network or a message healing
    // its decrypt lands well after that. Doing nothing meant the reader
    // silently kept whatever scroll offset they had while content grew above
    // them -- so the same conversation opened four times sat in three
    // different places, each a picture's height apart.
    //
    // Chromium absorbs this natively (scroll anchoring); Safari implements
    // none, which is why it read as an iPhone bug. At the bottom, follow the
    // growth down -- that is what somebody parked at the bottom wants.
    // Otherwise hold the row they are actually looking at.
    if (signal.kind === "resize") {
      return { state, action: state.nearBottom ? "pin-bottom" : "hold-position" };
    }
    return { state, action: state.nearBottom ? "pin-bottom" : "none" };
  }

  if (!state.anchored) {
    // The one shot, keyed off the *rendered* row rather than the divider
    // value, so it can only latch on a line that is actually in the DOM.
    if (signal.kind === "render" && signal.dividerIndex >= 0) {
      return {
        state: { ...state, anchored: true, target: "divider" },
        action: "centre-divider",
      };
    }
    // Nothing to centre on: hold the bottom. Latching that choice waits until
    // the divider's existence is actually decided, so a slow conversation
    // list cannot cost the divider its shot.
    const decided = signal.kind === "render" && !signal.dividerPending;
    return {
      state: decided ? { ...state, anchored: true, target: "bottom" } : state,
      action: "pin-bottom",
    };
  }

  // Anchored, still settling: put the scroll back on what the open chose.
  // Unconditionally -- see the header. This is the fix.
  return {
    state,
    action: state.target === "divider" ? "centre-divider" : "pin-bottom",
  };
}
