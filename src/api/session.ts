// What survives a page reload.
//
// Two separate keys with deliberately different lifetimes, which is the whole
// content of this file:
//
//   messenger.session -- the bearer token and who it belongs to. Cleared on
//                        logout and on any 401.
//   messenger.device  -- this browser's device id. Survives logout, and must.
//
// ---------------------------------------------------------------------------
// Why the device id outlives the session
// ---------------------------------------------------------------------------
//
// `POST /auth/login` takes a device descriptor. Send the id and the server
// reuses that device row; omit it and the server creates a *new* device, which
// docs/api.md calls the single easiest thing for a client to get wrong.
//
// The failure is quiet, which is what makes it dangerous. Nothing breaks and
// no error is returned -- there is simply an extra device on the account, and
// every message sent to that user from then on fans out to one more envelope
// that nobody will ever drain or ack. Log out and back in ten times and the
// account has eleven devices and an eleven-way fan-out.
//
// So the device id is not part of the session. It is a property of this
// browser profile, and the only thing that should clear it is the user
// clearing site data -- at which point this genuinely is a new device and a
// new row is the correct outcome.
//
// localStorage rather than IndexedDB for both, on purpose. These are small,
// synchronous reads needed before the first render to decide whether to show
// a login screen, and IndexedDB's async API would mean a flash of the wrong
// screen on every load. Message history is the opposite shape and lives in
// IndexedDB; see store/.

import type { AuthResult, Platform, PublicDevice, PublicUser } from "./types";
import { vaultDelete, vaultGet, vaultSet } from "../vault";

const SESSION_KEY = "messenger.session";
const DEVICE_KEY = "messenger.device";

// The Tauri shells mirror both keys into the OS keychain and restore them
// when the webview's localStorage comes up empty -- see vault.ts for why
// (WebKit may evict an inactive iOS app's storage, and losing the device
// id recreates the phantom-device fan-out this file exists to prevent).
// Outside the shells every vault call is an inert no-op, so nothing here
// branches on platform. Writes are fire-and-forget: this module's callers
// are synchronous by design, and a keychain that cannot be written must
// never break a login.
const VAULT_SESSION = "session";
const VAULT_DEVICE = "device";

/**
 * Restores what the vault holds and localStorage lost. Called once, before
 * the first render (main.tsx), because loadSession below is synchronous
 * and the login-or-chat decision is made on the first frame. Best-effort,
 * like everything the vault does: on any failure the app simply behaves as
 * if the storage really were gone.
 */
export async function restoreFromVault(): Promise<void> {
  if (!readKey(DEVICE_KEY)) {
    const device = await vaultGet(VAULT_DEVICE);
    if (device) writeKey(DEVICE_KEY, device);
  }
  if (!readKey(SESSION_KEY)) {
    const session = await vaultGet(VAULT_SESSION);
    if (session) {
      writeKey(SESSION_KEY, session);
      // Drop the memoised null so the next loadSession re-reads.
      cached = undefined;
    }
  }
}

export type StoredSession = {
  token: string;
  expiresAt: string;
  user: PublicUser;
  device: PublicDevice;
  /**
   * A snapshot, not a live value -- it is only as fresh as the last login,
   * register, or explicit refresh. Verifying happens by clicking a link in
   * another tab or device, which nothing here is told about as it happens.
   * The gate screen that reads this is what keeps it honest, by re-checking
   * against `GET /auth/me` rather than trusting this forever.
   */
  emailVerified: boolean;
};

/**
 * Every access is wrapped, because localStorage is not always there.
 *
 * It throws rather than returning null when a browser is configured to block
 * site data, and the throw happens on access rather than at startup. An
 * unguarded read would take down the whole app for that user, so the degraded
 * behaviour is "you have to log in again each time", not a blank page.
 */
function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Nothing to do. The app works, it just will not be remembered.
  }
}

function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // As above.
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

let cached: StoredSession | null | undefined;

/** The stored session, or null. Read before the first render. */
export function loadSession(): StoredSession | null {
  if (cached !== undefined) return cached;

  const raw = readKey(SESSION_KEY);
  if (!raw) {
    cached = null;
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as StoredSession;
    // A stored value from an older build could be any shape at all. Check the
    // one field everything else depends on rather than trusting the cast.
    if (typeof parsed?.token !== "string") throw new Error("malformed");
    cached = parsed;
    return parsed;
  } catch {
    // Corrupt or from an incompatible build. Drop it and show the login
    // screen, which is recoverable; leaving it would fail on every request.
    removeKey(SESSION_KEY);
    cached = null;
    return null;
  }
}

/** Stores the session, and separately remembers the device for next time. */
export function saveSession(result: AuthResult): StoredSession {
  const session: StoredSession = {
    token: result.token,
    expiresAt: result.expiresAt,
    user: result.user,
    device: result.device,
    emailVerified: result.emailVerified,
  };
  cached = session;
  writeKey(SESSION_KEY, JSON.stringify(session));
  void vaultSet(VAULT_SESSION, JSON.stringify(session));

  // The line this whole file exists for.
  writeKey(DEVICE_KEY, result.device.id);
  void vaultSet(VAULT_DEVICE, result.device.id);

  return session;
}

