// Which packaging this build is running in, and where its updates come from.
//
// base.ts owns "where the server lives"; this file owns the sibling
// question the version-floor decision (docs/roadmap.md, 2026-09-01) said
// must not be sniffed at the call site: "where do I send somebody to
// update?". The answer differs per shell -- the web reloads, the desktop
// app points at a release, a store build points at its listing -- and a
// hard-stop wall shown precisely because the app is too old is the worst
// possible place to be deriving it from user agents.
//
// Two different notions of "shell" on purpose:
//
//   SHELL          -- baked at build time (VITE_SHELL, set by the build:*
//                     scripts' env files). Says what this *bundle* is: a
//                     web build served by Caddy, or assets bundled into the
//                     desktop/iOS/Android Tauri app. This is what update
//                     routing needs, because it is the bundle that goes
//                     stale.
//   isTauriShell() -- detected at runtime by the API Tauri injects. Says
//                     what the *process* is, and stays correct even for a
//                     bundle built without VITE_SHELL. This is what
//                     capability guards need (keychain vault, OS
//                     notifications, "don't tell people to add a native
//                     app to their home screen").
//
// The two agree in every build produced by the scripts; the split survives
// the builds that predate VITE_SHELL, where SHELL reads "web" inside the
// desktop app.

export type Shell = "web" | "desktop" | "ios" | "android";

const known: readonly Shell[] = ["web", "desktop", "ios", "android"];

function readShell(): Shell {
  // `?.` for the same reason as base.ts: tsx-run tests have no Vite.
  const raw = import.meta.env?.VITE_SHELL;
  return known.includes(raw as Shell) ? (raw as Shell) : "web";
}

/** What this bundle was built to be. */
export const SHELL: Shell = readShell();

/**
 * True inside any Tauri shell (desktop or mobile). Feature detection, not
 * user agent: `__TAURI_INTERNALS__` exists exactly when the shell injected
 * its API. Moved here from sync/desktop-notify.ts when the iOS shell made
 * it about more than desktop notifications.
 */
export function isTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Where a stale build gets its replacement.
 *
 * "reload" means the same origin serves current assets and a navigation is
 * the whole update -- the web case, handled by reload.ts's cache-defeating
 * URL. "external" means the bundle is baked into an installed app and no
 * reload can freshen it; the href is where the new build lives.
 */
export type UpdateDestination =
  | { kind: "reload" }
  | { kind: "external"; href: string; label: string };

// Where the desktop and sideloaded-iOS builds update from: release.yml
// builds installers for every tag. When an App Store listing exists, the
// ios arm below changes to `https://apps.apple.com/app/id<...>` and nothing
// else moves -- that one-line swap being confined to this file is the
// reason it exists.
const RELEASES_URL = "https://github.com/ctarabocchia/messenger/releases/latest";

export function updateDestination(): UpdateDestination {
  switch (SHELL) {
    case "web":
      return { kind: "reload" };
    case "desktop":
      return { kind: "external", href: RELEASES_URL, label: "Get the update" };
    case "ios":
    case "android":
      // No store listing yet: point at releases, where the built app came
      // from. Swap for the store URL with the first accepted submission.
      return { kind: "external", href: RELEASES_URL, label: "Get the update" };
  }
}

/**
 * Opens a URL outside the app. In a Tauri shell an `<a href>` would
 * navigate the webview itself away from the bundled app -- the opposite of
 * an escape hatch -- so the opener plugin hands the URL to the system
 * browser instead. Outside the shell this is not called: the web app keeps
 * real anchors, per the escape-hatch-is-a-link rule (CLAUDE.md), and this
 * function throws rather than half-working to keep that honest.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isTauriShell()) {
    throw new Error("openExternal is for Tauri shells; use an anchor");
  }
  const opener = await import("@tauri-apps/plugin-opener");
  await opener.openUrl(url);
}
