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
      // As ng/push-p2's PushPlugin.swift answers: no environment until the
      // plugin holds an alert token this process.
      return {
        provider: plugin.provider,
        configured: plugin.configured,
        token: plugin.token,
        environment: plugin.token === null ? null : plugin.environment,
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

// The server's §4.3 routes, with the validation ng/push-p1's routes/push.ts
// and services/push.ts apply. Rows are keyed by provider: one device.
const server = {
  mode: "known" as "known" | "absent",
  providers: { apns: true, fcm: true },
  rows: new Map<string, Json & { refKey: string }>(),
  registers: [] as Json[],
  unregisters: [] as Json[],
  /** The unregister route cannot be reached (offline). */
  unregisterOffline: false,
  /** The register route cannot be reached (offline). */
  registerOffline: false,
  /** A server with P1's routes and without migration 0033 (H7). */
  before0033: false,
};

/** A successful POST /auth/logout: forgetNativeTokens(deviceId). */
function serverLogout(): void {
  server.rows.clear();
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
/** Real-shaped RFC 8291 material: a 65-byte uncompressed point, 16 bytes. */
const P256DH_BYTES = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : (i * 29 + 7) % 256));
const AUTH_BYTES = new Uint8Array(16).map((_, i) => (i * 13 + 5) % 256);
const KEYS = { p256dh: b64url(P256DH_BYTES), auth: b64url(AUTH_BYTES) };
const VOIP_KEYS = {
  p256dh: b64url(P256DH_BYTES.map((byte, i) => (i === 0 ? 4 : byte ^ 0x5a))),
  auth: b64url(AUTH_BYTES.map((byte) => byte ^ 0x33)),
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
    if (server.registerOffline) throw new TypeError("Load failed");
    server.registers.push(body);
    const provider = body["provider"] as string;
    const allowed = new Set(["provider", "token", "environment", "p256dh", "auth", "alerts"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) return reply(400, { error: "VALIDATION" });
    const apns = provider === "apns" || provider === "apns_voip";
    if (apns && (!body["environment"] || !/^[0-9a-f]+$/i.test(String(body["token"])))) {
      return reply(400, { error: "INVALID_PUSH_TOKEN" });
    }
    if (provider === "fcm" && body["environment"] !== undefined) {
      return reply(400, { error: "INVALID_PUSH_TOKEN" });
    }
    // The schema's patterns: unpadded base64url of 65 and 16 bytes.
    if (body["p256dh"] !== undefined && !/^[A-Za-z0-9_-]{87}$/.test(String(body["p256dh"]))) {
      return reply(400, { error: "VALIDATION" });
    }
    if (body["auth"] !== undefined && !/^[A-Za-z0-9_-]{22}$/.test(String(body["auth"]))) {
      return reply(400, { error: "VALIDATION" });
    }
    if ((provider === "fcm" || provider === "apns_voip") && (!body["p256dh"] || !body["auth"])) {
      return reply(400, { error: "INVALID_PUSH_KEYS" });
    }
    if (body["alerts"] !== undefined && typeof body["alerts"] !== "boolean") {
      return reply(400, { error: "VALIDATION" });
    }
    // A server from before migration 0033 knows no `alerts` field.
    if (server.before0033 && body["alerts"] !== undefined) {
      return reply(400, { error: "INVALID_REQUEST" });
    }
    const existing = server.rows.get(provider);
    const refKey =
      existing?.refKey ??
      Buffer.alloc(32, refKeySeed++).toString("base64url");
    // 0033's upsert: an absent field keeps the row's value, true for a new row.
    const alerts =
      typeof body["alerts"] === "boolean"
        ? body["alerts"]
        : ((existing?.["alerts"] as boolean | undefined) ?? true);
    const row: Json & { refKey: string } = { ...body, refKey, alerts };
    server.rows.set(provider, row);
    return reply(200, server.before0033 ? { refKey } : { refKey, alerts });
  }
  if (path === "/api/push/native/unregister") {
    if (server.unregisterOffline) throw new TypeError("Load failed");
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
  server.unregisterOffline = false;
  server.registerOffline = false;
  server.before0033 = false;
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
  plugin.keys = KEYS;
  assert.equal(await quiet(() => native.enableNative()), "on");
  assert.deepEqual(server.registers.at(-1), {
    provider: "fcm",
    token: "fcm:" + "x".repeat(150),
    p256dh: KEYS.p256dh,
    auth: KEYS.auth,
    alerts: true,
  });
});

