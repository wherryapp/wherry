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
  deleteHub,
  fetchFriends,
  fetchHub,
  fetchHubEvents,
  kickHubMember,
  leaveHub,
  lookupUser,
  renameHub,
  renameHubChannel,
  searchHub,
  setHubRole,
  type Friend,
} from "../api/client";
import type {
  HubDetail,
  HubEvent,
  HubRole,
  HubSearchResult,
} from "../api/types";
import { sync } from "../sync/engine";
import { mlsEnabled, mlsSync } from "../sync/mls";
import {
  Avatar,
  Button,
  ErrorText,
  Input,
  Note,
  Panel,
  PanelSection,
  PencilIcon,
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
    case "role_changed":
      return `${actor} made ${target} ${event.title ?? "a member"}`;
    case "renamed":
      return `${actor} named the hub "${event.title ?? ""}"`;
    case "channel_created":
      return `${actor} created #${event.title ?? "a channel"}`;
    case "channel_renamed":
      return `${actor} renamed a channel to #${event.title ?? ""}`;
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
  /** Opens a channel's thread (closing this panel is the caller's half). */
  onOpenChannel: (conversationId: string) => void;
}) {
  const [detail, setDetail] = useState<HubDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const load = useCallback(() => {
    void fetchHub(hubId)
      .then((fetched) => {
        setDetail(fetched);
        setName(fetched.name);
        setLoadError(null);
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

  async function renameChannel(conversationId: string, current: string): Promise<void> {
    // window.prompt, the same low-ceremony bar as Timeline's delete confirm.
    const next = window.prompt("Channel name", current)?.trim();
    if (!next || next === current) return;
    setChannelError(null);
    try {
      await renameHubChannel({ hubId, conversationId, name: next });
      sync.invalidateConversations();
      load();
    } catch (caught) {
      setChannelError(
        caught instanceof ApiError
          ? caught.message
          : "Could not rename the channel.",
      );
    }
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
      !window.confirm("Ban them? They will not be able to rejoin on their own.")
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
      !window.confirm(
        "Transfer ownership? You become a moderator and cannot undo this yourself.",
      )
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
    if (!window.confirm("Leave this hub and all of its channels?")) return;
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
      !window.confirm(
        "Delete this hub for everyone? Its channels close for every member.",
      )
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
              <li key={channel.id} className="flex items-center gap-2 py-1.5">
                <button
                  onClick={() => onOpenChannel(channel.id)}
                  className="min-w-0 flex-1 truncate text-left text-sm text-neutral-900 hover:underline dark:text-neutral-100"
                >
                  <span className="mr-1 text-neutral-400 dark:text-neutral-500">
                    #
                  </span>
                  {channel.title ?? "channel"}
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
                      onClick={() => onOpenChannel(result.conversationId)}
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
              {events.map((event) => (
                <li
                  key={event.id}
                  className="text-xs text-neutral-500 dark:text-neutral-400"
                >
                  {hubEventText(event, selfUserId)}
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
    </Panel>
  );
}
