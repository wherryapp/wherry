// Pins the unread divider's boundary rules against store.countUnread's:
// exclusive lower bound on the marker, own messages never counted, and
// nothing but real messages on either side. The badge and the divider name
// the same number or one of them is lying.
//
// Run with `pnpm test` from client/. No database, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { unreadBoundary } from "./unread.ts";
import type { TimelineItem } from "./hooks.ts";

const ME = "user-self";
const THEM = "user-other";

/** A sent item, cut down to the two fields the boundary actually reads. */
function sent(messageId: string, senderUserId: string): TimelineItem {
  return {
    kind: "sent",
    message: {
      messageId,
      conversationId: "c1",
      senderUserId,
      senderDeviceId: "d1",
      protocolVersion: 2,
      payload: new Uint8Array(),
      sentAt: "2026-08-31T12:00:00.000Z",
    },
    content: { text: "hi", attachments: [] },
    marks: null,
  };
}

/** A notice line -- never a boundary, never counted. */
function event(id: string): TimelineItem {
  return {
    kind: "event",
    event: {
      id,
      conversationId: "c1",
      kind: "member_added",
      actorUserId: THEM,
      actorUsername: "them",
      actorDisplayName: "Them",
      targetUserId: ME,
      targetUsername: "self",
      targetDisplayName: "Self",
      title: null,
      historyShared: false,
    callId: null,
    call: null,
      createdAt: "2026-08-31T12:00:00.000Z",
    },
  };
}

/** An unsent outbox entry -- no server id, so it cannot bound anything. */
function pending(clientMessageId: string): TimelineItem {
  return {
    kind: "pending",
    entry: {
      clientMessageId,
      protocolVersion: 2,
      payload: new Uint8Array(),
      conversationId: "c1",
      content: new Uint8Array(),
      createdAt: "2026-08-31T12:00:00.000Z",
      attempts: 0,
    },
    content: { text: "typing", attachments: [] },
  };
}

test("no marker: everything from others is unread, oldest anchors", () => {
  const items = [sent("m1", THEM), sent("m2", THEM), sent("m3", THEM)];
  assert.deepEqual(unreadBoundary(items, null, ME), {
    firstUnreadId: "m1",
    count: 3,
  });
});

test("the marked message itself is read -- the bound is exclusive", () => {
  const items = [sent("m1", THEM), sent("m2", THEM), sent("m3", THEM)];
  assert.deepEqual(unreadBoundary(items, "m2", ME), {
    firstUnreadId: "m3",
    count: 1,
  });
});

test("your own messages anchor nothing and count nothing", () => {
  const items = [
    sent("m1", THEM),
    sent("m2", ME),
    sent("m3", ME),
    sent("m4", THEM),
    sent("m5", ME),
  ];
  assert.deepEqual(unreadBoundary(items, "m1", ME), {
    firstUnreadId: "m4",
    count: 1,
  });
});

test("everything read: no divider", () => {
  const items = [sent("m1", THEM), sent("m2", THEM)];
  assert.equal(unreadBoundary(items, "m2", ME), null);
});

test("no marker but only your own messages: still no divider", () => {
  const items = [sent("m1", ME), sent("m2", ME)];
  assert.equal(unreadBoundary(items, null, ME), null);
});

test("notices and unsent entries are ignored on both sides", () => {
  const items = [
    event("e1"),
    sent("m1", THEM),
    event("e2"),
    sent("m2", THEM),
    pending("out-1"),
  ];
  assert.deepEqual(unreadBoundary(items, "m1", ME), {
    firstUnreadId: "m2",
    count: 1,
  });
  // ...and with nothing read, the first *message* anchors, not the notice
  // that sorts above it.
  assert.deepEqual(unreadBoundary(items, null, ME), {
    firstUnreadId: "m1",
    count: 2,
  });
});

test("an empty timeline has no boundary", () => {
  assert.equal(unreadBoundary([], null, ME), null);
});
