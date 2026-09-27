// sync/native-push.ts against mocks of its two contracts: the wherry-push
// plugin's commands and events (native-push-plan.md §5.1) and the server's
// three routes (§4.3). P4 is built in wave 1 before either exists, so this
// is the record that the client speaks both shapes; the real plugin and
// server meet it in wave 3 (rows I-40 to I-45, A-44 to A-48).
//
// The harness stands in for exactly what the page would see inside a phone
// shell: `window.__TAURI_INTERNALS__` (invoke, and the callback table
// plugin events arrive through), plugin-notification's `window.Notification`
// shim, localStorage, and `fetch`. No DOM, no database, no network.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const storage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, String(value)),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
};

const callbacks = new Map<number, (message: unknown) => void>();
let nextCallback = 1;
const listeners: Array<{ event: string; id: number; index: number }> = [];

const plugin = {
  present: true,
  provider: "apns" as "apns" | "fcm",
  configured: true,
  token: "ab".repeat(32) as string | null,
  environment: "sandbox" as "sandbox" | "production" | null,
  keys: null as { p256dh: string; auth: string } | null,
  pendingOpen: null as Json | null,
  calls: [] as Array<{ command: string; args: Json }>,
};

function pluginCalls(command: string): Json[] {
  return plugin.calls.filter((call) => call.command === command).map((call) => call.args);
}

function emit(event: string, payload: unknown): void {
  for (const listener of listeners.filter((l) => l.event === event)) {
    callbacks.get(listener.id)?.({ index: listener.index++, message: payload });
  }
}

async function invoke(command: string, args: Json = {}): Promise<unknown> {
  if (command.startsWith("vault_")) return null;
  if (command === "plugin:notification|is_permission_granted") {
    return notification.permission === "granted";
  }
  const prefix = "plugin:wherry-push|";
  if (!command.startsWith(prefix) || !plugin.present) {
    throw new Error(`no handler for ${command}`);
  }
  const name = command.slice(prefix.length);
  plugin.calls.push({ command: name, args });
  switch (name) {
    case "status":
      return {
        provider: plugin.provider,
        configured: plugin.configured,
        token: plugin.token,
        environment: plugin.environment,
        ...(plugin.keys ?? {}),
      };
    case "register":
      if (!plugin.configured) throw new Error("unconfigured");
      return { token: plugin.token, environment: plugin.environment, ...(plugin.keys ?? {}) };
    case "unregister":
    case "clear":
    case "set_badge":
    case "open_settings":
    case "remove_listener":
      return null;
    case "take_open": {
      const open = plugin.pendingOpen;
      plugin.pendingOpen = null;
      return open;
    }
    case "register_listener": {
      const handler = args["handler"] as { id: number };
      listeners.push({ event: String(args["event"]), id: handler.id, index: 0 });
      return null;
    }
    default:
      throw new Error(`unknown command ${name}`);
  }
}

const notification = {
  permission: "default" as "default" | "granted" | "denied",
  answer: "granted" as "granted" | "denied" | "default",
  requests: 0,
  async requestPermission(): Promise<string> {
    notification.requests += 1;
    if (notification.answer !== "default") notification.permission = notification.answer;
    return notification.answer;
  },
};

// The server's §4.3 routes, with the validation the plan names.
const server = {
  mode: "known" as "known" | "absent",
  providers: { apns: true, fcm: true },
  rows: new Map<string, Json & { refKey: string }>(),
  registers: [] as Json[],
  unregisters: [] as Json[],
};
let refKeySeed = 1;

function reply(status: number, body?: unknown): Response {
  return status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
}

