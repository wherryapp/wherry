// The status vocabulary and the duration arithmetic. Run with `pnpm test`
// from client/. No DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STATUS_OPTIONS,
  durationSeconds,
  expiryLabel,
  nextMorning,
  onlineOthers,
  presenceStatusOf,
  statusDotClass,
  statusLabel,
} from "./status.ts";

test("the picker offers the four statuses, online first", () => {
  assert.deepEqual(
    STATUS_OPTIONS.map((option) => option.status),
    ["online", "away", "dnd", "invisible"],
  );
  for (const option of STATUS_OPTIONS) {
    assert.equal(option.label, statusLabel(option.status));
    assert.ok(statusDotClass(option.status).length > 0);
  }
});

test("absent from the statuses map reads as plain online, an older server included", () => {
  assert.equal(presenceStatusOf("u", undefined), "online");
  assert.equal(presenceStatusOf("u", {}), "online");
  assert.equal(presenceStatusOf("u", { u: "dnd" }), "dnd");
});

test("until tomorrow is the next 08:00 local, never later today", () => {
  const evening = new Date(2026, 8, 3, 23, 30);
  const next = nextMorning(evening);
  assert.deepEqual([next.getDate(), next.getHours(), next.getMinutes()], [4, 8, 0]);

  // Set just before 08:00, it still means TOMORROW's 08:00.
  const early = new Date(2026, 8, 3, 7, 59, 30);
  assert.equal(nextMorning(early).getDate(), 4);
  assert.ok(durationSeconds("tomorrow", early)! > 23 * 3600);
});

test("fixed durations are exact; until-changed is null", () => {
  const now = new Date(2026, 8, 3, 12, 0);
  assert.equal(durationSeconds("until-changed", now), null);
  assert.equal(durationSeconds("30m", now), 1800);
  assert.equal(durationSeconds("1h", now), 3600);
});

test("the expiry label says tomorrow when it is", () => {
  const now = new Date(2026, 8, 3, 12, 0);
  assert.match(expiryLabel(new Date(2026, 8, 3, 14, 30).toISOString(), now), /^Until \d/);
  assert.match(expiryLabel(new Date(2026, 8, 4, 8, 0).toISOString(), now), /^Until tomorrow/);
});

test("onlineOthers keeps member order and drops the caller", () => {
  const members = ["a", "b", "c", "d"];
  assert.deepEqual(onlineOthers(members, "a", ["d", "b", "a"]), ["b", "d"]);
});

test("onlineOthers treats an absent snapshot as unknown, not offline", () => {
  // Unknown and everyone-offline render the same way today -- no dots -- but
  // they must not be conflated: presence has no stored form, so "we have not
  // been told" is the state a socket-down client is in most of the time.
  assert.deepEqual(onlineOthers(["a", "b"], "a", undefined), []);
  assert.deepEqual(onlineOthers(["a", "b"], "a", []), []);
});

test("onlineOthers ignores ids that are not members", () => {
  // The bulk answer is per conversation, but a stale one could name somebody
  // who has since left; the row draws members, so the intersection is what
  // matters rather than the raw list's length.
  assert.deepEqual(onlineOthers(["a", "b"], "a", ["z", "b"]), ["b"]);
});
