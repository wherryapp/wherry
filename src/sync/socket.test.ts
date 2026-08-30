import { test } from "node:test";
import assert from "node:assert/strict";
import { SocketManager, type SocketLike } from "./socket.js";
import { Backoff } from "./backoff.js";

// A fake WebSocket the tests drive by hand. Events are delivered as plain
// objects; the manager only reads `.data` and `.code`, so that is all the
// fakes carry.
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed: { code?: number }[] = [];
  #listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener as (event: unknown) => void);
    this.#listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed.push(code === undefined ? {} : { code });
    // A real socket fires close asynchronously; synchronously is the harsher
    // ordering, and the manager must survive it.
    this.fire("close", { code: code ?? 1000 });
  }

  fire(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function harness(options?: { token?: string | null }) {
  const sockets: FakeSocket[] = [];
  let notified = 0;
  const manager = new SocketManager({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    url: "ws://test/api/ws",
    getToken: () => (options && "token" in options ? options.token! : "tok"),
    notify: () => (notified += 1),
    // Instant, deterministic reconnects: a zero-width backoff window.
    backoff: new Backoff({ baseMs: 0, ceilingMs: 0 }),
    staleCheckMs: 60 * 60 * 1000,
  });
  return { manager, sockets, notified: () => notified };
}

const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 5));

test("sends the auth frame on open and nothing before it", () => {
  const { manager, sockets } = harness();
  manager.start();

  const socket = sockets[0]!;
  assert.deepEqual(socket.sent, []);

  socket.fire("open", {});
  assert.deepEqual(JSON.parse(socket.sent[0]!), {
    v: 1,
    type: "auth",
    token: "tok",
  });
  manager.stop();
});

test("ready makes it healthy and notifies once (the reconnect drain)", () => {
  const { manager, sockets, notified } = harness();
  manager.start();
  const socket = sockets[0]!;
  socket.fire("open", {});

  assert.equal(manager.isHealthy(), false);
  socket.fire("message", { data: '{"type":"ready"}' });

  assert.equal(manager.isHealthy(), true);
  assert.equal(notified(), 1);
  manager.stop();
});

test("wake notifies; ping answers pong; junk is ignored", () => {
  const { manager, sockets, notified } = harness();
  manager.start();
  const socket = sockets[0]!;
  socket.fire("open", {});
  socket.fire("message", { data: '{"type":"ready"}' });

  socket.fire("message", { data: '{"type":"wake"}' });
  assert.equal(notified(), 2);

  socket.fire("message", { data: '{"type":"ping"}' });
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), { type: "pong" });

  socket.fire("message", { data: "not json" });
  socket.fire("message", { data: '{"type":"presence"}' }); // a newer server
  assert.equal(notified(), 2);
  assert.equal(manager.isHealthy(), true);
  manager.stop();
});

test("a healthy socket dying notifies and reconnects", async () => {
  const { manager, sockets, notified } = harness();
  manager.start();
  const first = sockets[0]!;
  first.fire("open", {});
  first.fire("message", { data: '{"type":"ready"}' });
  assert.equal(notified(), 1);

  first.fire("close", { code: 1006 });
  assert.equal(manager.isHealthy(), false);
  // The unhealthy transition pokes, so the engine's 30s wait ends now.
  assert.equal(notified(), 2);

  await flushTimers();
  assert.equal(sockets.length, 2);
  manager.stop();
});

test("a connection that never got healthy reconnects without notifying", async () => {
  const { manager, sockets, notified } = harness();
  manager.start();
  sockets[0]!.fire("close", { code: 1006 });

  assert.equal(notified(), 0);
  await flushTimers();
  assert.equal(sockets.length, 2);
  manager.stop();
});

test("4401 and 4403 are terminal: no reconnect", async () => {
  for (const code of [4401, 4403]) {
    const { manager, sockets } = harness();
    manager.start();
    const socket = sockets[0]!;
    socket.fire("open", {});
    socket.fire("close", { code });

    await flushTimers();
    assert.equal(sockets.length, 1, `code ${code} must not reconnect`);
    manager.stop();
  }
});

test("stop closes the socket and stops reconnects", async () => {
  const { manager, sockets } = harness();
  manager.start();
  manager.stop();

  assert.equal(sockets[0]!.closed.length, 1);
  await flushTimers();
  assert.equal(sockets.length, 1);
});

test("no token means no socket at all", () => {
  const { manager, sockets } = harness({ token: null });
  manager.start();
  assert.equal(sockets.length, 0);
  manager.stop();
});

test("staleness closes a silent socket, which routes into reconnect", async () => {
  const sockets: FakeSocket[] = [];
  const manager = new SocketManager({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    url: "ws://test/api/ws",
    getToken: () => "tok",
    notify: () => {},
    backoff: new Backoff({ baseMs: 0, ceilingMs: 0 }),
    staleMs: 10,
    staleCheckMs: 20,
  });
  manager.start();
  const first = sockets[0]!;
  first.fire("open", {});
  first.fire("message", { data: '{"type":"ready"}' });

  // Silence past staleMs: the checker must close it as half-open.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(first.closed.length > 0, "silent socket was not closed");
  assert.ok(sockets.length >= 2, "no reconnect after staleness close");
  manager.stop();
});