async function fakeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const path = String(url);
  if (server.mode === "absent") return reply(404, { error: "NOT_FOUND" });
  const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
  if (path === "/api/push/native" && (init?.method ?? "GET") === "GET") {
    return reply(200, { providers: server.providers });
  }
  if (path === "/api/push/native/register") {
    server.registers.push(body);
    const provider = body["provider"] as string;
    const allowed = new Set(["provider", "token", "environment", "p256dh", "auth"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) return reply(400, { error: "VALIDATION" });
    const apns = provider === "apns" || provider === "apns_voip";
    if (apns && (!body["environment"] || !/^[0-9a-f]+$/i.test(String(body["token"])))) {
      return reply(400, { error: "INVALID_PUSH_TOKEN" });
    }
    if (provider === "fcm" && body["environment"] !== undefined) {
      return reply(400, { error: "INVALID_PUSH_TOKEN" });
    }
    if ((provider === "fcm" || provider === "apns_voip") && (!body["p256dh"] || !body["auth"])) {
      return reply(400, { error: "VALIDATION" });
    }
    const existing = server.rows.get(provider);
    const refKey =
      existing?.refKey ??
      Buffer.alloc(32, refKeySeed++).toString("base64url");
    server.rows.set(provider, { ...body, refKey });
    return reply(200, { refKey });
  }
  if (path === "/api/push/native/unregister") {
    server.unregisters.push(body);
    server.rows.delete(String(body["provider"]));
    return reply(204);
  }
  return reply(404, { error: "NOT_FOUND" });
}

Object.assign(globalThis, {
  window: globalThis,
  __TAURI_INTERNALS__: {
    invoke,
    transformCallback(callback: (message: unknown) => void): number {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id: number): void {
      callbacks.delete(id);
    },
  },
  Notification: notification,
  fetch: fakeFetch,
});
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

const native = await import("./native-push.ts");
const { saveSession } = await import("../api/session.ts");
const { computeRef } = await import("./native-push-rules.ts");

function signIn(token: string, deviceId = "0199aaaa-0000-7000-8000-00000000d001"): void {
  saveSession({
    token,
    expiresAt: "2027-01-01T00:00:00.000Z",
    user: { id: "u1", username: "u1", displayName: "U1" } as never,
    device: { id: deviceId, displayName: "Phone" } as never,
    emailVerified: true,
  });
}

