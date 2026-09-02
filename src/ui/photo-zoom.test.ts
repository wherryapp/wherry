import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SCALE,
  RESET,
  clampPan,
  clampScale,
  isReset,
  scaleAbout,
  type Transform,
} from "./photo-zoom.ts";

// A viewport and a picture that fills its width but not its height -- the
// asymmetric case, where the two axes must clamp differently.
const viewport = { width: 400, height: 800 };
const content = { width: 400, height: 300 };

test("clampScale holds the ends", () => {
  assert.equal(clampScale(0.2), 1);
  assert.equal(clampScale(1), 1);
  assert.equal(clampScale(99), MAX_SCALE);
});

test("scaling about the centre leaves the centre alone", () => {
  const next = scaleAbout(RESET, 2, 0, 0);
  assert.deepEqual(next, { scale: 2, x: 0, y: 0 });
});

test("the point under the fingers stays under the fingers", () => {
  // Where a content point sits on screen, for a given transform.
  const project = (t: Transform, local: number): number => t.x + t.scale * local;

  const origin = 120; // 120px right of the viewport centre
  const before: Transform = { scale: 1, x: 0, y: 0 };
  // The content coordinate currently under that screen point.
  const local = (origin - before.x) / before.scale;

  const after = scaleAbout(before, 3, origin, 0);
  assert.equal(after.scale, 3);
  assert.ok(Math.abs(project(after, local) - origin) < 1e-9);
});

test("scaling past the cap still pins the origin, at the capped scale", () => {
  const after = scaleAbout(RESET, 100, 50, 50);
  assert.equal(after.scale, MAX_SCALE);
  const local = 50;
  assert.ok(Math.abs(after.x + MAX_SCALE * local - 50) < 1e-9);
});

test("an axis that fits cannot be panned off centre", () => {
  // At scale 1 neither axis overhangs, so both offsets are pulled back to 0.
  const dragged = clampPan({ scale: 1, x: 90, y: -70 }, viewport, content);
  assert.deepEqual(dragged, { scale: 1, x: 0, y: 0 });

  // At scale 2 the width overhangs by 400 (half of that each side) while the
  // 600px-tall content still fits inside 800.
  const wide = clampPan({ scale: 2, x: 500, y: 500 }, viewport, content);
  assert.equal(wide.x, 200);
  assert.equal(wide.y, 0);
});

test("panning within the overhang is left alone", () => {
  const inside = clampPan({ scale: 2, x: -137, y: 0 }, viewport, content);
  assert.equal(inside.x, -137);
});

test("zooming back out walks the offsets home", () => {
  // Pushed to a corner at 4x, then pinched back to 1: the clamp is what stops
  // the picture from staying jammed against the edge it was dragged to.
  const cornered = clampPan({ scale: 4, x: 9999, y: 9999 }, viewport, content);
  assert.equal(cornered.x, 600);
  assert.equal(cornered.y, 200);

  const home = clampPan({ ...cornered, scale: 1 }, viewport, content);
  assert.deepEqual(home, RESET);
});

test("isReset is what a tap-to-close asks", () => {
  assert.equal(isReset(RESET), true);
  assert.equal(isReset({ scale: 2.5, x: 0, y: 0 }), false);
});
