// Native push on the phone shells: the named interface the `wherry-push`
// plugin sits behind (docs/prompts/native-push-plan.md §5.1, §7.1).
//
// Decisions in TypeScript, mechanism in the plugin: the Swift and Kotlin
// halves obtain a token, report taps, clear delivered notifications and set
// the badge; everything this file decides is in native-push-rules.ts,
// where it is tested. The permission prompt is not the plugin's either --
// it belongs to @tauri-apps/plugin-notification, already a dependency,
// which asks for [.badge, .alert, .sound] on iOS and POST_NOTIFICATIONS on
// Android 13 and later.
//
// Loaded only through sync/push.ts's `withNativePush`, which imports this
// module dynamically and only inside a phone-shell candidate, so the web
// bundle never fetches it (row W-107). The Tauri API is imported
// dynamically here too, as in desktop-notify.ts.
//
// **Nothing here may throw into the sync loop** (CLAUDE.md: a throw near it
// has wedged all tap input before). Every export that runs outside a user
// gesture swallows its failures; the two a button calls (`enableNative`,
// `disableNative`) return a state instead of throwing wherever a state is
// the honest answer.

import {
  ApiError,
  fetchNativePushProviders,
  registerNativePush,
  unregisterNativePush,
  type NativePushProvider,
  type RegisterNativePushBody,
} from "../api/client";
import { loadSession } from "../api/session";
import {
  NATIVE_PUSH_STORAGE_KEY,
  afterAlertRegistration,
  alertEntry,
  carryOver,
  computeRef,
  encodeBase64Url,
  nativeStateFrom,
  normaliseKeys,
  parseOpen,
  parseStored,
  reregisterReason,
  resolveRefAmong,
  signedOut,
  withEntry,
  withPending,
  withoutEntry,
  type NativeOpen,
  type NativePushState,
  type PluginStatus,
  type PushKeys,
  type ServerProviders,
  type StoredNative,
} from "./native-push-rules";

export type { NativeOpen, NativePushState };

const PLUGIN = "wherry-push";

// ---------------------------------------------------------------------------
// The plugin (§5.1's contract)
// ---------------------------------------------------------------------------

async function invokePlugin<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(`plugin:${PLUGIN}|${command}`, args);
}

/** What `register` and the `token` event carry. `p256dh` and `auth` are
 *  the device's RFC 8291 key material (decision M-1 = E): optional in the
 *  §5.1 contract, supplied by the native half that holds the private key.
 *  Read through `takeKeys`, never sent as given. */
type TokenAnswer = {
  token: string;
  environment: "sandbox" | "production" | null;
  p256dh?: unknown;
  auth?: unknown;
};

/**
 * The plugin's `status`, validated; null when there is no plugin to ask (a
 * desktop `tauri dev` page, or a shell built without it). The first probe
 * is the whole cost of asking in a process that turns out not to be a phone.
 */
async function pluginStatus(): Promise<PluginStatus | null> {
  try {
    const raw = await invokePlugin<Partial<PluginStatus> & Partial<TokenAnswer>>("status");
    if (raw.provider !== "apns" && raw.provider !== "fcm") return null;
    const status: PluginStatus = {
      provider: raw.provider,
      configured: raw.configured === true,
      token: typeof raw.token === "string" && raw.token.length > 0 ? raw.token : null,
      environment:
        raw.environment === "sandbox" || raw.environment === "production"
          ? raw.environment
          : null,
    };
    takeKeys(raw);
    return status;
  } catch {
    return null;
  }
}

/**
 * Folds the key material in a plugin answer into `lastKeys`, in the
 * server's spelling (`normaliseKeys`). An answer that carries none leaves
 * `lastKeys` alone; one that carries material which is not a P-256 point
 * and a 16-byte secret clears it, and says so in the console -- the
 * registration it would have gone into then fails with a message naming
 * the fields, instead of sending the previous pair or a bare 400.
 */