/**
 * Updates just the verification snapshot, after the gate screen asks
 * `GET /auth/me` and learns the address was confirmed elsewhere. Everything
 * else about the session is unchanged -- this is not a re-login.
 */
export function markEmailVerified(session: StoredSession): StoredSession {
  const updated: StoredSession = { ...session, emailVerified: true };
  cached = updated;
  writeKey(SESSION_KEY, JSON.stringify(updated));
  void vaultSet(VAULT_SESSION, JSON.stringify(updated));
  return updated;
}

/**
 * Updates the stored snapshot's avatar hue after the person picks one in
 * Settings, markEmailVerified's pattern exactly: not a re-login, just
 * keeping the snapshot honest so the header avatar is right on the next
 * load instead of the next sign-in.
 */
export function markAvatarHue(
  session: StoredSession,
  avatarHue: number | null,
): StoredSession {
  const updated: StoredSession = {
    ...session,
    user: { ...session.user, avatarHue },
  };
  cached = updated;
  writeKey(SESSION_KEY, JSON.stringify(updated));
  void vaultSet(VAULT_SESSION, JSON.stringify(updated));
  return updated;
}

/**
 * Forgets the token but *keeps* the device id.
 *
 * Called on logout and on a 401. Clearing the device id here would recreate
 * the fan-out bug on the next login, which is exactly when it would be least
 * obvious.
 */
export function clearSession(): void {
  cached = null;
  removeKey(SESSION_KEY);
  // The vault mirrors the lifetime exactly: token gone, keychain copy gone,
  // device id kept in both places.
  void vaultDelete(VAULT_SESSION);
}

export function currentToken(): string | null {
  return loadSession()?.token ?? null;
}

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

/** This browser's device id, if it has ever logged in. */
export function storedDeviceId(): string | null {
  return readKey(DEVICE_KEY);
}

/**
 * Forgets the device id. The one caller is the `UNKNOWN_DEVICE` recovery in
 * Login.tsx, and the narrowness is the point.
 *
 * The rule this looks like it breaks -- only the user clearing site data may
 * clear the device id, or an account accumulates a device per sign-in -- is
 * about ids the server still honours. `UNKNOWN_DEVICE` is the server saying
 * this id is *gone*: revoked from the device list, or belonging to an account
 * that no longer has it. Keeping it then buys no dedupe, because there is no
 * row left to reuse; it only makes the id unusable forever.
 *
 * Which is what it did. Revoking a device from Settings left that device's
 * app showing "This device is no longer recognised. Clearing site data will
 * fix it." on every sign-in attempt -- advice with no button behind it in a
 * desktop app, so revoking a device bricked it permanently.
 */
export function forgetDevice(): void {
  removeKey(DEVICE_KEY);
  // Same reasoning as the localStorage removal: the server says this id is
  // gone, so a keychain copy that would resurrect it is worse than none.
  void vaultDelete(VAULT_DEVICE);
}

/**
 * The descriptor to send with register or login.
 *
 * The id is included only when we have one. `undefined` rather than null: the
 * server's schema has `additionalProperties: false` and `removeAdditional` is
 * off, so a literal null would be a 400 rather than being treated as absent.
 */
export function deviceDescriptor(displayName: string): {
  id?: string;
  displayName: string;
  platform: Platform;
} {
  const id = storedDeviceId();
  return {
    ...(id ? { id } : {}),
    displayName,
    platform: detectPlatform(),
  };
}

/**
 * What kind of device this is.
 *
 * This used to be hard-coded to "desktop", reasoning that Phase 5 wraps the
 * same app in Tauri where it stays desktop, and that ios and android would
 * arrive with native builds. That was written before the app was installable,
 * and it stopped being true the day somebody added it to an iPhone home
 * screen: the column now claims every phone is a computer, in a device list
 * people read to decide which device to revoke.
 *
 * A native build later reporting the same value as the web app on the same
 * platform is correct, not a collision -- the column describes the device, not
 * the packaging.
 */
function detectPlatform(): Platform {
  const ua = navigator.userAgent;

  // Before the Mac check, because an iPhone's user agent contains "Mac OS X"
  // and an iPad in desktop mode claims to be a Macintosh outright -- only the
  // touch count gives that one away. Same ordering trap as defaultDeviceName
  // below, and as sync/push.ts.
  if (/iPad|iPhone|iPod/.test(ua)) return "ios";
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return "ios";
  if (/Android/.test(ua)) return "android";

  return "desktop";
}

/**
 * A default name for this browser, used the first time it registers.
 *
 * Only a label -- the server does not parse it and nothing depends on its
 * shape. It exists so a user with three devices can tell them apart.
 */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua)
    ? "Firefox"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  // Phones first, and the order is the whole point. An iPhone's user agent
  // contains "Mac OS X" and an Android's contains "Linux", so testing desktop
  // platforms first labels every phone as a computer -- which is how a live
  // iPhone came to be listed as "Safari on Mac" and an Android as "Chrome on
  // Linux". This name is what somebody reads to tell their devices apart, so
  // being wrong about it defeats the only reason it exists.
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : // An iPad in desktop mode claims to be a Mac and only the touch count
      // gives it away, same trick as sync/push.ts.
      /iPad/.test(ua) ||
        (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  return os ? `${browser} on ${os}` : browser;
}
