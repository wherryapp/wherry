// Whether this page asks its shell to keep it scheduled while its window is
// covered -- and the one call that asks.
//
// Measured 2026-09-07 (docs/prompts/native-media-plan.md §5.1, gate 2):
// WebKit on macOS 26 runs the desktop shell's page in a process it may
// **suspend** -- no timers, no JavaScript at all -- once the view is not
// visible and nothing else holds it up, and a window fully behind another
// window is not visible. A window that launches covered is suspended about
// eight seconds in; one that was seen first gets a grace of minutes at
// background priority. Two things in this app depend on the page running
// while nobody is looking at it: the sync engine (its poll, its socket
// handling, the notification decision) and, under the native audio engine,
// a call's two-second epoch poll -- the webview engine plays the call's
// audio in the page, and audible playback is one of the three things WebKit
// treats as foreground, which is why it never showed this.
//
// The shell's mechanism is WKWebView's window-occlusion detection
// (src-tauri/src/lib.rs, "Keeping the page scheduled"): off, a covered
// window still counts as visible and the process keeps its foreground
// assertion. This file holds the decision, as the shell's rule requires:
// the desktop shell asks for it for its whole life, because a messenger
// that stops syncing when its window is behind another one is broken in a
// way no power saving pays for. The phones do not ask -- a phone's webview
// is not covered by other windows -- and the web has no shell to ask.
//
// "Desktop shell" is feature-detected, not read from the build: the shell
// injects `__TAURI_INTERNALS__` (isTauriShell), and the phones say what
// they are through VITE_SHELL. A `tauri dev` desktop shell serves the plain
// web bundle, where VITE_SHELL is unset and SHELL reads "web" -- deciding
// on SHELL alone left that shell (every measurement shell) undecided, which
// is how the first version of this file shipped a decision nothing took.
//
// What it changes for the rest of the client: while the window is covered
// (not minimized, not hidden) `document.visibilityState` now reads
// "visible". Every reader was checked (2026-09-07): `windowIsFocused()`
// also requires focus, so a covered window still notifies; the socket's
// reconnect-on-visible fires less, which is harmless; the timeline's
// observers now run while covered, which is the behaviour they wanted.

import { isTauriShell, SHELL, type Shell } from "./api/shell";

/**
 * The decision, pure: a Tauri shell that is not a phone keeps its page
 * scheduled when covered.
 */
export function shouldKeepPageVisible(input: { shell: Shell; inTauriShell: boolean }): boolean {
  if (!input.inTauriShell) return false;
  return input.shell !== "ios" && input.shell !== "android";
}

/**
 * Ask the shell, once, at boot. Resolves to whether the shell agreed --
 * false outside a Tauri shell, on a shell without the command, or on a
 * platform where it is a no-op (the command answers Ok there, but only
 * macOS suspends a covered page).
 */
export async function keepPageScheduled(): Promise<boolean> {
  if (!shouldKeepPageVisible({ shell: SHELL, inTauriShell: isTauriShell() })) return false;
  try {
    const core = await import("@tauri-apps/api/core");
    await core.invoke<void>("shell_keep_page_visible", { enabled: true });
    return true;
  } catch (error) {
    console.warn("shell_keep_page_visible refused", error);
    return false;
  }
}
