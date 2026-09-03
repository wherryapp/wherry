import assert from "node:assert/strict";
import { test } from "node:test";
import { BackStack, type HistoryLike } from "./back.ts";

/**
 * A history that models the one property this depends on: entries exist,
 * `back()` spends one, and the popstate for it arrives *later*. Later is
 * the whole point -- a synchronous fake would hide exactly the race the
 * class is shaped around -- so `settle()` is what delivers it.
 */
function fakeHistory(): HistoryLike & {
  pushes: number;
  backs: number;
  pending: number;
  settle: () => void;
  attach: (stack: BackStack) => void;
} {
  let stack: BackStack | null = null;
  const h = {
    pushes: 0,
    backs: 0,
    pending: 0,
    pushState() {
      h.pushes += 1;
    },
    back() {
      h.backs += 1;
      h.pending += 1;
    },
    /** Deliver every popstate the queued back() calls owe. */
    settle() {
      while (h.pending > 0) {
        h.pending -= 1;
        stack?.onPopState();
      }
    },
    attach(s: BackStack) {
      stack = s;
    },
  };
  return h;
}

test("each open layer owns one history entry", () => {
  const history = fakeHistory();
  const stack = new BackStack(history);
  history.attach(stack);

  stack.push(() => {});
  assert.equal(stack.entries, 1);
  stack.push(() => {});
  assert.equal(stack.entries, 2);
  assert.equal(history.pushes, 2);
});

test("a back press closes the topmost layer, one per press", () => {
  const history = fakeHistory();
  const stack = new BackStack(history);
  history.attach(stack);

  const closed: string[] = [];
  stack.push(() => closed.push("panel"));
  stack.push(() => closed.push("photo"));

  assert.equal(stack.onPopState(), true);
  assert.deepEqual(closed, ["photo"]);
  assert.equal(stack.depth, 1);
  assert.equal(stack.entries, 1);

  assert.equal(stack.onPopState(), true);
  assert.deepEqual(closed, ["photo", "panel"]);
  assert.equal(stack.entries, 0);
});

test("with nothing open a back press is not ours", () => {
  const history = fakeHistory();
  const stack = new BackStack(history);
  history.attach(stack);

  // This is what lets the Android activity finish rather than the page
  // eating the gesture: no entries owned, nothing claimed.
  assert.equal(stack.onPopState(), false);
  assert.equal(history.backs, 0);
  assert.equal(stack.entries, 0);
});

test("closing a layer some other way gives its entry back", () => {
  const history = fakeHistory();
  const stack = new BackStack(history);
  history.attach(stack);

  let closes = 0;
  const release = stack.push(() => {
    closes += 1;
  });
  release();

  assert.equal(history.backs, 1);
  history.settle();
  assert.equal(stack.entries, 0);
  assert.equal(stack.depth, 0);
  // The layer closed itself; the popstate its own back() produced must not
  // close it a second time.
  assert.equal(closes, 0);
});

test("a released layer does not eat the next real back press", () => {
  const history = fakeHistory();
  const stack = new BackStack(history);
  history.attach(stack);

  const closed: string[] = [];
  stack.push(() => closed.push("panel"));
  const releasePhoto = stack.push(() => closed.push("photo"));

  releasePhoto();
  history.settle();
  assert.equal(stack.entries, 1);

  stack.onPopState();
  assert.deepEqual(closed, ["panel"]);
  assert.equal(stack.entries, 0);
});

test("a close-and-reopen inside one tick settles at one entry", () => {
  // React's development double-invoke: mount, cleanup, mount, all before
  // the first back()'s popstate can arrive. This is the case the naive
  // swallow-counter version got wrong -- it left a counter armed and the
  // next real back press did nothing at all.
  const history = fakeHistory();
  const stack = new BackStack(history);
  history.attach(stack);

  let closed = 0;
  const release = stack.push(() => {
    closed += 1;
  });
  release();
  stack.push(() => {
    closed += 1;
  });

  history.settle();

  assert.equal(stack.depth, 1);
  assert.equal(stack.entries, 1);
  assert.equal(closed, 0);

  // And the layer that is actually open is the one a back press closes.
  stack.onPopState();
  assert.equal(closed, 1);
  assert.equal(stack.entries, 0);
});

test("a back press's own close() cleanup releases nothing twice", () => {
  const history = fakeHistory();
  const stack = new BackStack(history);
  history.attach(stack);

  // What React does: the close handler unmounts the component, whose effect
  // cleanup then calls release. The layer is already off the stack by then.
  let release = (): void => {};
  release = stack.push(() => release());
  stack.onPopState();
  history.settle();

  assert.equal(stack.depth, 0);
  assert.equal(stack.entries, 0);
  assert.equal(history.backs, 0);
});

test("releasing a buried layer keeps the counts in step", () => {
  const history = fakeHistory();
  const stack = new BackStack(history);
  history.attach(stack);

  const closed: string[] = [];
  const releaseLower = stack.push(() => closed.push("lower"));
  stack.push(() => closed.push("upper"));

  releaseLower();
  history.settle();
  assert.equal(stack.depth, 1);
  assert.equal(stack.entries, 1);

  stack.onPopState();
  assert.deepEqual(closed, ["upper"]);
  assert.equal(stack.entries, 0);
});

test("several layers released at once cost one entry each", () => {
  const history = fakeHistory();
  const stack = new BackStack(history);
  history.attach(stack);

  const releases = [
    stack.push(() => {}),
    stack.push(() => {}),
    stack.push(() => {}),
  ];
  assert.equal(stack.entries, 3);

  // Closing a panel that had a dialog over it, say: everything unmounts in
  // one commit, but only one back() may be in flight at a time.
  for (const release of releases) release();
  assert.equal(history.backs, 1);

  history.settle();
  assert.equal(stack.entries, 0);
  assert.equal(stack.depth, 0);
  assert.equal(history.backs, 3);
});
