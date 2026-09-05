// The hub panel: members, roles, channels, search, and the audit line.
//
// Same full-screen Panel shape as Friends, Settings and GroupDetails. The
// permission checks here are a MIRROR of the server's pure matrix
// (server/src/services/hub-roles.ts) for showing and hiding controls -- the
// server enforces for real, so a stale mirror costs a 403, never a breach.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ApiError,
  addHubMembers,
  createHubCategory,
  createHubChannel,
  createHubInvite,
  deleteHub,
  deleteHubCategory,
  fetchFriends,
  fetchHub,
  fetchHubEvents,
  fetchHubInvites,
  kickHubMember,
  leaveHub,
  lookupUser,
  muteConversation,
  removeHubAvatar,
  renameHub,
  revokeHubInvite,
  searchHub,
  setHubAvatarColor,
  setHubRole,
  unbanHubMember,
  unmuteConversation,
  updateHubCategory,
  updateHubChannel,
  uploadHubAvatar,
  type Friend,
} from "../api/client";
import type {
  HubCategory,
  HubChannel,
  HubDetail,
  HubEvent,
  HubInvite,
  HubRole,
  HubSearchResult,
  ChannelKind,
} from "../api/types";
import { webOrigin } from "../api/base";
import { sync } from "../sync/engine";
import { mlsEnabled, mlsSync } from "../sync/mls";
import { useConversations } from "./hooks";
import {
  Button,
  ErrorText,
  Input,
  LoadingLine,
  LockIcon,
  Note,
  Panel,
  PanelSection,
  PencilIcon,
  Select,
  TrashIcon,
  useConfirm,
  usePrompt,
  handleInputProps,
  HeadphonesIcon,
} from "./kit";
import { UserAvatar } from "./UserAvatar";
import { HubAvatar } from "./HubAvatar";
import { HuePicker } from "./HuePicker";
import { prepareAvatar } from "./media";
import { groupChannels } from "./sidebar/channels";
import { openProfile } from "./profile";
import { ContactCheckboxRow } from "./ContactRow";
import { classLabel, classSentence, isServerReadable } from "./hub-class";

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
  const { prompt, promptDialog } = usePrompt();

  const [name, setName] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);

  const [categoryName, setCategoryName] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const [channelName, setChannelName] = useState("");
  const [channelKind, setChannelKind] = useState<ChannelKind>("text");
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

  /**
   * The hub picture, prepared in the browser exactly as a profile picture
   * is (ui/media.ts: centre-cropped, 256px, JPEG) and sent as raw bytes.
   * The panel re-reads the detail afterwards rather than patching state,
   * because the summary the sidebar draws from refreshes on the wake the
   * server sends and the two should agree about the same key.
   */
  async function pickHubAvatar(file: File | undefined) {
    if (!file) return;
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      const prepared = await prepareAvatar(file);
      if ("kind" in prepared) {
        setAvatarError(prepared.message);
        return;
      }
      await uploadHubAvatar(hubId, prepared.bytes);
      load();
      sync.invalidateConversations();
    } catch (caught) {
      setAvatarError(
        caught instanceof ApiError ? caught.message : "Could not save the picture.",
      );
    } finally {
      setAvatarBusy(false);
    }
  }

  async function dropHubAvatar() {
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      await removeHubAvatar(hubId);
      load();
      sync.invalidateConversations();
    } catch (caught) {
      setAvatarError(
        caught instanceof ApiError ? caught.message : "Could not remove the picture.",
      );
    } finally {
      setAvatarBusy(false);
    }
  }

  async function pickHubHue(hue: number | null) {
    if (!detail) return;
    setAvatarError(null);
    const previous = detail;
    // Optimistic: the preview repaints on the tap, and reverts on failure.
    setDetail({ ...detail, avatarHue: hue });
    try {
      setDetail(await setHubAvatarColor({ hubId, hue }));
      sync.invalidateConversations();
    } catch (caught) {
      setDetail(previous);
      setAvatarError(
        caught instanceof ApiError ? caught.message : "Could not save that colour.",
      );
    }
  }

  async function addCategory(event: FormEvent) {
    event.preventDefault();
    setCategoryBusy(true);
    setCategoryError(null);
    try {
      await createHubCategory({ hubId, name: categoryName.trim() });
      setCategoryName("");
      load();
      sync.invalidateConversations();
    } catch (caught) {
      setCategoryError(
        caught instanceof ApiError ? caught.message : "Could not create the category.",
      );
    } finally {
      setCategoryBusy(false);
    }
  }

  async function changeCategory(
    categoryId: string,
    patch: { name?: string; position?: number },
  ): Promise<void> {
    setCategoryError(null);
    try {
      await updateHubCategory({ hubId, categoryId, ...patch });
      load();
      sync.invalidateConversations();
    } catch (caught) {
      setCategoryError(
        caught instanceof ApiError ? caught.message : "Could not change the category.",
      );
    }
  }

  async function renameCategory(category: HubCategory): Promise<void> {
    const next = (
      await prompt({ message: "Category name", initial: category.name })
    )?.trim();
    if (!next || next === category.name) return;
    await changeCategory(category.id, { name: next });
  }

  async function removeCategory(category: HubCategory): Promise<void> {
    if (
      !(await confirm({
        message: `Delete the category "${category.name}"? Its channels stay, filed under none.`,
        confirmLabel: "Delete",
      }))
    ) {
      return;
    }
    setCategoryError(null);
    try {
      await deleteHubCategory({ hubId, categoryId: category.id });
      load();
      sync.invalidateConversations();
    } catch (caught) {
      setCategoryError(
        caught instanceof ApiError ? caught.message : "Could not delete the category.",
      );
    }
  }

  async function addChannel(event: FormEvent) {
    event.preventDefault();
    setChannelBusy(true);
    setChannelError(null);
    try {
      await createHubChannel({ hubId, name: channelName.trim(), kind: channelKind });
      setChannelName("");
      setChannelKind("text");
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

  /** One PATCH per changed field; the kit prompt keeps the ceremony low for
   *  inputs that are a single line of text or a number. */
  async function changeChannel(
    conversationId: string,
    patch: {
      name?: string;
      topic?: string;
      posting?: "everyone" | "moderators";
      slowmodeSeconds?: number | null;
      joinMutedAbove?: number | null;
      categoryId?: string | null;
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
    const next = (
      await prompt({ message: "Channel name", initial: current })
    )?.trim();
    if (!next || next === current) return;
    await changeChannel(conversationId, { name: next });
  }

  async function editTopic(channel: HubChannel): Promise<void> {
    const next = await prompt({
      message: "Channel topic (empty clears it)",
      initial: channel.topic ?? "",
    });
    if (next === null || next.trim() === (channel.topic ?? "")) return;
    await changeChannel(channel.id, { topic: next });
  }

  async function editSlowmode(channel: HubChannel): Promise<void> {
    const raw = await prompt({
      message: "Seconds between messages (0 turns slowmode off)",
      initial: String(channel.slowmodeSeconds ?? 0),
    });
    if (raw === null) return;
    const seconds = Number.parseInt(raw, 10);
    if (Number.isNaN(seconds) || seconds < 0 || seconds > 21600) return;
    await changeChannel(channel.id, {
      slowmodeSeconds: seconds === 0 ? null : seconds,
    });
  }

  /** Voice channels: the join-mute threshold. Empty turns auto-mute off. */
  async function editJoinMuted(channel: HubChannel): Promise<void> {
    const next = await prompt({
      message:
        "Join muted when more than this many people are already in (empty: never)",
      initial: channel.joinMutedAbove === null ? "" : String(channel.joinMutedAbove),
    });
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === "") {
      await changeChannel(channel.id, { joinMutedAbove: null });
      return;
    }
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 0 || value > 1000) {
      setChannelError("The threshold must be a whole number from 0 to 1000.");
      return;
    }
    await changeChannel(channel.id, { joinMutedAbove: value });
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
        <LoadingLine className="p-4 text-sm" />
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
          {/* The privacy-class label, said where it matters -- and said in
              the same words as the creation form and the join page, because
              all three read it from ui/hub-class.ts. */}
          <Note>
            {classLabel(detail.visibility)} hub — {classSentence(detail.visibility)}
          </Note>
          {/* Public only, and this is the "may anyone join?" question, not
              the readability one: an invite-only hub's id opens nothing,
              its invite links do (Invites, below). */}
          {detail.visibility === "public" && (
            <Note className="mt-1">
              Share this ID so people can join:{" "}
              <span className="select-all break-all font-mono text-[0.6875rem]">
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
              <Button type="submit" size="sm" loading={nameBusy} className="shrink-0">
                Save
              </Button>
            </form>
          ) : null}
          {nameError && <ErrorText className="mt-1">{nameError}</ErrorText>}
        </PanelSection>

        {/* The hub's picture and colour (migration 0028): the Settings
            profile-picture section, hub-sized. Readable in BOTH classes --
            a private hub's name was never sealed either -- and said so
            where it is chosen, the same sentence Settings uses. Everyone
            sees the picture; moderators get the controls. */}
        <PanelSection
          title="Picture"
          description="Shown to everyone in the hub. Not encrypted."
        >
          <div className="flex items-center gap-3">
            <HubAvatar hub={detail} size="lg" />
            {manages(myRole) && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={avatarInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onInput={(event) => {
                    const input = event.currentTarget;
                    const file = input.files?.[0];
                    // Cleared so picking the same file twice fires again.
                    input.value = "";
                    void pickHubAvatar(file);
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={avatarBusy}
                  onClick={() => avatarInput.current?.click()}
                >
                  {detail.avatarKey ? "Change" : "Choose"}
                </Button>
                {detail.avatarKey && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={avatarBusy}
                    onClick={() => void dropHubAvatar()}
                  >
                    Remove
                  </Button>
                )}
              </div>
            )}
          </div>
          {manages(myRole) && (
            <div className="mt-3">
              <Note>Colour behind the initials, when there is no picture.</Note>
              <div className="mt-2">
                <HuePicker
                  seedId={detail.id}
                  hue={detail.avatarHue}
                  onPick={(hue) => void pickHubHue(hue)}
                  disabled={avatarBusy}
                />
              </div>
            </div>
          )}
          {avatarError && <ErrorText className="mt-1">{avatarError}</ErrorText>}
        </PanelSection>

        <PanelSection title={`Channels (${detail.channels.length})`}>
          {/* Grouped under the categories the way the sidebar draws them
              (sidebar/channels.ts), empties included so a category made a
              moment ago is visible to file into. */}
          {groupChannels(detail.channels, detail.categories ?? [], {
            includeEmpty: true,
          }).map((group) => (
          <div key={group.category?.id ?? "uncategorised"}>
          {group.category && (
            <h3 className="mt-3 text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              {group.category.name}
            </h3>
          )}
          {group.category && group.channels.length === 0 && (
            <Note>No channels yet.</Note>
          )}
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {group.channels.map((channel) => (
              <li key={channel.id} className="py-1.5">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onOpenChannel(channel.id)}
                    className="min-w-0 flex-1 truncate text-left text-sm text-neutral-900 hover:underline dark:text-neutral-100"
                  >
                    <span className="mr-1 inline-block align-[-2px] text-neutral-400 dark:text-neutral-500">
                      {channel.kind === "voice" ? (
                        <HeadphonesIcon className="inline h-3.5 w-3.5" />
                      ) : (
                        "#"
                      )}
                    </span>
                    {channel.title ?? (channel.kind === "voice" ? "voice" : "channel")}
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
                {manages(myRole) && channel.kind === "voice" && (
                  <div className="ml-4 mt-0.5 flex gap-3 text-xs">
                    <button
                      onClick={() => editJoinMuted(channel)}
                      className="text-neutral-500 hover:underline dark:text-neutral-400"
                    >
                      {channel.joinMutedAbove === null
                        ? "Join-mute: off"
                        : `Join-mute above ${channel.joinMutedAbove}`}
                    </button>
                  </div>
                )}
                {manages(myRole) && channel.kind !== "voice" && (
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
                    {/* Slowmode enforcement reads the payload kind, so it
                        is offered wherever the server can read one -- the
                        same isServerReadable test the service applies. */}
                    {isServerReadable(detail.visibility) && (
                      <button
                        onClick={() => editSlowmode(channel)}
                        className="text-neutral-500 hover:underline dark:text-neutral-400"
                      >
                        Slowmode
                      </button>
                    )}
                  </div>
                )}
                {/* Where the channel is filed. Offered only once a category
                    exists -- a select with one option is a control that
                    does nothing. */}
                {manages(myRole) && (detail.categories?.length ?? 0) > 0 && (
                  <div className="ml-4 mt-1 flex items-center gap-2 text-xs">
                    <span className="text-neutral-500 dark:text-neutral-400">
                      Category
                    </span>
                    <Select
                      value={channel.categoryId ?? ""}
                      onChange={(e) =>
                        void changeChannel(channel.id, {
                          categoryId: e.target.value === "" ? null : e.target.value,
                        })
                      }
                      aria-label={`Category for #${channel.title ?? "channel"}`}
                    >
                      <option value="">None</option>
                      {detail.categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
              </li>
            ))}
          </ul>
          </div>
          ))}
          {manages(myRole) && (
            <form onSubmit={addChannel} className="mt-2 flex gap-2">
              <Input
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                placeholder="New channel name"
                maxLength={100}
              />
              <Select
                value={channelKind}
                onChange={(e) => setChannelKind(e.target.value as ChannelKind)}
                aria-label="Channel kind"
                className="shrink-0"
              >
                <option value="text">Text</option>
                <option value="voice">Voice</option>
              </Select>
              <Button
                type="submit"
                size="sm"
                loading={channelBusy}
                disabled={channelName.trim().length === 0}
                className="shrink-0"
              >
                Add
              </Button>
            </form>
          )}
          {channelError && <ErrorText className="mt-1">{channelError}</ErrorText>}
          <Button
            variant="secondary"
            size="sm"
            onClick={toggleMuteAll}
            loading={muteAllBusy}
            className="mt-2 w-full"
          >
            {allMuted ? "Unmute all channels" : "Mute all channels"}
          </Button>
        </PanelSection>

        {/* Channel categories (migration 0029): the headings the sidebar
            groups channels under. Moderators only -- a member sees the
            result in the channel list above and in the sidebar. Order here
            is the order there; Up and Down rather than a drag, because
            this is a settings list that changes twice a year. */}
        {manages(myRole) && (
          <PanelSection
            title={`Categories (${detail.categories?.length ?? 0})`}
            description="Headings the sidebar groups channels under. A hub with none shows its channels in one list, as before."
          >
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {(detail.categories ?? []).map((category, index, all) => (
                <li key={category.id} className="flex items-center gap-1 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-900 dark:text-neutral-100">
                    {category.name}
                  </span>
                  <button
                    onClick={() => void changeCategory(category.id, { position: index - 1 })}
                    disabled={index === 0}
                    aria-label={`Move ${category.name} up`}
                    className="shrink-0 rounded px-1 text-xs text-neutral-500 hover:text-neutral-800 disabled:opacity-30 dark:text-neutral-400 dark:hover:text-neutral-200"
                  >
                    Up
                  </button>
                  <button
                    onClick={() => void changeCategory(category.id, { position: index + 1 })}
                    disabled={index === all.length - 1}
                    aria-label={`Move ${category.name} down`}
                    className="shrink-0 rounded px-1 text-xs text-neutral-500 hover:text-neutral-800 disabled:opacity-30 dark:text-neutral-400 dark:hover:text-neutral-200"
                  >
                    Down
                  </button>
                  <button
                    onClick={() => void renameCategory(category)}
                    aria-label={`Rename ${category.name}`}
                    className="shrink-0 rounded p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                  >
                    <PencilIcon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => void removeCategory(category)}
                    aria-label={`Delete ${category.name}`}
                    className="shrink-0 rounded p-1 text-neutral-400 hover:text-red-600 dark:hover:text-red-400"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
            <form onSubmit={addCategory} className="mt-2 flex gap-2">
              <Input
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                placeholder="New category name"
                maxLength={100}
              />
              <Button
                type="submit"
                size="sm"
                loading={categoryBusy}
                disabled={categoryName.trim().length === 0}
                className="shrink-0"
              >
                Add
              </Button>
            </form>
            {categoryError && <ErrorText className="mt-1">{categoryError}</ErrorText>}
          </PanelSection>
        )}

        {/* Search reads body_text, which every v4 row has -- so an
            invite-only hub is searchable exactly like a public one. */}
        {isServerReadable(detail.visibility) && (
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
                loading={searchBusy}
                disabled={query.trim().length === 0}
                className="shrink-0"
              >
                Search
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
                  <button
                    type="button"
                    onClick={(event) =>
                      openProfile({
                        userId: member.userId,
                        anchor: event.currentTarget,
                        hint: {
                          displayName: member.displayName || member.username,
                          username: member.username,
                          avatarHue: member.avatarHue,
                          avatarKey: member.avatarKey,
                        },
                      })
                    }
                    className="flex min-w-0 items-center gap-2 rounded-md text-left hover:opacity-80"
                  >
                    <UserAvatar
                      size="sm"
                      name={member.displayName || member.username}
                      userId={member.userId}
                      hue={member.avatarHue}
                      avatarKey={member.avatarKey}
                    />
                    <span className="min-w-0 truncate">
                      {member.displayName || member.username}
                      {member.displayName && (
                        <span className="ml-1 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                          @{member.username}
                        </span>
                      )}
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
                  </button>
                  {!self && (
                    <span className="flex shrink-0 items-center gap-2">
                      {myRole === "owner" && (
                        <Select
                          value={member.role}
                          disabled={busy}
                          onChange={(e) =>
                            changeRole(member.userId, e.target.value as HubRole)
                          }
                          aria-label={`Role for ${member.displayName || member.username}`}
                          className="py-0.5"
                        >
                          <option value="member">Member</option>
                          <option value="moderator">Moderator</option>
                          <option value="owner">Owner…</option>
                        </Select>
                      )}
                      {manages(myRole) && outranks(myRole, member.role) && (
                        <>
                          <Button
                            variant="ghost-danger"
                            size="sm"
                            onClick={() => kick(member.userId, false)}
                            loading={busy}
                            className="hover:underline"
                          >
                            Remove
                          </Button>
                          <Button
                            variant="ghost-danger"
                            size="sm"
                            onClick={() => kick(member.userId, true)}
                            disabled={busy}
                            className="hover:underline"
                          >
                            Ban
                          </Button>
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
                    <UserAvatar
                      size="sm"
                      name={entry.displayName || entry.username}
                      userId={entry.userId}
                      hue={entry.avatarHue}
                      avatarKey={entry.avatarKey}
                    />
                    <span className="min-w-0 truncate">
                      {entry.displayName || entry.username}
                      {entry.displayName && (
                        // A ban list is exactly where "which Sam?" matters --
                        // the unban targets the address, so show it.
                        <span className="ml-1 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                          @{entry.username}
                        </span>
                      )}
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
                      <span className="min-w-0 select-all truncate font-mono text-[0.6875rem] text-neutral-700 dark:text-neutral-300">
                        {inviteUrl(invite)}
                      </span>
                      <span className="flex shrink-0 gap-2">
                        <button
                          onClick={() => copyInvite(invite)}
                          className="text-xs font-medium text-accent-700 hover:underline dark:text-accent-300"
                        >
                          {copiedInviteId === invite.id ? "Copied" : "Copy"}
                        </button>
                        <Button
                          variant="ghost-danger"
                          size="sm"
                          onClick={() => revokeInvite(invite.id)}
                          className="hover:underline"
                        >
                          Revoke
                        </Button>
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
              <Select
                value={inviteExpiry}
                onChange={(e) => setInviteExpiry(e.target.value)}
                aria-label="Invite expiry"
                className="py-1"
              >
                <option value="86400">1 day</option>
                <option value="604800">7 days</option>
                <option value="0">Never expires</option>
              </Select>
              <Select
                value={inviteUses}
                onChange={(e) => setInviteUses(e.target.value)}
                aria-label="Invite use limit"
                className="py-1"
              >
                <option value="0">Unlimited uses</option>
                <option value="1">1 use</option>
                <option value="10">10 uses</option>
              </Select>
              <Button
                type="submit"
                size="sm"
                loading={inviteBusy}
                className="ml-auto shrink-0"
              >
                New link
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
                {...handleInputProps}
                className="font-mono"
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
                loading={addBusy}
                disabled={picked.size === 0 && username.trim().length === 0}
                className="w-full"
              >
                Add
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
              loading={dangerBusy}
              className="w-full"
            >
              Delete hub
            </Button>
          ) : (
            <Button
              variant="danger"
              size="sm"
              onClick={doLeave}
              loading={dangerBusy}
              className="w-full"
            >
              Leave hub
            </Button>
          )}
          {dangerError && <ErrorText className="mt-1">{dangerError}</ErrorText>}
        </div>
      </div>
      {confirmDialog}
      {promptDialog}
    </Panel>
  );
}
