// This device's notification preferences: today one switch, "Names in
// notifications" (docs/prompts/notification-names-plan.md §1.5), default on.
//
// localStorage rather than the server or the store's meta table: it is a
// per-device choice, read synchronously when the page computes the label
// maps, and never synced -- the same reasoning as voice/prefs.ts. The parse
// is native-push-rules.ts's `parseNotificationPrefs`, where it is tested.
//
// Deliberately NOT sync/native-push.ts: that module is loaded only in a phone
// shell (row W-107), and this one is read by voice/phone-bridge.ts, which
// every page loads. It imports nothing but the rules.

import {
  NOTIFICATION_PREFS_KEY,
  parseNotificationPrefs,
  type NotificationPrefs,
} from "./native-push-rules";

export function loadNotificationPrefs(): NotificationPrefs {
  try {
    return parseNotificationPrefs(localStorage.getItem(NOTIFICATION_PREFS_KEY));
  } catch {
    return parseNotificationPrefs(null);
  }
}

const listeners = new Set<() => void>();

export function saveNotificationPrefs(patch: Partial<NotificationPrefs>): NotificationPrefs {
  const next = { ...loadNotificationPrefs(), ...patch };
  try {
    localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the choice cannot be kept, and the default (names
    // on) stands; the Settings box then springs back, which is honest.
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener's problem is its own.
    }
  }
  return next;
}

/** For the phone bridge (re-send the labels) and useSyncExternalStore. */
export function subscribeNotificationPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
