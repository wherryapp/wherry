import { test } from "node:test";
import assert from "node:assert/strict";
import { listTime } from "./format.ts";

// A fixed "now" so the boundaries are the test's, not the clock's. Local time
// throughout, because the function compares calendar days the way a person
// reading the list does.
const now = new Date(2026, 8, 2, 14, 30); // Wed 2 Sep 2026, 14:30

const at = (
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
): string => new Date(year, month, day, hour, minute).toISOString();

// Assertions are on shape rather than on exact output, because the function
// formats in the reader's locale and CI's is not this machine's. What the
// change is actually about survives that: a numeric date has no letters in it
// in any locale, and a weekday name is nothing but letters.
const hasLetters = (s: string): boolean => /\p{L}/u.test(s);

test("today shows a time", () => {
  const shown = listTime(at(2026, 8, 2, 9, 15), now);
  assert.ok(shown.includes(":"), `expected a clock time, got ${shown}`);
  assert.ok(shown.includes("15"), `expected the minutes, got ${shown}`);
});

test("a minute after midnight today is still a time", () => {
  assert.ok(listTime(at(2026, 8, 2, 0, 1), now).includes(":"));
});

test("yesterday is a date, not a weekday", () => {
  const shown = listTime(at(2026, 8, 1, 23, 50), now);
  assert.ok(!hasLetters(shown), `expected a numeric date, got ${shown}`);
  assert.ok(!shown.includes(":"), `expected no clock time, got ${shown}`);
});

test("earlier this week is a date, which is the whole change", () => {
  // Sun 30 Aug. This used to render "Sun", indistinguishable from the Sunday
  // a week before it -- the ambiguity the change exists to remove.
  const shown = listTime(at(2026, 7, 30), now);
  assert.ok(!hasLetters(shown), `expected a numeric date, got ${shown}`);
  assert.ok(shown.includes("30"), `expected the day of the month, got ${shown}`);
});

test("a different year says so, and this year does not", () => {
  assert.ok(listTime(at(2025, 11, 24), now).includes("2025"));
  assert.ok(!listTime(at(2026, 0, 3), now).includes("2026"));
});

test("the boundary is the calendar day, not 24 hours", () => {
  // 23:50 yesterday is less than 24 hours ago and must still read as a date;
  // 09:15 today is more than 24 hours after 09:00 the day before and must
  // read as a time. An elapsed-hours rule gets both of these backwards.
  assert.ok(!listTime(at(2026, 8, 1, 23, 50), now).includes(":"));
  assert.ok(listTime(at(2026, 8, 2, 9, 15), now).includes(":"));
});
