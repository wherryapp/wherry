// Is a hub class's content server-readable?
//
// The one question every content-shaped branch about a hub is actually
// asking, and the mirror of the server's own
// (`server/src/services/hub-roles.ts`'s `isServerReadable`).
//
// True for `public` and, since 2026-09-03, for `invite_only`: both store
// protocol v4 rows -- readable, one archive row per message, no envelopes --
// so both take the plaintext send path, the cursor sync in place of an
// inbox drain, search, mention-gated push, and neither has an MLS group.
// False for `private`, whose channels are MLS groups like any group chat.
//
// The question this does NOT answer is "may anyone join?", which is
// `visibility === "public"` and stays spelled out where it is asked. Those
// two varied together while there were two classes; the third is exactly
// where they come apart, and a branch that confuses them either sends MLS
// ciphertext into a room with no group behind it or leaves a readable room
// unable to post.
//
// It lives beside the wire types rather than in `ui/` (where the *wording*
// for each class lives, in ui/hub-class.ts) because sync/engine.ts needs
// it: `ui` imports `sync`, never the other way around, and this predicate
// is a fact about the protocol rather than about the screen.

import type { HubVisibility } from "./types";

export function isServerReadable(
  visibility: HubVisibility | null | undefined,
): boolean {
  // Undefined is a conversation row stored before hubs existed, and every
  // one of those is a sealed direct or group chat -- never readable by
  // default, since guessing wrong here routes plaintext into an E2EE room.
  return visibility === "public" || visibility === "invite_only";
}
