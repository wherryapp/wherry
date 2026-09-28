// The Tauri shell's OS notifications -- the one module that knows the app
// might be running inside the desktop shell at all.
//
// The PWA's push path is guarded and skips in the webview (the service
// worker registers but no push service will deliver to tauri.localhost), so
// without this the desktop app is silent. The shape is Phase 5's roadmap
// line verbatim: "Tauri's notification plugin fed by the socket" -- fed, in
// practice, by the sync engine's post-store moment, which only the leader
// tab runs, so the single-notifier property is inherited rather than built.
//
// Detection is by feature, not user agent -- `isTauriShell` in api/shell.ts,
// which took the helper over when the iOS shell made "am I inside Tauri?"
// about more than desktop notifications. Outside the shell every export
// here is a cheap no-op, and the plugin module is imported dynamically so
// the web bundle never even loads it.

import { isTauriShell } from "../api/shell";

export { isTauriShell };

/**
 * Whether the app window is actually in front of the person.
 *
 * This is the input `shouldNotify` calls `windowFocused`, and the reason a
 * notification is suppressed while somebody is already looking at the app.
 *
 * `document.hasFocus()` alone is not that question on Android. A
 * backgrounded Tauri shell there reports `hasFocus() === true` while
 * `visibilityState` is "hidden" -- measured on Android 16 / WebView 133,
 * 2026-09-03, with a message that arrived, landed in the timeline, and
 * posted no notification because the window claimed to be focused. The
 * shell had therefore never shown one at all.
 *
 * Both halves have to agree, and on every other platform they do: a
 * minimized or occluded desktop window is hidden or unfocused, and a
 * visible-but-unfocused one still notifies, which is the case the focused
 * rule was written for. So this only ever adds notifications, in the one
 * state that should not exist.
 */
export function windowIsFocused(): boolean {
  if (typeof document === "undefined") return false;
  return document.hasFocus() && document.visibilityState === "visible";
}

// The permission answer is sticky per process: asked at most once, and only
// at the moment a notification is actually deserved -- an app requesting
// notification rights before it has ever received a message is the pattern
// people decline.
let permission: "unknown" | "granted" | "denied" = "unknown";

/**
 * Shows "New message from <sender>". The sender's display name only, never
 * message text -- the same who-but-never-what contract the web push payload
 * keeps (services/push.ts), because a lock-screen-class surface never gets
 * plaintext. The empty body is deliberate, not unfinished.
 *
 * Never throws: this runs adjacent to the sync loop, and a throw anywhere
 * near that loop has wedged all tap input before. A notification that fails
 * to show costs a glance at the dock, never the app.
 */
export async function notifyDesktop(senderName: string): Promise<void> {
  if (!isTauriShell()) return;
  try {
    const plugin = await import("@tauri-apps/plugin-notification");

    if (permission !== "granted") {
      if (permission === "denied") return;
      let granted = await plugin.isPermissionGranted();
      if (!granted) {
        granted = (await plugin.requestPermission()) === "granted";
      }
      permission = granted ? "granted" : "denied";
      if (!granted) return;
    }

    plugin.sendNotification({ title: `New message from ${senderName}` });
  } catch {
    // Best effort by contract; see above.
  }
}

/**
 * The notification id a ring's plain notification is posted under, so that
 * it can be taken down when the ring ends (`closeDesktopCall`). Derived from
 * the call id (FNV-1a, kept to 31 bits because the plugin's id is an `i32`),
 * so the page needs no table of what it posted and a second post for the
 * same ring replaces the first. Without one the plugin's Rust side picks a
 * random id (`NotificationData`'s `default_id`) that the page never learns,
 * which is why the ring notification could not be closed before.
 */
export function callNotificationId(callId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < callId.length; i += 1) {
    hash ^= callId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0x7fffffff;
}

/**
 * "Incoming call from <name>" in a shell, for a ring that lands while the
 * window is not focused (phone-rules.ts's `pageRingDuties` decides) -- the
 * same who-but-never-what contract as above. The plugin has no
 * notification actions on desktop; the window is where the call is
 * answered, and the single-instance plugin brings it up.
 *
 * Posted under `callNotificationId(callId)`, and the ring's end must call
 * `closeDesktopCall` with the same call: nothing else takes it down, and on
 * Android it stayed on the shade for 25 minutes after its ring (row A-63).
 */
export function notifyDesktopCall(callerName: string, callId: string): Promise<void> {
  if (!isTauriShell()) return Promise.resolve();
  return inRingOrder(() => postCall(callerName, callId));
}

/**
 * Ring notifications' posts and closes, one after another in the order they
 * were asked for. A post awaits the plugin's import and perhaps the
 * permission prompt, so without this a ring that ends at once would close
 * before its own post landed, and the close before a re-post (the sheet's
 * effect re-runs when the caller's name arrives) could land after it.
 */
let ringOrder: Promise<void> = Promise.resolve();

function inRingOrder(step: () => Promise<void>): Promise<void> {
  ringOrder = ringOrder.then(step, step);
  return ringOrder;
}

async function postCall(callerName: string, callId: string): Promise<void> {
  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    if (permission !== "granted") {
      if (permission === "denied") return;
      let granted = await plugin.isPermissionGranted();
      if (!granted) {
        granted = (await plugin.requestPermission()) === "granted";
      }
      permission = granted ? "granted" : "denied";
      if (!granted) return;
    }
    plugin.sendNotification({
      id: callNotificationId(callId),
      title: `Incoming call from ${callerName}`,
    });
  } catch {
    // Best effort by contract; see above.
  }
}

/**
 * Takes down the ring notification `notifyDesktopCall` posted for this call,
 * when the ring ends however it ends (answered, declined, cancelled, timed
 * out, answered elsewhere): the sheet unmounting is that moment.
 *
 * `removeActive` exists on the phones only. tauri-plugin-notification's
 * desktop half (2.4.0) registers `notify`, `request_permission` and
 * `is_permission_granted` and nothing else, so on the desktop the command
 * is not found and the promise rejects -- absorbed here. There a posted
 * toast or banner cannot be withdrawn through the plugin at all; it goes
 * the way the system's own notifications go. On the phones Tauri hands a
 * command the Rust side lacks to the native plugin (`removeActive`), and the
 * capability's `notification:default` grants `allow-remove-active`. On
 * Android that is `NotificationManager.cancel(id)` (no tag: the plugin
 * posts with none, so the calls plugin's tagged `ring.<callId>` is never
 * touched); on iOS the delivered notification with that identifier goes.
 */
export function closeDesktopCall(callId: string): Promise<void> {
  if (!isTauriShell()) return Promise.resolve();
  return inRingOrder(async () => {
    try {
      const plugin = await import("@tauri-apps/plugin-notification");
      await plugin.removeActive([{ id: callNotificationId(callId) }]);
    } catch {
      // Best effort by contract; see above.
    }
  });
}
