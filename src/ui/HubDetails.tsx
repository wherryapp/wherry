// The hub panel: members, roles, channels, search, and the audit line.
//
// Same full-screen Panel shape as Friends, Settings and GroupDetails. The
// permission checks here are a MIRROR of the server's pure matrix
// (server/src/services/hub-roles.ts) for showing and hiding controls -- the
// server enforces for real, so a stale mirror costs a 403, never a breach.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ApiError,
  addHubMembers,
  createHubChannel,
  createHubInvite,
  deleteHub,
  fetchFriends,
  fetchHub,
  fetchHubEvents,
  fetchHubInvites,
  kickHubMember,
  leaveHub,
  lookupUser,
  muteConversation,
  renameHub,
  revokeHubInvite,
  searchHub,
  setHubRole,
  unbanHubMember,
  unmuteConversation,
  updateHubChannel,
  type Friend,
} from "../api/client";
import type {
  HubChannel,
  HubDetail,
  HubEvent,
  HubInvite,
  HubRole,
  HubSearchResult,
} from "../api/types";
import { webOrigin } from "../api/base";
import { sync } from "../sync/engine";
import { mlsEnabled, mlsSync } from "../sync/mls";
import { useConversations } from "./hooks";
import {
  Avatar,
  Button,
  ErrorText,
  Input,
  LockIcon,
  Note,
  Panel,
  PanelSection,
  PencilIcon,
  useConfirm,
} from "./kit";
import { ContactCheckboxRow } from "./ContactRow";

// Mirrors hub-roles.ts on the server; see the file comment above.
const RANK: Record<HubRole, number> = { owner: 3, moderator: 2, member: 1 };
const manages = (role: HubRole): boolean => RANK[role] >= RANK.moderator;
const outranks = (actor: HubRole, target: HubRole): boolean =>
  RANK[actor] > RANK[target];

const ROLE_LABEL: Record<HubRole, string> = {
  owner: "Owner",
  moderator: "Moderator",
  member: "Member",
};

/** The words for a hub audit line -- the hub_events mirror of eventText. */
function hubEventText(event: HubEvent, selfUserId: string): string {
  const actor =
    event.actorUserId === selfUserId
      ? "You"
      : event.actorDisplayName || event.actorUsername;
  const target =
    event.targetUserId === selfUserId
      ? "you"
      : (event.targetDisplayName || event.targetUsername) ?? "someone";

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
    default:
      // A kind from a newer server: render nothing rather than guess.
      return "";
  }
}

