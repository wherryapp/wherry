// Native push's decisions, pure so they can be unit-tested without a shell,
// a DOM or a server -- the same split as notify-rules.ts beside the engine.
//
// sync/native-push.ts is the named interface the `wherry-push` plugin sits
// behind (docs/prompts/native-push-plan.md §7.1). Everything it has to
// *decide* lives here: whether this process is a candidate at all, what the
// availability state is from its inputs, whether a launch owes the server a
// fresh registration, whether push owns the phone's alerts, and the opaque
// per-device conversation reference a payload carries in place of an id.
//
// Nothing here imports the Tauri API, so the web bundle can carry this file
// without carrying the plugin. Nothing here throws on a bad input either: a
// stored record that fails to parse is simply "not registered".

import type { Shell } from "../api/shell";

/** The providers the server's `push_tokens` table admits (migration 0032).
 *  `apns_voip` is the phone-calls plan's PushKit token; this module stores
 *  it but never uses its ref key. */
export type NativeProvider = "apns" | "apns_voip" | "fcm";

const PROVIDERS: readonly NativeProvider[] = ["apns", "apns_voip", "fcm"];

/** The provider that carries alerts on this platform. The only one whose
 *  ref key resolves a tapped notification to a conversation. */
export type AlertProvider = "apns" | "fcm";

/** The six kinds a native alert can carry (plan §2's table). The server
 *  sends no text; the kind is all the device learns. */
export type NativeKind =
  | "message"
  | "mention"
  | "call"
  | "missed_call"
  | "contact_request"
  | "contact_accepted";

const KINDS: readonly NativeKind[] = [
  "message",
  "mention",
  "call",
  "missed_call",
  "contact_request",
  "contact_accepted",
];

/**
 * What the Settings row and the nudge can say about native push here.
 *
 * - `on`: this device registered a token, and permission is still granted.
 * - `ready`: everything is in place; pressing Turn on will work.
 * - `blocked`: the person refused the prompt, and only the OS settings page
 *   can undo it (the plugin's `open_settings` goes there).
 * - `server-disabled`: this server has no key for this platform's provider,
 *   or is too old to know the routes (a 404).
 * - `unconfigured`: this *build* cannot get a token -- an Android build
 *   made without `google-services.json`.
 * - `unsupported`: not a phone shell, or the plugin did not answer.
 */
export type NativePushState =
  | "on"
  | "ready"
  | "blocked"
  | "server-disabled"
  | "unconfigured"
  | "unsupported";

/** The plugin's `status` answer (plan §5.1). */
export type PluginStatus = {
  provider: AlertProvider;
  configured: boolean;
  token: string | null;
  environment: "sandbox" | "production" | null;
};

/** One registered provider, as this device remembers it. */
export type StoredEntry = {
  token: string;
  environment: "sandbox" | "production" | null;
  /** base64url, 32 bytes. Present for every provider the server returned
   *  one for; only the alert provider's is ever used. */
  refKey: string | null;
  /** `false` when the server's row is kept with alerts off (migration
   *  0033, hunk H7): on Android the `fcm` row also carries the phone-calls
   *  plan's ring, so Turn off keeps it and says `alerts: false` instead of
   *  unregistering. Absent means on, which is every entry written before
   *  the flag existed. */
  alerts?: false;
};

/**
 * What this install remembers about native push, under `wherry.nativePush`.
 *
 * A per-device convenience, not state that must survive: when it is lost,
 * the next Turn on registers again and the server returns the same ref key
 * for the same (device, provider) (plan §4.3).
 */
