// The hub privacy classes. Run with `pnpm test` from client/. No DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubVisibility } from "../api/types.js";
import { classLabel, classSentence, isServerReadable } from "./hub-class.js";

const ALL: HubVisibility[] = ["private", "public", "invite_only"];

test("readability is about reading, not about the door", () => {
  assert.equal(isServerReadable("public"), true);
  assert.equal(isServerReadable("invite_only"), true);
  assert.equal(isServerReadable("private"), false);
});

test("an absent class is sealed, never readable", () => {
  // A conversation row stored before hubs existed carries no visibility at
  // all, and every one of those is a sealed direct or group chat. Defaulting
  // the other way would route a plaintext send into an E2EE conversation.
  assert.equal(isServerReadable(null), false);
  assert.equal(isServerReadable(undefined), false);
});

test("every class has a label and a sentence", () => {
  for (const visibility of ALL) {
    assert.ok(classLabel(visibility).length > 0);
    assert.ok(classSentence(visibility).length > 20);
  }
});

test("both readable classes say so, and the private one does not", () => {
  // The property that matters, checked as a property rather than by
  // matching the exact prose: a sentence for a readable class has to
  // mention that the server can read it, or the label is a lie.
  for (const visibility of ALL) {
    const mentionsReadable = /readable by the server/.test(classSentence(visibility));
    assert.equal(mentionsReadable, isServerReadable(visibility), visibility);
  }
});

test("invite-only does not read as private", () => {
  // The whole design surface of the third class. "Invite only" alone is what
  // most people would call private, so the sentence has to say the other
  // half -- and say what it is the same as, since the comparison is what
  // stops somebody assuming the encryption.
  const sentence = classSentence("invite_only");
  assert.ok(!/end-to-end/.test(sentence));
  assert.ok(/readable by the server/.test(sentence));
  assert.ok(/the same as a public hub/.test(sentence));
});

test("a sentence never repeats its own label", () => {
  // Every surface draws the label beside the sentence, so a sentence that
  // opens with the class name renders as a stutter ("Invite only / Invite
  // only. Messages are..."), which is what shipped for about an hour on
  // 2026-09-03 before the browser pass caught it.
  for (const visibility of ALL) {
    const label = classLabel(visibility).toLowerCase();
    assert.ok(
      !classSentence(visibility).toLowerCase().startsWith(label),
      visibility,
    );
  }
});
