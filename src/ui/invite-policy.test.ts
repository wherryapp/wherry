// The invite form's defaults and the listed link's state. Run with
// `pnpm test` from client/. No DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_INVITE_EXPIRY,
  DEFAULT_INVITE_USES,
  INVITE_EXPIRY_CHOICES,
  INVITE_USE_CHOICES,
  choiceIsUnbounded,
  inviteDetail,
  inviteIsUnbounded,
  inviteRequest,
  inviteState,
} from "./invite-policy.js";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const LATER = "2026-11-30T12:00:00.000Z";
const EARLIER = "2026-11-20T12:00:00.000Z";
const day = (iso: string) => iso.slice(0, 10);

test("a new link is bounded by default: 7 days and 10 uses", () => {
  assert.deepEqual(inviteRequest(DEFAULT_INVITE_EXPIRY, DEFAULT_INVITE_USES), {
    expiresInSeconds: 604800,
    maxUses: 10,
  });
  assert.equal(choiceIsUnbounded(DEFAULT_INVITE_EXPIRY, DEFAULT_INVITE_USES), false);
});

test("the defaults are among the choices offered", () => {
  assert.ok(INVITE_EXPIRY_CHOICES.some((c) => c.value === DEFAULT_INVITE_EXPIRY));
  assert.ok(INVITE_USE_CHOICES.some((c) => c.value === DEFAULT_INVITE_USES));
});

test("every bounded choice is inside the server's schema", () => {
  // routes/hubs.ts: expiresInSeconds 60..31536000, maxUses 1..500. A value
  // outside it is a 400 the person cannot fix from the form.
  for (const { value } of INVITE_EXPIRY_CHOICES) {
    const n = Number(value);
    assert.ok(n === 0 || (n >= 60 && n <= 31536000), value);
  }
  for (const { value } of INVITE_USE_CHOICES) {
    const n = Number(value);
    assert.ok(n === 0 || (n >= 1 && n <= 500), value);
  }
});

test("never and unlimited are left out of the body, and flagged", () => {
  assert.deepEqual(inviteRequest("0", "10"), { maxUses: 10 });
  assert.deepEqual(inviteRequest("604800", "0"), { expiresInSeconds: 604800 });
  assert.deepEqual(inviteRequest("0", "0"), {});
  assert.equal(choiceIsUnbounded("0", "10"), true);
  assert.equal(choiceIsUnbounded("604800", "0"), true);
  assert.equal(choiceIsUnbounded("0", "0"), true);
});

test("a link's state mirrors the server's redeem rule", () => {
  const live = { expiresAt: LATER, maxUses: 10, useCount: 3 };
  assert.equal(inviteState(live, NOW), "live");
  assert.equal(inviteState({ ...live, expiresAt: EARLIER }, NOW), "expired");
  // expires_at > now() is what redeems, so the instant itself is dead.
  assert.equal(inviteState({ ...live, expiresAt: new Date(NOW).toISOString() }, NOW), "expired");
  assert.equal(inviteState({ ...live, useCount: 10 }, NOW), "used_up");
  assert.equal(inviteState({ ...live, useCount: 9 }, NOW), "live");
  assert.equal(inviteState({ expiresAt: null, maxUses: null, useCount: 400 }, NOW), "live");
  assert.equal(inviteState({ expiresAt: EARLIER, maxUses: 1, useCount: 1 }, NOW), "expired");
});

test("only a live link with no end is flagged", () => {
  assert.equal(inviteIsUnbounded({ expiresAt: null, maxUses: 10, useCount: 0 }, NOW), true);
  assert.equal(inviteIsUnbounded({ expiresAt: LATER, maxUses: null, useCount: 0 }, NOW), true);
  assert.equal(inviteIsUnbounded({ expiresAt: LATER, maxUses: 10, useCount: 0 }, NOW), false);
  assert.equal(inviteIsUnbounded({ expiresAt: EARLIER, maxUses: null, useCount: 0 }, NOW), false);
});

test("the line under a link says whether it still works", () => {
  assert.equal(
    inviteDetail({ expiresAt: LATER, maxUses: 10, useCount: 3 }, NOW, day),
    "3/10 uses · expires 2026-11-30",
  );
  assert.equal(
    inviteDetail({ expiresAt: EARLIER, maxUses: 10, useCount: 3 }, NOW, day),
    "Expired 2026-11-20 · 3/10 uses",
  );
  assert.equal(
    inviteDetail({ expiresAt: LATER, maxUses: 10, useCount: 10 }, NOW, day),
    "Used up · 10/10 uses",
  );
  assert.equal(
    inviteDetail({ expiresAt: null, maxUses: null, useCount: 1 }, NOW, day),
    "1 join, no use limit · never expires",
  );
});
