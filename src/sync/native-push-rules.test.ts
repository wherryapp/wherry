import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  REF_PATTERN,
  afterAlertRegistration,
  alertEntry,
  alertsToSend,
  carryOver,
  computeRef,
  decodeBase64Url,
  encodeBase64Url,
  nativeOwnsAlerts,
  nativePushCandidate,
  nativeStateFrom,
  normaliseKeys,
  openTarget,
  ownerDevice,
  parseOpen,
  parseStored,
  reregisterReason,
  resolveRefAmong,
  rowEntry,
  signedOut,
  turnOffKeepsRow,
  withEntry,
  withPending,
  withoutEntry,
  type NativePushState,
  type PluginStatus,
  type ServerProviders,
  type StoredNative,
} from "./native-push-rules.ts";

const OWNER = "0199aaaa-0000-7000-8000-000000000001:fingerprint";
const OTHER_OWNER = "0199aaaa-0000-7000-8000-000000000001:another-sign-in";
const REF_KEY = encodeBase64Url(new Uint8Array(32).map((_, i) => i * 7 + 3));
const TOKEN = "a".repeat(64);

const apnsStatus: PluginStatus = {
  provider: "apns",
  configured: true,
  token: TOKEN,
  environment: "sandbox",
};
const fcmStatus: PluginStatus = {
  provider: "fcm",
  configured: true,
  token: "fcm-token-" + "x".repeat(140),
  environment: null,
};
const bothOn: ServerProviders = { kind: "known", apns: true, fcm: true };

function registered(provider: "apns" | "fcm", token = TOKEN): StoredNative {
  return withEntry(null, OWNER, provider, {
    token,
    environment: provider === "apns" ? "sandbox" : null,
    refKey: REF_KEY,
  });
}

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