export function HubDetails({
  hubId,
  selfUserId,
  onClose,
  onOpenChannel,
}: {
  hubId: string;
  selfUserId: string;
  onClose: () => void;
  /**
   * Opens a channel's thread (closing this panel is the caller's half).
   * A search hit passes itself along so the caller can store it locally and
   * scroll the timeline to it -- the jump half of search.
   */
  onOpenChannel: (conversationId: string, jumpTo?: HubSearchResult) => void;
}) {
  const [detail, setDetail] = useState<HubDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const [name, setName] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const [channelName, setChannelName] = useState("");
  const [channelBusy, setChannelBusy] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);

  const [contacts, setContacts] = useState<Friend[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [username, setUsername] = useState("");
  const [shareHistory, setShareHistory] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [memberBusyId, setMemberBusyId] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  const [dangerBusy, setDangerBusy] = useState(false);
  const [dangerError, setDangerError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HubSearchResult[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);

  const [events, setEvents] = useState<HubEvent[]>([]);

  const [muteAllBusy, setMuteAllBusy] = useState(false);
  const { conversations } = useConversations();

  const [invites, setInvites] = useState<HubInvite[] | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteExpiry, setInviteExpiry] = useState("604800");
  const [inviteUses, setInviteUses] = useState("0");
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);

  const load = useCallback(() => {
    void fetchHub(hubId)
      .then((fetched) => {
        setDetail(fetched);
        setName(fetched.name);
        setLoadError(null);
        // Moderators also see the invite list; asking as a member would
        // only earn a 403 the panel then has to hide anyway.
        if (RANK[fetched.role] >= RANK.moderator) {
          void fetchHubInvites(hubId)
            .then(setInvites)
            .catch(() => setInvites([]));
        }
      })
      .catch((caught) => {
        setLoadError(
          caught instanceof ApiError && caught.status === 404
            ? "This hub is gone, or you are no longer in it."
            : "Could not load the hub.",
        );
      });
    void fetchHubEvents({ hubId })
      .then((page) => setEvents(page.events))
      .catch(() => {});
  }, [hubId]);

  useEffect(load, [load]);

  useEffect(() => {
    void fetchFriends()
      .then((lists) => setContacts(lists.friends))
      .catch(() => setContacts([]));
  }, []);

  const myRole = detail?.role ?? "member";
  const isPrivate = detail?.visibility === "private";
  const memberIds = useMemo(
    () => new Set((detail?.members ?? []).map((m) => m.userId)),
    [detail],
  );

  /** Membership changed: the sweep has crypto to do (private) and the list
   *  is stale (both classes) -- the GroupDetails nudge, hub-sized. */
  function nudge(): void {
    if (isPrivate) mlsSync.invalidate();
    sync.invalidateConversations();
  }

  async function saveName(event: FormEvent) {
    event.preventDefault();
    setNameBusy(true);
    setNameError(null);
    try {
      setDetail(await renameHub({ hubId, name: name.trim() }));
      sync.invalidateConversations();
    } catch (caught) {
      setNameError(
        caught instanceof ApiError ? caught.message : "Could not rename the hub.",
      );
    } finally {
      setNameBusy(false);
    }
  }

  async function addChannel(event: FormEvent) {
    event.preventDefault();
    setChannelBusy(true);
    setChannelError(null);
    try {
      await createHubChannel({ hubId, name: channelName.trim() });
      setChannelName("");
      nudge();
      load();
    } catch (caught) {
      setChannelError(
        caught instanceof ApiError
          ? caught.message
          : "Could not create the channel.",
      );
    } finally {
      setChannelBusy(false);
    }
  }

  /** One PATCH per changed field; window.prompt keeps the ceremony low for
   *  inputs that are a single line of text or a number. */
  async function changeChannel(
    conversationId: string,
    patch: {
      name?: string;
      topic?: string;
      posting?: "everyone" | "moderators";
      slowmodeSeconds?: number | null;
    },
  ): Promise<void> {
    setChannelError(null);
    try {
      await updateHubChannel({ hubId, conversationId, ...patch });
      sync.invalidateConversations();
      load();
    } catch (caught) {
      setChannelError(
        caught instanceof ApiError
          ? caught.message
          : "Could not change the channel.",
      );
    }
  }

  async function renameChannel(conversationId: string, current: string): Promise<void> {
    const next = window.prompt("Channel name", current)?.trim();
    if (!next || next === current) return;
    await changeChannel(conversationId, { name: next });
  }

  async function editTopic(channel: HubChannel): Promise<void> {
    const next = window.prompt(
      "Channel topic (empty clears it)",
      channel.topic ?? "",
    );
    if (next === null || next.trim() === (channel.topic ?? "")) return;
    await changeChannel(channel.id, { topic: next });
  }

  async function editSlowmode(channel: HubChannel): Promise<void> {
    const raw = window.prompt(
      "Seconds between messages (0 turns slowmode off)",
      String(channel.slowmodeSeconds ?? 0),
    );
    if (raw === null) return;
    const seconds = Number.parseInt(raw, 10);
    if (Number.isNaN(seconds) || seconds < 0 || seconds > 21600) return;
    await changeChannel(channel.id, {
      slowmodeSeconds: seconds === 0 ? null : seconds,
    });
  }

  async function togglePosting(channel: HubChannel): Promise<void> {
    const restricting = channel.posting === "everyone";
    if (
      restricting &&
      !(await confirm({
        message:
          "Make this channel announcement-only? Only moderators will be able to post, react or reply in it.",
        confirmLabel: "Restrict",
      }))
    ) {
      return;
    }
    await changeChannel(channel.id, {
      posting: restricting ? "moderators" : "everyone",
    });
  }

  function toggle(userId: string): void {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function addPicked(event: FormEvent) {
    event.preventDefault();
    setAddBusy(true);
    setAddError(null);
    try {
      const names = [
        ...new Set(
          username
            .split(/[\s,]+/)
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        ),
      ];
      const typed = await Promise.all(names.map((entry) => lookupUser(entry)));
      const newIds = [
        ...new Set([...picked, ...typed.map((user) => user.id)]),
      ].filter((id) => id !== selfUserId && !memberIds.has(id));
      if (newIds.length === 0) return;

      const updated = await addHubMembers({
        hubId,
        memberUserIds: newIds,
        shareHistory: isPrivate && shareHistory,
      });
      setDetail(updated);

      if (isPrivate && shareHistory && mlsEnabled()) {
        // Per channel, because each channel is its own conversation with
        // its own history keys -- the GroupDetails share, multiplied.
        for (const channel of updated.channels) {
          try {
            await mlsSync.shareHistory(channel.id, newIds);
          } catch (caught) {
            console.warn("history share failed", channel.id, caught);
          }
        }
      }

      nudge();
      setPicked(new Set());
      setUsername("");
    } catch (caught) {
      setAddError(
        caught instanceof ApiError && caught.code === "UNKNOWN_USER"
          ? "No account with one of those usernames."
          : caught instanceof ApiError
            ? caught.message
            : "Could not add them.",
      );
    } finally {
      setAddBusy(false);
    }
  }

  async function kick(userId: string, ban: boolean): Promise<void> {
    if (
      ban &&
      !(await confirm({
        message: "Ban them? They will not be able to rejoin on their own.",
        confirmLabel: "Ban",
      }))
    ) {
      return;
    }
    setMemberBusyId(userId);
    setMemberError(null);
    try {
      setDetail(await kickHubMember({ hubId, userId, ban }));
      nudge();
    } catch (caught) {
      setMemberError(
        caught instanceof ApiError ? caught.message : "Could not remove them.",
      );
    } finally {
      setMemberBusyId(null);
    }
  }

  async function changeRole(userId: string, role: HubRole): Promise<void> {
    if (
      role === "owner" &&
      !(await confirm({
        message:
          "Transfer ownership? You become a moderator and cannot undo this yourself.",
        confirmLabel: "Transfer",
      }))
    ) {
      load();
      return;
    }
    setMemberBusyId(userId);
    setMemberError(null);
    try {
      setDetail(await setHubRole({ hubId, userId, role }));
    } catch (caught) {
      setMemberError(
        caught instanceof ApiError ? caught.message : "Could not change the role.",
      );
      load();
    } finally {
      setMemberBusyId(null);
    }
  }

  async function doLeave(): Promise<void> {
    if (
      !(await confirm({
        message: "Leave this hub and all of its channels?",
        confirmLabel: "Leave",
      }))
    ) {
      return;
    }
    setDangerBusy(true);
    setDangerError(null);
    try {
      await leaveHub(hubId);
      nudge();
      onClose();
    } catch (caught) {
      setDangerError(
        caught instanceof ApiError ? caught.message : "Could not leave the hub.",
      );
      setDangerBusy(false);
    }
  }

  async function doDelete(): Promise<void> {
    if (
      !(await confirm({
        message:
          "Delete this hub for everyone? Its channels close for every member.",
        confirmLabel: "Delete",
      }))
    ) {
      return;
    }
    setDangerBusy(true);
    setDangerError(null);
    try {
      await deleteHub(hubId);
      nudge();
      onClose();
    } catch (caught) {
      setDangerError(
        caught instanceof ApiError ? caught.message : "Could not delete the hub.",
      );
      setDangerBusy(false);
    }
  }

  /**
   * The hub-level mute: one tap writes the existing per-channel mute for
   * every channel -- no server column, no new endpoint; muted_at on
   * conversation_members already does all the work. A channel created
   * after this starts unmuted; the button simply covers it next time.
   */
  const channelMuted = new Map(
    conversations
      .filter((conversation) => conversation.hubId === hubId)
      .map((conversation) => [conversation.id, conversation.muted]),
  );
  const allMuted =
    (detail?.channels.length ?? 0) > 0 &&
    (detail?.channels ?? []).every(
      (channel) => channelMuted.get(channel.id) === true,
    );

  async function toggleMuteAll(): Promise<void> {
    if (!detail) return;
    setMuteAllBusy(true);
    try {
      await Promise.all(
        detail.channels.map((channel) =>
          allMuted ? unmuteConversation(channel.id) : muteConversation(channel.id),
        ),
      );
      sync.invalidateConversations();
    } catch {
      // Partial success self-heals: the button reads the refreshed state.
    } finally {
      setMuteAllBusy(false);
    }
  }

  async function unban(userId: string): Promise<void> {
    setMemberBusyId(userId);
    setMemberError(null);
    try {
      setDetail(await unbanHubMember({ hubId, userId }));
    } catch (caught) {
      setMemberError(
        caught instanceof ApiError ? caught.message : "Could not unban them.",
      );
    } finally {
      setMemberBusyId(null);
    }
  }

  async function makeInvite(event: FormEvent) {
    event.preventDefault();
    setInviteBusy(true);
    setInviteError(null);
    try {
      const expiresInSeconds = Number.parseInt(inviteExpiry, 10);
      const maxUses = Number.parseInt(inviteUses, 10);
      const created = await createHubInvite({
        hubId,
        ...(expiresInSeconds > 0 ? { expiresInSeconds } : {}),
        ...(maxUses > 0 ? { maxUses } : {}),
      });
      setInvites((current) => [created, ...(current ?? [])]);
    } catch (caught) {
      setInviteError(
        caught instanceof ApiError
          ? caught.message
          : "Could not create the invite.",
      );
    } finally {
      setInviteBusy(false);
    }
  }

  async function revokeInvite(inviteId: string): Promise<void> {
    if (
      !(await confirm({
        message: "Revoke this invite? Its link stops working immediately.",
        confirmLabel: "Revoke",
      }))
    ) {
      return;
    }
    setInviteError(null);
    try {
      await revokeHubInvite({ hubId, inviteId });
      setInvites((current) =>
        (current ?? []).filter((invite) => invite.id !== inviteId),
      );
    } catch (caught) {
      setInviteError(
        caught instanceof ApiError
          ? caught.message
          : "Could not revoke the invite.",
      );
    }
  }

  function inviteUrl(invite: HubInvite): string {
    // webOrigin, not window.location.origin: an invite link is handed to
    // someone else, and the desktop build's own origin (tauri://localhost)
    // means nothing outside its webview.
    return `${webOrigin()}/join/${invite.token}`;
  }

  async function copyInvite(invite: HubInvite): Promise<void> {
    try {
      await navigator.clipboard.writeText(inviteUrl(invite));
      setCopiedInviteId(invite.id);
      setTimeout(() => setCopiedInviteId(null), 2000);
    } catch {
      // Clipboard can be denied; the visible URL below is the fallback.
    }
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    setSearchBusy(true);
    try {
      const page = await searchHub({ hubId, query: trimmed });
      setResults(page.results);
    } catch {
      setResults([]);
    } finally {
      setSearchBusy(false);
    }
  }

  if (loadError) {
    return (
      <Panel title="Hub" onClose={onClose}>
        <div className="p-4">
          <ErrorText>{loadError}</ErrorText>
        </div>
      </Panel>
    );
  }

  if (!detail) {
    return (
      <Panel title="Hub" onClose={onClose}>
        <div className="p-4 text-sm text-neutral-500 dark:text-neutral-400">
          Loading…
        </div>
      </Panel>
    );
  }

  const addable = (contacts ?? []).filter(
    (contact) => !memberIds.has(contact.userId),
  );

  return (
    <Panel title={detail.name} onClose={onClose}>
      <div>
        <PanelSection title="About">
          {/* The privacy-class label, said where it matters. One sentence,
              honest, matching the creation flow's wording. */}
          <Note>
            {detail.visibility === "public"
              ? "Public hub — anyone with an account can join, and messages here are stored readable by the server so search and moderation can work."
              : "Private hub — invitation only, and every channel is end-to-end encrypted like a group chat."}
          </Note>
          {detail.visibility === "public" && (
            <Note className="mt-1">
              Share this ID so people can join:{" "}
              <span className="select-all break-all font-mono text-[11px]">
                {detail.id}
              </span>
            </Note>
          )}
          {manages(myRole) ? (
            <form onSubmit={saveName} className="mt-2 flex gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Hub name"
                maxLength={100}
              />
              <Button type="submit" size="sm" disabled={nameBusy} className="shrink-0">
                {nameBusy ? "…" : "Save"}
              </Button>
            </form>
          ) : null}
          {nameError && <ErrorText className="mt-1">{nameError}</ErrorText>}
        </PanelSection>

        <PanelSection title={`Channels (${detail.channels.length})`}>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {detail.channels.map((channel) => (
              <li key={channel.id} className="py-1.5">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onOpenChannel(channel.id)}
                    className="min-w-0 flex-1 truncate text-left text-sm text-neutral-900 hover:underline dark:text-neutral-100"
                  >
                    <span className="mr-1 text-neutral-400 dark:text-neutral-500">
                      #
                    </span>
                    {channel.title ?? "channel"}
                    {channel.posting === "moderators" && (
                      <LockIcon className="ml-1 inline h-3.5 w-3.5 align-[-2px] text-neutral-400 dark:text-neutral-500" />
                    )}
                  </button>
                  {manages(myRole) && (
                    <button
                      onClick={() =>
                        renameChannel(channel.id, channel.title ?? "")
                      }
                      aria-label={`Rename #${channel.title ?? "channel"}`}
                      className="shrink-0 rounded p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                    >
                      <PencilIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {(channel.topic || channel.slowmodeSeconds !== null) && (
                  <p className="ml-4 truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {channel.topic}
                    {channel.slowmodeSeconds !== null && (
                      <span className={channel.topic ? "ml-2" : ""}>
                        · slowmode {channel.slowmodeSeconds}s
                      </span>
                    )}
                  </p>
                )}
                {manages(myRole) && (
                  <div className="ml-4 mt-0.5 flex gap-3 text-xs">
                    <button
                      onClick={() => editTopic(channel)}
                      className="text-neutral-500 hover:underline dark:text-neutral-400"
                    >
                      Topic
                    </button>
                    <button
                      onClick={() => togglePosting(channel)}
                      className="text-neutral-500 hover:underline dark:text-neutral-400"
                    >
                      {channel.posting === "moderators"
                        ? "Open to everyone"
                        : "Announcement-only"}
                    </button>
                    {detail.visibility === "public" && (
                      <button
                        onClick={() => editSlowmode(channel)}
                        className="text-neutral-500 hover:underline dark:text-neutral-400"
                      >
                        Slowmode
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {manages(myRole) && (
            <form onSubmit={addChannel} className="mt-2 flex gap-2">
              <Input
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                placeholder="New channel name"
                maxLength={100}
              />
              <Button
                type="submit"
                size="sm"
                disabled={channelBusy || channelName.trim().length === 0}
                className="shrink-0"
              >
                {channelBusy ? "…" : "Add"}
              </Button>
            </form>
          )}
          {channelError && <ErrorText className="mt-1">{channelError}</ErrorText>}
          <Button
            variant="secondary"
            size="sm"
            onClick={toggleMuteAll}
            disabled={muteAllBusy}
            className="mt-2 w-full"
          >
            {muteAllBusy
              ? "…"
              : allMuted
                ? "Unmute all channels"
                : "Mute all channels"}
          </Button>
        </PanelSection>

        {detail.visibility === "public" && (
          <PanelSection
            title="Search"
            description="Searches every channel in this hub."
          >
            <form onSubmit={runSearch} className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search messages"
                maxLength={200}
              />
              <Button
                type="submit"
                size="sm"
                disabled={searchBusy || query.trim().length === 0}
                className="shrink-0"
              >
                {searchBusy ? "…" : "Search"}
              </Button>
            </form>
            {results !== null && (
              <ul className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-800">
                {results.length === 0 && <Note>No messages matched.</Note>}
                {results.map((result) => (
                  <li key={result.messageId}>
                    <button
                      onClick={() => onOpenChannel(result.conversationId, result)}
                      className="block w-full py-2 text-left"
                    >
                      <span className="block text-xs font-medium text-neutral-900 dark:text-neutral-100">
                        {result.senderDisplayName || result.senderUsername}
                        <span className="ml-2 font-normal text-neutral-500 dark:text-neutral-400">
                          {new Date(result.sentAt).toLocaleDateString()}
                        </span>
                      </span>
                      {/* ts_headline wraps matches in <b> -- rendered as
                          plain text on purpose, so nothing the server (or a
                          sender) says can inject markup here. */}
                      <span className="block truncate text-xs text-neutral-600 dark:text-neutral-300">
                        {result.snippet.replaceAll("<b>", "").replaceAll("</b>", "")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </PanelSection>
        )}

        <PanelSection title={`Members (${detail.members.length})`}>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {detail.members.map((member) => {
              const self = member.userId === selfUserId;
              const busy = memberBusyId === member.userId;
              return (
                <li
                  key={member.userId}
                  className="flex items-center justify-between gap-2 py-2 text-sm text-neutral-900 dark:text-neutral-100"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar
                      size="sm"
                      name={member.displayName || member.username}
                      userId={member.userId}
                    />
                    <span className="min-w-0 truncate">
                      {member.displayName || member.username}
                      {self && (
                        <span className="ml-1 text-xs text-neutral-500 dark:text-neutral-400">
                          (you)
                        </span>
                      )}
                      {member.role !== "member" && (
                        <span className="ml-1 text-xs text-accent-700 dark:text-accent-300">
                          {ROLE_LABEL[member.role]}
                        </span>
                      )}
                    </span>
                  </span>
                  {!self && (
                    <span className="flex shrink-0 items-center gap-2">
                      {myRole === "owner" && (
                        <select
                          value={member.role}
                          disabled={busy}
                          onChange={(e) =>
                            changeRole(member.userId, e.target.value as HubRole)
                          }
                          aria-label={`Role for ${member.displayName || member.username}`}
                          className="rounded border border-neutral-300 bg-white px-1 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
                        >
                          <option value="member">Member</option>
                          <option value="moderator">Moderator</option>
                          <option value="owner">Owner…</option>
                        </select>
                      )}
                      {manages(myRole) && outranks(myRole, member.role) && (
                        <>
                          <button
                            onClick={() => kick(member.userId, false)}
                            disabled={busy}
                            className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                          >
                            {busy ? "…" : "Remove"}
                          </button>
                          <button
                            onClick={() => kick(member.userId, true)}
                            disabled={busy}
                            className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                          >
                            Ban
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {memberError && <ErrorText className="mt-1">{memberError}</ErrorText>}
        </PanelSection>

        {detail.banned.length > 0 && (
          <PanelSection
            title={`Banned (${detail.banned.length})`}
            description="Unbanning lets them come back; it does not re-add them."
          >
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {detail.banned.map((entry) => (
                <li
                  key={entry.userId}
                  className="flex items-center justify-between gap-2 py-2 text-sm text-neutral-900 dark:text-neutral-100"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar
                      size="sm"
                      name={entry.displayName || entry.username}
                      userId={entry.userId}
                    />
                    <span className="min-w-0 truncate">
                      {entry.displayName || entry.username}
                    </span>
                  </span>
                  <button
                    onClick={() => unban(entry.userId)}
                    disabled={memberBusyId === entry.userId}
                    className="shrink-0 text-xs font-medium text-accent-700 hover:underline disabled:opacity-50 dark:text-accent-300"
                  >
                    {memberBusyId === entry.userId ? "…" : "Unban"}
                  </button>
                </li>
              ))}
            </ul>
          </PanelSection>
        )}

        {manages(myRole) && (
          <PanelSection
            title="Invite links"
            description={
              isPrivate
                ? "Anyone with a link can join. Joining by link shares no earlier messages."
                : "Anyone with a link can join."
            }
          >
            {(invites ?? []).length > 0 && (
              <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {(invites ?? []).map((invite) => (
                  <li key={invite.id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 select-all truncate font-mono text-[11px] text-neutral-700 dark:text-neutral-300">
                        {inviteUrl(invite)}
                      </span>
                      <span className="flex shrink-0 gap-2">
                        <button
                          onClick={() => copyInvite(invite)}
                          className="text-xs font-medium text-accent-700 hover:underline dark:text-accent-300"
                        >
                          {copiedInviteId === invite.id ? "Copied" : "Copy"}
                        </button>
                        <button
                          onClick={() => revokeInvite(invite.id)}
                          className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                        >
                          Revoke
                        </button>
                      </span>
                    </div>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      {invite.maxUses === null
                        ? `${invite.useCount} joins`
                        : `${invite.useCount}/${invite.maxUses} uses`}
                      {" · "}
                      {invite.expiresAt === null
                        ? "never expires"
                        : `expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={makeInvite} className="mt-2 flex items-center gap-2">
              <select
                value={inviteExpiry}
                onChange={(e) => setInviteExpiry(e.target.value)}
                aria-label="Invite expiry"
                className="rounded border border-neutral-300 bg-white px-1 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              >
                <option value="86400">1 day</option>
                <option value="604800">7 days</option>
                <option value="0">Never expires</option>
              </select>
              <select
                value={inviteUses}
                onChange={(e) => setInviteUses(e.target.value)}
                aria-label="Invite use limit"
                className="rounded border border-neutral-300 bg-white px-1 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              >
                <option value="0">Unlimited uses</option>
                <option value="1">1 use</option>
                <option value="10">10 uses</option>
              </select>
              <Button
                type="submit"
                size="sm"
                disabled={inviteBusy}
                className="ml-auto shrink-0"
              >
                {inviteBusy ? "…" : "New link"}
              </Button>
            </form>
            {inviteError && <ErrorText className="mt-1">{inviteError}</ErrorText>}
          </PanelSection>
        )}

        {manages(myRole) && (
          <PanelSection title="Add people">
            <form onSubmit={addPicked} className="space-y-2">
              {addable.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800">
                  {addable.map((contact) => (
                    <ContactCheckboxRow
                      key={contact.userId}
                      contact={contact}
                      checked={picked.has(contact.userId)}
                      onToggle={() => toggle(contact.userId)}
                    />
                  ))}
                </div>
              )}
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Or add by username"
              />
              {isPrivate && (
                <label className="flex cursor-pointer items-start gap-2 text-sm text-neutral-800 dark:text-neutral-100">
                  <input
                    type="checkbox"
                    checked={shareHistory}
                    onChange={(e) => setShareHistory(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0"
                  />
                  <span>
                    Share previous messages
                    <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                      Every channel's earlier messages, from everyone, not
                      only yours.
                    </span>
                  </span>
                </label>
              )}
              {addError && <ErrorText>{addError}</ErrorText>}
              <Button
                type="submit"
                size="sm"
                disabled={
                  addBusy || (picked.size === 0 && username.trim().length === 0)
                }
                className="w-full"
              >
                {addBusy ? "…" : "Add"}
              </Button>
            </form>
          </PanelSection>
        )}

        {events.length > 0 && (
          <PanelSection title="Recent activity">
            <ul className="space-y-1">
              {events
                .map((event) => ({
                  id: event.id,
                  text: hubEventText(event, selfUserId),
                }))
                .filter((line) => line.text !== "")
                .map((line) => (
                  <li
                    key={line.id}
                    className="text-xs text-neutral-500 dark:text-neutral-400"
                  >
                    {line.text}
                  </li>
                ))}
            </ul>
          </PanelSection>
        )}

        <div className="border-b border-neutral-200 px-4 py-5 dark:border-neutral-800">
          {myRole === "owner" ? (
            <Button
              variant="danger"
              size="sm"
              onClick={doDelete}
              disabled={dangerBusy}
              className="w-full"
            >
              {dangerBusy ? "…" : "Delete hub"}
            </Button>
          ) : (
            <Button
              variant="danger"
              size="sm"
              onClick={doLeave}
              disabled={dangerBusy}
              className="w-full"
            >
              {dangerBusy ? "…" : "Leave hub"}
            </Button>
          )}
          {dangerError && <ErrorText className="mt-1">{dangerError}</ErrorText>}
        </div>
      </div>
      {confirmDialog}
    </Panel>
  );
}
