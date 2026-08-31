// What a device with no group state decides to do about it.
//
// planJoin is three conditions, and getting them wrong does not throw --
// it strands a device outside a group it is entitled to, with every send
// parked as pendingEncryption and no error anywhere. That is what the
// first cut of external joins did to brand-new conversations, and it is
// what these cases exist to stop happening twice.
//
// Run with `pnpm test` from client/. No database, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CREATION_GRACE_MS, planJoin } from "./join-plan.ts";

const ME = "01a058ac-0000-7000-8000-000000000001";
const OTHER = "01a05352-0000-7000-8000-000000000002";
const LATER = "01a059ff-0000-7000-8000-000000000003";

/** Defaults for the cases where the creation grace is not what is under test. */
const FRESH = { msWaitingForCreation: 0, hasPendingSend: false };

test("a brand-new group with GroupInfo at epoch 0 is externally joinable", () => {
  // The regression. A conversation created moments ago has no commits, so
  // the server's epoch is 0 -- but its creator published GroupInfo, so
  // there is a real group to join. Gating the join on `serverEpoch > 0`
  // sent every other member device to "wait" and left the creator, which
  // might be a closed browser tab, as the only thing that could ever
  // unblock them.
  assert.deepEqual(
    planJoin({
      ...FRESH,
      serverEpoch: 0,
      groupInfoEpoch: 0,
      myDeviceId: ME,
      memberDeviceIds: [OTHER, ME, LATER],
    }),
    { action: "external-join", epoch: 0 },
  );
});

test("a committed group with current GroupInfo is externally joinable", () => {
  assert.deepEqual(
    planJoin({
      ...FRESH,
      serverEpoch: 9,
      groupInfoEpoch: 9,
      myDeviceId: ME,
      memberDeviceIds: [OTHER, ME],
    }),
    { action: "external-join", epoch: 9 },
  );
});

test("stale GroupInfo falls back to waiting for a welcome", () => {
  // Joining on a stale GroupInfo can only build a commit that loses the
  // epoch race, so it is not worth the round trip.
  assert.deepEqual(
    planJoin({
      ...FRESH,
      serverEpoch: 9,
      groupInfoEpoch: 7,
      myDeviceId: ME,
      memberDeviceIds: [OTHER, ME],
    }),
    { action: "wait" },
  );
});

test("a committed group with no GroupInfo at all falls back to waiting", () => {
  // The pre-feature world: a committer on an older build. Nothing to join
  // against, so the welcome path stands -- and no creation grace applies,
  // because the group exists and creating a second one would fork it.
  assert.deepEqual(
    planJoin({
      serverEpoch: 4,
      groupInfoEpoch: null,
      myDeviceId: ME,
      memberDeviceIds: [OTHER, ME],
      msWaitingForCreation: CREATION_GRACE_MS * 10,
      hasPendingSend: false,
    }),
    { action: "wait" },
  );
});

test("with no group at all, the smallest device id creates and the rest defer", () => {
  const memberDeviceIds = [LATER, OTHER, ME];

  assert.deepEqual(
    planJoin({
      ...FRESH,
      serverEpoch: 0,
      groupInfoEpoch: null,
      myDeviceId: OTHER, // sorts first
      memberDeviceIds,
    }),
    { action: "create" },
  );

  assert.deepEqual(
    planJoin({
      ...FRESH,
      serverEpoch: 0,
      groupInfoEpoch: null,
      myDeviceId: ME,
      memberDeviceIds,
    }),
    { action: "wait" },
  );

  // Exactly one creator up front, whatever order the roster arrives in.
  const plans = memberDeviceIds.map((deviceId) =>
    planJoin({
      ...FRESH,
      serverEpoch: 0,
      groupInfoEpoch: null,
      myDeviceId: deviceId,
      memberDeviceIds: [...memberDeviceIds].reverse(),
    }),
  );
  assert.equal(plans.filter((plan) => plan.action === "create").length, 1);
});

test("the creation grace expires so a dormant nominee cannot deadlock a conversation", () => {
  // The report: a brand-new hub whose smallest device id belongs to an old
  // browser profile that is never opened. Every other device deferred
  // forever and every send parked as pendingEncryption with no error.
  const args = {
    serverEpoch: 0,
    groupInfoEpoch: null,
    myDeviceId: ME,
    memberDeviceIds: [OTHER, ME, LATER], // OTHER sorts first, and is asleep
    hasPendingSend: false,
  };

  assert.deepEqual(
    planJoin({ ...args, msWaitingForCreation: CREATION_GRACE_MS - 1 }),
    { action: "wait" },
  );
  assert.deepEqual(
    planJoin({ ...args, msWaitingForCreation: CREATION_GRACE_MS }),
    { action: "create" },
  );
});

test("a queued message creates the group now rather than serving out the grace", () => {
  // The reported experience: make a hub, type immediately, watch it say
  // "sending" for a full minute. Deferring is a background courtesy; once a
  // person is waiting on their own message it stops being one.
  assert.deepEqual(
    planJoin({
      serverEpoch: 0,
      groupInfoEpoch: null,
      myDeviceId: ME,
      memberDeviceIds: [OTHER, ME], // OTHER sorts first
      msWaitingForCreation: 0,
      hasPendingSend: true,
    }),
    { action: "create" },
  );
});

test("a queued message still never duplicates a group that exists", () => {
  // Urgency changes when this device creates, never whether it should.
  assert.deepEqual(
    planJoin({
      serverEpoch: 3,
      groupInfoEpoch: 3,
      myDeviceId: ME,
      memberDeviceIds: [OTHER, ME],
      msWaitingForCreation: 0,
      hasPendingSend: true,
    }),
    { action: "external-join", epoch: 3 },
  );

  // ...and with a group that exists but no usable GroupInfo, a pending send
  // must not tempt this device into forking it.
  assert.deepEqual(
    planJoin({
      serverEpoch: 3,
      groupInfoEpoch: null,
      myDeviceId: ME,
      memberDeviceIds: [OTHER, ME],
      msWaitingForCreation: CREATION_GRACE_MS * 10,
      hasPendingSend: true,
    }),
    { action: "wait" },
  );
});

test("the grace never overrides a group that does exist", () => {
  // Whatever the clock says, an existing joinable group is joined, never
  // duplicated -- creating a second group here would fork the conversation.
  assert.deepEqual(
    planJoin({
      serverEpoch: 0,
      groupInfoEpoch: 0,
      myDeviceId: ME,
      memberDeviceIds: [OTHER, ME],
      msWaitingForCreation: CREATION_GRACE_MS * 10,
      hasPendingSend: false,
    }),
    { action: "external-join", epoch: 0 },
  );
});

test("a sole device with no group creates it immediately", () => {
  assert.deepEqual(
    planJoin({
      ...FRESH,
      serverEpoch: 0,
      groupInfoEpoch: null,
      myDeviceId: ME,
      memberDeviceIds: [ME],
    }),
    { action: "create" },
  );
});