export type StoredNative = {
  v: 1;
  /** The sign-in the entries were registered under: the Wherry device id
   *  and a fingerprint of that sign-in's session (native-push.ts
   *  `currentOwner`), `<deviceId>:<fingerprint>`. The fingerprint is what
   *  tells a new sign-in from the old one; what a new sign-in *does* with
   *  the old one's entries is `carryOver`'s decision, and it depends on how
   *  the old sign-in ended. Another device's entries never apply. */
  owner: string;
  entries: Partial<Record<NativeProvider, StoredEntry>>;
  /** The last permission request on this device answered "denied". */
  declined?: boolean;
  /** Whether the server reported the alert provider enabled the last time
   *  it was asked -- a flip to true is worth one re-registration. */
  serverEnabled?: boolean;
  /** The entries were carried over from an earlier sign-in of this device
   *  that ended without a sign-out (a 401: an expired or revoked session).
   *  The server's row most likely survived, but nothing proves it, so this
   *  sign-in registers the alert token once more (`reregisterReason`'s
   *  `sign-in`), which returns the same ref key. */
  resync?: boolean;
  /** Providers the server may still hold a row for although this device no
   *  longer wants pushes through them: an explicit sign-out (whose logout
   *  is best effort, so the server may never have forgotten), or a Turn off
   *  whose unregister did not reach the server. Retried at every start on
   *  this device until the server answers; registering the same provider
   *  again takes it off the list. */
  pendingUnregister?: NativeProvider[];
};

export const NATIVE_PUSH_STORAGE_KEY = "wherry.nativePush";

// ---------------------------------------------------------------------------
// Is this process a candidate at all?
// ---------------------------------------------------------------------------

/**
 * Whether native push is worth asking about in this process.
 *
 * True inside a Tauri shell unless the bundle says it is the desktop app.
 * Deliberately not `shell === "ios" || shell === "android"`: a
 * `pnpm tauri ios dev` / `android dev` page is served by Vite with no build
 * mode, so its bundle reads "web" while it runs inside the phone shell. The
 * plugin's own `status` probe is the real answer; this only decides whether
 * to load `native-push.ts` and ask. A desktop `tauri dev` page therefore
 * asks once and hears nothing (the plugin is mobile-only), which is the
 * whole cost.
 *
 * In a browser this is always false, which is what keeps the module out of
 * the web bundle's loaded chunks (row W-107).
 */