function quiet<T>(run: () => Promise<T>): Promise<T> {
  const info = console.info;
  const warn = console.warn;
  console.info = () => {};
  console.warn = () => {};
  return run().finally(() => {
    console.info = info;
    console.warn = warn;
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  storage.clear();
  plugin.present = true;
  plugin.provider = "apns";
  plugin.configured = true;
  plugin.token = "ab".repeat(32);
  plugin.environment = "sandbox";
  plugin.keys = null;
  plugin.pendingOpen = null;
  plugin.calls = [];
  notification.permission = "default";
  notification.answer = "granted";
  notification.requests = 0;
  server.mode = "known";
  server.providers = { apns: true, fcm: true };
  server.rows.clear();
  server.registers = [];
  server.unregisters = [];
  listeners.length = 0;
  signIn("session-token-1");
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

test("no plugin to answer is unsupported", async () => {
  plugin.present = false;
  assert.equal(await native.nativeAvailability(), "unsupported");
});

test("an Android build without Firebase config is unconfigured, and Turn on says so", async () => {
  plugin.provider = "fcm";
  plugin.configured = false;
  assert.equal(await native.nativeAvailability(), "unconfigured");
  assert.equal(await quiet(() => native.enableNative()), "unconfigured");
  assert.equal(notification.requests, 0);
});

test("an older server (404) or one without the key is server-disabled, and no prompt is spent", async () => {
  server.mode = "absent";
  assert.equal(await native.nativeAvailability(), "server-disabled");
  assert.equal(await quiet(() => native.enableNative()), "server-disabled");
  server.mode = "known";
  server.providers = { apns: false, fcm: true };
  assert.equal(await quiet(() => native.enableNative()), "server-disabled");
  assert.equal(notification.requests, 0);
});

// ---------------------------------------------------------------------------
// Turning it on and off
// ---------------------------------------------------------------------------

test("iOS: Turn on prompts, registers an APNs token with its environment and no keys", async () => {
  assert.equal(await native.nativeAvailability(), "ready");
  assert.equal(await quiet(() => native.enableNative()), "on");
  assert.equal(notification.requests, 1);
  assert.deepEqual(server.registers, [
    { provider: "apns", token: "ab".repeat(32), environment: "sandbox" },
  ]);
  assert.equal(await native.nativeAvailability(), "on");
});

test("Android: the FCM body carries the device's key material and no environment", async () => {
  plugin.provider = "fcm";
  plugin.token = "fcm:" + "x".repeat(150);
  plugin.environment = null;
  plugin.keys = { p256dh: "BPublicKeyBase64url", auth: "AuthSecret16" };
  assert.equal(await quiet(() => native.enableNative()), "on");
  assert.deepEqual(server.registers.at(-1), {
    provider: "fcm",
    token: "fcm:" + "x".repeat(150),
    p256dh: "BPublicKeyBase64url",
    auth: "AuthSecret16",
  });
});

test("a refused prompt is blocked, stays blocked, and Open settings reaches the plugin", async () => {
  notification.answer = "denied";
  assert.equal(await quiet(() => native.enableNative()), "blocked");
  await settle();
  assert.equal(await native.nativeAvailability(), "blocked");
  assert.equal(server.registers.length, 0);
  await native.openNativeSettings();
  assert.equal(pluginCalls("open_settings").length, 1);
});

test("Turn off tells the server first, then the plugin, and forgets locally", async () => {
  await quiet(() => native.enableNative());
  assert.equal(await native.disableNative(), "ready");
  assert.deepEqual(server.unregisters, [{ provider: "apns" }]);
  assert.equal(pluginCalls("unregister").length, 1);
  assert.equal(await native.refFor("c1"), null);
});

// ---------------------------------------------------------------------------
// The calls plan's contract: registerNativeToken(provider, token)
// ---------------------------------------------------------------------------

test("registerNativeToken('apns_voip', token) takes the APNs environment from the plugin", async () => {
  await quiet(() => native.enableNative());
  const voip = "cd".repeat(32);
  const keys = { p256dh: "BVoipKey", auth: "VoipAuth" };
  await native.registerNativeToken("apns_voip", voip, { keys });
  assert.deepEqual(server.registers.at(-1), {
    provider: "apns_voip",
    token: voip,
    environment: "sandbox",
    p256dh: "BVoipKey",
    auth: "VoipAuth",
  });
  // The alert registration is untouched: still on, same ref key.
  assert.equal(await native.nativeAvailability(), "on");
});

test("the two-argument call the calls plan names reaches the server without key material", async () => {
  // Recorded, not endorsed: under M-1 = E the server requires keys for
  // apns_voip, so this 400s until the calls plugin supplies them (stage log).
  signIn("session-token-voip");
  await assert.rejects(native.registerNativeToken("apns_voip", "ef".repeat(32)));
  assert.deepEqual(server.registers.at(-1), {
    provider: "apns_voip",
    token: "ef".repeat(32),
    environment: "sandbox",
  });
});

// ---------------------------------------------------------------------------
// References, clearing, the badge
// ---------------------------------------------------------------------------

test("refs use the ref key the server returned; clear sends this device's ref", async () => {
  await quiet(() => native.enableNative());
  const refKey = server.rows.get("apns")!.refKey;
  const ids = ["c-a", "c-b", "c-c"];
  const expected = await computeRef(refKey, "c-b");
  assert.equal(await native.refFor("c-b"), expected);
  assert.equal(await native.resolveRef(expected!, ids), "c-b");
  await native.clearNative("c-b");
  assert.deepEqual(pluginCalls("clear"), [{ ref: expected }]);
});

test("without push turned on, clearing and resolving do nothing", async () => {
  await native.clearNative("c-b");
  assert.equal(pluginCalls("clear").length, 0);
  assert.equal(await native.resolveRef("A".repeat(22), ["c-b"]), null);
});

test("the badge is sent once per new number", async () => {
  await native.setBadge(3);
  await native.setBadge(3);
  await native.setBadge(0);
  assert.deepEqual(pluginCalls("set_badge"), [{ count: 3 }, { count: 0 }]);
});

// ---------------------------------------------------------------------------
// Running: startNativePush
// ---------------------------------------------------------------------------

test("start takes a cold-start tap once, pokes on receipt, and reports the state", async () => {
  await quiet(() => native.enableNative());
  plugin.pendingOpen = { kind: "message", ref: "AAAAAAAAAAAAAAAAAAAAAA" };
  const opens: unknown[] = [];
  const states: string[] = [];
  let pokes = 0;
  const stop = native.startNativePush({
    onOpen: (open) => opens.push(open),
    poke: () => (pokes += 1),
    onState: (state) => states.push(state),
  });
  await quiet(settle);
  assert.deepEqual(opens, [{ kind: "message", ref: "AAAAAAAAAAAAAAAAAAAAAA" }]);
  assert.equal(states.at(-1), "on");

  await quiet(async () => emit("received", { kind: "message" }));
  assert.equal(pokes, 1);

  // A warm tap: the event says "look", take_open hands it over once.
  plugin.pendingOpen = { k: "contact_request" };
  emit("opened", {});
  await quiet(settle);
  assert.deepEqual(opens.at(-1), { kind: "contact_request", ref: null });
  assert.equal(pluginCalls("take_open").length, 2);

  stop();
  assert.ok(pluginCalls("remove_listener").length >= 3);
});

test("iOS re-registers at launch; a rotated token re-registers with the same ref key", async () => {
  await quiet(() => native.enableNative());
  const refKey = server.rows.get("apns")!.refKey;
  server.registers = [];
  const stop = native.startNativePush({ onOpen: () => {}, poke: () => {} });
  await quiet(settle);
  assert.equal(server.registers.length, 1, "the launch registration");

  // The plugin's own launch registration reports the same token: no copy.
  emit("token", { token: "ab".repeat(32), environment: "sandbox" });
  await quiet(settle);
  assert.equal(server.registers.length, 1, "no second launch registration");

  emit("token", { token: "ef".repeat(32), environment: "sandbox" });
  await quiet(settle);
  assert.deepEqual(server.registers.at(-1), {
    provider: "apns",
    token: "ef".repeat(32),
    environment: "sandbox",
  });
  assert.equal(server.rows.get("apns")!.refKey, refKey);
  stop();
});

test("Android does not re-register an unchanged token at launch", async () => {
  plugin.provider = "fcm";
  plugin.token = "fcm:" + "y".repeat(150);
  plugin.environment = null;
  plugin.keys = { p256dh: "BKey", auth: "Auth" };
  await quiet(() => native.enableNative());
  server.registers = [];
  const stop = native.startNativePush({ onOpen: () => {}, poke: () => {} });
  await quiet(settle);
  assert.equal(server.registers.length, 0);
  stop();
});

test("after a sign-out and back in, push is off until turned on again", async () => {
  await quiet(() => native.enableNative());
  // Same device id (it outlives a sign-out), new session.
  signIn("session-token-2");
  server.registers = [];
  const states: string[] = [];
  const stop = native.startNativePush({
    onOpen: () => {},
    poke: () => {},
    onState: (state) => states.push(state),
  });
  await quiet(settle);
  assert.equal(server.registers.length, 0);
  assert.equal(states.at(-1), "ready");
  stop();
});

test("a permission granted to local notifications does not turn push on by itself", async () => {
  notification.permission = "granted";
  const stop = native.startNativePush({ onOpen: () => {}, poke: () => {} });
  await quiet(settle);
  assert.equal(server.registers.length, 0);
  assert.equal(await native.nativeAvailability(), "ready");
  stop();
});
