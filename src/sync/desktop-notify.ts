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
 * "Incoming call from <name>" in the desktop shell, for a ring that lands
 * while the window is not focused -- the same who-but-never-what contract
 * as above. The plugin has no notification actions on desktop; the
 * window is where the call is answered, and the single-instance plugin
 * brings it up.
 */
export async function notifyDesktopCall(callerName: string): Promise<void> {
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
    plugin.sendNotification({ title: `Incoming call from ${callerName}` });
  } catch {
    // Best effort by contract; see above.
  }
}
