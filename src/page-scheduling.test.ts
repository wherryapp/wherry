import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldKeepPageVisible } from "./page-scheduling.js";

test("a desktop Tauri shell asks to stay scheduled while covered", () => {
  assert.equal(shouldKeepPageVisible({ shell: "desktop", inTauriShell: true }), true);
});

test("a tauri dev shell serving the web bundle still asks", () => {
  // VITE_SHELL is unset under `pnpm tauri dev`, so SHELL reads "web"; the
  // injected API is what says a shell is there.
  assert.equal(shouldKeepPageVisible({ shell: "web", inTauriShell: true }), true);
});

test("the web and the phones do not ask", () => {
  assert.equal(shouldKeepPageVisible({ shell: "web", inTauriShell: false }), false);
  assert.equal(shouldKeepPageVisible({ shell: "desktop", inTauriShell: false }), false);
  assert.equal(shouldKeepPageVisible({ shell: "ios", inTauriShell: true }), false);
  assert.equal(shouldKeepPageVisible({ shell: "android", inTauriShell: true }), false);
});
