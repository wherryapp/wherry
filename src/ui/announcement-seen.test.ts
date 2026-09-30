import assert from "node:assert/strict";
import { test } from "node:test";

import { markSeenTarget } from "./announcement-seen";

const OLDER = "0192a000-0000-7000-8000-000000000001";
const NEWER = "0192a000-0000-7000-8000-000000000002";

test("no announcements: nothing to mark", () => {
  assert.equal(markSeenTarget(undefined, null), null);
  assert.equal(markSeenTarget(undefined, OLDER), null);
});

test("never seen: the newest is marked", () => {
  assert.equal(markSeenTarget(NEWER, null), NEWER);
});

test("a newer announcement than the mark: marked", () => {
  assert.equal(markSeenTarget(NEWER, OLDER), NEWER);
});

test("already seen: nothing written, which is what ends the loop", () => {
  assert.equal(markSeenTarget(NEWER, NEWER), null);
});

test("a mark ahead of the list is never moved backwards", () => {
  assert.equal(markSeenTarget(OLDER, NEWER), null);
});
