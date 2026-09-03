import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { restoreFromVault } from "./api/session";
import { isTauriShell } from "./api/shell";
import { startStallDetector } from "./diagnostics";
import { registerServiceWorker } from "./pwa";
import { stripReloadMarker } from "./reload";
import { guardStrayFileDrops } from "./ui/drop-guard";
import { trackVisualViewport } from "./ui/viewport";
import { lockPageZoom } from "./ui/zoom";
import { restoreTextScale } from "./ui/text-scale";
import { startIdleTracking } from "./sync/idle";

// Before the first render, so the shell is sized correctly on the first
// paint rather than jumping once the listeners attach.
trackVisualViewport();

// Beside it, and for the same reason it is a startup call rather than a
// component effect: the gesture it cancels is available from the first frame,
// and a lock that attaches after the tree mounts is a lock with a gap in it.
lockPageZoom();

// The other half of turning page pinch-zoom off (2026-09-03): the chosen
// text size, on the document before the first paint. A component effect
// would repaint the whole app one frame in, which on a phone reads as the
// UI resizing itself every time it is opened. See ui/text-scale.ts.
restoreTextScale();

// Idle detection starts with the page too: the five-minute clock it keeps
// has to begin at the first input, not at the first render of some panel.
startIdleTracking();

// And beside that one again: dropping a file anywhere the composer is not
// listening would otherwise navigate the app away to that file, which in an
// installed shell means the app is gone until it is restarted. See
// drop-guard.ts -- it is also what lets the composer receive a drop at all.
guardStrayFileDrops();

// The update banner's reload navigates to a throwaway parameter to defeat the
// page cache; this is the other half, putting the address bar back. Safe to
// call unconditionally -- it returns immediately when the marker is absent,
// which is every ordinary load. See reload.ts.
stripReloadMarker();

// Before anything heavy runs, so the first pass after sign-in -- the one
// the iPhone freeze reports point at -- is measured like any other. See
// diagnostics.ts for what it is trying to settle.
startStallDetector();

// Not awaited: nothing on screen depends on it, and notifications are the
// only thing that does.
void registerServiceWorker();

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

function render(): void {
  createRoot(root!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Dev-only diagnostics (crypto tracing, dev auto-login), loaded before the
// first render so a traced sign-in captures everything from the first
// crypto call. The guarded dynamic import means production bundles contain
// none of it. See devtools.ts.
/**
 * In the Tauri shells, ask the OS keychain for anything the webview's
 * storage lost to eviction *before* the first render -- loadSession is
 * synchronous and App decides login-versus-chat on the first frame, so a
 * restore after render would flash the login screen at a person who never
 * signed out. One awaited hop, only in the shells; the web renders exactly
 * as before. Failure falls through to rendering: the vault is best-effort
 * everywhere, and a broken keychain must read as "storage really is
 * empty", never as a hang on a blank page.
 */
async function restoreThenRender(): Promise<void> {
  try {
    await restoreFromVault();
  } catch {
    // As above: proceed as if there were nothing to restore.
  }
  render();
}

if (import.meta.env.DEV) {
  // The shells hand devtools the vault restore to run first: the dev
  // auto-login and auto-call read the session, and in a shell it may only
  // exist in the keychain until restored.
  const restore = isTauriShell() ? restoreFromVault : null;
  void import("./devtools")
    .then((devtools) => devtools.installDevtools(restore))
    .catch(async (error: unknown) => {
      console.error("devtools failed", error);
      // Never lose the restore to a broken dev instrument.
      if (restore) await restore().catch(() => {});
    })
    .then(render);
} else if (isTauriShell()) {
  void restoreThenRender();
} else {
  render();
}
