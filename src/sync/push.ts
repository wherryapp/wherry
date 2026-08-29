// Turning notifications on and off for this browser.
//
// Lives beside the sync engine rather than in `ui/` because it is the same
// kind of thing: something that talks to the server on the app's behalf and
// that the UI only ever asks about. The engine polls; this arranges to be
// woken between polls.
//
// Deliberately not part of the engine itself. The poll loop runs in one tab
// under a Web Lock, and a subscription belongs to the *browser* rather than to
// whichever tab happens to be leading -- tying them together would mean
// notifications quietly following the leader election around.

import {
  ApiError,
  fetchPushKey,
  subscribeToPush,
  unsubscribeFromPush,
} from "../api/client";
import { isInstalled } from "../pwa";

/** Why notifications cannot be turned on, when they cannot. */
export type PushAvailability =
  | { state: "ready" }
  /** The browser has no push support at all. */
  | { state: "unsupported" }
  /** iOS: push is only delivered to a site added to the home screen. */
  | { state: "needs-install" }
  /** Permission was refused, and only the browser's own UI can undo that. */
  | { state: "blocked" }
  /** The server has no VAPID keys installed. */
  | { state: "server-disabled" };

export type PushState = PushAvailability["state"] | "on";

/**
 * What this browser is currently capable of.
 *
 * `needs-install` is the interesting one and the reason this returns a reason
 * rather than a boolean: on iOS, a perfectly capable browser refuses push
 * until the site is on the home screen, and "notifications are not available"
 * with no explanation is the kind of dead end people never get past.
 */
export function availability(): PushAvailability {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    // Safari in a tab reports no PushManager on iOS, so an uninstalled iPhone
    // lands here rather than on the check below. Distinguish it, because the
    // advice is completely different.
    if (isIos() && !isInstalled()) return { state: "needs-install" };
    return { state: "unsupported" };
  }

  if (isIos() && !isInstalled()) return { state: "needs-install" };
  if (Notification.permission === "denied") return { state: "blocked" };

  return { state: "ready" };
}

function isIos(): boolean {
  // iPadOS reports itself as a Mac, so the touch check is what separates a
  // tablet from a desktop. Neither half is sufficient alone.
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const iPadOS =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return ios || iPadOS;
}

/** Whether this browser already has a subscription. */
export async function isSubscribed(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.ready;
  return (await registration.pushManager.getSubscription()) !== null;
}

/**
 * Asks for permission, subscribes, and tells the server.
 *
 * Must be called from a user gesture. Browsers refuse a permission prompt that
 * was not asked for, and Safari is the strictest about it -- which is also the
 * right behaviour for the app: nobody should be asked on first load, before
 * they have any idea what this is.
 */
export async function enable(): Promise<PushState> {
  const available = availability();
  if (available.state !== "ready") return available.state;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return permission === "denied" ? "blocked" : "unsupported";
  }

  // Fetched rather than built in, so rotating the server's keys does not need
  // a client release. The 503 is a real answer -- see fetchPushKey.
  let publicKey: string;
  try {
    ({ publicKey } = await fetchPushKey());
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) {
      return "server-disabled";
    }
    throw error;
  }

  const registration = await navigator.serviceWorker.ready;

  // An existing subscription is reused unless it was issued against a
  // different key. Calling subscribe() with a new key while one exists throws
  // rather than replacing it, which is the case a key rotation produces.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Required, and required to be true: a subscription that could be used
      // to wake the browser without showing anything is a tracking mechanism,
      // and browsers refuse to issue one.
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    }));

  await subscribeToPush(toJSON(subscription));
  return "on";
}

/**
 * Unsubscribes this browser and tells the server to forget it.
 *
 * The server is told first. If the browser drops the subscription and the
 * request then fails, the server keeps sending to an endpoint nobody is
 * listening on -- harmless but permanent, since only the push service will
 * ever say it is gone.
 */
export async function disable(): Promise<PushState> {
  if (!("serviceWorker" in navigator)) return "unsupported";

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return availability().state;

  try {
    await unsubscribeFromPush(subscription.endpoint);
  } catch {
    // Best effort. Losing the local subscription is what the person asked
    // for, and a stale row on the server is marked dead the first time a
    // notification is sent to it.
  }

  await subscription.unsubscribe();
  return availability().state;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * base64url to bytes, which is the only form `applicationServerKey` accepts.
 *
 * `atob` does not understand base64url, and the VAPID key is base64url --
 * feeding it in unchanged fails on any key that happens to contain `-` or `_`,
 * which is most of them and not all of them. That intermittency is the whole
 * reason this is a named function rather than an inline expression.
 */
function decodeKey(base64url: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);

  // Allocated and filled rather than `Uint8Array.from`, and returned as the
  // underlying ArrayBuffer. `applicationServerKey` takes a BufferSource, and
  // a Uint8Array's buffer is only known to be an ArrayBuffer when it was
  // allocated as one -- otherwise the type includes SharedArrayBuffer, which
  // BufferSource excludes.
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes.buffer;
}

/**
 * The wire shape the server expects.
 *
 * `subscription.toJSON()` produces exactly this, but with everything optional
 * in its type, so the fields are checked rather than asserted -- a
 * subscription missing its keys would otherwise be stored and fail silently at
 * send time, long after anyone could connect the two.
 */
function toJSON(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = subscription.toJSON();
  const p256dh = json.keys?.["p256dh"];
  const auth = json.keys?.["auth"];

  if (!json.endpoint || !p256dh || !auth) {
    throw new Error("push subscription is missing its endpoint or keys");
  }

  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}
