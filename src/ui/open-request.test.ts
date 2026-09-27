import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REQUEST_TTL_MS,
  consumeOpen,
  isStale,
  pendingOpen,
  requestOpen,
  type OpenRequest,
} from "./open-request.ts";

function quietly(run: () => void): void {
  const info = console.info;
  console.info = () => {};
  try {
    run();
  } finally {
    console.info = info;
  }
}

test("a request is stale only after the TTL", () => {
  const request: OpenRequest = { kind: "message", ref: "r", at: 1_000 };
  assert.equal(isStale(request, 1_000 + REQUEST_TTL_MS), false);
  assert.equal(isStale(request, 1_000 + REQUEST_TTL_MS + 1), true);
});

test("a request is held until the shell consumes that very request", () => {
  quietly(() => {
    requestOpen({ kind: "message", ref: "AAAAAAAAAAAAAAAAAAAAAA" });
    const first = pendingOpen();
    assert.equal(first?.ref, "AAAAAAAAAAAAAAAAAAAAAA");

    // A newer tap replaces it: the latest is what the person meant.
    requestOpen({ kind: "call", conversationId: "c-1" });
    const second = pendingOpen();
    assert.equal(second?.conversationId, "c-1");

    // Consuming the older one (a resolution that finished late) leaves the
    // newer one standing.
    consumeOpen(first!);
    assert.equal(pendingOpen(), second);

    consumeOpen(second!);
    assert.equal(pendingOpen(), null);
  });
});
