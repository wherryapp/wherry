// Pure display-formatting helpers shared by the sidebar and the thread
// header -- conversation data in, a string out, nothing stateful.

import type { StoredConversation } from "../store/types";

function conversationTitle(
  conversation: StoredConversation,
  selfUserId: string,
): string {
  if (conversation.title) return conversation.title;
  const others = conversation.members.filter((m) => m.userId !== selfUserId);
  if (others.length === 0) return "You";
  return others.map((m) => m.displayName || m.username).join(", ");
}

/** A member's display name, for attribution in groups. */
function memberName(conversation: StoredConversation, userId: string): string {
  const member = conversation.members.find((m) => m.userId === userId);
  return member ? member.displayName || member.username : "Someone";
}

/**
 * A conversation-list timestamp: the time today, the weekday within a week,
 * a date beyond that. The list answers "how stale is this thread" at a
 * glance; the exact minute of last Tuesday answers nothing.
 */
function listTime(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  if (then.toDateString() === now.toDateString()) {
    return then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (now.getTime() - then.getTime() < 6 * 86_400_000) {
    return then.toLocaleDateString([], { weekday: "short" });
  }
  return then.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

/**
 * Who a conversation's avatar depicts: the other person in a 1:1, the group
 * itself otherwise. The id doubles as the colour seed (see kit's Avatar),
 * so a group keeps one identity even as its title changes.
 */
function avatarSeed(
  conversation: StoredConversation,
  selfUserId: string,
): string {
  const others = conversation.members.filter((m) => m.userId !== selfUserId);
  // Direct only -- a two-person hub channel is still the channel, not the
  // other person, so it keeps its own identity like a group does.
  if (conversation.kind === "direct" && others.length === 1) {
    return others[0]!.userId;
  }
  return conversation.id;
}

/**
 * The chosen hue for the person avatarSeed resolved to, or null when the
 * avatar depicts the group/channel itself -- those stay id-derived, since a
 * room is nobody's colour to pick. The same 1:1 test as avatarSeed, so the
 * two answer about the same person.
 */
function avatarHue(
  conversation: StoredConversation,
  selfUserId: string,
): number | null {
  const others = conversation.members.filter((m) => m.userId !== selfUserId);
  if (conversation.kind === "direct" && others.length === 1) {
    return others[0]!.avatarHue ?? null;
  }
  return null;
}

export { conversationTitle, memberName, listTime, avatarSeed, avatarHue };