test("only a Tauri process that is not the desktop bundle is a candidate", () => {
  assert.equal(nativePushCandidate({ tauriShell: false, shell: "web" }), false);
  // A browser never is, whatever the bundle says: W-107's guard.
  assert.equal(nativePushCandidate({ tauriShell: false, shell: "ios" }), false);
  assert.equal(nativePushCandidate({ tauriShell: true, shell: "desktop" }), false);
  assert.equal(nativePushCandidate({ tauriShell: true, shell: "ios" }), true);
  assert.equal(nativePushCandidate({ tauriShell: true, shell: "android" }), true);
  // `tauri ios dev` serves an unmoded bundle; the plugin probe decides.
  assert.equal(nativePushCandidate({ tauriShell: true, shell: "web" }), true);
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

function state(overrides: Partial<Parameters<typeof nativeStateFrom>[0]>): NativePushState {
  return nativeStateFrom({
    status: apnsStatus,
    server: bothOn,
    permissionGranted: true,
    stored: null,
    owner: OWNER,
    ...overrides,
  });
}

test("no plugin answer is unsupported", () => {
  assert.equal(state({ status: null }), "unsupported");
});

test("a build without Firebase config is unconfigured, before anything else", () => {
  assert.equal(
    state({ status: { ...fcmStatus, configured: false }, server: { kind: "absent" } }),
    "unconfigured",
  );
});

test("a server without this platform's key, or without the routes, is server-disabled", () => {
  assert.equal(state({ server: { kind: "known", apns: false, fcm: true } }), "server-disabled");
  assert.equal(
    state({ status: fcmStatus, server: { kind: "known", apns: true, fcm: false } }),
    "server-disabled",
  );
  // A 404 from an older server: a new client tolerates an old server.
  assert.equal(state({ server: { kind: "absent" } }), "server-disabled");
  // Even for a device that registered earlier.
  assert.equal(
    state({ server: { kind: "absent" }, stored: registered("apns") }),
    "server-disabled",
  );
});

test("an unreachable server is not evidence either way", () => {
  assert.equal(state({ server: { kind: "unknown" } }), "ready");
  assert.equal(state({ server: { kind: "unknown" }, stored: registered("apns") }), "on");
});

test("granted and registered is on; granted and not registered is ready", () => {
  assert.equal(state({ stored: registered("apns") }), "on");
  assert.equal(state({}), "ready");
  assert.equal(state({ status: fcmStatus, stored: registered("fcm") }), "on");
});

test("a registration from an earlier sign-in does not count", () => {
  // The device id outlives a sign-out; the server's rows do not.
  assert.equal(state({ stored: registered("apns"), owner: OTHER_OWNER }), "ready");
});

test("a registration for the other provider does not count", () => {
  assert.equal(state({ stored: registered("fcm") }), "ready");
});

test("refused, or revoked after registering, is blocked; never asked is ready", () => {
  assert.equal(state({ permissionGranted: false }), "ready");
  assert.equal(
    state({ permissionGranted: false, stored: { v: 1, owner: OWNER, entries: {}, declined: true } }),
    "blocked",
  );
  assert.equal(state({ permissionGranted: false, stored: registered("apns") }), "blocked");
});

test("only on owns the alerts", () => {
  const all: NativePushState[] = [
    "on",
    "ready",
    "blocked",
    "server-disabled",
    "unconfigured",
    "unsupported",
  ];
  assert.deepEqual(
    all.filter(nativeOwnsAlerts),
    ["on"],
  );
});

// ---------------------------------------------------------------------------
// Re-registration
// ---------------------------------------------------------------------------

function reason(overrides: Partial<Parameters<typeof reregisterReason>[0]>) {
  return reregisterReason({
    stored: registered("fcm", fcmStatus.token!),
    owner: OWNER,
    provider: "fcm",
    currentToken: fcmStatus.token,
    permissionGranted: true,
    server: bothOn,
    ...overrides,
  });
}

test("a launch never registers a device that did not turn push on", () => {
  assert.equal(reason({ stored: null }), null);
  assert.equal(reason({ owner: OTHER_OWNER }), null);
  assert.equal(
    reason({ stored: null, provider: "apns", currentToken: TOKEN }),
    null,
  );
});

test("a rotated token is re-registered", () => {
  assert.equal(reason({ currentToken: "fcm-token-rotated" }), "token-changed");
});

test("Android re-registers an unchanged FCM token at every launch (only a registration revives a row marked failed)", () => {
  assert.equal(reason({}), "launch");
});

test("iOS re-registers at every launch", () => {
  assert.equal(
    reason({ stored: registered("apns"), provider: "apns", currentToken: TOKEN }),
    "launch",
  );
});

test("a server that gained its key is told again", () => {
  const stored: StoredNative = { ...registered("fcm", fcmStatus.token!), serverEnabled: false };
  assert.equal(reason({ stored }), "server-enabled");
  // An unanswered server is no evidence of a flip: an ordinary launch.
  assert.equal(reason({ stored, server: { kind: "unknown" } }), "launch");
});

test("no permission, or no token yet, means no registration", () => {
  assert.equal(reason({ permissionGranted: false, currentToken: "rotated" }), null);
  assert.equal(reason({ currentToken: null }), null);
});

// ---------------------------------------------------------------------------
// The stored record
// ---------------------------------------------------------------------------

test("the stored record round-trips and rejects anything malformed", () => {
  const stored = { ...registered("apns"), serverEnabled: true };
  assert.deepEqual(parseStored(JSON.stringify(stored)), stored);
  assert.equal(parseStored(null), null);
  assert.equal(parseStored("not json"), null);
  assert.equal(parseStored("[]"), null);
  assert.equal(parseStored(JSON.stringify({ v: 2, owner: OWNER, entries: {} })), null);
  assert.equal(parseStored(JSON.stringify({ v: 1, entries: {} })), null);
  // A malformed entry is dropped, the rest kept.
  const mixed = parseStored(
    JSON.stringify({
      v: 1,
      owner: OWNER,
      entries: { apns: { token: 5 }, fcm: { token: "t", environment: "nope", refKey: REF_KEY } },
    }),
  );
  assert.deepEqual(mixed?.entries, { fcm: { token: "t", environment: null, refKey: REF_KEY } });
});

test("an entry without a ref key is not a registration", () => {
  const stored = withEntry(null, OWNER, "apns", { token: TOKEN, environment: "sandbox", refKey: null });
  assert.equal(alertEntry(stored, OWNER, "apns"), null);
});

test("withEntry starts over for a new sign-in and clears a remembered refusal", () => {
  const old: StoredNative = { ...registered("apns"), declined: true };
  const next = withEntry(old, OTHER_OWNER, "fcm", { token: "t", environment: null, refKey: REF_KEY });
  assert.equal(next.owner, OTHER_OWNER);
  assert.deepEqual(Object.keys(next.entries), ["fcm"]);
  assert.equal(next.declined, false);
  // The same sign-in keeps its other providers (the calls plan's VoIP token).
  const both = withEntry(registered("apns"), OWNER, "apns_voip", {
    token: TOKEN,
    environment: "sandbox",
    refKey: REF_KEY,
  });
  assert.deepEqual(Object.keys(both.entries).sort(), ["apns", "apns_voip"]);
  assert.deepEqual(Object.keys(withoutEntry(both, "apns")!.entries), ["apns_voip"]);
});

// ---------------------------------------------------------------------------
// Carrying a record across sign-ins
// ---------------------------------------------------------------------------

const OTHER_DEVICE = "0199aaaa-0000-7000-8000-000000000002:fingerprint";

test("ownerDevice is the part before the fingerprint", () => {
  assert.equal(ownerDevice(OWNER), "0199aaaa-0000-7000-8000-000000000001");
  assert.equal(ownerDevice("no-fingerprint"), "no-fingerprint");
});

test("a session that ended without a sign-out carries its registration over, marked for one re-registration", () => {
  const stored = { ...registered("fcm", fcmStatus.token!), serverEnabled: true };
  const carried = carryOver(stored, OTHER_OWNER);
  assert.equal(carried?.owner, OTHER_OWNER);
  assert.deepEqual(carried?.entries, stored.entries);
  assert.equal(carried?.resync, true);
  assert.equal(carried?.serverEnabled, true);
  // So the new sign-in reads on (the engine's gate) and resolves taps...
  assert.equal(
    nativeStateFrom({ status: fcmStatus, server: bothOn, permissionGranted: true, stored: carried, owner: OTHER_OWNER }),
    "on",
  );
  assert.equal(alertEntry(carried, OTHER_OWNER, "fcm")?.refKey, REF_KEY);
  // ...and tells the server once, although the token did not change.
  assert.equal(
    reason({ stored: carried, owner: OTHER_OWNER }),
    "sign-in",
  );
  const settled = afterAlertRegistration(carried, true);
  assert.equal(settled?.resync, undefined);
  // Settled: from then on it is an ordinary launch.
  assert.equal(reason({ stored: settled, owner: OTHER_OWNER }), "launch");
});

test("carryOver leaves the same sign-in alone and drops another device's record", () => {
  const stored = registered("apns");
  assert.equal(carryOver(stored, OWNER), stored);
  assert.equal(carryOver(null, OWNER), null);
  assert.equal(carryOver(stored, OTHER_DEVICE), null);
});

test("an explicit sign-out empties the entries and queues every provider for the next sign-in to forget", () => {
  const both = withEntry(registered("apns"), OWNER, "apns_voip", {
    token: TOKEN,
    environment: "sandbox",
    refKey: REF_KEY,
  });
  const out = signedOut({ ...both, resync: true });
  assert.deepEqual(out?.entries, {});
  assert.deepEqual(out?.pendingUnregister, ["apns", "apns_voip"]);
  assert.equal(out?.resync, undefined);
  assert.equal(signedOut(null), null);
  // The next sign-in on this device: off, with the queue kept.
  const next = carryOver(out, OTHER_OWNER);
  assert.equal(next?.resync, undefined);
  assert.deepEqual(next?.pendingUnregister, ["apns", "apns_voip"]);
  assert.equal(
    nativeStateFrom({ status: apnsStatus, server: bothOn, permissionGranted: true, stored: next, owner: OTHER_OWNER }),
    "ready",
  );
  assert.equal(reason({ stored: next, owner: OTHER_OWNER, provider: "apns", currentToken: TOKEN }), null);
});

test("the unregister queue: added to, taken off, and cleared by registering the same provider", () => {
  const queued = withPending(registered("apns"), OWNER, "fcm", true);
  assert.deepEqual(queued.pendingUnregister, ["fcm"]);
  assert.deepEqual(withPending(queued, OWNER, "apns", true).pendingUnregister, ["apns", "fcm"]);
  assert.equal(withPending(queued, OWNER, "fcm", false).pendingUnregister, undefined);
  const again = withEntry(queued, OWNER, "fcm", { token: "t", environment: null, refKey: REF_KEY });
  assert.equal(again.pendingUnregister, undefined);
});

test("the new fields round-trip through storage, and junk in them is dropped", () => {
  const stored: StoredNative = {
    ...registered("apns"),
    resync: true,
    pendingUnregister: ["apns_voip", "fcm"],
  };
  assert.deepEqual(parseStored(JSON.stringify(stored)), stored);
  const junk = parseStored(
    JSON.stringify({ v: 1, owner: OWNER, entries: {}, resync: "yes", pendingUnregister: ["nope", "fcm", 3] }),
  );
  assert.equal(junk?.resync, undefined);
  assert.deepEqual(junk?.pendingUnregister, ["fcm"]);
});

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

test("key material is sent as unpadded base64url of a 65-byte point and a 16-byte secret", () => {
  const point = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : i));
  const secret = new Uint8Array(16).map((_, i) => 250 - i);
  const expected = { p256dh: encodeBase64Url(point), auth: encodeBase64Url(secret) };
  assert.match(expected.p256dh, /^[A-Za-z0-9_-]{87}$/);
  assert.match(expected.auth, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(normaliseKeys(expected), expected);
  // Padded standard base64 with line breaks (Android's Base64.DEFAULT).
  const standard = Buffer.from(point).toString("base64");
  assert.deepEqual(
    normaliseKeys({
      p256dh: `${standard.slice(0, 76)}\n${standard.slice(76)}\n`,
      auth: Buffer.from(secret).toString("base64"),
    }),
    expected,
  );
});

test("key material of the wrong shape is refused", () => {
  const point = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : i));
  const secret = new Uint8Array(16);
  const auth = encodeBase64Url(secret);
  assert.equal(normaliseKeys({}), null);
  assert.equal(normaliseKeys({ p256dh: encodeBase64Url(point) }), null);
  // A compressed point, or one without the 0x04 prefix.
  assert.equal(normaliseKeys({ p256dh: encodeBase64Url(point.subarray(0, 33)), auth }), null);
  assert.equal(normaliseKeys({ p256dh: encodeBase64Url(point.map((b, i) => (i === 0 ? 2 : b))), auth }), null);
  assert.equal(normaliseKeys({ p256dh: encodeBase64Url(point), auth: encodeBase64Url(secret.subarray(0, 15)) }), null);
  assert.equal(normaliseKeys({ p256dh: "not base64 at all!", auth }), null);
  assert.equal(normaliseKeys({ p256dh: 5, auth }), null);
});

