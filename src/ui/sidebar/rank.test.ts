// Pins the sidebar's ordering rules: recency ranking with the UUIDv7
// creation-time fallback, the deterministic tie-break, and how the manual
// hub order treats hubs it has never seen and ids that no longer exist.
//
// Run with `pnpm test` from client/. No database, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  moveItem,
  orderHubs,
  rankConversations,
  recencyRanker,
  seedHubOrder,
  uuidv7Ms,
} from "./rank.ts";

// A real UUIDv7 layout: first 48 bits are unix milliseconds. 0x018f4e2d1a2b
// is a plausible 2024 timestamp; the rest of the id is arbitrary.
function v7(ms: number, suffix = "8000-8000-000000000000"): string {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${suffix.slice(1)}`;
}

test("uuidv7Ms reads the 48-bit millisecond prefix back out", () => {
  const ms = 1_714_000_000_123;
  assert.equal(uuidv7Ms(v7(ms)), ms);
});

test("recencyRanker prefers the preview's sentAt over creation time", () => {
  const oldButBusy = { id: v7(1_000_000) };
  const newButQuiet = { id: v7(2_000_000) };
  const latest = new Map([
    [oldButBusy.id, { message: { sentAt: "2026-08-31T12:00:00.000Z" } }],
  ]);
  const ranked = rankConversations([newButQuiet, oldButBusy], recencyRanker(latest));
  assert.deepEqual(
    ranked.map((c) => c.id),
    [oldButBusy.id, newButQuiet.id],
  );
});

test("without previews the order is creation time, newest first", () => {
  const a = { id: v7(1_000_000) };
  const b = { id: v7(2_000_000) };
  const c = { id: v7(3_000_000) };
  const ranked = rankConversations([a, c, b], recencyRanker(new Map()));
  assert.deepEqual(ranked.map((x) => x.id), [c.id, b.id, a.id]);
});

test("equal ranks tie-break by id descending, matching the old order", () => {
  const ms = 5_000_000;
  const low = { id: v7(ms, "8000-8000-000000000001") };
  const high = { id: v7(ms, "8000-8000-000000000002") };
  const latest = new Map([
    [low.id, { message: { sentAt: "2026-08-31T12:00:00.000Z" } }],
    [high.id, { message: { sentAt: "2026-08-31T12:00:00.000Z" } }],
  ]);
  const ranked = rankConversations([low, high], recencyRanker(latest));
  assert.deepEqual(ranked.map((c) => c.id), [high.id, low.id]);
});

test("orderHubs with no stored order keeps server order", () => {
  const hubs = [{ id: "b" }, { id: "a" }, { id: "c" }];
  assert.deepEqual(orderHubs(hubs, []), hubs);
});

test("orderHubs applies stored positions and appends unknown hubs after", () => {
  const hubs = [{ id: "newest" }, { id: "a" }, { id: "b" }];
  const ordered = orderHubs(hubs, ["b", "a"]);
  assert.deepEqual(
    ordered.map((h) => h.id),
    ["b", "a", "newest"],
  );
});

test("moveItem drops into a later slot, adjusting for the removal", () => {
  assert.deepEqual(moveItem(["a", "b", "c", "d"], 0, 3), ["b", "c", "a", "d"]);
});

test("moveItem drops into an earlier slot unadjusted", () => {
  assert.deepEqual(moveItem(["a", "b", "c", "d"], 3, 1), ["a", "d", "b", "c"]);
});

test("moveItem treats the item's own two slots as no-ops", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 1, 1), ["a", "b", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 1, 2), ["a", "b", "c"]);
});

test("moveItem to the very ends", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 3), ["b", "c", "a"]);
});

test("orderHubs ignores stale ids for hubs since left", () => {
  const hubs = [{ id: "a" }, { id: "b" }];
  const ordered = orderHubs(hubs, ["gone", "b", "also-gone", "a"]);
  assert.deepEqual(ordered.map((h) => h.id), ["b", "a"]);
});

test("seedHubOrder waits until the summary says whether the account has an order", () => {
  assert.deepEqual(seedHubOrder([], ["a"]), { action: "wait" });
  // A summary stored by a build that never carried sortOrder.
  assert.deepEqual(seedHubOrder([{ id: "a" }], ["a"]), { action: "wait" });
});

test("seedHubOrder seeds once from a local order the account lacks", () => {
  const hubs = [
    { id: "b", sortOrder: null },
    { id: "a", sortOrder: null },
    { id: "c", sortOrder: null },
  ];
  const decision = seedHubOrder(hubs, ["a", "stale", "b"]);
  assert.equal(decision.action, "seed");
  if (decision.action === "seed") {
    assert.deepEqual(
      decision.order.map((hub) => hub.id),
      ["a", "b", "c"],
    );
  }
});

test("seedHubOrder clears a local order the account has superseded, or that names nothing", () => {
  assert.deepEqual(
    seedHubOrder([{ id: "a", sortOrder: 0 }, { id: "b", sortOrder: null }], ["b", "a"]),
    { action: "clear" },
  );
  assert.deepEqual(
    seedHubOrder([{ id: "a", sortOrder: null }], ["gone"]),
    { action: "clear" },
  );
  assert.deepEqual(seedHubOrder([{ id: "a", sortOrder: null }], []), { action: "clear" });
});
