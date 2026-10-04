import { test } from "node:test";
import assert from "node:assert/strict";
import type { Shell } from "../api/shell.js";
import {
  isPhoneShell,
  nativeMediaDefault,
  readNativeMediaPref,
  shouldProbeNativeMedia,
} from "./native-media-rules.js";

const shells: Shell[] = ["web", "desktop", "ios", "android"];

test("only the two phone shells are phones", () => {
  assert.deepEqual(
    shells.filter((shell) => isPhoneShell(shell)),
    ["ios", "android"],
  );
});

test("the engine is on by default everywhere but the phones (M-4: ships dark)", () => {
  assert.equal(nativeMediaDefault("desktop"), true);
  assert.equal(nativeMediaDefault("web"), true);
  assert.equal(nativeMediaDefault("ios"), false);
  assert.equal(nativeMediaDefault("android"), false);
});

test("a desktop keeps a stored choice and defaults on", () => {
  for (const shell of ["desktop", "web"] as const) {
    assert.equal(readNativeMediaPref(shell, {}), true);
    assert.equal(readNativeMediaPref(shell, { nativeMedia: true }), true);
    assert.equal(readNativeMediaPref(shell, { nativeMedia: false }), false);
    // Garbage reads as the default, as every other pref here does.
    assert.equal(readNativeMediaPref(shell, { nativeMedia: "no" }), true);
  }
});

test("a phone is off until the person chose, whatever an earlier save wrote", () => {
  for (const shell of ["ios", "android"] as const) {
    assert.equal(readNativeMediaPref(shell, {}), false);
    // What every phone that ever saved a voice preference carries: the old
    // desktop default written back whole. It is not a choice.
    assert.equal(readNativeMediaPref(shell, { nativeMedia: true }), false);
    assert.equal(readNativeMediaPref(shell, { nativeMedia: true, nativeMediaChosen: false }), false);
    // The choice, made in Settings or by the dev switch.
    assert.equal(readNativeMediaPref(shell, { nativeMedia: true, nativeMediaChosen: true }), true);
    // Chosen off stays off.
    assert.equal(readNativeMediaPref(shell, { nativeMedia: false, nativeMediaChosen: true }), false);
    // A marker with no value is not a yes, and a string is not a boolean.
    assert.equal(readNativeMediaPref(shell, { nativeMediaChosen: true }), false);
    assert.equal(readNativeMediaPref(shell, { nativeMedia: "true", nativeMediaChosen: true }), false);
  }
});

test("a phone build without the engine never asks the shell for it", () => {
  assert.equal(shouldProbeNativeMedia("ios", false), false);
  assert.equal(shouldProbeNativeMedia("android", false), false);
  assert.equal(shouldProbeNativeMedia("ios", true), true);
  // The desktop and the web probe whatever the flag says: the flag is about
  // phone builds.
  assert.equal(shouldProbeNativeMedia("desktop", false), true);
  assert.equal(shouldProbeNativeMedia("web", false), true);
});
