// The leader election against a Web Locks API that misbehaves.
//
// The case that matters is a `navigator.locks.request` that rejects outright
// -- WebKit does this (`InvalidStateError` for a document it no longer
// considers fully active, among others). Before 2026-09-07 the election
// re-queued in the rejection's own `.finally`, so a rejecting API became an
// unbounded chain of microtasks: request, reject, abort, request, ... with
// no macrotask in between, which is a main thread that never returns to its
// event loop. A 3-second `sample` of an iOS-simulator page pegged for days
// showed exactly that stack (docs/freeze/2026-09-07-simulator-main-thread.txt).
// These tests stand in for the phone: the fake API rejects, and the
// assertion is that the election yields.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

type Request = (name: string, options: unknown, cb: () => Promise<void>) => Promise<void>;

let requests = 0;
let requestImpl: Request;
// The escape hatch that keeps a regressed build from hanging the suite. It
// has to run *inside* the fake, synchronously: a microtask loop starves every
// timer, so a setInterval guard would never get its turn (it did not, the
// first time this test was run against the unfixed election).
let stopAfter: { at: number; stop: () => void } | null = null;
const listeners = { add: () => {}, remove: () => {} };

function installGlobals(): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: (name: string, options: unknown, cb: () => Promise<void>) => {
          requests += 1;
          if (stopAfter && requests >= stopAfter.at) stopAfter.stop();
          return requestImpl(name, options, cb);
        },
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "visible", addEventListener: listeners.add, removeEventListener: listeners.remove },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { addEventListener: listeners.add, removeEventListener: listeners.remove },
  });
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: class {
      postMessage(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    },
  });
}

function rejecting(name: string, message: string): Request {
  return () => Promise.reject(new DOMException(message, name));
}

beforeEach(() => {
  requests = 0;
  installGlobals();
});

afterEach(() => {
  for (const key of ["navigator", "document", "window", "BroadcastChannel"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

const { runAsLeader } = await import("./leader.ts");

test("a request that rejects outright does not re-queue in the same turn", async () => {
  requestImpl = rejecting("InvalidStateError", "The document is not fully active.");
  // A macrotask scheduled *before* the election starts. With the bug it only
  // runs once the loop is broken from outside; fixed, it runs after a
  // handful of requests at most.
  let seenAtFirstTimer = -1;
  const firstTimer = new Promise<void>((resolve) =>
    setTimeout(() => {
      seenAtFirstTimer = requests;
      resolve();
    }, 0),
  );
  const handle = runAsLeader("test", async () => {});
  stopAfter = { at: 1000, stop: () => handle.stop() };
  await firstTimer;
  stopAfter = null;
  handle.stop();
  assert.ok(
    seenAtFirstTimer <= 2,
    `expected the event loop to run after at most 2 requests, saw ${seenAtFirstTimer}`,
  );
});

test("a rejecting API is retried on a timer, with backoff, and recovers", async () => {
  let granted = false;
  requestImpl = (_name, _options, cb) => {
    if (requests <= 2) return Promise.reject(new DOMException("nope", "InvalidStateError"));
    granted = true;
    return cb();
  };
  const handle = runAsLeader("test", (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve())));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests, 1, "no retry inside the first 20 ms");
  // First retry after ~250 ms, second after ~500 ms more: granted by ~800 ms.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.ok(granted, "the third request should have been granted");
  assert.equal(handle.isLeader(), true);
  handle.stop();
});

test("a task that returns on its own is not restarted", async () => {
  requestImpl = (_name, _options, cb) => cb();
  const handle = runAsLeader("test", async () => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests, 1);
  assert.equal(handle.isLeader(), false);
  handle.stop();
});