// ---------------------------------------------------------------------------
// Taps
// ---------------------------------------------------------------------------

test("a tap is validated, and an unknown kind with a ref reads as a message", () => {
  const ref = "AAAAAAAAAAAAAAAAAAAAAA";
  assert.deepEqual(parseOpen({ kind: "mention", ref }), { kind: "mention", ref });
  // The payload's own short keys, as the plugin may hand them over.
  assert.deepEqual(parseOpen({ k: "call", r: ref }), { kind: "call", ref });
  assert.deepEqual(parseOpen({ kind: "future_kind", ref }), { kind: "message", ref });
  assert.deepEqual(parseOpen({ kind: "contact_request" }), { kind: "contact_request", ref: null });
  assert.equal(parseOpen({ kind: "future_kind" }), null);
  assert.equal(parseOpen(null), null);
  assert.equal(parseOpen("message"), null);
  // A malformed ref is dropped rather than resolved.
  assert.deepEqual(parseOpen({ kind: "message", ref: "../../etc" }), { kind: "message", ref: null });
});

test("contact kinds open Friends; everything else a conversation", () => {
  assert.equal(openTarget("contact_request"), "friends");
  assert.equal(openTarget("contact_accepted"), "friends");
  for (const kind of ["message", "mention", "call", "missed_call"] as const) {
    assert.equal(openTarget(kind), "conversation");
  }
});

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

