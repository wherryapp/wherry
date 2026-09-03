import assert from "node:assert/strict";
import { test } from "node:test";

import { uploadPercent, uploadStatusLine } from "./upload-status.js";

test("the percentage is floored, never rounded", () => {
  // Rounding shows 100% while bytes are still going out, which is precisely
  // what makes a slow upload look stuck.
  assert.equal(uploadPercent(0.996), 99);
  assert.equal(uploadPercent(0.999999), 99);
  assert.equal(uploadPercent(1), 100);
});

test("the percentage stays inside 0..100 whatever it is handed", () => {
  assert.equal(uploadPercent(0), 0);
  assert.equal(uploadPercent(-1), 0);
  assert.equal(uploadPercent(2), 100);
});

test("a fraction that is not a number reports no progress rather than full", () => {
  // NaN and Infinity both mean "there is no usable fraction here" -- a
  // zero-length body, or a total the transport never reported. Showing 100%
  // for that would claim a finished upload on the strength of a broken
  // measurement, which is the one direction this must not fail in.
  assert.equal(uploadPercent(Number.NaN), 0);
  assert.equal(uploadPercent(Number.POSITIVE_INFINITY), 0);
});

test("a single attachment is not counted at the reader", () => {
  const one = { index: 0, total: 1, fraction: 0.5 } as const;
  assert.equal(uploadStatusLine({ ...one, stage: "preparing" }), "Preparing…");
  assert.equal(uploadStatusLine({ ...one, stage: "sealing" }), "Encrypting…");
  assert.equal(uploadStatusLine({ ...one, stage: "uploading" }), "Uploading — 50%");
});

test("several attachments say which one, one-based", () => {
  const second = { index: 1, total: 3, fraction: 0.42 } as const;
  assert.equal(uploadStatusLine({ ...second, stage: "preparing" }), "Preparing 2 of 3…");
  assert.equal(uploadStatusLine({ ...second, stage: "sealing" }), "Encrypting 2 of 3…");
  assert.equal(
    uploadStatusLine({ ...second, stage: "uploading" }),
    "Uploading 2 of 3 — 42%",
  );
});

test("a fresh upload reads 0%, not blank", () => {
  assert.equal(
    uploadStatusLine({ index: 0, total: 1, stage: "uploading", fraction: 0 }),
    "Uploading — 0%",
  );
});
