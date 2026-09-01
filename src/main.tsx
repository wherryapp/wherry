import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { restoreFromVault } from "./api/session";
import { isTauriShell } from "./api/shell";
import { startStallDetector } from "./diagnostics";
import { registerServiceWorker } from "./pwa";
import { stripReloadMarker } from "./reload";
import { trackVisualViewport } from "./ui/viewport";

// Before the first render, so the shell is sized correctly on the first
// paint rather than jumping once the listeners attach.
trackVisualViewport();

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
  void import("./devtools")
    .then((devtools) => devtools.installDevtools())
    .catch((error: unknown) => console.error("devtools failed", error))
    .then(() => (isTauriShell() ? restoreThenRender() : render()));
} else if (isTauriShell()) {
  void restoreThenRender();
} else {
  render();
}
