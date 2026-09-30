// The words for a hub audit line (hub_events), shown in HubDetails' "Recent
// activity". Pure, so the kinds a newer server adds are pinned by a test
// rather than found missing by reading the panel.

import type { HubEvent } from "../api/types";

/**
 * One line of text for a hub event, or "" for a kind this build does not
 * know -- the caller drops empty lines, so a newer server's kind is left out
 * rather than guessed at. The list mirrors server/src/services/hubs.ts's
 * HubEventKind.
 */
export function hubEventText(event: HubEvent, selfUserId: string): string {
  const actor =
    event.actorUserId === selfUserId
      ? "You"
      : event.actorDisplayName || event.actorUsername;
  const targetIsSelf = event.targetUserId === selfUserId;
  const targetName = (event.targetDisplayName || event.targetUsername) ?? "someone";
  const target = targetIsSelf ? "you" : targetName;
  const targets = targetIsSelf ? "your" : `${targetName}'s`;

  switch (event.kind) {
    case "member_added":
      return event.actorUserId === event.targetUserId
        ? `${actor} joined`
        : event.historyShared
          ? `${actor} added ${target}, with earlier messages shared`
          : `${actor} added ${target}`;
    case "member_removed":
      return event.actorUserId === event.targetUserId
        ? `${actor} left`
        : `${actor} removed ${target}`;
    case "member_banned":
      return `${actor} banned ${target}`;
    case "member_unbanned":
      return `${actor} unbanned ${target}`;
    case "role_changed":
      return `${actor} made ${target} ${event.title ?? "a member"}`;
    case "renamed":
      return `${actor} named the hub "${event.title ?? ""}"`;
    case "avatar_changed":
      return `${actor} changed the hub picture`;
    case "channel_moved":
      return `${actor} moved #${event.title ?? "a channel"} to a category`;
    case "category_created":
      return `${actor} created the category "${event.title ?? ""}"`;
    case "category_renamed":
      return `${actor} renamed a category to "${event.title ?? ""}"`;
    case "category_deleted":
      return `${actor} deleted the category "${event.title ?? ""}"`;
    case "channel_created":
      return `${actor} created #${event.title ?? "a channel"}`;
    case "channel_renamed":
      return `${actor} renamed a channel to #${event.title ?? ""}`;
    case "channel_topic":
      return event.title
        ? `${actor} set a channel topic`
        : `${actor} cleared a channel topic`;
    case "channel_posting":
      return event.title === "moderators"
        ? `${actor} made a channel announcement-only`
        : `${actor} opened a channel to everyone`;
    case "channel_slowmode":
      return event.title
        ? `${actor} set slowmode to ${event.title}s`
        : `${actor} turned slowmode off`;
    case "message_deleted":
      return `${actor} removed a message`;
    case "message_pinned":
      return `${actor} pinned a message`;
    case "message_unpinned":
      return `${actor} unpinned a message`;
    case "invite_created":
      return `${actor} created an invite link`;
    case "invite_revoked":
      return `${actor} revoked an invite link`;
    case "channel_join_muted":
      // The title is the threshold as a string, or null when cleared; the
      // same words VoiceRoom uses for the rule itself.
      return event.title === null
        ? `${actor} stopped a voice channel muting people who join`
        : event.title === "0"
          ? `${actor} set a voice channel so everyone joins muted`
          : `${actor} set a voice channel to mute people who join once more than ${event.title} are in`;
    case "voice_muted":
      return `${actor} muted ${target} in a voice channel`;
    case "voice_disconnected":
      return `${actor} disconnected ${target} from a voice channel`;
    case "video_stopped":
      return `${actor} stopped ${targets} camera or screen share`;
    case "video_cap_changed":
      return `${actor} changed the hub's video limit`;
    default:
      // A kind from a newer server: render nothing rather than guess.
      return "";
  }
}
