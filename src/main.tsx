import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { trackVisualViewport } from "./ui/viewport";

// Before the first render, so the shell is sized correctly on the first
// paint rather than jumping once the listeners attach.
trackVisualViewport();

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
