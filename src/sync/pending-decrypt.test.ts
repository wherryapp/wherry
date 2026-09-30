// The forward archive sync must not pin on a failure it cannot heal
// (sweep 1001, client-core-10).
//
// Run with `pnpm test` from client/. No database, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FORWARD_SYNC_ATTEMPTS,
  settlePendingDecrypts,
} from "./pending-decrypt.ts";

const row = (messageId: string, decryptFailed: boolean) => ({
  messageId,
  conversationId: `c-${messageId}`,
  decryptFailed,
});

test("a healed row leaves the record and names its conversation", () => {
  const pending = { a: "c-a", b: "c-b" };
  const attempts = new Map<string, number>();
  const healed = settlePendingDecrypts(pending, [row("a", false), row("x", false)], attempts);
  assert.deepEqual(pending, { b: "c-b" });
  assert.deepEqual([...healed], ["c-a"]);
});

test("a row that keeps failing is given up after a few reads, not pinned forever", () => {
  const pending: Record<string, string> = { a: "c-a", b: "c-b" };
  const attempts = new Map<string, number>();
  for (let run = 1; run < FORWARD_SYNC_ATTEMPTS; run++) {
    settlePendingDecrypts(pending, [row("a", true)], attempts);
    assert.ok("a" in pending, `still pending after read ${run}`);
  }
  settlePendingDecrypts(pending, [row("a", true)], attempts);
  assert.deepEqual(pending, { b: "c-b" });
  assert.equal(attempts.has("a"), false);
});

test("a row that heals on a later read is healed, and its count forgotten", () => {
  const pending: Record<string, string> = { a: "c-a" };
  const attempts = new Map<string, number>();
  settlePendingDecrypts(pending, [row("a", true)], attempts);
  const healed = settlePendingDecrypts(pending, [row("a", false)], attempts);
  assert.deepEqual(pending, {});
  assert.deepEqual([...healed], ["c-a"]);
  assert.equal(attempts.size, 0);
});

test("rows not in the record are ignored", () => {
  const pending: Record<string, string> = {};
  const attempts = new Map<string, number>();
  const healed = settlePendingDecrypts(pending, [row("z", true), row("y", false)], attempts);
  assert.equal(healed.size, 0);
  assert.equal(attempts.size, 0);
});
