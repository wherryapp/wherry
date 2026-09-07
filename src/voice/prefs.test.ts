import { test } from "node:test";
import assert from "node:assert/strict";
import { loadVoicePrefs } from "./prefs.js";

// No localStorage under node: loadVoicePrefs falls through to its defaults,
// which is exactly the reading a fresh device gets.
test("a fresh device runs calls through the shell's own engine where one exists", () => {
  assert.equal(loadVoicePrefs().nativeMedia, true);
});
