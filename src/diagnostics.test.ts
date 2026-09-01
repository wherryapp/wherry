// The stall detector's rules, pinned.
//
// The plumbing (a timer, localStorage) is not testable and does not need to
// be; these three decisions are, and each has a failure mode that would make
// the instrument lie rather than merely not work. A diagnostic nobody can
// trust is worse than none, because it sends the next session hunting in the
// wrong place -- which is precisely what this file exists to stop happening
// a third time.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isSlowCall, keepWorst, stallFrom } from "./diagnostics.ts";

test("a gap only counts once it is meaningfully late", () => {
  // Ticks are 1000ms and the threshold is 500ms late.
  assert.equal(stallFrom(1000, "visible"), null, "on time");
  assert.equal(stallFrom(1400, "visible"), null, "jitter, not a stall");
  assert.equal(stallFrom(1500, "visible"), 500, "exactly at the threshold");
  assert.equal(stallFrom(4200, "visible"), 3200, "a real freeze");
});

test("a hidden document never reports a stall, however long the gap", () => {
  // The one that matters. Browsers throttle background timers on purpose and
  // iOS suspends the app outright, so a phone in a pocket produces gaps of
  // minutes. Counting those would bury the real freeze under noise -- and
  // since only the worst few are kept, it would evict it entirely.
  assert.equal(stallFrom(600_000, "hidden"), null);
  assert.equal(stallFrom(4200, "hidden"), null);
});

test("only calls slow enough to matter are named", () => {
  // Native WebCrypto answers in single-digit milliseconds; the threshold is
  // set well above ordinary work so the record is a tail, not a log.
  assert.equal(isSlowCall(12), false);
  assert.equal(isSlowCall(149), false);
  assert.equal(isSlowCall(150), true);
  assert.equal(isSlowCall(3200), true);
});

test("the report keeps the WORST entries, not the most recent", () => {
  // A ring buffer of the latest would throw away the freeze being hunted the
  // moment a few small ones followed it.
  const items = [{ ms: 100 }, { ms: 5000 }, { ms: 200 }, { ms: 300 }];
  const kept = keepWorst(items, (i) => i.ms);
  assert.equal(kept[0]?.ms, 5000);
  assert.deepEqual(
    kept.map((i) => i.ms),
    [5000, 300, 200, 100],
  );
});

test("the kept list is bounded", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ ms: i }));
  const kept = keepWorst(many, (i) => i.ms);
  assert.ok(kept.length <= 8, `kept ${kept.length}`);
  assert.equal(kept[0]?.ms, 49, "and it is the worst that survive");
});