function takeKeys(value: { p256dh?: unknown; auth?: unknown }): void {
  if (value.p256dh === undefined && value.auth === undefined) return;
  lastKeys = normaliseKeys(value);
  if (lastKeys === null) {
    console.warn(
      "native push: the plugin's p256dh/auth are not a 65-byte P-256 point and a 16-byte secret; ignored",
    );
  }
}

/** The key material the plugin last reported, if it reports any. */
let lastKeys: PushKeys | null = null;

// ---------------------------------------------------------------------------
// The server and the permission
// ---------------------------------------------------------------------------

async function serverProviders(): Promise<ServerProviders> {
  try {
    const { providers } = await fetchNativePushProviders();
    return { kind: "known", apns: providers.apns === true, fcm: providers.fcm === true };
  } catch (error) {
    // An older server does not know the route. Read as server-disabled.
    if (error instanceof ApiError && error.status === 404) return { kind: "absent" };
    return { kind: "unknown" };
  }
}

async function permissionGranted(): Promise<boolean> {
  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    return await plugin.isPermissionGranted();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// What this install remembers (a convenience; see StoredNative)
// ---------------------------------------------------------------------------

function readStored(): StoredNative | null {
  try {
    return parseStored(window.localStorage.getItem(NATIVE_PUSH_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStored(value: StoredNative | null): void {
  try {
    if (value === null) window.localStorage.removeItem(NATIVE_PUSH_STORAGE_KEY);
    else window.localStorage.setItem(NATIVE_PUSH_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Lost memory costs one re-registration, which returns the same ref key.
  }
}

/**
 * The record as this sign-in sees it: what an earlier sign-in of this
 * device left is carried over (`carryOver` decides how), and the result is
 * written back, so the carry-over happens once. Every read that is about
 * the current sign-in goes through here.
 */
function readStoredFor(owner: string): StoredNative | null {
  const stored = readStored();
  const carried = carryOver(stored, owner);
  if (carried !== stored) writeStored(carried);
  return carried;
}

/**
 * An explicit sign-out is under way: this device's registrations stop
 * counting, and the next sign-in on it makes sure the server forgot them
 * (`signedOut`). Called by the shell just before it signs out; the logout
 * route forgets the tokens when it succeeds, and this covers the times it
 * does not (offline). Needs no session. Never throws.
 */
export function noteSignOut(): void {
  try {
    const stored = readStored();
    if (stored) writeStored(signedOut(stored));
  } catch {
    // The next sign-in on this device re-registers instead, which is the
    // lesser failure (push stays on, and nothing is shown twice).
  }
}

/**
 * Who the stored entries belong to: this device and this sign-in. The
 * sign-in part is a fingerprint of the session token (SHA-256, 12 bytes),
 * never the token itself; the token already sits beside it in
 * localStorage, so this adds nothing a reader of storage did not have.
 * Null when signed out.
 */
async function currentOwner(): Promise<string | null> {
  const session = loadSession();
  if (!session) return null;
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(session.token),
    );
    return `${session.device.id}:${encodeBase64Url(new Uint8Array(digest).subarray(0, 12))}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State, and who listens to it
// ---------------------------------------------------------------------------

const stateListeners = new Set<(state: NativePushState) => void>();

function publishState(state: NativePushState): NativePushState {
  for (const listener of stateListeners) {
    try {
      listener(state);
    } catch {
      // A listener's problem is its own.
    }
  }
  return state;
}

/**
 * The state for Settings and the nudge: `on`, `ready`, `blocked`,
 * `server-disabled`, `unconfigured` or `unsupported`, from the server's
 * `GET /api/push/native`, plugin-notification's permission and the
 * plugin's `status`. Never throws.
 */
export async function nativeAvailability(): Promise<NativePushState> {
  try {
    const status = await pluginStatus();
    if (status === null) return publishState("unsupported");
    const [server, granted, owner] = await Promise.all([
      serverProviders(),
      permissionGranted(),
      currentOwner(),
    ]);
    if (owner === null) return publishState("unsupported");
    const stored = readStoredFor(owner);
    rememberServer(stored, owner, status, server);
    return publishState(
      nativeStateFrom({ status, server, permissionGranted: granted, stored, owner }),
    );
  } catch {
    return publishState("unsupported");
  }
}

function rememberServer(
  stored: StoredNative | null,
  owner: string,
  status: PluginStatus,
  server: ServerProviders,
): void {
  if (!stored || stored.owner !== owner || server.kind !== "known") return;
  const enabled = server[status.provider];
  if (stored.serverEnabled === enabled) return;
  writeStored({ ...stored, serverEnabled: enabled });
}

// ---------------------------------------------------------------------------
// Registration: the one path (coordination §4)
// ---------------------------------------------------------------------------

/**
 * Registers one token with the server and remembers what came back. The
 * one registration path: `enableNative`, the silent re-registration at
 * launch, the `token` event, and the phone-calls plan's PushKit token
 * (`registerNativeToken("apns_voip", token, …)`) all come through here.
 *
 * `environment` is required for the two APNs providers. It defaults to what
 * the wherry-push plugin's `status` reports -- an app's alert and VoIP
 * tokens come from the same signed build, so they share the APNs host --
 * **but that status reports an environment only once the plugin holds an
 * alert token this process** (ng/push-p2's `PushPlugin.swift`), which it
 * never does for somebody who has not turned notifications on. A PushKit
 * token needs no notification permission, so the calls plugin must pass
 * `environment` itself (or §5.1 must be amended so `status` always reports
 * it; hunk H6). Without one, this throws before sending, rather than
 * sending what the server refuses with 400 INVALID_PUSH_TOKEN.
 *
 * `keys` are required for `fcm` and `apns_voip`, the providers whose rings
 * are encrypted (M-1 = E), and dropped for `apns`. They default to what
 * this plugin last reported, which is right for `fcm` only; the calls
 * plugin passes the pair it holds for `apns_voip`. Either way they go
 * through `normaliseKeys`, so a padded or standard-alphabet spelling is
 * sent as the unpadded base64url the server's schema takes, and material
 * that is not a P-256 point and a 16-byte secret throws here, naming the
 * fields, instead of coming back as a bare 400.
 *
 * Throws on failure (an ApiError, a NetworkError, "signed out", or one of
 * the two above): the caller decides whether that is a state or a shrug.
 */
export async function registerNativeToken(
  provider: NativePushProvider,
  token: string,
  options: {
    environment?: "sandbox" | "production" | null;
    keys?: { p256dh: string; auth: string } | null;
  } = {},
): Promise<{ refKey: string }> {
  const owner = await currentOwner();
  if (owner === null) throw new Error("native push: signed out");

  let environment = options.environment ?? null;
  if (environment === null && provider !== "fcm") {
    environment = (await pluginStatus())?.environment ?? null;
  }
  if (provider !== "fcm" && environment === null) {
    throw new Error(
      `native push: ${provider} needs an APNs environment, and the wherry-push plugin reported none; pass options.environment`,
    );
  }

  // Only the providers that carry encrypted rings take key material (plan
  // §4.3); an APNs alert is fixed text and needs none.
  let keys: PushKeys | null = null;
  if (provider !== "apns") {
    const given = options.keys !== undefined ? options.keys : provider === "fcm" ? lastKeys : null;
    keys = given ? normaliseKeys(given) : null;
    if (keys === null) {
      throw new Error(
        `native push: ${provider} needs p256dh and auth (a 65-byte uncompressed P-256 point and a 16-byte secret), and ${given ? "those given are not" : "none were given"}`,
      );
    }
  }

  const body: RegisterNativePushBody = { provider, token };
  if (provider !== "fcm" && environment !== null) body.environment = environment;
  if (keys) {
    body.p256dh = keys.p256dh;
    body.auth = keys.auth;
  }

  const { refKey } = await registerNativePush(body);
  writeStored(withEntry(readStoredFor(owner), owner, provider, { token, environment, refKey }));
  return { refKey };
}

/**
 * Turns native push on. Called from a user gesture (the Settings toggle or
 * the nudge): the permission prompt first, then the plugin's token, then
 * the server. Returns the state the row should now show.
 */
export async function enableNative(): Promise<NativePushState> {
  try {
    const status = await pluginStatus();
    if (status === null) return publishState("unsupported");
    if (!status.configured) return publishState("unconfigured");

    // Asked before the prompt: prompting for something this server cannot
    // send would spend the one prompt iOS gives an app on nothing.
    const server = await serverProviders();
    if (server.kind === "absent" || (server.kind === "known" && !server[status.provider])) {
      return publishState("server-disabled");
    }

    const plugin = await import("@tauri-apps/plugin-notification");
    let granted = await plugin.isPermissionGranted();
    if (!granted) {
      const answer = await plugin.requestPermission();
      granted = answer === "granted";
      if (!granted) {
        if (answer === "denied") rememberDeclined();
        return publishState(answer === "denied" ? "blocked" : "ready");
      }
    }

    const answer = await invokePlugin<TokenAnswer>("register");
    takeKeys(answer);
    await registerNativeToken(status.provider, answer.token, {
      environment: answer.environment,
    });
    writeStored(
      afterAlertRegistration(
        readStored(),
        server.kind === "known" ? server[status.provider] : null,
      ),
    );
    return publishState("on");
  } catch (error) {
    console.warn("native push: enable failed", error);
    return nativeAvailability();
  }
}

function rememberDeclined(): void {
  void currentOwner().then((owner) => {
    if (owner === null) return;
    const stored = readStoredFor(owner);
    const base: StoredNative = stored ?? { v: 1, owner, entries: {} };
    writeStored({ ...base, declined: true });
  });
}

/**
 * Turns native push off: the server forgets the token first, then the
 * plugin forgets it, then this install does. The server goes first for the
 * same reason as web push's `disable`: a server that still holds a token
 * nobody listens to keeps sending until the provider says it is gone.
 *
 * On iOS this leaves the phone-calls plan's `apns_voip` entry alone: a
 * ring is a separate PushKit token, so turning alerts off leaves calls
 * ringing. **On Android it does not**, and cannot from here: Android has
 * no separate VoIP provider, so the calls plan's ring (`call_ring` and
 * `ring_ended`, through PUSH's one FirebaseMessagingService) travels on
 * this same `fcm` row and token, and forgetting them silences rings too.
 * Correct today, while nothing rings through FCM; before CALLS-A1/A2 builds
 * on the row, hunk H7 needs a decision (P4 recommends a server-side
 * per-row "alerts off" that keeps the row, so this toggle would register
 * that instead of unregistering on Android).
 */
export async function disableNative(): Promise<NativePushState> {
  try {
    const status = await pluginStatus();
    if (status === null) return publishState("unsupported");
    const owner = await currentOwner();
    let reached = true;
    try {
      await unregisterNativePush(status.provider);
    } catch (error) {
      // Not reached (offline, a 5xx): the server keeps its row and keeps
      // sending, and an iOS token is not invalidated by the plugin's
      // `unregister` (P2 only forgets its cached copy). So it is queued and
      // retried at every start until the server answers.
      reached = !unregisterWorthRetrying(error);
    }
    try {
      await invokePlugin("unregister");
    } catch {
      // Best effort: forgetting locally is what was asked for.
    }
    let stored = withoutEntry(owner ? readStoredFor(owner) : readStored(), status.provider);
    if (!reached && owner) stored = withPending(stored, owner, status.provider, true);
    writeStored(stored);
  } catch {
    // Fall through to whatever the state now is.
  }
  return nativeAvailability();
}

/** Whether an unregister that failed this way can still succeed later. A
 *  404 (a server older than the routes, so no row) or a 400 will not. */
function unregisterWorthRetrying(error: unknown): boolean {
  return !(error instanceof ApiError && (error.status === 404 || error.status === 400));
}

/**
 * Tells the server to forget what this device queued for forgetting: the
 * registrations of a sign-in that ended with a sign-out, and a Turn off the
 * server never heard (`StoredNative.pendingUnregister`). Each provider comes
 * off the list once the server answers. Run at every start.
 */
async function flushPendingUnregisters(owner: string): Promise<void> {
  const pending = readStoredFor(owner)?.pendingUnregister ?? [];
  for (const provider of pending) {
    // Re-read: a Turn on since the list was read takes the provider off it,
    // and its fresh row must not be forgotten.
    if (!readStoredFor(owner)?.pendingUnregister?.includes(provider)) continue;
    try {
      await unregisterNativePush(provider);
    } catch (error) {
      if (unregisterWorthRetrying(error)) continue;
    }
    console.info(`native-push unregistered (${provider}, queued)`);
    writeStored(withPending(readStoredFor(owner), owner, provider, false));
  }
}

/** Opens this app's page in the system settings: the way out of blocked. */
export async function openNativeSettings(): Promise<void> {
  try {
    await invokePlugin("open_settings");
  } catch {
    // Nothing better to offer.
  }
}

// ---------------------------------------------------------------------------
// Running: taps, receipts, token rotation
// ---------------------------------------------------------------------------

export type NativePushHooks = {
  /** A notification was tapped. The shell's open-request store. */
  onOpen: (open: NativeOpen) => void;
  /** A push arrived while the process was alive: sync now. */
  poke: () => void;
  /** The state changed (the engine's gate reads nativeOwnsAlerts of it). */
  onState?: (state: NativePushState) => void;
};

/**
 * Starts native push for this sign-in. Called once by the shell after
 * sign-in; returns the stop function its effect cleans up with.
 *
 * Listens for the plugin's `token`, `opened` and `received` events, takes a
 * tap that happened before anything listened (a cold start) once, sends
 * any unregister this device queued (`flushPendingUnregisters`), and, for
 * a device that already turned push on, re-registers silently when the
 * rules say this launch owes it: once per launch on both platforms (which
 * is also what revives a row the server marked failed), and again whenever
 * the token rotates. It never turns push on by itself.
 */
export function startNativePush(hooks: NativePushHooks): () => void {
  let stopped = false;
  const run: Run = { launchRegistered: false };
  const unlisten: Array<() => void> = [];
  const onState = hooks.onState;
  if (onState) stateListeners.add(onState);

  const takeOpen = async (): Promise<void> => {
    try {
      const open = parseOpen(await invokePlugin<unknown>("take_open"));
      if (open && !stopped) {
        console.info(`native-push open ${open.kind}${open.ref ? ` ${open.ref}` : ""}`);
        hooks.onOpen(open);
      }
    } catch {
      // No tap, or no plugin.
    }
  };

  void (async () => {
    try {
      const status = await pluginStatus();
      if (status === null || stopped) {
        publishState("unsupported");
        return;
      }

      const core = await import("@tauri-apps/api/core");
      const listen = async <T>(event: string, handler: (payload: T) => void): Promise<void> => {
        const listener = await core.addPluginListener<T>(PLUGIN, event, (payload) => {
          try {
            handler(payload);
          } catch {
            // Never into the caller.
          }
        });
        if (stopped) void listener.unregister();
        else unlisten.push(() => void listener.unregister());
      };

      await listen<TokenAnswer>("token", (answer) => {
        takeKeys(answer);
        void reregisterIfOwed(run, status.provider, answer.token);
      });
      await listen<unknown>("opened", () => {
        void takeOpen();
      });
      await listen<{ kind?: string }>("received", (payload) => {
        // Row I-43 reads this line.
        console.info(`native-push received → poke (${payload?.kind ?? "?"})`);
        hooks.poke();
      });

      await takeOpen();
      const owner = await currentOwner();
      if (owner !== null && !stopped) await flushPendingUnregisters(owner);
      await reregisterIfOwed(run, status.provider, status.token);
      if (!stopped) await nativeAvailability();
    } catch {
      // Best effort by contract.
    }
  })();

  return () => {
    stopped = true;
    if (onState) stateListeners.delete(onState);
    for (const off of unlisten.splice(0)) off();
  };
}

/** One `startNativePush` run: a sign-in in this process. */
type Run = {
  /** This run has told the server its token once, or is telling it now.
   *  The plugin also registers by itself at an iOS cold launch and emits
   *  `token` (and Android may emit one at start), and the launch
   *  registration needs no second copy. Set before the request, so a
   *  `token` event that lands while it is in flight does not send a
   *  duplicate; cleared again if the request fails. */
  launchRegistered: boolean;
};

async function reregisterIfOwed(
  run: Run,
  provider: "apns" | "fcm",
  token: string | null,
): Promise<void> {
  try {
    const owner = await currentOwner();
    if (owner === null) return;
    const [server, granted] = await Promise.all([serverProviders(), permissionGranted()]);
    const stored = readStoredFor(owner);
    const reason = reregisterReason({
      stored,
      owner,
      provider,
      currentToken: token,
      permissionGranted: granted,
      server,
    });
    if (reason === null || token === null) return;
    // One launch registration per process; a rotated token (or a
    // carried-over sign-in) is registered whenever it appears.
    if (reason === "launch" && run.launchRegistered) return;
    const wasRegistered = run.launchRegistered;
    run.launchRegistered = true;
    // The environment comes from the plugin's status (registerNativeToken's
    // default): the build decides it, not what was stored. On Android the
    // key material comes from the plugin's status or `token` event too
    // (H3): without it this throws, and the next launch asks again.
    try {
      await registerNativeToken(provider, token);
    } catch (error) {
      run.launchRegistered = wasRegistered;
      throw error;
    }
    writeStored(
      afterAlertRegistration(readStored(), server.kind === "known" ? server[provider] : null),
    );
    console.info(`native-push re-registered (${reason})`);
  } catch {
    // The next launch asks again.
  }
}

// ---------------------------------------------------------------------------
// References, clearing, the badge
// ---------------------------------------------------------------------------

async function alertRefKey(): Promise<string | null> {
  const owner = await currentOwner();
  if (owner === null) return null;
  const stored = readStoredFor(owner);
  const entry =
    alertEntry(stored, owner, "apns") ?? alertEntry(stored, owner, "fcm");
  return entry?.refKey ?? null;
}

/** This device's opaque reference for a conversation; null when push was
 *  never turned on here. */
export async function refFor(conversationId: string): Promise<string | null> {
  try {
    const refKey = await alertRefKey();
    return refKey === null ? null : await computeRef(refKey, conversationId);
  } catch {
    return null;
  }
}

/** The conversation whose reference is `ref`, among the ids given. */
export async function resolveRef(
  ref: string,
  conversationIds: readonly string[],
): Promise<string | null> {
  try {
    const refKey = await alertRefKey();
    return refKey === null ? null : await resolveRefAmong(refKey, ref, conversationIds);
  } catch {
    return null;
  }
}

/** Removes delivered notifications for a conversation (it was read). */
export async function clearNative(conversationId: string): Promise<void> {
  try {
    const ref = await refFor(conversationId);
    if (ref !== null) await invokePlugin("clear", { ref });
  } catch {
    // A stale notification costs a swipe.
  }
}

let lastBadge: number | null = null;

/**
 * Sets the app icon's number. The client owns the badge (plan §7.4): the
 * server cannot tell an operation from a message, so its count would
 * disagree with ui/unread.ts. The same total as the title, so the two
 * cannot disagree either. Skips a repeat of the same number.
 */
export async function setBadge(count: number): Promise<void> {
  const next = Math.max(0, Math.floor(count));
  if (next === lastBadge) return;
  lastBadge = next;
  try {
    await invokePlugin("set_badge", { count: next });
  } catch {
    lastBadge = null;
  }
}