export function nativePushCandidate(input: {
  tauriShell: boolean;
  shell: Shell;
}): boolean {
  return input.tauriShell && input.shell !== "desktop";
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** The server's `GET /api/push/native`, or what stood in for it. */
export type ServerProviders =
  | { kind: "known"; apns: boolean; fcm: boolean }
  /** 404: a server older than the routes. Read as server-disabled, so a new
   *  client tolerates an old server (plan §7.2). */
  | { kind: "absent" }
  /** Not answered (offline, 5xx). Not evidence either way. */
  | { kind: "unknown" };

export function nativeStateFrom(input: {
  /** null when the plugin did not answer (not a phone shell). */
  status: PluginStatus | null;
  server: ServerProviders;
  permissionGranted: boolean;
  stored: StoredNative | null;
  owner: string;
}): NativePushState {
  const { status, server, permissionGranted, stored, owner } = input;

  if (status === null) return "unsupported";
  if (!status.configured) return "unconfigured";

  if (server.kind === "absent") return "server-disabled";
  if (server.kind === "known" && !server[status.provider]) {
    return "server-disabled";
  }

  const registered = alertEntry(stored, owner, status.provider) !== null;

  if (!permissionGranted) {
    // Granted-then-revoked in the OS settings reads the same as refused:
    // the prompt will not come back, so the way out is the settings page.
    if (stored?.declined === true || registered) return "blocked";
    return "ready";
  }

  return registered ? "on" : "ready";
}

/**
 * The stored entry for this platform's alert provider, if it belongs to
 * this device and carries a ref key. Anything else is "not registered".
 */
export function alertEntry(
  stored: StoredNative | null,
  owner: string,
  provider: AlertProvider,
): StoredEntry | null {
  const entry = rowEntry(stored, owner, provider);
  return entry === null || entry.alerts === false ? null : entry;
}

/**
 * The stored entry for a provider whose server row this device keeps,
 * alerts on or off: what the launch re-registration maintains, and whose
 * ref key still resolves a notification delivered before alerts went off.
 * `alertEntry` is the narrower "registered **and** alerting", which is
 * what the state and the engine's gate read.
 */
export function rowEntry(
  stored: StoredNative | null,
  owner: string,
  provider: NativeProvider,
): StoredEntry | null {
  if (!stored || stored.owner !== owner) return null;
  const entry = stored.entries[provider];
  if (!entry || !entry.refKey) return null;
  return entry;
}

// ---------------------------------------------------------------------------
// Alerts off without losing the ring (hunk H7)
// ---------------------------------------------------------------------------

/**
 * Whether Turn off keeps this provider's server row, registered with
 * `alerts: false`, instead of unregistering it.
 *
 * Only `fcm`. On Android the one `fcm` row and Firebase token carry both
 * message alerts and the phone-calls plan's ring (`call_ring`,
 * `ring_ended`); forgetting them would stop the phone ringing too. The
 * server skips a row with alerts off for every ordinary notification, so
 * Google stops seeing when messages arrive, and the ring (sent to the row
 * directly) still comes. On iOS the ring is its own `apns_voip` row, so
 * Turn off can and does forget the `apns` row and its token as before.
 */
export function turnOffKeepsRow(provider: AlertProvider): boolean {
  return provider === "fcm";
}

/**
 * The `alerts` field a registration sends, or undefined to send none.
 *
 * Sent for `fcm` only, and always explicitly there: what the caller asked
 * for (Turn on says `true`, Turn off `false`), otherwise what the stored
 * entry says, so the launch re-registration, a rotated token and the
 * phone-calls plan's calls through the one registration path all keep the
 * person's choice. With no entry at all the row is being created by
 * something other than Turn on -- the calls plan's ring registration on
 * Android -- and alerts stay off until the person turns them on. (The
 * server's own rule for an absent field is "leave the row as it is", so
 * this is belt and braces against a caller that forgets.)
 */
export function alertsToSend(
  provider: NativeProvider,
  requested: boolean | undefined,
  existing: StoredEntry | null,
): boolean | undefined {
  if (provider !== "fcm") return undefined;
  if (requested !== undefined) return requested;
  if (existing === null) return false;
  return existing.alerts !== false;
}

/**
 * Whether push owns this phone's alerts, which is the engine's gate
 * (`shouldNotify`'s `nativePushOwnsAlerts`).
 *
 * Only `on`: in every other state no push is coming, so the engine's local
 * notification is still the only alert there is. `server-disabled`
 * matters most -- a token registered against a server with no key would
 * otherwise silence the app entirely.
 */
export function nativeOwnsAlerts(state: NativePushState): boolean {
  return state === "on";
}

// ---------------------------------------------------------------------------
// Re-registration at launch
// ---------------------------------------------------------------------------

export type ReregisterReason =
  | "sign-in"
  | "token-changed"
  | "server-enabled"
  | "launch";

/**
 * Whether this launch owes the server a fresh registration, and why.
 *
 * Only for a device that already holds a row (turned push on, or kept its
 * row with alerts off, H7): a launch never registers on its own initiative, because a granted OS permission on a phone may
 * have been granted to the *local* notifications (desktop-notify.ts asks at
 * the first message), not to push. Turning push on is the person's choice.
 *
 * - `sign-in`: the registration was carried over from a sign-in that
 *   ended without a sign-out (`carryOver`), so this one tells the server
 *   again rather than trusting that its row survived.
 * - `token-changed`: the provider rotated the token (FCM does, and APNs
 *   can after a restore). The old one is dead weight on the server.
 * - `server-enabled`: the server said "off" last time and "on" now. The
 *   row is already there, so this is belt and braces, and cheap.
 * - `launch`: every other launch, on both platforms. Apple recommends it
 *   because an APNs token can change without any callback the app would
 *   see. On Android it is what revives a row the server has written off:
 *   a send that FCM refused (a 400 naming the token, `SENDER_ID_MISMATCH`,
 *   an `UNREGISTERED` during a Firebase-side reset) sets `failed_at`, the
 *   server then sends that row nothing, and **only a registration clears
 *   it** (P1's upsert). The plugin keeps reporting the same token, so
 *   neither `token-changed` nor anything else would ever fire, and the
 *   state would read `on` -- which also keeps the engine's local
 *   notification off -- while the phone received nothing at all. One
 *   idempotent POST per launch (same row, same ref key) is the price.
 *
 * `currentToken` is null when the plugin has not obtained one yet this
 * process; the `token` event re-asks when it has.
 */
export function reregisterReason(input: {
  stored: StoredNative | null;
  owner: string;
  provider: AlertProvider;
  currentToken: string | null;
  permissionGranted: boolean;
  server: ServerProviders;
}): ReregisterReason | null {
  // A row kept with alerts off is maintained too (H7): on Android it is
  // still how the phone rings, and a rotated or failed token would lose
  // the ring as surely as the alerts.
  const entry = rowEntry(input.stored, input.owner, input.provider);
  if (entry === null) return null;
  if (!input.permissionGranted) return null;
  if (input.currentToken === null) return null;
  if (input.stored?.resync === true) return "sign-in";
  if (input.currentToken !== entry.token) return "token-changed";

  const enabledNow =
    input.server.kind === "known" && input.server[input.provider];
  if (enabledNow && input.stored?.serverEnabled === false) {
    return "server-enabled";
  }

  return "launch";
}

// ---------------------------------------------------------------------------
// The stored record
// ---------------------------------------------------------------------------

/** Parses the stored record; anything malformed is simply absent. */
export function parseStored(raw: string | null): StoredNative | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<StoredNative>;
  if (record.v !== 1 || typeof record.owner !== "string") return null;
  if (typeof record.entries !== "object" || record.entries === null) {
    return null;
  }
  const entries: Partial<Record<NativeProvider, StoredEntry>> = {};
  for (const provider of PROVIDERS) {
    const entry = (record.entries as Record<string, unknown>)[provider];
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Partial<StoredEntry>;
    if (typeof candidate.token !== "string") continue;
    entries[provider] = {
      token: candidate.token,
      environment:
        candidate.environment === "sandbox" ||
        candidate.environment === "production"
          ? candidate.environment
          : null,
      refKey: typeof candidate.refKey === "string" ? candidate.refKey : null,
      ...(candidate.alerts === false ? { alerts: false as const } : {}),
    };
  }
  const pending = Array.isArray(record.pendingUnregister)
    ? PROVIDERS.filter((provider) =>
        (record.pendingUnregister as unknown[]).includes(provider),
      )
    : [];
  return {
    v: 1,
    owner: record.owner,
    entries,
    ...(typeof record.declined === "boolean" ? { declined: record.declined } : {}),
    ...(typeof record.serverEnabled === "boolean"
      ? { serverEnabled: record.serverEnabled }
      : {}),
    ...(record.resync === true ? { resync: true } : {}),
    ...(pending.length > 0 ? { pendingUnregister: pending } : {}),
  };
}

