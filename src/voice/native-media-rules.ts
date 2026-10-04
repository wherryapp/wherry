// Whether the shell's own media engine is wanted, decided from the shell this
// bundle is and what was stored -- the pure half of native-media.ts and
// prefs.ts, in its own file so the tests can pass a shell (the real one is
// baked at build time and reads "web" under node).
//
// Two shapes, one rule each:
//
// - **Desktop** (and the web, where the preference is stored and ignored):
//   on unless the person turned it off. Dark first, then on by decision
//   (2026-09-07), and a stored `false` is a choice that survives.
// - **The phones** (phone-calls-plan.md §8.2, maintainer decision M-4, 2026-09-29):
//   **off until the person turns it on**, and the flip is a later decision
//   after N1's rows. The subtlety is what "turned on" means in storage. This
//   preference has been saved as `true` by every earlier `saveVoicePrefs` on
//   a phone (the desktop default was written back whole), so a stored `true`
//   proves nothing there: it is what a phone that never chose carries. Only a
//   `true` beside `nativeMediaChosen` -- which `saveVoicePrefs` sets whenever
//   it is handed a `nativeMedia` -- counts, so an installed phone does not
//   find the engine switched on by a build that gained it.

import type { Shell } from "../api/shell";

export function isPhoneShell(shell: Shell): boolean {
  return shell === "ios" || shell === "android";
}

/** What a device that has never saved a choice gets. */
export function nativeMediaDefault(shell: Shell): boolean {
  return !isPhoneShell(shell);
}

/** The effective preference, from what localStorage held (already parsed). */
export function readNativeMediaPref(
  shell: Shell,
  stored: { nativeMedia?: unknown; nativeMediaChosen?: unknown },
): boolean {
  if (!isPhoneShell(shell)) return stored.nativeMedia !== false;
  return stored.nativeMedia === true && stored.nativeMediaChosen === true;
}

/**
 * Whether to ask the shell for `voice_probe` at all. Desktop and the web
 * always (the answer is how the engine is found, and on the web it is an
 * immediate no). A phone only when this bundle was built for a shell that
 * carries the engine (`VITE_PHONE_MEDIA=1`, set beside the `phone-media`
 * cargo feature): a phone build without it has no such command, and asking
 * would be a round trip to a rejection on every launch, which is the one
 * thing "never probes" rules out.
 */
export function shouldProbeNativeMedia(shell: Shell, phoneMediaBuild: boolean): boolean {
  return !isPhoneShell(shell) || phoneMediaBuild;
}