const CONVERSATIONS = [
  "0199aaaa-0000-7000-8000-00000000000a",
  "0199aaaa-0000-7000-8000-00000000000b",
  "0199aaaa-0000-7000-8000-00000000000c",
];

// scripts/push/ref.ts is the operator's copy of the same HMAC (node:crypto
// rather than WebCrypto), run as a process the way rows I-41 and A-45 run
// it. Outside this project's typecheck on purpose; Node 24 runs it as-is.
const REF_SCRIPT = fileURLToPath(new URL("../../../scripts/push/ref.ts", import.meta.url));
function scriptRef(refKey: string, conversationId: string): string {
  return execFileSync(process.execPath, [REF_SCRIPT, refKey, conversationId], {
    encoding: "utf8",
  }).trim();
}

test("a ref is 16 bytes of base64url and matches the plan's HMAC", async () => {
  const ref = await computeRef(REF_KEY, CONVERSATIONS[0]!);
  assert.ok(ref !== null && REF_PATTERN.test(ref));
  assert.equal(ref, scriptRef(REF_KEY, CONVERSATIONS[0]!));
  // The same key in standard base64, as `encode(ref_key, 'base64')` gives it.
  const standard = Buffer.from(decodeBase64Url(REF_KEY)!).toString("base64");
  assert.equal(scriptRef(standard, CONVERSATIONS[0]!), ref);
});

test("resolveRef round-trips against scripts/push/ref.ts's output", async () => {
  for (const id of CONVERSATIONS) {
    const printed = scriptRef(REF_KEY, id);
    assert.equal(await resolveRefAmong(REF_KEY, printed, CONVERSATIONS), id);
  }
});