/** The device id part of an owner (`<deviceId>:<fingerprint>`). */
export function ownerDevice(owner: string): string {
  const colon = owner.indexOf(":");
  return colon === -1 ? owner : owner.slice(0, colon);
}

/**
 * The record as the sign-in `owner` should see it, from whatever an earlier
 * sign-in left. native-push.ts runs it before anything reads the record.
 *
 * - The same sign-in: unchanged.
 * - Another device (another account -- a device belongs to one user -- or
 *   a device whose site data was cleared): nothing applies. Null.
 * - The same device, a new sign-in: the record is re-based onto it, and
 *   what its entries mean depends on how the old sign-in ended:
 *   - after an explicit sign-out, `signedOut` has already emptied the
 *     entries and queued the providers in `pendingUnregister`, so push
 *     stays off and the server is told again to forget (the logout that
 *     should have done it is best effort, and fails offline);
 *   - otherwise the sign-in ended without anybody asking (the 30-day
 *     expiry, or any other 401), the server forgot nothing, and this
 *     device's person turned push on, so it stays on: the entries are kept
 *     and marked `resync`, and this sign-in registers once more.
 *   Reading that second case as "off" is what made the server's pushes and
 *   the engine's local notification both fire (its gate read "ready"),
 *   with taps that resolved nothing and nothing ever cleared.
 */
