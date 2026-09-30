// Hub audit lines. Run with `pnpm test` from client/. No DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubEvent } from "../api/types.ts";
import { hubEventText } from "./hub-events.ts";

const SELF = "self-id";

function event(kind: string, extra: Partial<HubEvent> = {}): HubEvent {
  return {
    id: "e1",
    hubId: "h1",
    kind,
    actorUserId: "mod-id",
    actorUsername: "mod",
    actorDisplayName: "Mod",
    targetUserId: "someone-id",
    targetUsername: "sam",
    targetDisplayName: "Sam",
    title: null,
    messageId: null,
    historyShared: false,
    createdAt: "2026-09-29T00:00:00Z",
    ...extra,
  };
}

test("the voice and video moderation kinds the server writes have words", () => {
  // Every kind server/src/services/hubs.ts's HubEventKind lists after the
  // original set; each rendered "" (and so vanished) before this.
  for (const kind of [
    "channel_join_muted",
    "voice_muted",
    "voice_disconnected",
    "video_stopped",
    "video_cap_changed",
  ]) {
    assert.notEqual(hubEventText(event(kind), SELF), "", kind);
  }
});

test("moderation lines name the target, and say you and your for self", () => {
  assert.equal(
    hubEventText(event("voice_muted"), SELF),
    "Mod muted Sam in a voice channel",
  );
  assert.equal(
    hubEventText(event("video_stopped"), SELF),
    "Mod stopped Sam's camera or screen share",
  );
  assert.equal(
    hubEventText(event("video_stopped", { targetUserId: SELF }), SELF),
    "Mod stopped your camera or screen share",
  );
  assert.equal(
    hubEventText(event("voice_disconnected", { actorUserId: SELF }), SELF),
    "You disconnected Sam from a voice channel",
  );
});

test("the join-mute line reads its threshold from the title", () => {
  assert.match(
    hubEventText(event("channel_join_muted", { title: "5" }), SELF),
    /once more than 5 are in$/,
  );
  assert.match(
    hubEventText(event("channel_join_muted", { title: "0" }), SELF),
    /everyone joins muted$/,
  );
  assert.match(
    hubEventText(event("channel_join_muted", { title: null }), SELF),
    /^Mod stopped a voice channel muting/,
  );
});

test("a kind from a newer server renders nothing rather than a guess", () => {
  assert.equal(hubEventText(event("something_new"), SELF), "");
});
