// What a hub's privacy class is CALLED, and the honest sentence for it.
//
// The predicate half -- "can the server read this?" -- lives in
// api/hub-class.ts, because sync/engine.ts needs it and `sync` must not
// import from `ui`. It is re-exported here so a component has one import.
//
// This file is the wording, and the wording is the whole design surface of
// the third class. "Invite only" reads to most people as "private", and
// here it must not: an invite-only hub's messages are as readable to the
// server as a public hub's. So each sentence says both halves at once --
// how you get in, and who can read it -- and every surface that shows a
// class shows this one string: creation, the join landing page, and the
// hub's own About section. Three copies of this sentence is how one of
// those three ends up telling somebody the opposite of the truth.

import type { HubVisibility } from "../api/types";
import { isServerReadable } from "../api/hub-class";

export { isServerReadable };

/** The short name of the class, for a pill or a heading. */
export function classLabel(visibility: HubVisibility): string {
  switch (visibility) {
    case "public":
      return "Public";
    case "invite_only":
      return "Invite only";
    case "private":
      return "Private";
  }
}

/**
 * The sentence that goes with the label. Every surface that shows a class
 * shows this one, beneath the label or after it -- never a sentence of its
 * own composition.
 *
 * It deliberately does NOT repeat the class name, because every surface
 * already shows the label right beside it: a radio has the name on the line
 * above, and the hub's About and the join page render "Invite only hub —
 * …". Repeating it produced "Invite only / Invite only. Messages are…",
 * which is how a careful sentence starts reading like a bug.
 *
 * Private says encrypted and says nothing about the server, because there
 * is nothing to say. The two readable classes both say the server can read
 * the messages *and why that buys anything* -- search and moderation are
 * what a readable room is for, and a warning with no upside reads as a
 * defect rather than a choice. Invite-only then names what it is not: the
 * same storage as a public hub, without the open door. That comparison is
 * the load-bearing clause, because "invite only" on its own is exactly
 * what somebody would read as "private".
 */
export function classSentence(visibility: HubVisibility): string {
  switch (visibility) {
    case "public":
      return "Anyone with an account can join. Messages are stored readable by the server, so search and moderation work.";
    case "invite_only":
      return "Only people you send a link to can join, and messages are stored readable by the server so search and moderation can work — the same as a public hub, without the open door.";
    case "private":
      return "Invitation only. Every channel is end-to-end encrypted, like a group chat.";
  }
}

/** The extra half-sentence at creation: none of this can be changed after
 *  the hub exists, and the reason differs by class (a private hub's history
 *  cannot be unsealed without keys the server must never hold; a readable
 *  one's past cannot be un-read). Said once, at the only point where the
 *  choice is still open. */
export const CLASS_IS_PERMANENT = "This cannot be changed later.";