export function carryOver(
  stored: StoredNative | null,
  owner: string,
): StoredNative | null {
  if (!stored || stored.owner === owner) return stored;
  if (ownerDevice(stored.owner) !== ownerDevice(owner)) return null;
  const carried: StoredNative = { ...stored, owner };
  delete carried.resync;
  if (Object.keys(stored.entries).length > 0) carried.resync = true;
  return carried;
}

/**
 * The record after an explicit sign-out: no entries, and every provider it
 * held queued for the next sign-in on this device to unregister. The
 * logout route forgets the device's tokens when it succeeds; this covers
 * the times it does not. Needs no session, so it can run while the sign-out
 * is under way.
 */
export function signedOut(stored: StoredNative | null): StoredNative | null {
  if (!stored) return null;
  const pending = new Set<NativeProvider>(stored.pendingUnregister ?? []);
  for (const provider of PROVIDERS) {
    if (stored.entries[provider]) pending.add(provider);
  }
  const next: StoredNative = { ...stored, entries: {} };
  delete next.resync;
  delete next.pendingUnregister;
  const list = PROVIDERS.filter((provider) => pending.has(provider));
  if (list.length > 0) next.pendingUnregister = list;
  return next;
}

/** The record with `provider` added to, or taken off, the unregister
 *  retry list. A record left by another owner keeps nothing. */
export function withPending(
  stored: StoredNative | null,
  owner: string,
  provider: NativeProvider,
  pending: boolean,
): StoredNative {
  const base: StoredNative =
    stored && stored.owner === owner ? stored : { v: 1, owner, entries: {} };
  const set = new Set<NativeProvider>(base.pendingUnregister ?? []);
  if (pending) set.add(provider);
  else set.delete(provider);
  const next: StoredNative = { ...base };
  delete next.pendingUnregister;
  const list = PROVIDERS.filter((known) => set.has(known));
  if (list.length > 0) next.pendingUnregister = list;
  return next;
}

/** The record after the alert provider registered: a carried-over
 *  registration is settled, and the server's answer about the provider is
 *  remembered when there was one. */
export function afterAlertRegistration(
  stored: StoredNative | null,
  serverEnabled: boolean | null,
): StoredNative | null {
  if (!stored) return null;
  const next: StoredNative = { ...stored };
  delete next.resync;
  if (serverEnabled !== null) next.serverEnabled = serverEnabled;
  return next;
}

/** The record with one provider's entry set. A record left by another
 *  owner keeps nothing (callers run `carryOver` first, so that is another
 *  device's). The provider comes off the unregister retry list: the row
 *  the server now holds is one this device wants. */
export function withEntry(
  stored: StoredNative | null,
  owner: string,
  provider: NativeProvider,
  entry: StoredEntry,
): StoredNative {
  const base = withPending(stored, owner, provider, false);
  const next: StoredNative = { ...base, entries: { ...base.entries, [provider]: entry } };
  // Only a registration with alerts on is evidence the notification prompt
  // was granted. PushKit (apns_voip) needs no permission, and an `fcm` row
  // with `alerts: false` may be the phone-calls plan's ring registration on
  // Android (R9), made whether or not POST_NOTIFICATIONS was granted.
  // Either one after a refused prompt must keep the refusal: erasing it
  // turns "blocked" into a "ready" whose Turn on cannot prompt again.
  // Android's Turn off (`alerts: false` after a Turn on) keeps what the
  // record held, which that Turn on already set false.
  if (provider !== "apns_voip" && entry.alerts !== false) next.declined = false;
  return next;
}

/** The record with one provider's entry removed. */
export function withoutEntry(
  stored: StoredNative | null,
  provider: NativeProvider,
): StoredNative | null {
  if (!stored) return null;
  const entries = { ...stored.entries };
  delete entries[provider];
  return { ...stored, entries };
}

// ---------------------------------------------------------------------------
// Taps
// ---------------------------------------------------------------------------

/** A tap the plugin handed over (`take_open`), validated. */
export type NativeOpen = { kind: NativeKind; ref: string | null };

