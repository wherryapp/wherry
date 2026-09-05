// Pins the reorder arithmetic: the hold-cancel distance is radial and
// measured from the press, slots count midpoints, and the indicator hides
// at the two positions that would be a no-op.
//
// Run with `pnpm test` from client/. No database, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOLD_CANCEL_PX,
  HOLD_MS,
  indicatorSlot,
  insertionSlot,
  movedPastHold,
} from "./reorder.ts";

test("the hold is shorter than Android's own long-press", () => {
  // Chrome on Android raises contextmenu at ~500 ms; the lift must win.
  assert.ok(HOLD_MS < 500);
});

test("movedPastHold is radial and measured against the press", () => {
  assert.equal(movedPastHold(0, 0), false);
  assert.equal(movedPastHold(HOLD_CANCEL_PX, 0), false);
  assert.equal(movedPastHold(HOLD_CANCEL_PX + 1, 0), true);
  // 6 + 6 is under 8 on either axis alone but over it as a distance.
  assert.equal(movedPastHold(6, 6), true);
});

test("insertionSlot counts the midpoints before the pointer", () => {
  const extents = [
    { start: 0, end: 40 },
    { start: 40, end: 80 },
    { start: 80, end: 120 },
  ];
  assert.equal(insertionSlot(extents, -5), 0);
  assert.equal(insertionSlot(extents, 19), 0);
  assert.equal(insertionSlot(extents, 21), 1);
  assert.equal(insertionSlot(extents, 61), 2);
  assert.equal(insertionSlot(extents, 101), 3);
  assert.equal(insertionSlot(extents, 500), 3);
  assert.equal(insertionSlot([], 10), 0);
});

test("insertionSlot is axis-agnostic: the same numbers work for x and y", () => {
  const horizontal = [
    { start: 100, end: 164 },
    { start: 172, end: 236 },
  ];
  assert.equal(insertionSlot(horizontal, 150), 1);
  assert.equal(insertionSlot(horizontal, 130), 0);
});

test("indicatorSlot hides the two no-op positions", () => {
  assert.equal(indicatorSlot(1, 1), null);
  assert.equal(indicatorSlot(1, 2), null);
  assert.equal(indicatorSlot(1, 0), 0);
  assert.equal(indicatorSlot(1, 3), 3);
  assert.equal(indicatorSlot(0, 0), null);
  assert.equal(indicatorSlot(0, 1), null);
});
