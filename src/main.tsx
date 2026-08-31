import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { registerServiceWorker } from "./pwa";
import { trackVisualViewport } from "./ui/viewport";

// Before the first render, so the shell is sized correctly on the first
// paint rather than jumping once the listeners attach.
trackVisualViewport();

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
if (import.meta.env.DEV) {
  void import("./devtools")
    .then((devtools) => devtools.installDevtools())
    .catch((error: unknown) => console.error("devtools failed", error))
    .then(render);
} else {
  render();
}