/**
 * Validates the plugin's `take_open` answer. An unknown kind with a ref is
 * read as a message (the safe reading: it opens a conversation the person
 * is a member of, or nothing); an unknown kind without one is dropped.
 */
export function parseOpen(value: unknown): NativeOpen | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { kind?: unknown; k?: unknown; ref?: unknown; r?: unknown };
  const kindValue = raw.kind ?? raw.k;
  const refValue = raw.ref ?? raw.r;
  const ref =
    typeof refValue === "string" && REF_PATTERN.test(refValue) ? refValue : null;
  const kind = KINDS.find((known) => known === kindValue);
  if (kind) return { kind, ref };
  return ref ? { kind: "message", ref } : null;
}

/** What a tapped kind opens. */
export function openTarget(kind: NativeKind): "conversation" | "friends" {
  return kind === "contact_request" || kind === "contact_accepted"
    ? "friends"
    : "conversation";
}

// ---------------------------------------------------------------------------
// The per-device conversation reference (plan §2, point 2)
// ---------------------------------------------------------------------------

/** 16 bytes of base64url, unpadded. */
export const REF_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * `base64url(HMAC-SHA256(refKey, "conv:" + conversationId))[0..16 bytes]`.
 *
 * The server sends this instead of the conversation id, so Apple and Google
 * cannot link the devices that share a conversation: the key is per device
 * (per `push_tokens` row), so the same conversation has a different ref on
 * every phone. The device finds the conversation by computing the same
 * value over the ids it holds.
 *
 * WebCrypto HMAC-SHA256 is baseline everywhere this app runs (Safari,
 * Android WebView, WebView2, Node); the CLAUDE.md probe rule is about the
 * newer curves. Returns null for a malformed key rather than throwing.
 */
export async function computeRef(
  refKey: string,
  conversationId: string,
): Promise<string | null> {
  const keyBytes = decodeBase64Url(refKey);
  if (keyBytes === null || keyBytes.length !== 32) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`conv:${conversationId}`),
  );
  return encodeBase64Url(new Uint8Array(mac).subarray(0, 16));
}

/** The conversation among `conversationIds` whose ref is `ref`, if any. */
export async function resolveRefAmong(
  refKey: string,
  ref: string,
  conversationIds: readonly string[],
): Promise<string | null> {
  if (!REF_PATTERN.test(ref)) return null;
  for (const id of conversationIds) {
    if ((await computeRef(refKey, id)) === ref) return id;
  }
  return null;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url (padded or not) to bytes; null for anything else. */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) return null;
  const base64 = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Key material (M-1 = E)
// ---------------------------------------------------------------------------

/** RFC 8291 key material as the server's schema takes it (P1's
 *  routes/push.ts): unpadded base64url, `p256dh` the 65-byte uncompressed
 *  P-256 point (87 characters), `auth` the 16-byte secret (22). */
export type PushKeys = { p256dh: string; auth: string };

/**
 * Key material a native half reported, in the one spelling the server
 * accepts; null when there is none, or when it is not a 65-byte
 * uncompressed point (leading 0x04) and a 16-byte secret.
 *
 * Normalises rather than refuses the spellings a native half reaches for
 * first -- padding, the standard alphabet's `+` and `/`, and line breaks,
 * which is Android's `Base64.DEFAULT` -- because the server's patterns take
 * exactly unpadded base64url, and anything else is a 400 that reads, on the
 * phone, as a toggle that springs back.
 */
export function normaliseKeys(value: {
  p256dh?: unknown;
  auth?: unknown;
}): PushKeys | null {
  const p256dh = keyBytes(value.p256dh);
  const auth = keyBytes(value.auth);
  if (p256dh === null || auth === null) return null;
  if (p256dh.length !== 65 || p256dh[0] !== 0x04) return null;
  if (auth.length !== 16) return null;
  return { p256dh: encodeBase64Url(p256dh), auth: encodeBase64Url(auth) };
}

function keyBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  const urlSafe = value
    .replace(/\s+/g, "")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return urlSafe.length === 0 ? null : decodeBase64Url(urlSafe);
}
