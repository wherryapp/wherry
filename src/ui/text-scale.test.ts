// The text-size steps. Run with `pnpm test` from client/. No DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TEXT_SCALES,
  TEXT_SCALE_LABELS,
  clampScale,
  rootFontSize,
  stepScale,
} from "./text-scale.js";

test("every step has a label", () => {
  for (const scale of TEXT_SCALES) {
    assert.equal(typeof TEXT_SCALE_LABELS[scale], "string");
  }
});

test("clampScale accepts the steps, as numbers or as stored strings", () => {
  assert.equal(clampScale(1.15), 1.15);
  // localStorage hands back strings, and this is the read path for it.
  assert.equal(clampScale("1.45"), 1.45);
});

test("clampScale defaults anything unrecognised to 1", () => {
  assert.equal(clampScale(undefined), 1);
  assert.equal(clampScale(null), 1);
  assert.equal(clampScale("huge"), 1);
  assert.equal(clampScale(Number.NaN), 1);
  // Deliberately NOT snapped to the nearest step: a size nobody chose is
  // harder to explain than the default. 1.2 is between two steps and could
  // only come from a hand-edited key or a build that had different ones.
  assert.equal(clampScale(1.2), 1);
  // A value past the ends is the same case, not a clamp.
  assert.equal(clampScale(4), 1);
});

test("stepScale saturates rather than wrapping", () => {
  assert.equal(stepScale(1, 1), 1.15);
  assert.equal(stepScale(1, -1), 0.85);
  assert.equal(stepScale(1.45, 1), 1.45);
  assert.equal(stepScale(0.85, -1), 0.85);
});

test("rootFontSize is the browser default times the scale", () => {
  assert.equal(rootFontSize(1), "16px");
  assert.equal(rootFontSize(1.45), "23.2px");
});
