import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatRate,
  transferRate,
  uploadPercent,
  uploadStatusLine,
} from "./upload-status.js";

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

// ---------------------------------------------------------------------------
// Transfer rate
// ---------------------------------------------------------------------------

test("a rate is quoted in decimal units, the way a connection is", () => {
  // An ISP, a speed test and the router all quote decimal. A binary rate
  // would not compare with the number the reader would compare it against.
  assert.equal(formatRate(1000), "1 kB/s");
  assert.equal(formatRate(1_500_000), "1.5 MB/s");
  assert.equal(formatRate(400_000), "400 kB/s");
  assert.equal(formatRate(999), "999 B/s");
});

test("a nonsense rate renders as nothing rather than as a number", () => {
  assert.equal(formatRate(0), "");
  assert.equal(formatRate(-5), "");
  assert.equal(formatRate(Number.NaN), "");
  assert.equal(formatRate(Number.POSITIVE_INFINITY), "");
});

test("no rate is claimed from the first moments of a transfer", () => {
  // The opening samples are dominated by buffering; a rate from them is
  // confidently wrong.
  assert.equal(transferRate(50_000, 100), null);
  assert.equal(transferRate(0, 5_000), null);
});

test("once there is something to measure, the rate is the average so far", () => {
  assert.equal(transferRate(1_000_000, 1_000), 1_000_000);
  assert.equal(transferRate(500_000, 2_000), 250_000);
});

test("the status line carries the rate only when there is one", () => {
  const base = { index: 0, total: 1, stage: "uploading", fraction: 0.42 } as const;
  assert.equal(uploadStatusLine(base), "Uploading — 42%");
  assert.equal(
    uploadStatusLine({ ...base, bytesPerSecond: 1_500_000 }),
    "Uploading — 42% · 1.5 MB/s",
  );
  assert.equal(
    uploadStatusLine({ ...base, bytesPerSecond: 0 }),
    "Uploading — 42%",
    "a zero rate is not a rate",
  );
});
