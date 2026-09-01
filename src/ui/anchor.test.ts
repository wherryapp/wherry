import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshAnchor,
  planAnchor,
  type AnchorSignal,
  type AnchorState,
} from "./anchor.ts";

/** Feeds a run of signals through, collecting what the caller would have done. */
function drive(
  state: AnchorState,
  signals: AnchorSignal[],
): { state: AnchorState; actions: string[] } {
  const actions: string[] = [];
  let current = state;
  for (const signal of signals) {
    const next = planAnchor(current, signal);
    current = next.state;
    actions.push(next.action);
  }
  return { state: current, actions };
}

const render = (dividerIndex: number, dividerPending = false): AnchorSignal => ({
  kind: "render",
  dividerIndex,
  dividerPending,
});

test("an open with nothing unread pins to the bottom and latches there", () => {
  const { state, actions } = drive(freshAnchor(), [render(-1)]);
  assert.deepEqual(actions, ["pin-bottom"]);
  assert.equal(state.anchored, true);
  assert.equal(state.target, "bottom");
});

test("an open with unread centres the divider and latches there", () => {
  const { state, actions } = drive(freshAnchor(), [render(12)]);
  assert.deepEqual(actions, ["centre-divider"]);
  assert.equal(state.target, "divider");
});

test("a pending divider holds the bottom without spending the one shot", () => {
  const { state, actions } = drive(freshAnchor(), [render(-1, true)]);
  assert.deepEqual(actions, ["pin-bottom"]);
  assert.equal(state.anchored, false, "the divider still gets its shot");

  // ...and when the answer finally lands, it does.
  const later = drive(state, [render(7)]);
  assert.deepEqual(later.actions, ["centre-divider"]);
  assert.equal(later.state.target, "divider");
});

// ---------------------------------------------------------------------------
// The regression this file exists for.
// ---------------------------------------------------------------------------

test("re-applying the open anchor ignores nearBottom -- the growth that displaces the anchor used to disable it", () => {
  // The exact sequence that shipped broken: pin to the bottom, then notices
  // land and push the bottom 200px away, then the scroll event our own pin
  // queued finally dispatches and samples the grown geometry as "not at the
  // bottom". Every re-anchor after that used to be a no-op.
  const opened = drive(freshAnchor(), [render(-1)]).state;
  const poisoned: AnchorState = { ...opened, nearBottom: false };

  assert.equal(
    planAnchor(poisoned, render(-1)).action,
    "pin-bottom",
    "a commit during the settle window must re-pin regardless of nearBottom",
  );
  assert.equal(
    planAnchor(poisoned, { kind: "resize" }).action,
    "pin-bottom",
    "so must a bare height change -- an image decoding, a font swapping",
  );
});

test("the same holds for the divider target", () => {
  const opened = drive(freshAnchor(), [render(9)]).state;
  const poisoned: AnchorState = { ...opened, nearBottom: false };
  assert.equal(planAnchor(poisoned, { kind: "resize" }).action, "centre-divider");
});

test("a re-apply repeats the open's decision rather than re-deriving it", () => {
  // dividerIndex goes to -1 mid-settle (useTimeline's items briefly lag a
  // conversation switch). The anchor must not fall back to the bottom.
  const opened = drive(freshAnchor(), [render(9)]).state;
  assert.equal(planAnchor(opened, render(-1)).action, "centre-divider");
});

// ---------------------------------------------------------------------------
// After hand-over, the reader owns the scroll.
// ---------------------------------------------------------------------------

test("hand-over stops the anchor and hands arrivals the nearBottom gate", () => {
  const opened = drive(freshAnchor(), [render(-1)]).state;
  const settled = planAnchor(opened, { kind: "handover" }).state;
  assert.equal(settled.settled, true);

  const atBottom: AnchorState = { ...settled, nearBottom: true };
  assert.equal(planAnchor(atBottom, render(-1)).action, "pin-bottom");

  const scrolledUp: AnchorState = { ...settled, nearBottom: false };
  assert.equal(
    planAnchor(scrolledUp, render(-1)).action,
    "none",
    "an arrival must not yank a reader who has scrolled up",
  );
});

test("a height change after hand-over holds the reader's place", () => {
  // The residual defect after the first fix: the open window closes about
  // 700ms in, and a photo off the network or a message healing its decrypt
  // lands later than that. Doing nothing here left the reader a picture's
  // height out of place, repeatably, which is exactly what was reported.
  const settled = planAnchor(
    drive(freshAnchor(), [render(-1)]).state,
    { kind: "handover" },
  ).state;

  assert.equal(
    planAnchor({ ...settled, nearBottom: false }, { kind: "resize" }).action,
    "hold-position",
    "growth above a reader mid-conversation must not move them",
  );
  assert.equal(
    planAnchor({ ...settled, nearBottom: true }, { kind: "resize" }).action,
    "pin-bottom",
    "somebody parked at the bottom follows the growth down instead",
  );
});

test("hold-position is only ever a settled-state answer", () => {
  // While the open still owns the scroll, a resize re-asserts the *target*.
  // Holding the reader's place there would freeze the timeline wherever the
  // first commit happened to leave it.
  const opening = drive(freshAnchor(), [render(-1)]).state;
  assert.equal(planAnchor(opening, { kind: "resize" }).action, "pin-bottom");
  const onDivider = drive(freshAnchor(), [render(5)]).state;
  assert.equal(planAnchor(onDivider, { kind: "resize" }).action, "centre-divider");
});

test("hand-over before the one shot leaves the scroll alone", () => {
  // The reader flicked the list open and started scrolling immediately.
  const settled = planAnchor(freshAnchor(), { kind: "handover" }).state;
  assert.equal(planAnchor(settled, render(4)).action, "pin-bottom");
  assert.equal(
    planAnchor({ ...settled, nearBottom: false }, render(4)).action,
    "none",
    "a reader who is already scrolling keeps their place",
  );
});

test("planAnchor never mutates the state it is given", () => {
  const state = freshAnchor();
  const before = JSON.stringify(state);
  planAnchor(state, render(3));
  planAnchor(state, { kind: "resize" });
  planAnchor(state, { kind: "handover" });
  assert.equal(JSON.stringify(state), before);
});
