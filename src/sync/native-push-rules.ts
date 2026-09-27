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
   *  `currentOwner`). The device id alone is not enough, because it
   *  deliberately outlives a sign-out (api/session.ts) while the server
   *  forgets the device's native tokens at logout (plan §4.3). A different
   *  owner means none of the entries apply any more, and push stays off
   *  until somebody turns it on again: a sign-out means stop. */
  owner: string;
  entries: Partial<Record<NativeProvider, StoredEntry>>;
  /** The last permission request on this device answered "denied". */
  declined?: boolean;
  /** Whether the server reported the alert provider enabled the last time
   *  it was asked -- a flip to true is worth one re-registration. */
  serverEnabled?: boolean;
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
  if (!stored || stored.owner !== owner) return null;
  const entry = stored.entries[provider];
  if (!entry || !entry.refKey) return null;
  return entry;
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
  | "token-changed"
  | "server-enabled"
  | "ios-launch";

/**
 * Whether this launch owes the server a fresh registration, and why.
 *
 * Only for a device that already turned push on: a launch never registers
 * on its own initiative, because a granted OS permission on a phone may
 * have been granted to the *local* notifications (desktop-notify.ts asks at
 * the first message), not to push. Turning push on is the person's choice.
 *
 * - `token-changed`: the provider rotated the token (FCM does, and APNs
 *   can after a restore). The old one is dead weight on the server.
 * - `server-enabled`: the server said "off" last time and "on" now. The
 *   row is already there (registration works without keys, plan §4.3), so
 *   this is belt and braces, and cheap.
 * - `ios-launch`: Apple recommends registering at every launch, because a
 *   token can change without any callback the app would see.
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
  const entry = alertEntry(input.stored, input.owner, input.provider);
  if (entry === null) return null;
  if (!input.permissionGranted) return null;
  if (input.currentToken === null) return null;
  if (input.currentToken !== entry.token) return "token-changed";

  const enabledNow =
    input.server.kind === "known" && input.server[input.provider];
  if (enabledNow && input.stored?.serverEnabled === false) {
    return "server-enabled";
  }

  if (input.provider === "apns") return "ios-launch";
  return null;
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
  for (const provider of ["apns", "apns_voip", "fcm"] as const) {
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
    };
  }
  return {
    v: 1,
    owner: record.owner,
    entries,
    ...(typeof record.declined === "boolean" ? { declined: record.declined } : {}),
    ...(typeof record.serverEnabled === "boolean"
      ? { serverEnabled: record.serverEnabled }
      : {}),
  };
}

/** The record with one provider's entry set, re-based on `owner` (a
 *  record left by an earlier sign-in keeps nothing). */
export function withEntry(
  stored: StoredNative | null,
  owner: string,
  provider: NativeProvider,
  entry: StoredEntry,
): StoredNative {
  const base: StoredNative =
    stored && stored.owner === owner
      ? stored
      : { v: 1, owner, entries: {} };
  return {
    ...base,
    entries: { ...base.entries, [provider]: entry },
    // A successful registration means permission was granted.
    declined: false,
  };
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
