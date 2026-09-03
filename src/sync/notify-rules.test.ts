import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldNotify, type NotifyCandidate } from "./notify-rules.ts";

// The eligible baseline every case below perturbs one field of.
const eligible: NotifyCandidate = {
  windowFocused: false,
  isOwn: false,
  decryptFailed: false,
  kind: "renderable",
  muted: false,
  publicChannel: false,
  mentionsSelf: false,
  dnd: false,
};

test("do-not-disturb silences everything, mentions included", () => {
  assert.equal(shouldNotify({ ...eligible, dnd: true }), false);
  assert.equal(
    shouldNotify({ ...eligible, dnd: true, publicChannel: true, mentionsSelf: true }),
    false,
  );
});

test("an unfocused window with a fresh renderable message notifies", () => {
  assert.equal(shouldNotify(eligible), true);
});

test("a focused window silences everything", () => {
  assert.equal(shouldNotify({ ...eligible, windowFocused: true }), false);
  // Even a public-channel mention -- the app itself shows it.
  assert.equal(
    shouldNotify({
      ...eligible,
      windowFocused: true,
      publicChannel: true,
      mentionsSelf: true,
    }),
    false,
  );
});

test("your own message never notifies", () => {
  assert.equal(shouldNotify({ ...eligible, isOwn: true }), false);
});

test("mute means mute", () => {
  assert.equal(shouldNotify({ ...eligible, muted: true }), false);
});

test("operations and unrenderable payloads stay silent", () => {
  assert.equal(shouldNotify({ ...eligible, kind: "op" }), false);
  assert.equal(shouldNotify({ ...eligible, kind: "unsupported" }), false);
  assert.equal(shouldNotify({ ...eligible, decryptFailed: true }), false);
});

test("a public channel notifies only on a mention", () => {
  assert.equal(shouldNotify({ ...eligible, publicChannel: true }), false);
  assert.equal(
    shouldNotify({ ...eligible, publicChannel: true, mentionsSelf: true }),
    true,
  );
});