test("the same conversation has a different ref under another device's key", async () => {
  const otherKey = encodeBase64Url(new Uint8Array(32).fill(9));
  const mine = await computeRef(REF_KEY, CONVERSATIONS[1]!);
  const theirs = await computeRef(otherKey, CONVERSATIONS[1]!);
  assert.notEqual(mine, theirs);
  assert.equal(await resolveRefAmong(otherKey, mine!, CONVERSATIONS), null);
});

test("an unknown or malformed ref resolves to nothing; a bad key computes nothing", async () => {
  assert.equal(await resolveRefAmong(REF_KEY, "A".repeat(22), CONVERSATIONS), null);
  assert.equal(await resolveRefAmong(REF_KEY, "short", CONVERSATIONS), null);
  assert.equal(await computeRef("too-short", CONVERSATIONS[0]!), null);
  assert.equal(await computeRef("not base64!", CONVERSATIONS[0]!), null);
});

test("base64url round-trips, padded or not", () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x3e]);
  const encoded = encodeBase64Url(bytes);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeBase64Url(encoded), bytes);
  assert.deepEqual(decodeBase64Url(encoded + "="), bytes);
  assert.equal(decodeBase64Url("+/+/"), null);
});

// ---------------------------------------------------------------------------
// Alerts off without losing the ring (H7, migration 0033)
// ---------------------------------------------------------------------------

function alertsOff(): StoredNative {
  return withEntry(null, OWNER, "fcm", {
    token: fcmStatus.token!,
    environment: null,
    refKey: REF_KEY,
    alerts: false,
  });
}

test("only Android keeps its row at Turn off; iOS forgets the apns row as before", () => {
  assert.equal(turnOffKeepsRow("fcm"), true);
  assert.equal(turnOffKeepsRow("apns"), false);
});

test("a row kept with alerts off is a row but not an alert registration", () => {
  const stored = alertsOff();
  assert.equal(alertEntry(stored, OWNER, "fcm"), null);
  assert.equal(rowEntry(stored, OWNER, "fcm")?.refKey, REF_KEY);
  // The state Settings shows, and so the engine's gate: off.
  assert.equal(
    nativeStateFrom({ status: fcmStatus, server: bothOn, permissionGranted: true, stored, owner: OWNER }),
    "ready",
  );
  // Permission revoked afterwards is not "blocked": alerts were off anyway.
  assert.equal(
    nativeStateFrom({ status: fcmStatus, server: bothOn, permissionGranted: false, stored, owner: OWNER }),
    "ready",
  );
  // Another sign-in's row is nobody's.
  assert.equal(rowEntry(stored, OTHER_OWNER, "fcm"), null);
});

test("a kept row is re-registered at launch like any other (the ring needs it alive)", () => {
  assert.equal(reason({ stored: alertsOff() }), "launch");
  assert.equal(reason({ stored: alertsOff(), currentToken: "fcm-token-rotated" }), "token-changed");
  assert.equal(reason({ stored: alertsOff(), permissionGranted: false }), null);
});

test("the alerts field: fcm only, explicit, and never turned on by a caller that did not ask", () => {
  const on = registered("fcm", fcmStatus.token!).entries.fcm!;
  const off = alertsOff().entries.fcm!;
  // What the caller asked for wins.
  assert.equal(alertsToSend("fcm", true, off), true);
  assert.equal(alertsToSend("fcm", false, on), false);
  // Otherwise the device's choice is kept.
  assert.equal(alertsToSend("fcm", undefined, on), true);
  assert.equal(alertsToSend("fcm", undefined, off), false);
  // No row yet and nobody asked: the calls plan's ring registration. Off.
  assert.equal(alertsToSend("fcm", undefined, null), false);
  // Never sent for the APNs providers, whatever is asked.
  assert.equal(alertsToSend("apns", true, null), undefined);
  assert.equal(alertsToSend("apns", false, null), undefined);
  assert.equal(alertsToSend("apns_voip", undefined, null), undefined);
});

test("alerts off round-trips through storage; anything but false reads as on", () => {
  const stored = alertsOff();
  assert.deepEqual(parseStored(JSON.stringify(stored)), stored);
  const junk = parseStored(
    JSON.stringify({
      v: 1,
      owner: OWNER,
      entries: { fcm: { token: "t", environment: null, refKey: REF_KEY, alerts: "false" } },
    }),
  );
  assert.deepEqual(junk?.entries.fcm, { token: "t", environment: null, refKey: REF_KEY });
});

test("a sign-out forgets a kept row too, and queues it for the server to forget", () => {
  const out = signedOut(alertsOff());
  assert.deepEqual(out?.entries, {});
  assert.deepEqual(out?.pendingUnregister, ["fcm"]);
});