test("Android: padded standard base64 with a line break is sent as unpadded base64url", async () => {
  plugin.provider = "fcm";
  plugin.token = "fcm:" + "x".repeat(150);
  plugin.environment = null;
  // What Kotlin's Base64.DEFAULT produces: '+', '/', '=' and a newline.
  const standard = Buffer.from(P256DH_BYTES).toString("base64");
  plugin.keys = {
    p256dh: standard.slice(0, 40) + "\n" + standard.slice(40),
    auth: Buffer.from(AUTH_BYTES).toString("base64"),
  };
  assert.match(plugin.keys.auth, /=$/);
  assert.equal(await quiet(() => native.enableNative()), "on");
  assert.equal(server.registers.at(-1)!["p256dh"], KEYS.p256dh);
  assert.equal(server.registers.at(-1)!["auth"], KEYS.auth);
});

test("Android: key material that is not a P-256 point and a 16-byte secret is never sent, and Turn on says it did not work", async () => {
  plugin.provider = "fcm";
  plugin.token = "fcm:" + "x".repeat(150);
  plugin.environment = null;
  plugin.keys = { p256dh: KEYS.p256dh, auth: b64url(AUTH_BYTES.subarray(0, 15)) };
  assert.equal(await quiet(() => native.enableNative()), "ready");
  assert.equal(server.registers.length, 0);
  // No key material at all (P3 not yet supplying it) is the same answer.
  plugin.keys = null;
  assert.equal(await quiet(() => native.enableNative()), "ready");
  assert.equal(server.registers.length, 0);
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
// Android: alerts off keeps the row, because it is also the ring's (H7)
// ---------------------------------------------------------------------------

function android(letter = "k"): void {
  plugin.provider = "fcm";
  plugin.token = "fcm:" + letter.repeat(150);
  plugin.environment = null;
  plugin.keys = KEYS;
}

test("Android: Turn off keeps the row with alerts off, and keeps the Firebase token", async () => {
  android();
  await quiet(() => native.enableNative());
  const refKey = server.rows.get("fcm")!.refKey;
  assert.equal(await quiet(() => native.disableNative()), "ready");
  assert.equal(server.unregisters.length, 0, "the row is not forgotten");
  assert.equal(pluginCalls("unregister").length, 0, "the plugin keeps its token");
  assert.deepEqual(server.registers.at(-1), { provider: "fcm", token: plugin.token, ...KEYS, alerts: false });
  assert.equal(server.rows.get("fcm")!["alerts"], false);
  assert.equal(server.rows.get("fcm")!.refKey, refKey, "the same row");
  // The engine's gate reads "ready", so the app's own local notification is
  // the alert again while it runs; a notification delivered before still
  // resolves and clears.
  assert.equal(await native.nativeAvailability(), "ready");
  const ref = await computeRef(refKey, "c-b");
  assert.equal(await native.resolveRef(ref!, ["c-a", "c-b"]), "c-b");
});

test("Android: every launch re-registers a kept row with alerts still off", async () => {
  android();
  await quiet(() => native.enableNative());
  await quiet(() => native.disableNative());
  server.rows.get("fcm")!["failed"] = true;
  server.registers = [];
  const { states, stop } = startRecording();
  await quiet(settle);
  assert.deepEqual(server.registers, [{ provider: "fcm", token: plugin.token, ...KEYS, alerts: false }]);
  assert.equal(server.rows.get("fcm")!["failed"], undefined, "a failed row is revived for the ring");
  assert.equal(states.at(-1), "ready");
  // A rotated token is registered with alerts off too.
  emit("token", { token: "fcm:" + "r".repeat(150), environment: null, ...KEYS });
  await quiet(settle);
  assert.equal(server.registers.at(-1)!["alerts"], false);
  assert.equal(server.registers.at(-1)!["token"], "fcm:" + "r".repeat(150));
  stop();
});

test("Android: Turn on after Turn off sends alerts: true on the same row", async () => {
  android();
  await quiet(() => native.enableNative());
  const refKey = server.rows.get("fcm")!.refKey;
  await quiet(() => native.disableNative());
  notification.permission = "granted";
  assert.equal(await quiet(() => native.enableNative()), "on");
  assert.equal(server.registers.at(-1)!["alerts"], true);
  assert.equal(server.rows.get("fcm")!["alerts"], true);
  assert.equal(server.rows.get("fcm")!.refKey, refKey);
});

test("Android: a Turn off the server did not hear is remembered, and the next launch sends it", async () => {
  android();
  await quiet(() => native.enableNative());
  server.registerOffline = true;
  assert.equal(await quiet(() => native.disableNative()), "ready");
  assert.equal(server.rows.get("fcm")!["alerts"], true, "the server has not heard yet");
  assert.equal(server.unregisters.length, 0);
  assert.equal(pluginCalls("unregister").length, 0);
  server.registerOffline = false;
  const { states, stop } = startRecording();
  await quiet(settle);
  assert.equal(server.rows.get("fcm")!["alerts"], false);
  assert.equal(states.at(-1), "ready");
  stop();
});

test("Android: a server from before 0033 refuses the field, so Turn off unregisters as it used to", async () => {
  android();
  // Turned on while the server still took the field (that server would
  // refuse this client's Turn on too, which is why H7 must reach `main`
  // no later than P1's routes do).
  await quiet(() => native.enableNative());
  server.before0033 = true;
  assert.equal(await quiet(() => native.disableNative()), "ready");
  assert.deepEqual(server.unregisters, [{ provider: "fcm" }]);
  assert.equal(server.rows.has("fcm"), false);
  assert.equal(pluginCalls("unregister").length, 1);
});

test("Android: the calls plan's registration of the fcm row never turns alerts on by itself", async () => {
  android();
  // Somebody who never turned message alerts on: the ring path registers
  // the row (coordination §4), through the one registration path.
  await native.registerNativeToken("fcm", plugin.token!);
  assert.equal(server.registers.at(-1)!["alerts"], false);
  assert.equal(await native.nativeAvailability(), "ready", "Settings still reads off");
  // After a Turn on, the same call keeps the person's choice.
  notification.permission = "granted";
  await quiet(() => native.enableNative());
  await native.registerNativeToken("fcm", plugin.token!);
  assert.equal(server.registers.at(-1)!["alerts"], true);
  assert.equal(await native.nativeAvailability(), "on");
});

test("iOS sends no alerts field: its Turn off still deletes the apns row, and apns_voip rings on", async () => {
  await quiet(() => native.enableNative());
  await native.registerNativeToken("apns_voip", "cd".repeat(32), { keys: VOIP_KEYS });
  assert.equal(server.registers.every((body) => !("alerts" in body)), true);
  await quiet(() => native.disableNative());
  assert.equal(server.rows.has("apns"), false);
  assert.equal(server.rows.has("apns_voip"), true);
});

// ---------------------------------------------------------------------------
// The calls plan's contract: registerNativeToken(provider, token)
// ---------------------------------------------------------------------------

test("registerNativeToken('apns_voip', token) takes the APNs environment from the plugin once it has an alert token", async () => {
  await quiet(() => native.enableNative());
  const voip = "cd".repeat(32);
  await native.registerNativeToken("apns_voip", voip, { keys: VOIP_KEYS });
  assert.deepEqual(server.registers.at(-1), {
    provider: "apns_voip",
    token: voip,
    environment: "sandbox",
    p256dh: VOIP_KEYS.p256dh,
    auth: VOIP_KEYS.auth,
  });
  // The alert registration is untouched: still on, same ref key.
  assert.equal(await native.nativeAvailability(), "on");
});

test("apns_voip for somebody who never turned notifications on needs the environment passed", async () => {
  // PushKit needs no notification permission, so the calls plugin can hold
  // a VoIP token while wherry-push has never obtained an alert token -- and
  // P2's status then reports no environment.
  plugin.token = null;
  const voip = "cd".repeat(32);
  await assert.rejects(
    native.registerNativeToken("apns_voip", voip, { keys: VOIP_KEYS }),
    /needs an APNs environment/,
  );
  assert.equal(server.registers.length, 0, "nothing the server would refuse is sent");
  await native.registerNativeToken("apns_voip", voip, {
    keys: VOIP_KEYS,
    environment: "production",
  });
  assert.equal(server.registers.at(-1)!["environment"], "production");
  assert.equal(server.rows.has("apns_voip"), true);
});

test("the two-argument call the calls plan first named fails here, naming the keys", async () => {
  // Under M-1 = E the server requires keys for apns_voip; the calls plugin
  // must pass the pair it holds (H4). Refused before a request, not by a 400.
  await assert.rejects(
    native.registerNativeToken("apns_voip", "ef".repeat(32)),
    /needs p256dh and auth/,
  );
  assert.equal(server.registers.length, 0);
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

test("Android re-registers at every launch, which revives a row the server marked failed", async () => {
  plugin.provider = "fcm";
  plugin.token = "fcm:" + "y".repeat(150);
  plugin.environment = null;
  plugin.keys = KEYS;
  await quiet(() => native.enableNative());
  const refKey = server.rows.get("fcm")!.refKey;
  // A send FCM refused (SENDER_ID_MISMATCH, say): P1's markFailed. The
  // plugin still reports the same token, so nothing else would tell it.
  server.rows.get("fcm")!["failed"] = true;
  server.registers = [];
  const stop = native.startNativePush({ onOpen: () => {}, poke: () => {} });
  await quiet(settle);
  assert.equal(server.registers.length, 1, "the launch registration");
  assert.deepEqual(server.registers[0], { provider: "fcm", token: plugin.token, ...KEYS, alerts: true });
  assert.equal(server.rows.get("fcm")!["failed"], undefined, "a registration clears failed_at");
  assert.equal(server.rows.get("fcm")!.refKey, refKey);

  // The same token again in this process sends no copy; a rotated one is
  // registered.
  emit("token", { token: plugin.token, environment: null, ...KEYS });
  await quiet(settle);
  assert.equal(server.registers.length, 1);
  emit("token", { token: "fcm:" + "w".repeat(150), environment: null, ...KEYS });
  await quiet(settle);
  assert.equal(server.registers.length, 2);
  stop();
});

test("a launch registration that could not be sent is not counted as done for the process", async () => {
  plugin.provider = "fcm";
  plugin.token = "fcm:" + "v".repeat(150);
  plugin.environment = null;
  plugin.keys = KEYS;
  await quiet(() => native.enableNative());
  server.registers = [];
  // This start's status carries unusable key material, so the launch
  // registration throws before any request.
  plugin.keys = { p256dh: "not-a-point", auth: "short" };
  const stop = native.startNativePush({ onOpen: () => {}, poke: () => {} });
  await quiet(settle);
  assert.equal(server.registers.length, 0);
  // The plugin then reports the token with its keys: that registers.
  emit("token", { token: plugin.token, environment: null, ...KEYS });
  await quiet(settle);
  assert.equal(server.registers.length, 1);
  stop();
});

function startRecording(): { states: string[]; stop: () => void } {
  const states: string[] = [];
  const stop = native.startNativePush({
    onOpen: () => {},
    poke: () => {},
    onState: (state) => states.push(state),
  });
  return { states, stop };
}

test("after a sign-out and back in, push is off until turned on again", async () => {
  await quiet(() => native.enableNative());
  native.noteSignOut();
  serverLogout();
  // Same device id (it outlives a sign-out), new session.
  signIn("session-token-2");
  server.registers = [];
  const { states, stop } = startRecording();
  await quiet(settle);
  assert.equal(server.registers.length, 0);
  // The queued forget is sent once, harmlessly, to a server that already did.
  assert.deepEqual(server.unregisters, [{ provider: "apns" }]);
  assert.equal(states.at(-1), "ready");
  stop();
  // And only once.
  const again = startRecording();
  await quiet(settle);
  assert.equal(server.unregisters.length, 1);
  again.stop();
});

test("a sign-out whose logout never reached the server still stops the pushes", async () => {
  await quiet(() => native.enableNative());
  native.noteSignOut();
  // Offline: POST /auth/logout failed and signOut swallowed it, so the
  // server still holds the row and still pushes to this device.
  assert.equal(server.rows.has("apns"), true);
  signIn("session-token-2");
  const { states, stop } = startRecording();
  await quiet(settle);
  assert.equal(server.rows.has("apns"), false);
  assert.equal(states.at(-1), "ready");
  assert.equal(await native.refFor("c1"), null);
  stop();
});

test("a session that expired (a 401, no sign-out) keeps push on, and the new sign-in re-registers", async () => {
  plugin.provider = "fcm";
  plugin.token = "fcm:" + "z".repeat(150);
  plugin.environment = null;
  plugin.keys = KEYS;
  await quiet(() => native.enableNative());
  const refKey = server.rows.get("fcm")!.refKey;
  // 30 days on: App.tsx's 401 path signs out locally and sends no logout,
  // so the server keeps the row. The same device signs in again.
  signIn("session-token-after-expiry");
  server.registers = [];
  const { states, stop } = startRecording();
  await quiet(settle);
  assert.equal(server.registers.length, 1, "told the server once, although the token is unchanged");
  assert.equal(server.rows.get("fcm")!.refKey, refKey);
  assert.equal(server.unregisters.length, 0);
  // The engine's gate is on, so the phone alerts once, not twice; taps
  // resolve and reads clear.
  assert.equal(states.at(-1), "on");
  const ref = await computeRef(refKey, "c-b");
  assert.equal(await native.resolveRef(ref!, ["c-a", "c-b"]), "c-b");
  await native.clearNative("c-b");
  assert.deepEqual(pluginCalls("clear").at(-1), { ref });
  stop();
  // Settled: the next launch registers once, as every launch does (reason
  // "launch", no longer "sign-in"), keeping the ref key.
  server.registers = [];
  const again = startRecording();
  await quiet(settle);
  assert.equal(server.registers.length, 1);
  assert.equal(server.rows.get("fcm")!.refKey, refKey);
  assert.equal(await quiet(() => native.nativeAvailability()), "on");
  again.stop();
});

test("iOS, after an expired session: the launch registration is the carried-over one", async () => {
  await quiet(() => native.enableNative());
  signIn("session-token-after-expiry");
  server.registers = [];
  const { states, stop } = startRecording();
  await quiet(settle);
  assert.equal(server.registers.length, 1);
  assert.equal(states.at(-1), "on");
  stop();
});

test("another device's record (another account, or cleared site data) applies to nothing", async () => {
  await quiet(() => native.enableNative());
  signIn("session-token-other", "0199aaaa-0000-7000-8000-00000000d002");
  server.registers = [];
  const { states, stop } = startRecording();
  await quiet(settle);
  assert.equal(server.registers.length, 0);
  assert.equal(server.unregisters.length, 0);
  assert.equal(states.at(-1), "ready");
  stop();
});

test("Turn off that cannot reach the server is retried at the next start", async () => {
  await quiet(() => native.enableNative());
  server.unregisterOffline = true;
  assert.equal(await native.disableNative(), "ready");
  assert.equal(server.rows.has("apns"), true, "the server still holds it");
  const first = startRecording();
  await quiet(settle);
  assert.equal(server.rows.has("apns"), true, "still offline");
  first.stop();
  server.unregisterOffline = false;
  const second = startRecording();
  await quiet(settle);
  assert.deepEqual(server.unregisters, [{ provider: "apns" }]);
  assert.equal(server.rows.has("apns"), false);
  second.stop();
});

test("turning push on again before the queued forget runs keeps the new registration", async () => {
  await quiet(() => native.enableNative());
  native.noteSignOut();
  signIn("session-token-2");
  assert.equal(await quiet(() => native.enableNative()), "on");
  const { states, stop } = startRecording();
  await quiet(settle);
  assert.equal(server.unregisters.length, 0);
  assert.equal(server.rows.has("apns"), true);
  assert.equal(states.at(-1), "on");
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
