import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Attachment } from "./Attachment";
import { Settings } from "./Settings";
import { Friends } from "./Friends";
import { HubDetails } from "./HubDetails";
import { ContactCheckboxRow } from "./ContactRow";
import { avatarSeed, conversationTitle, memberName } from "./format";
import { useIsDesktop } from "./viewport";
import { ConversationList } from "./sidebar/Sidebar";
import {
  decodeContent,
  encodeContent,
  encodeOp,
  isMessageOp,
  type AttachmentRef,
  type RenderableContent,
} from "../api/payload";
import { prepareForUpload } from "./media";
import {
  ApiError,
  addMembers,
  deleteHubMessage,
  fetchArchive,
  fetchAttachmentUsage,
  fetchFriends,
  fetchHubPins,
  leaveConversation,
  lookupUser,
  markConversationRead,
  muteConversation,
  pinHubMessage,
  previewHubInvite,
  redeemHubInvite,
  removeMember,
  renameConversation,
  unmuteConversation,
  unpinHubMessage,
  uploadAttachment,
  type Friend,
} from "../api/client";
import { decodeBase64 } from "../api/base64";
import type { HubInvitePreview, HubPin } from "../api/types";
import { PROTOCOL_PUBLIC } from "../crypto/provider";
import { e2e } from "../crypto";
import { encryptBlob } from "../crypto/blob";
import { store } from "../store";
import type { StoredSession } from "../api/session";
import type { StoredConversation, StoredEvent } from "../store/types";
import { sync } from "../sync/engine";
import { mlsEnabled, mlsSync } from "../sync/mls";
import {
  useAnnouncements,
  useConversations,
  useDeliveredMarks,
  useHubs,
  usePresence,
  useSyncStatus,
  useTimeline,
  useTyping,
  type MessageMarks,
  type TimelineItem,
} from "./hooks";
import {
  Avatar,
  BackButton,
  BellIcon,
  BellOffIcon,
  Button,
  ErrorText,
  IconButton,
  Input,
  LockIcon,
  Note,
  Panel,
  PanelSection,
  PencilIcon,
  PinIcon,
  PlusIcon,
  ReplyIcon,
  SendIcon,
  TrashIcon,
  XIcon,
  UsersIcon,
  useConfirm,
} from "./kit";

// ---------------------------------------------------------------------------
// Rendering content
// ---------------------------------------------------------------------------

// Decoding no longer happens here: useTimeline and useLatestMessages hand
// this file already-decoded content (RenderableContent | null, where null is
// a decrypt still waiting for keys), because the same decode pass is what
// aggregates reactions, edits and retractions onto their targets. See the
// aggregation notes on useTimeline in hooks.ts.

/** The words for a notice line -- see StoredEvent in store/types.ts. */
function eventText(event: StoredEvent, selfUserId: string): string {
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
      return event.historyShared
        ? `${actor} added ${target}, with earlier messages shared`
        : `${actor} added ${target}`;
    case "member_removed":
      return `${actor} removed ${target}`;
    case "renamed":
      return event.title
        ? `${actor} named the group "${event.title}"`
        : `${actor} cleared the group name`;
  }
}

/**
 * How many other members have read up to this message.
 *
 * Their markers are already in the conversation payload -- this is a
 * comparison, not a request. Ids are uuidv7, so comparing them compares send
 * order, which is the same property the server relies on to move a marker
 * forward and never back.
 *
 * Members who turned read receipts off arrive with a null marker and are
 * counted as not having read, which is exactly what they asked for: their
 * absence is indistinguishable from not having got to it yet.
 */
function readCount(
  conversation: StoredConversation | undefined,
  selfUserId: string,
  messageId: string,
): number {
  if (!conversation) return 0;

  return conversation.members.filter(
    (member) =>
      member.userId !== selfUserId &&
      member.lastReadMessageId !== null &&
      member.lastReadMessageId >= messageId,
  ).length;
}

/**
 * The words for a read count.
 *
 * Nothing at all when nobody has read it, rather than "Read by 0" -- an
 * unread message showing a receipt reads as a delivery failure. In a 1:1
 * there is only one possible reader, so the count is noise and it is just
 * "Read".
 */
function readLabel(count: number, others: number): string | undefined {
  if (count === 0) return undefined;
  if (others <= 1) return "Read";
  if (count >= others) return "Read by everyone";
  return `Read by ${count}`;
}

/**
 * How many other members' devices have received this message -- the
 * delivered watermark comparison, same uuidv7 trick as readCount above.
 *
 * The marks arrive over the realtime socket and are best-effort: an empty
 * map means "nothing known", not "not delivered", which is why the absence
 * of a delivered label says nothing at all rather than showing a failure.
 */
function deliveredCount(
  marks: Record<string, string>,
  messageId: string,
): number {
  return Object.values(marks).filter((upTo) => upTo >= messageId).length;
}

/**
 * The words for a delivered count, mirroring readLabel's shape. Only ever
 * shown when nobody has read yet -- "Read" implies delivered, so showing
 * both would say less with more.
 */
function deliveredLabel(count: number, others: number): string | undefined {
  if (count === 0) return undefined;
  if (others <= 1) return "Delivered";
  if (count >= others) return "Delivered to everyone";
  return `Delivered to ${count}`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wraps the @Name runs of the people a message actually names (its payload's
 * `mentions` list resolved to display names) -- a plain "@" in prose is left
 * alone, because only the sender's list says who was meant.
 */
function highlightMentions(text: string, names: readonly string[]): ReactNode {
  if (names.length === 0) return text;
  const pattern = names.map((name) => `@${escapeRegex(name)}`).join("|");
  const parts = text.split(new RegExp(`(${pattern})`, "g"));
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    part.startsWith("@") && names.includes(part.slice(1)) ? (
      <span key={index} className="rounded bg-black/10 px-0.5 font-semibold dark:bg-white/20">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The banner for states worth interrupting the layout for.
 *
 * Deliberately says nothing about a routine sync. The loop ticks every two
 * seconds as a fallback, stretched to thirty while the realtime socket is
 * healthy, so a "Syncing…" banner would insert and remove itself from the
 * layout on every pass either way -- the content below it shifting down and
 * back on a rhythm the reader would learn to see. That is not a status
 * indicator, it is a flicker, and the information it conveys ("a sync pass
 * happened") is worth nothing to the person reading the conversation.
 *
 * What is worth showing is the three states that persist and that the user
 * can act on: history still loading, the server unreachable, the session
 * gone. Each of those is stable for seconds or longer, so the one-time shift
 * when it appears reads as a change rather than as jitter.
 *
 * Trouble is driven off `error` rather than `state === "offline"` on purpose.
 * While the connection is down the engine alternates between backing off and
 * retrying, so keying on the state would hide the banner for the duration of
 * every attempt -- the same flicker, just rarer and more confusing. The error
 * is set on failure and cleared only by a success, which is exactly the
 * condition worth rendering.
 */
function StatusLine() {
  const status = useSyncStatus();

  const label =
    status.state === "unauthorized"
      ? "Session expired"
      : status.state === "hydrating"
        ? "Loading history…"
        : status.error !== null
          ? status.error
          : null;

  if (!label) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      {label}
    </div>
  );
}

/**
 * A commit mismatch between this build and what the server reports it is
 * running -- see sync/engine.ts's #checkForUpdate. Never auto-reloads: a
 * deploy landing mid-compose must not lose a draft on its own, so this only
 * ever offers the reload, same as the tab would ask a person to do by hand.
 *
 * Names the server's version when `/health` reported one worth naming
 * (`status.updateVersion`, set only alongside `updateAvailable` -- see the
 * type's comment in sync/engine.ts); otherwise falls back to today's
 * wording, which is every build before tagging starts.
 */
function UpdateBanner() {
  const status = useSyncStatus();

  if (!status.updateAvailable) return null;

  const label = status.updateVersion
    ? `Version ${status.updateVersion} is available.`
    : "A new version is available.";

  return (
    <div className="flex items-center justify-between gap-2 border-b border-accent-100 bg-accent-50 px-4 py-1.5 text-xs text-accent-900 motion-safe:animate-fade-in dark:border-accent-900 dark:bg-accent-950 dark:text-accent-100">
      <span>{label}</span>
      <button
        onClick={() => window.location.reload()}
        className="shrink-0 font-medium underline"
      >
        Reload
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Starting a conversation
// ---------------------------------------------------------------------------

// ContactCheckboxRow moved to ContactRow.tsx when HubDetails became its
// third user -- see that file's comment.

// ---------------------------------------------------------------------------
// Group details
// ---------------------------------------------------------------------------

/**
 * Rename and add-members, in one panel -- the two things only a group can do.
 * Same full-screen shape as Friends and Settings, for the same reason.
 */
function GroupDetails({
  conversation,
  selfUserId,
  onClose,
}: {
  conversation: StoredConversation;
  selfUserId: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(conversation.title ?? "");
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  const [contacts, setContacts] = useState<Friend[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [username, setUsername] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Default OFF: the adder is making this call on behalf of every other
  // member's messages, not only their own.
  const [shareHistory, setShareHistory] = useState(false);

  // Which member is currently being removed, if any -- disables just that
  // row's button rather than the whole panel.
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const memberIds = useMemo(
    () => new Set(conversation.members.map((m) => m.userId)),
    [conversation.members],
  );

  useEffect(() => {
    void fetchFriends()
      .then((lists) => setContacts(lists.friends))
      .catch(() => setContacts([]));
  }, []);

  async function saveTitle(event: FormEvent) {
    event.preventDefault();
    setTitleBusy(true);
    setTitleError(null);
    try {
      await renameConversation({
        conversationId: conversation.id,
        title: title.trim() || null,
      });
      // The list is refreshed on a timer, same as after creating a
      // conversation -- nudge it rather than waiting up to 30 seconds.
      sync.invalidateConversations();
    } catch (caught) {
      setTitleError(
        caught instanceof ApiError ? caught.message : "Could not rename the group.",
      );
    } finally {
      setTitleBusy(false);
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
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        ),
      ];
      const typed = await Promise.all(names.map((name) => lookupUser(name)));

      const newIds = [
        ...new Set([...picked, ...typed.map((user) => user.id)]),
      ].filter((id) => id !== selfUserId && !memberIds.has(id));

      if (newIds.length === 0) return;

      await addMembers({
        conversationId: conversation.id,
        memberUserIds: newIds,
        shareHistory,
      });
      if (shareHistory && mlsEnabled()) {
        // The membership row is in; hand the new members the history-key
        // generations this device holds. Additive and idempotent, so a
        // failure here is retryable by re-adding with the box checked --
        // and the notice line records the *choice* either way.
        try {
          await mlsSync.shareHistory(conversation.id, newIds);
        } catch (caught) {
          console.warn("history share failed", caught);
        }
      }
      // Membership changed: nudge the conversation list now, and run the
      // MLS sweep now rather than up to 30 seconds later -- it issues the
      // Add/welcome and rotates the history key for the new roster.
      mlsSync.invalidate();
      sync.invalidateConversations();
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

  async function removeOne(userId: string): Promise<void> {
    setRemovingUserId(userId);
    setRemoveError(null);
    try {
      await removeMember({ conversationId: conversation.id, userId });
      // Same nudge as addMembers: membership changed, so run the MLS sweep
      // now (it issues the Remove and rotates the history key) rather than
      // waiting for its own cadence, and refresh the list now too.
      mlsSync.invalidate();
      sync.invalidateConversations();
    } catch (caught) {
      setRemoveError(
        caught instanceof ApiError ? caught.message : "Could not remove them.",
      );
    } finally {
      setRemovingUserId(null);
    }
  }

  async function doLeave(): Promise<void> {
    setLeaveBusy(true);
    setLeaveError(null);
    try {
      await leaveConversation(conversation.id);
      mlsSync.invalidate();
      sync.invalidateConversations();
      // Nothing left to show a member of a group they just left.
      onClose();
    } catch (caught) {
      setLeaveError(
        caught instanceof ApiError ? caught.message : "Could not leave the group.",
      );
      setLeaveBusy(false);
    }
  }

  // Contacts not already in the group and not yourself -- the only people
  // this form can usefully add.
  const addable = (contacts ?? []).filter(
    (contact) => !memberIds.has(contact.userId),
  );

  return (
    <Panel title="Group details" onClose={onClose}>
      <div>
        <PanelSection title="Name">
          <form onSubmit={saveTitle} className="flex gap-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Group name"
              maxLength={100}
            />
            <Button type="submit" size="sm" loading={titleBusy} className="shrink-0">
              Save
            </Button>
          </form>
          {titleError && <ErrorText className="mt-1">{titleError}</ErrorText>}
        </PanelSection>

        <PanelSection title={`Members (${conversation.members.length})`}>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {conversation.members.map((member) => (
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
                  <span className="truncate">
                    {member.displayName || member.username}
                    {member.userId === selfUserId && (
                      <span className="ml-1 text-xs text-neutral-500 dark:text-neutral-400">
                        (you)
                      </span>
                    )}
                  </span>
                </span>
                {member.userId !== selfUserId && (
                  <Button
                    variant="ghost-danger"
                    size="sm"
                    onClick={() => removeOne(member.userId)}
                    loading={removingUserId === member.userId}
                    className="shrink-0 hover:underline"
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {removeError && <ErrorText className="mt-1">{removeError}</ErrorText>}
        </PanelSection>

        <div className="border-b border-neutral-200 px-4 py-5 dark:border-neutral-800">
          <Button
            variant="danger"
            size="sm"
            onClick={doLeave}
            loading={leaveBusy}
            className="w-full"
          >
            Leave group
          </Button>
          {leaveError && <ErrorText className="mt-1">{leaveError}</ErrorText>}
        </div>

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
                  Everyone's earlier messages in this group, not only yours.
                  The notice line will say you did.
                </span>
              </span>
            </label>

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
      </div>
    </Panel>
  );
}

/**
 * Marks a conversation read while it is on screen.
 *
 * Two conditions, both necessary. The conversation has to be open, and the
 * page has to be *visible* -- a thread left open on a backgrounded tab is not
 * being read, and marking it would clear a badge for messages nobody saw, on
 * every device at once.
 *
 * Fires on the newest message this device holds, whenever that changes. The
 * server only moves the marker forward, so re-sending the same id is a no-op
 * and there is no need to track whether this call would be one.
 */
function useMarkRead(conversationId: string | null, selfUserId: string): void {
  const { items } = useTimeline(conversationId, selfUserId);

  // The newest *stored* message. Outbox entries are excluded: they have no
  // server id yet, and marking your own unsent message read means nothing.
  let newest: string | null = null;
  for (const item of items) {
    if (item.kind === "sent") newest = item.message.messageId;
  }

  useEffect(() => {
    if (!conversationId || !newest) return;

    let cancelled = false;

    const mark = (): void => {
      // A thread open on a backgrounded tab is not being read, and marking it
      // would clear the badge on every device for messages nobody saw.
      if (cancelled || document.visibilityState !== "visible") return;

      void markConversationRead(conversationId, newest)
        .then(async () => {
          if (cancelled) return;
          // Locally too, so the badge clears now rather than whenever the next
          // conversation refresh brings the marker back.
          await store.mergeReadMarker(
            conversationId,
            selfUserId,
            newest,
            new Date().toISOString(),
          );
          sync.invalidateConversations();
        })
        .catch(() => {
          // Not worth surfacing. The marker is a convenience, the messages
          // are already delivered, and opening this again will retry.
        });
    };

    mark();

    // Coming back to a tab that already had the conversation open has to mark
    // it too. Without this the effect's dependencies have not changed, so
    // nothing would run again until the next message arrived -- leaving a
    // badge on a conversation being looked at.
    document.addEventListener("visibilitychange", mark);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", mark);
    };
  }, [conversationId, newest, selfUserId]);
}

// ---------------------------------------------------------------------------
// Hubs
// ---------------------------------------------------------------------------

/**
 * The landing surface for /join/<token> links. Previews before joining --
 * nobody should enter a room on a tap they could not inspect -- and carries
 * the privacy-class label, since an invited stranger has seen none of the
 * other surfaces that say it.
 */
function JoinInvite({
  token,
  onDone,
}: {
  token: string;
  /** Called with the hub's first channel to open, or null on dismiss. */
  onDone: (channelId: string | null) => void;
}) {
  const [preview, setPreview] = useState<HubInvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void previewHubInvite(token)
      .then(setPreview)
      .catch((caught) => {
        // Wrong, expired, revoked and exhausted all answer the same 404 --
        // so this is the one honest sentence for all of them.
        setError(
          caught instanceof ApiError && caught.status === 404
            ? "This invite link isn't valid anymore."
            : "Could not check that invite. Try again in a moment.",
        );
      });
  }, [token]);

  async function join(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const detail = await redeemHubInvite(token);
      sync.invalidateConversations();
      onDone(detail.channels[0]?.id ?? null);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 404
          ? "This invite link isn't valid anymore."
          : caught instanceof ApiError
            ? caught.message
            : "Could not join. Check your connection.",
      );
      setBusy(false);
    }
  }

  return (
    <Panel title="Hub invite" onClose={() => onDone(null)}>
      <div className="space-y-3 p-4">
        {error ? (
          <ErrorText>{error}</ErrorText>
        ) : preview === null ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Checking the invite…
          </p>
        ) : (
          <>
            <p className="text-sm text-neutral-900 dark:text-neutral-100">
              You're invited to{" "}
              <span className="font-semibold">{preview.name}</span> —{" "}
              {preview.memberCount}{" "}
              {preview.memberCount === 1 ? "member" : "members"}.
            </p>
            <Note>
              {preview.visibility === "public"
                ? "Public hub — messages here are stored readable by the server so search and moderation can work."
                : "Private hub — every channel is end-to-end encrypted. Joining by link shares none of the earlier messages."}
            </Note>
            <Button onClick={join} loading={busy} className="w-full">
              Join hub
            </Button>
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * A channel's pinned messages. Public pins carry their payload (the server
 * can hand readable content to a proven member); private pins are
 * references only, rendered from whatever this device holds -- here, as a
 * line naming the sender, with the jump showing the local copy.
 */
function PinsPanel({
  hubId,
  conversationId,
  canModerate,
  onClose,
  onJump,
}: {
  hubId: string;
  conversationId: string;
  canModerate: boolean;
  onClose: () => void;
  onJump: (pin: HubPin) => void;
}) {
  const [pins, setPins] = useState<HubPin[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchHubPins({ hubId, conversationId })
      .then(setPins)
      .catch(() => setError("Could not load the pins."));
  }, [hubId, conversationId]);

  async function unpin(messageId: string): Promise<void> {
    try {
      await unpinHubMessage({ hubId, conversationId, messageId });
      setPins((current) =>
        (current ?? []).filter((pin) => pin.messageId !== messageId),
      );
    } catch {
      setError("Could not unpin that.");
    }
  }

  return (
    <Panel title="Pinned messages" onClose={onClose}>
      <div className="p-4">
        {error && <ErrorText>{error}</ErrorText>}
        {pins !== null && pins.length === 0 && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Nothing pinned in this channel yet.
          </p>
        )}
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {(pins ?? []).map((pin) => {
            const content = pin.payload
              ? decodeContent(decodeBase64(pin.payload))
              : null;
            const line =
              content !== null &&
              content !== "unsupported" &&
              !isMessageOp(content)
                ? excerptOf(content)
                : "Pinned message";
            return (
              <li key={pin.messageId} className="py-2">
                <button
                  onClick={() => onJump(pin)}
                  className="block w-full text-left"
                >
                  <span className="block text-xs font-medium text-neutral-900 dark:text-neutral-100">
                    {pin.senderDisplayName || pin.senderUsername}
                    <span className="ml-2 font-normal text-neutral-500 dark:text-neutral-400">
                      {new Date(pin.sentAt).toLocaleDateString()}
                    </span>
                  </span>
                  <span className="block truncate text-xs text-neutral-600 dark:text-neutral-300">
                    {line}
                  </span>
                </button>
                {canModerate && (
                  <Button
                    variant="ghost-danger"
                    size="sm"
                    onClick={() => unpin(pin.messageId)}
                    className="mt-0.5 hover:underline"
                  >
                    Unpin
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}

// ConversationList (with NewConversation, NewHub and HubsSection) moved to
// sidebar/Sidebar.tsx, sidebar/NewConversation.tsx, sidebar/NewHub.tsx and
// sidebar/HubsSection.tsx.

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * A reply being composed: what the composer bar shows, and what becomes the
 * payload's `replyTo` on send. The excerpt is copied here at reply time --
 * into the payload too, eventually -- because the target may not exist on a
 * receiving device (see ReplyContext in api/payload.ts). `senderName` is
 * display-only; payloads carry the id and let each reader resolve the name.
 */
type ReplyDraft = {
  messageId: string;
  excerpt: string;
  senderUserId: string;
  senderName: string;
};

/**
 * An edit being composed: the composer becomes the edit surface, prefilled
 * with the message's current text -- the messengers people know converge on
 * this over an in-bubble editor, and it reuses the context-bar slot the
 * reply already fills. `text` is the effective current text (a prior edit
 * included), because editing an edited message starts from what it says now.
 */
type EditDraft = {
  messageId: string;
  text: string;
};

/** The quoted line a reply shows: the text, or what stands in for it. */
function excerptOf(content: { text: string; attachments: unknown[] }): string {
  return (
    content.text.slice(0, 120) ||
    (content.attachments.length > 0 ? "Photo" : "")
  );
}

/** The fixed quick-react palette. A search-every-emoji picker is a
 *  dependency and a design problem for another day; six cover the register
 *  the messengers people know converge on. */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

/** Which emoji this user currently has on a message, if any. One per
 *  person by construction: per (target, reactor) the latest op wins. */
function myReaction(
  marks: MessageMarks | null,
  selfUserId: string,
): string | null {
  if (!marks) return null;
  for (const [emoji, users] of marks.reactions) {
    if (users.includes(selfUserId)) return emoji;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pressing a message
// ---------------------------------------------------------------------------

type PressPointerEvent = {
  pointerType: string;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
};

// Beyond this, a release is a scroll or a drag, not a tap.
const TAP_MOVE_PX = 10;
// Beyond this, a release is a genuine long-press. Below iOS's own long-press
// threshold, so with select-none in place (see Bubble) a hold this short
// never triggers the OS gesture in the first place.
const TAP_MAX_MS = 400;

function Bubble({
  mine,
  content,
  marks,
  meta,
  muted,
  sender,
  receipt,
  first = true,
  last = true,
  actions,
  actionsShown = false,
  onPress,
  quote,
  chips,
  mentionNames,
}: {
  mine: boolean;
  /**
   * Null when the payload cannot be read yet (no keys); `"unsupported"` when
   * it decoded fine but this build does not know the kind.
   */
  content: RenderableContent | null;
  /** What the ops targeting this message add up to -- see useTimeline. */
  marks?: MessageMarks | null;
  meta: string;
  muted?: boolean;
  /**
   * "Read", or "Read by 2", under your own messages. Never under anybody
   * else's -- telling you that you have read something you are looking at is
   * not information.
   */
  receipt?: string | undefined;
  /**
   * Who sent it, on incoming messages in a group.
   *
   * Omitted in a 1:1, where left-versus-right already says it, and omitted on
   * your own messages for the same reason. In a group the sides carry no
   * information -- everybody else is on the left -- so without this a
   * three-way conversation is unreadable.
   */
  sender?: string | undefined;
  /**
   * Position in a run of consecutive messages from one sender (see
   * sameRun in Timeline). The name renders on the first of a run and the
   * time on the last -- a run reads as one turn in the conversation, and
   * stamping every line of a turn says nothing five times.
   */
  first?: boolean;
  last?: boolean;
  /**
   * The floating action bar -- quick reactions, and Delete on your own
   * messages. Lives in the slack beside the bubble that stage 3 of the
   * reform reserved: revealed on hover on a mouse, held open by `onPress`'s
   * tap on touch, and absolutely positioned so appearing never re-flows the
   * timeline under the reader.
   */
  actions?:
    | {
        /** null clears this user's reaction; an emoji sets or replaces it. */
        onReact: (emoji: string | null) => void;
        /** This user's current reaction, so the bar can show the toggle. */
        current: string | null;
        onReply?: (() => void) | undefined;
        onEdit?: (() => void) | undefined;
        onDelete?: (() => void) | undefined;
        /** Moderators only -- pins are hub furniture, not personal state. */
        onPin?: (() => void) | undefined;
      }
    | undefined;
  actionsShown?: boolean;
  /**
   * Called on a qualifying tap or right-click -- the caller decides what
   * "press" means (Timeline toggles `actionsShown` for this message id).
   * Bubble owns the tap-vs-scroll disambiguation itself because it is the
   * one component that knows its own rendered bounds: the wrapper this
   * attaches to is sized to the message's own footprint (bubble, action
   * bar and chips together), not the full-width row around it, so a tap
   * anywhere else on the screen -- even directly beside a narrow bubble --
   * never lands on this message by accident. Undefined for messages with
   * nothing to press (retracted, or still unsent).
   */
  onPress?: (() => void) | undefined;
  /**
   * The quoted block a reply renders above its text -- resolved by the
   * caller (name lookup is roster knowledge), tappable to jump to the
   * target when it is loaded.
   */
  quote?: { name: string; excerpt: string; onJump: () => void } | undefined;
  /** Aggregated reaction chips, rendered under the bubble. */
  chips?:
    | { emoji: string; count: number; mine: boolean; label: string }[]
    | undefined;
  /** Display names this message mentions, for the text highlight. */
  mentionNames?: readonly string[] | undefined;
}) {
  const retracted = marks?.retracted === true;
  const edited = !retracted && marks?.editedText !== undefined;

  const pointerStart = useRef<{ x: number; y: number; at: number } | null>(
    null,
  );

  const handlePointerDown = (event: PressPointerEvent): void => {
    if (event.pointerType === "mouse") return;
    pointerStart.current = { x: event.clientX, y: event.clientY, at: Date.now() };
  };
  const handlePointerUp = (event: PressPointerEvent): void => {
    if (event.pointerType === "mouse") return;
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start) return;
    // A tap landing on a button (the quote block, or a button in the bar
    // itself) is that button's own action, not a toggle of the bar around
    // it -- jumping to a quoted message must not also pop its reactions.
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved > TAP_MOVE_PX || Date.now() - start.at > TAP_MAX_MS) return;
    onPress?.();
  };
  const handlePointerCancel = (): void => {
    pointerStart.current = null;
  };
  const handleContextMenu = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    onPress?.();
  };

  return (
    // Full-width alignment row, carrying no handlers of its own -- the
    // narrower press-target wrapper inside is what a tap actually has to
    // land inside, which is the whole fix: this outer box spans edge to
    // edge so `justify-end`/`justify-start` can place the bubble, but a
    // press anywhere in the empty space it leaves beside a narrow bubble
    // must not land on this message.
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        data-bubble-press
        className={`group relative flex min-w-0 max-w-[85%] flex-col md:max-w-[70%] ${
          mine ? "items-end" : "items-start"
        }${
          onPress
            ? // iOS Safari's own long-press gesture (text selection, the
              // Copy/Look Up callout) fires on the same touch a hold-based
              // trigger would need to wait for, and wins -- select-none is
              // the standard trade a chat app makes so long-press means
              // this menu, not the OS's (see WhatsApp/iMessage/Telegram).
              " touch-manipulation select-none [-webkit-touch-callout:none]"
            : ""
        }`}
        {...(onPress
          ? {
              onPointerDown: handlePointerDown,
              onPointerUp: handlePointerUp,
              onPointerCancel: handlePointerCancel,
              onContextMenu: handleContextMenu,
            }
          : {})}
      >
      {actions && !retracted && (
        <div
          className={`absolute -top-4 z-10 flex items-center gap-0.5 rounded-full border border-neutral-200 bg-white px-1 py-0.5 shadow-sm transition-opacity dark:border-neutral-700 dark:bg-neutral-800 ${
            // pointer-events-none and -auto must never both be present: they
            // tie at equal specificity, and whichever Tailwind happens to
            // emit later in the stylesheet wins regardless of which one this
            // ternary "meant" -- which is exactly how the bar ended up
            // visible (opacity flips correctly) but permanently unclickable
            // (pointer-events stuck on none) once actionsShown went true.
            // The hover branch is safe on its own: group-hover:pointer-
            // events-auto is a compound selector, genuinely higher
            // specificity than the plain pointer-events-none beside it, so
            // it always wins on its own regardless of source order.
            actionsShown
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
          } ${mine ? "right-2" : "left-2"}`}
        >
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              onClick={() =>
                actions.onReact(actions.current === emoji ? null : emoji)
              }
              className={`rounded-full px-1 py-0.5 text-sm transition-transform hover:bg-neutral-100 motion-safe:hover:scale-125 dark:hover:bg-neutral-700 ${
                actions.current === emoji
                  ? "bg-accent-50 dark:bg-neutral-700"
                  : ""
              }`}
            >
              {emoji}
            </button>
          ))}
          {actions.onReply && (
            <button
              type="button"
              onClick={actions.onReply}
              aria-label="Reply"
              className="rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            >
              <ReplyIcon className="h-4 w-4" />
            </button>
          )}
          {actions.onEdit && (
            <button
              type="button"
              onClick={actions.onEdit}
              aria-label="Edit message"
              className="rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            >
              <PencilIcon className="h-4 w-4" />
            </button>
          )}
          {actions.onPin && (
            <button
              type="button"
              onClick={actions.onPin}
              aria-label="Pin message"
              className="rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            >
              <PinIcon className="h-4 w-4" />
            </button>
          )}
          {actions.onDelete && (
            <button
              type="button"
              onClick={actions.onDelete}
              aria-label="Delete message"
              className="rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-red-400"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      <div
        className={`min-w-0 rounded-2xl px-3 py-2 ${
          mine
            ? "bg-accent-600 text-white"
            : "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
        } ${muted ? "opacity-60" : ""}`}
      >
        {sender && first && (
          <span className="mb-0.5 block text-[11px] font-medium opacity-70">
            {sender}
          </span>
        )}
        {quote && !retracted && (
          <button
            type="button"
            onClick={quote.onJump}
            className={`mb-1 block w-full rounded-md border-l-2 px-2 py-1 text-left text-xs ${
              mine
                ? "border-white/60 bg-white/15 text-white/90"
                : "border-accent-400 bg-neutral-100 text-neutral-600 dark:bg-neutral-700/60 dark:text-neutral-300"
            }`}
          >
            <span className="block font-medium">{quote.name}</span>
            <span className="block truncate">{quote.excerpt}</span>
          </button>
        )}
        {retracted ? (
          // The tombstone. A quiet line rather than a vanished bubble --
          // vanishing re-flows the timeline under the reader, and a person
          // half-remembering that something was here deserves the honest
          // answer that it was.
          <span className="text-sm italic opacity-60">Message deleted</span>
        ) : content === null ? (
          <span className="text-sm italic opacity-80">
            Encrypted message — waiting for keys
          </span>
        ) : content === "unsupported" ? (
          <span className="text-sm italic opacity-80">
            This message needs a newer version of the app
          </span>
        ) : (
          <>
            {content.attachments.length > 0 && (
              <span className="mb-1 block space-y-1">
                {content.attachments.map((attachment) => (
                  <Attachment key={attachment.id} attachment={attachment} />
                ))}
              </span>
            )}
            {(marks?.editedText ?? content.text).length > 0 && (
              <span className="whitespace-pre-wrap wrap-anywhere text-sm">
                {highlightMentions(
                  marks?.editedText ?? content.text,
                  mentionNames ?? [],
                )}
              </span>
            )}
          </>
        )}
        {(last || receipt) && (
          <span
            className={`mt-1 block text-[10px] ${
              mine ? "text-white/90" : "opacity-60"
            }`}
          >
            {meta}
            {edited && " · edited"}
            {receipt && ` · ${receipt}`}
          </span>
        )}
      </div>
      {!retracted && chips && chips.length > 0 && (
        <div className={`mt-0.5 flex flex-wrap gap-1 px-1 ${mine ? "justify-end" : ""}`}>
          {chips.map((chip) => (
            <button
              key={chip.emoji}
              type="button"
              title={chip.label}
              aria-label={`${chip.emoji} ${chip.label}${chip.mine ? " — tap to remove yours" : ""}`}
              onClick={() =>
                actions?.onReact(chip.mine ? null : chip.emoji)
              }
              className={`rounded-full border px-1.5 py-0.5 text-xs motion-safe:animate-fade-in ${
                chip.mine
                  ? "border-accent-300 bg-accent-50 text-accent-900 dark:border-accent-700 dark:bg-neutral-800 dark:text-accent-100"
                  : "border-neutral-200 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              }`}
            >
              {chip.emoji}
              {chip.count > 1 && <span className="ml-0.5">{chip.count}</span>}
            </button>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

/** A notice line: no bubble, no sender, no side -- centred and easy to skip. */
function Notice({ text }: { text: string }) {
  return (
    <div className="flex justify-center">
      <span className="max-w-[85%] wrap-anywhere text-center text-xs text-neutral-500 dark:text-neutral-400">
        {text}
      </span>
    </div>
  );
}

/** Two adjacent timeline items read as one turn when the same person sent
 *  both within a few minutes. Notices always break a run -- "X removed Y"
 *  between two messages is a boundary in the conversation, not a pause. */
const RUN_GAP_MS = 5 * 60_000;

function runIdentity(
  item: TimelineItem | undefined,
  selfUserId: string,
): { sender: string; at: number } | null {
  if (!item) return null;
  if (item.kind === "sent") {
    return {
      sender: item.message.senderUserId,
      at: Date.parse(item.message.sentAt),
    };
  }
  if (item.kind === "pending") {
    return { sender: selfUserId, at: Date.parse(item.entry.createdAt) };
  }
  return null;
}

function sameRun(
  a: TimelineItem | undefined,
  b: TimelineItem | undefined,
  selfUserId: string,
): boolean {
  const first = runIdentity(a, selfUserId);
  const second = runIdentity(b, selfUserId);
  return (
    first !== null &&
    second !== null &&
    first.sender === second.sender &&
    Math.abs(second.at - first.at) < RUN_GAP_MS
  );
}

function Timeline({
  conversationId,
  session,
  conversation,
  onReply,
  onEdit,
  moderation,
  canPost = true,
  jumpTo = null,
  onJumped,
}: {
  conversationId: string;
  session: StoredSession;
  /** Undefined until the conversation list catches up; only names depend on it. */
  conversation: StoredConversation | undefined;
  /** Hands a reply draft up to the shell, which owns the composer's bar. */
  onReply: (draft: ReplyDraft) => void;
  /** Same shape for an edit: the composer is the edit surface. */
  onEdit: (draft: EditDraft) => void;
  /** Set when the viewer moderates this channel's hub: pinning everywhere,
   *  and Remove on others' messages where the server can enforce it. */
  moderation?: { hubId: string; isPublic: boolean } | undefined;
  /** False in an announcement-only channel for a plain member: every action
   *  here is a send, so the whole bar stays hidden rather than 403ing. */
  canPost?: boolean;
  /** A message id to scroll to once it is rendered -- search and pin jumps.
   *  The hook pages older store content until it appears (bounded). */
  jumpTo?: string | null;
  onJumped?: (() => void) | undefined;
}) {
  const { items, hasMore, loadOlder } = useTimeline(
    conversationId,
    session.user.id,
  );
  const delivered = useDeliveredMarks(conversationId);

  // Which message's edge actions are showing. Hover needs no state -- CSS
  // alone reveals the bar on a mouse; Bubble's own onPress is the touch path
  // to the same affordance, scoped to that message's own rendered bounds
  // (see the prop's comment on Bubble) rather than to this row's full width.
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  useEffect(() => setActionsFor(null), [conversationId]);
  const { confirm, confirmDialog } = useConfirm();

  /**
   * Delete for everyone: an ordinary send whose payload is a retract op --
   * see the ops notes on useTimeline in hooks.ts. Silent, because a phone
   * ringing over a deletion would be worse than the message it removes; the
   * optimistic outbox application is what tombstones it before the round
   * trip completes.
   */
  const retractMessage = async (messageId: string): Promise<void> => {
    if (
      !(await confirm({
        message: "Delete this message for everyone?",
        confirmLabel: "Delete",
      }))
    ) {
      return;
    }
    setActionsFor(null);
    void sync.enqueue(
      conversationId,
      encodeOp({ kind: "retract", target: messageId }),
      { silent: true },
    );
  };

  /**
   * Moderator removal of someone else's message -- server-enforced, public
   * channels only. The local copy goes too, and other devices follow via
   * the message_deleted hub event their sync engines act on.
   */
  const moderatorDelete = async (messageId: string): Promise<void> => {
    if (!moderation) return;
    if (
      !(await confirm({
        message: "Remove this message for everyone in the channel?",
        confirmLabel: "Remove",
      }))
    ) {
      return;
    }
    setActionsFor(null);
    try {
      await deleteHubMessage({
        hubId: moderation.hubId,
        conversationId,
        messageId,
      });
      await store.deleteMessages([messageId]);
      sync.notifyMessagesChanged([conversationId]);
    } catch (caught) {
      console.warn("moderator delete failed", caught);
    }
  };

  const pinMessage = (messageId: string): void => {
    if (!moderation) return;
    setActionsFor(null);
    void pinHubMessage({
      hubId: moderation.hubId,
      conversationId,
      messageId,
    }).catch((caught) => console.warn("pin failed", caught));
  };

  /**
   * Sets, replaces or (with null) removes this user's reaction -- the same
   * silent-op send as a retraction, aggregated the same way, so the chip
   * appears optimistically from the outbox before the server confirms.
   */
  const sendReaction = (messageId: string, emoji: string | null): void => {
    setActionsFor(null);
    void sync.enqueue(
      conversationId,
      encodeOp({ kind: "reaction", target: messageId, emoji }),
      { silent: true },
    );
  };

  // Names by user id, so attribution is a lookup rather than a scan per
  // message. Only built for groups and channels, since a 1:1 never shows
  // them. A channel shows senders at ANY size -- unlike a group, its
  // membership can grow past whoever is in the room right now, so "who
  // said this" is always information.
  const isGroup =
    conversation?.kind === "channel" ||
    (conversation?.members.length ?? 0) > 2;
  // Everybody but you. Used to decide whether "Read" means everyone.
  const others = Math.max(0, (conversation?.members.length ?? 1) - 1);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of conversation?.members ?? []) {
      map.set(member.userId, member.displayName || member.username);
    }
    return map;
  }, [conversation]);

  /** Resolves a message's replyTo into the quote block Bubble renders. */
  const quoteOf = (content: RenderableContent | null) => {
    if (content === null || content === "unsupported" || !content.replyTo) {
      return undefined;
    }
    const reply = content.replyTo;
    return {
      name:
        reply.senderUserId === session.user.id
          ? "You"
          : (names.get(reply.senderUserId) ?? "Someone"),
      excerpt: reply.excerpt,
      // Jump to the target if it is loaded. If it is above the loaded page
      // this is simply a no-op -- honest, since nothing can scroll to a row
      // that does not exist.
      onJump: () => {
        document.getElementById(`msg-${reply.messageId}`)?.scrollIntoView({
          block: "center",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
      },
    };
  };

  const bottom = useRef<HTMLDivElement>(null);
  const count = items.length;

  useEffect(() => {
    // A jump in progress owns the scroll position; pinning to the bottom
    // here would yank the reader away from the very message they asked for.
    if (jumpTo) return;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count, conversationId, jumpTo]);

  // The jump: scroll once the target renders; page older store content
  // until it does (the target is already stored by the caller). Bounded so
  // a vanished id cannot grow the page forever.
  const jumpTries = useRef(0);
  useEffect(() => {
    if (!jumpTo) {
      jumpTries.current = 0;
      return;
    }
    const el = document.getElementById(`msg-${jumpTo}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 800 });
      jumpTries.current = 0;
      onJumped?.();
    } else if (hasMore && jumpTries.current < 40) {
      jumpTries.current += 1;
      loadOlder();
    } else {
      jumpTries.current = 0;
      onJumped?.();
    }
  }, [jumpTo, items, hasMore, loadOlder, onJumped]);

  // The keyboard opening makes this pane shorter without moving what is
  // scrolled, so the newest message ends up hidden behind the composer at the
  // exact moment somebody is about to reply to it. Re-pin on every visual
  // viewport resize, which is the keyboard appearing, disappearing, or the
  // device being rotated.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const pin = (): void => {
      bottom.current?.scrollIntoView({ block: "end" });
    };

    viewport.addEventListener("resize", pin);
    return () => viewport.removeEventListener("resize", pin);
  }, []);

  // What separates a message *arriving* from a message being *loaded*: the
  // moment this conversation was opened. Only things newer than that animate
  // in -- fifty stored messages sliding up together on open would be the
  // decoration the motion rules forbid, and it would run on every switch.
  const openedAt = useMemo(() => Date.now(), [conversationId]);

  // The newest message you sent, which is the ONE that shows a receipt.
  // Per-message receipts were noise stacked on noise: "Read" under the last
  // message already says everything above it was read too (markers are
  // monotone), and delivered marks are watermarks with the same property.
  const newestOwnId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.kind === "sent" && item.message.senderUserId === session.user.id) {
        return item.message.messageId;
      }
    }
    return null;
  }, [items, session.user.id]);

  return (
    <div
      className="flex-1 overflow-y-auto bg-neutral-50 p-4 dark:bg-transparent"
      onClick={(event) => {
        // A tap inside a message's own press-bounded wrapper already
        // toggled that message's bar via Bubble's onPress (and toggling
        // TO a different message closes whatever was open, being the same
        // single-valued state) -- this only ever needs to act on genuine
        // dead space: empty timeline area, a notice line, the load-older
        // button. Checked by data attribute rather than the row's id,
        // because the row itself is still full width; only the marked
        // inner wrapper is the message's actual footprint.
        if (actionsFor === null) return;
        if (
          event.target instanceof Element &&
          event.target.closest("[data-bubble-press]")
        ) {
          return;
        }
        setActionsFor(null);
      }}
    >
      {hasMore && (
        <button
          onClick={loadOlder}
          className="mx-auto block rounded-md px-3 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          Load older messages
        </button>
      )}

      {items.map((item: TimelineItem, index) => {
        if (item.kind === "event") {
          return (
            <div key={item.event.id} className="mt-3">
              <Notice text={eventText(item.event, session.user.id)} />
            </div>
          );
        }

        // A run reads as one turn: tight spacing inside it, a real gap
        // between turns, the name once and the time once.
        const self = session.user.id;
        const first = !sameRun(items[index - 1], item, self);
        const last = !sameRun(item, items[index + 1], self);
        const live = (runIdentity(item, self)?.at ?? 0) > openedAt - 1_000;
        const entrance = live ? " motion-safe:animate-message-in" : "";

        if (item.kind === "sent") {
          const mine = item.message.senderUserId === session.user.id;
          const chips = (item.marks?.reactions ?? []).map(([emoji, users]) => ({
            emoji,
            count: users.length,
            mine: users.includes(session.user.id),
            label: users
              .map((userId) =>
                userId === session.user.id
                  ? "You"
                  : (names.get(userId) ?? "Someone"),
              )
              .join(", "),
          }));
          const content = item.content;
          return (
            <div
              key={item.message.messageId}
              id={`msg-${item.message.messageId}`}
              className={(first ? "mt-3" : "mt-0.5") + entrance}
            >
              <Bubble
                mine={mine}
                first={first}
                last={last}
                content={content}
                marks={item.marks}
                meta={time(item.message.sentAt)}
                sender={
                  isGroup && !mine
                    ? (names.get(item.message.senderUserId) ?? "Someone")
                    : undefined
                }
                quote={quoteOf(content)}
                mentionNames={
                  content !== null &&
                  content !== "unsupported" &&
                  content.mentions
                    ? content.mentions
                        .map((userId) =>
                          userId === session.user.id
                            ? session.user.displayName
                            : names.get(userId),
                        )
                        .filter((name): name is string => name !== undefined)
                    : undefined
                }
                actions={canPost ? {
                  onReact: (emoji) =>
                    sendReaction(item.message.messageId, emoji),
                  current: myReaction(item.marks, session.user.id),
                  // Replying quotes the content, so there is nothing to
                  // reply to on a placeholder or a still-sealed message.
                  onReply:
                    content !== null && content !== "unsupported"
                      ? () => {
                          setActionsFor(null);
                          onReply({
                            messageId: item.message.messageId,
                            excerpt: excerptOf(content),
                            senderUserId: item.message.senderUserId,
                            senderName: mine
                              ? "You"
                              : (names.get(item.message.senderUserId) ??
                                "Someone"),
                          });
                        }
                      : undefined,
                  // Editing starts from what the message says NOW -- a
                  // prior edit included -- and only your own text is yours
                  // to change.
                  onEdit:
                    mine && content !== null && content !== "unsupported"
                      ? () => {
                          setActionsFor(null);
                          onEdit({
                            messageId: item.message.messageId,
                            text: item.marks?.editedText ?? content.text,
                          });
                        }
                      : undefined,
                  onDelete: mine
                    ? () => void retractMessage(item.message.messageId)
                    : moderation?.isPublic
                      ? () => void moderatorDelete(item.message.messageId)
                      : undefined,
                  onPin: moderation
                    ? () => pinMessage(item.message.messageId)
                    : undefined,
                } : undefined}
                actionsShown={actionsFor === item.message.messageId}
                onPress={
                  item.marks?.retracted || !canPost
                    ? undefined
                    : () =>
                        setActionsFor((current) =>
                          current === item.message.messageId
                            ? null
                            : item.message.messageId,
                        )
                }
                chips={chips}
                receipt={
                  // A tombstone with "Delivered" under it would be receipts
                  // for a message that no longer says anything.
                  item.message.messageId === newestOwnId &&
                  !item.marks?.retracted
                    ? readLabel(
                        readCount(
                          conversation,
                          session.user.id,
                          item.message.messageId,
                        ),
                        others,
                      ) ??
                      deliveredLabel(
                        deliveredCount(delivered, item.message.messageId),
                        others,
                      )
                    : undefined
                }
              />
            </div>
          );
        }
        return (
          <div
            key={item.entry.clientMessageId}
            className={(first ? "mt-3" : "mt-0.5") + entrance}
          >
            <Bubble
              mine
              muted
              first={first}
              last={last}
              content={item.content}
              quote={quoteOf(item.content)}
              meta={
                item.entry.failedPermanently
                  ? `Failed — ${item.entry.lastError ?? "not sent"}`
                  : "Sending…"
              }
            />
          </div>
        );
      })}

      <div ref={bottom} />
      {confirmDialog}
    </div>
  );
}

/**
 * "Online", quietly, under the conversation title. Null while no presence
 * answer has arrived -- unknown is rendered as nothing, never as offline,
 * because the absence of an answer carries no information (see usePresence).
 * The reform owns this surface's real design; this is the honest minimum.
 */
function Presence({
  conversationId,
  conversation,
}: {
  conversationId: string;
  conversation: StoredConversation | undefined;
}) {
  const online = usePresence(conversationId);
  if (online === null || online.length === 0) return null;

  const isGroup =
    conversation?.kind === "channel" ||
    (conversation?.members.length ?? 0) > 2;
  return (
    <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
      {isGroup ? `${online.length} online` : "Online"}
    </span>
  );
}

/**
 * The typing indicator, in the slot between timeline and composer.
 *
 * The line reserves its height whether or not anyone is typing: appearing
 * and disappearing at typing speed would bounce the composer up and down
 * under the user's thumbs, the exact flicker StatusLine's comment warns
 * about.
 */
function TypingLine({
  conversationId,
  conversation,
}: {
  conversationId: string;
  conversation: StoredConversation | undefined;
}) {
  const typing = useTyping(conversationId);

  let text = "";
  if (typing.length === 1 && conversation) {
    text = `${memberName(conversation, typing[0]!)} is typing…`;
  } else if (typing.length > 1) {
    text = "Several people are typing…";
  }

  return (
    <div className="h-5 shrink-0 px-4 text-xs italic text-neutral-500 dark:text-neutral-400">
      {/* The height never moves (see above); only the words fade in. Keyed
          so a change of who is typing re-runs the fade. */}
      {text && (
        <span key={text} className="motion-safe:animate-fade-in">
          {text}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

type Pending = {
  file: File;
  /** A local preview, so a photo appears the moment it is chosen. */
  url: string;
};

function Composer({
  conversationId,
  publicChannel,
  members,
  slowmodeSeconds,
  reply,
  onClearReply,
  edit,
  onClearEdit,
}: {
  conversationId: string;
  /**
   * The other members, for @-mention autocomplete. Mentions ride the
   * payload additively (api/payload.ts) -- highlight everywhere, and in a
   * public channel the server reads them to push exactly the people named.
   */
  members: readonly { userId: string; name: string }[];
  /** Shown when set; the server enforces it (mods exempt, ops exempt). */
  slowmodeSeconds: number | null;
  /**
   * True in a public hub channel, where nothing is sealed: the message
   * payload goes up readable (protocol v4 -- sync/engine.ts's enqueue
   * decides that on its own from the stored conversation), and attachments
   * skip the blob seal here for the same honesty -- a key that rides inside
   * a readable payload protects nothing, so encrypting the blob would be
   * decoration pretending to be a property.
   */
  publicChannel: boolean;
  /** The reply being composed, owned by the shell so Timeline can set it. */
  reply: ReplyDraft | null;
  onClearReply: () => void;
  /** The edit being composed. The shell keeps this and `reply` exclusive. */
  edit: EditDraft | null;
  onClearEdit: () => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // How this field was last touched -- the same pointerType signal Bubble's
  // press handling uses, never the platform (see CLAUDE.md's sharp edge on
  // this, and the action bar's tap trigger it points at). A touch keyboard's
  // Return breaks the line; a hardware keyboard's Enter sends.
  const touchInput = useRef(false);

  // The @-token being typed at the caret, or null. Suggestion picks insert
  // "@Name " and remember name -> id here; at send time only the names still
  // present in the text become the payload's mentions, so deleting a name
  // un-mentions the person without any bookkeeping.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const mentionsPicked = useRef(new Map<string, string>());
  useEffect(() => {
    mentionsPicked.current.clear();
    setMentionQuery(null);
  }, [conversationId]);

  const mentionMatches =
    mentionQuery === null
      ? []
      : members
          .filter((member) =>
            member.name.toLowerCase().startsWith(mentionQuery.toLowerCase()),
          )
          .slice(0, 5);

  function readMentionQuery(value: string, caret: number): void {
    const before = value.slice(0, caret);
    const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);
    setMentionQuery(match ? match[2]! : null);
  }

  function pickMention(member: { userId: string; name: string }): void {
    const el = textarea.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const replaced = before.replace(/@([^\s@]{0,30})$/, `@${member.name} `);
    mentionsPicked.current.set(member.name, member.userId);
    setText(replaced + after);
    setMentionQuery(null);
    el?.focus();
  }

  // Entering edit mode loads the message's current text over whatever was
  // being typed; leaving it (cancel or save, both of which clear `edit`
  // explicitly alongside the text) never runs this.
  useEffect(() => {
    if (edit) setText(edit.text);
  }, [edit]);

  // Grows the textarea with its content, up to the CSS max-height (then it
  // scrolls internally). Resetting to "auto" first is what lets it shrink
  // back down when text is deleted, not just grow.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const cancelEdit = (): void => {
    onClearEdit();
    setText("");
  };

  // Revoke preview URLs when they stop being used, or every photo somebody
  // picks and reconsiders is held in memory until the page is reloaded.
  useEffect(() => {
    return () => {
      for (const item of pending) URL.revokeObjectURL(item.url);
    };
  }, [pending]);

  function choose(event: FormEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];

    setPending((current) => [
      ...current,
      ...files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    ]);
    setError(null);

    // Cleared so picking the same file twice in a row still fires a change.
    input.value = "";
  }

  function remove(index: number): void {
    setPending((current) => {
      const item = current[index];
      if (item) URL.revokeObjectURL(item.url);
      return current.filter((_, i) => i !== index);
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();

    const trimmed = text.trim();
    if (busy) return;

    // Edit mode: the send button saves the edit -- a silent op, aggregated
    // like any other, so the bubble re-renders from the outbox before the
    // round trip. Emptying the text is not a retraction; Delete is, and
    // conflating them would make a slip of the keyboard destructive.
    if (edit) {
      if (trimmed.length === 0) return;
      const target = edit.messageId;
      cancelEdit();
      await sync.enqueue(
        conversationId,
        encodeOp({ kind: "edit", target, text: trimmed }),
        { silent: true },
      );
      return;
    }

    if (trimmed.length === 0 && pending.length === 0) return;

    setBusy(true);
    setError(null);

    try {
      // Uploaded before the message is queued, because the payload has to
      // carry the ids. That makes an attachment send fail *before* anything is
      // in the outbox, which is the right way round: a queued message
      // referring to an upload that never happened would retry forever and
      // never work.
      const limits = await fetchAttachmentUsage();
      const attachments: AttachmentRef[] = [];

      for (const item of pending) {
        const prepared = await prepareForUpload(item.file, limits.maxBytes);

        if ("kind" in prepared) {
          setError(prepared.message);
          return;
        }

        // Under MLS the blob is sealed before it leaves this device, with a
        // fresh single-use key that rides inside the message payload -- the
        // one place already encrypted to exactly this conversation's
        // readers. See crypto/blob.ts. The passthrough build keeps
        // uploading plaintext, same as the messages around it -- and so
        // does a public channel, whose payload is readable by design (see
        // the publicChannel prop above): the ref then carries no key
        // fields, which every client already reads as the plaintext form.
        const sealed =
          e2e.handshake && !publicChannel
            ? await encryptBlob(prepared.bytes)
            : null;

        const uploaded = await uploadAttachment(
          conversationId,
          sealed ? sealed.ciphertext : prepared.bytes,
        );

        attachments.push({
          id: uploaded.id,
          mediaType: prepared.mediaType,
          byteSize: uploaded.byteSize,
          ...(prepared.width ? { width: prepared.width } : {}),
          ...(prepared.height ? { height: prepared.height } : {}),
          ...(sealed ? sealed.ref : {}),
        });
      }

      // Cleared before the await, so typing the next message is never blocked
      // on the network. The message is durable in the outbox by the time this
      // resolves, and the engine owns delivering it.
      setText("");
      for (const item of pending) URL.revokeObjectURL(item.url);
      setPending([]);
      if (reply) onClearReply();

      // Only the names still present count -- see the mention state above.
      const mentionIds = [...mentionsPicked.current]
        .filter(([name]) => trimmed.includes(`@${name}`))
        .map(([, userId]) => userId);
      mentionsPicked.current.clear();

      await sync.enqueue(
        conversationId,
        encodeContent({
          text: trimmed,
          attachments,
          ...(reply
            ? {
                replyTo: {
                  messageId: reply.messageId,
                  excerpt: reply.excerpt,
                  senderUserId: reply.senderUserId,
                },
              }
            : {}),
          ...(mentionIds.length > 0 ? { mentions: mentionIds } : {}),
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not send that. Check your connection.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-t border-neutral-200 p-3 dark:border-neutral-800"
    >
      {pending.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto">
          {pending.map((item, index) => (
            <div key={item.url} className="relative shrink-0">
              <img
                src={item.url}
                alt=""
                className="h-16 w-16 rounded-md object-cover"
              />
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label="Remove attachment"
                className="absolute -right-1 -top-1 rounded-full bg-neutral-900 px-1.5 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <ErrorText className="mb-2">{error}</ErrorText>}

      {/* The reply-context bar, in the slot the stage-3 comment below
          reserved for it. Height comes and goes with the reply -- that is a
          deliberate act by the user, not the ambient flicker the typing
          line's fixed height guards against. */}
      {reply && !edit && (
        <div className="mb-2 flex items-center gap-2 rounded-md border-l-2 border-accent-400 bg-neutral-100 px-2 py-1 motion-safe:animate-fade-in dark:bg-neutral-800">
          <span className="min-w-0 flex-1 text-xs text-neutral-600 dark:text-neutral-300">
            <span className="block font-medium">
              Replying to {reply.senderName}
            </span>
            <span className="block truncate">{reply.excerpt}</span>
          </span>
          <IconButton
            label="Cancel reply"
            onClick={onClearReply}
            className="shrink-0"
          >
            <XIcon className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      {edit && (
        <div className="mb-2 flex items-center gap-2 rounded-md border-l-2 border-accent-400 bg-neutral-100 px-2 py-1 motion-safe:animate-fade-in dark:bg-neutral-800">
          <span className="min-w-0 flex-1 text-xs text-neutral-600 dark:text-neutral-300">
            <span className="block font-medium">Editing message</span>
            <span className="block truncate">{edit.text}</span>
          </span>
          <IconButton
            label="Cancel edit"
            onClick={cancelEdit}
            className="shrink-0"
          >
            <XIcon className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      {mentionMatches.length > 0 && !edit && (
        <div className="mb-2 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
          {mentionMatches.map((member) => (
            <button
              key={member.userId}
              type="button"
              onClick={() => pickMention(member)}
              className="block w-full px-3 py-1.5 text-left text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800"
            >
              @{member.name}
            </button>
          ))}
        </div>
      )}

      {/* A column on purpose: the row below keeps the reply-context bar's
          slot above it (filled by the block above since the wave's stage 3),
          and the row itself has room for a mic button beside the attach one
          for the same reason. */}
      <div className="flex items-center gap-2">
        {/* accept without capture. `capture` forces the camera and removes the
            photo library, which on a phone is where the photo somebody wants
            to send almost always already is. */}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          onInput={choose}
          className="hidden"
        />
        {/* No attach while editing: an edit replaces text only, and the
            target's attachments stay exactly as sent. */}
        {!edit && (
          <IconButton
            label="Attach a photo"
            onClick={() => fileInput.current?.click()}
            className="rounded-full"
          >
            <PlusIcon />
          </IconButton>
        )}
        <textarea
          ref={textarea}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            readMentionQuery(
              e.target.value,
              e.target.selectionStart ?? e.target.value.length,
            );
            // The typing signal, on input rather than on a timer. The
            // engine floors this to one frame per few seconds, so calling
            // it per keystroke is the debounce, not a violation of one.
            if (e.target.value.length > 0) sync.sendTyping(conversationId);
          }}
          onPointerDown={(e) => {
            touchInput.current = e.pointerType !== "mouse";
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
            // Touch keyboard: Return breaks the line, and only the send
            // button sends. Hardware keyboard: Enter sends (Shift+Enter
            // breaks the line, handled by the guard above).
            if (touchInput.current) return;
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }}
          placeholder="Message"
          className="max-h-32 min-w-0 flex-1 resize-none overflow-y-auto rounded-full border border-neutral-300 bg-white px-4 py-2 text-base outline-none transition-colors focus:border-neutral-500 md:text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={busy || (text.trim().length === 0 && pending.length === 0)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-600 text-white transition hover:bg-accent-700 disabled:bg-neutral-300 motion-safe:active:scale-90 dark:disabled:bg-neutral-700"
        >
          <SendIcon className="h-4.5 w-4.5" />
        </button>
      </div>
      {slowmodeSeconds !== null && (
        <Note className="mt-1">
          Slowmode is on — one message every {slowmodeSeconds}s.
        </Note>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function Chat({
  session,
  onSignOut,
  inviteToken = null,
  onInviteHandled = () => {},
}: {
  session: StoredSession;
  onSignOut: () => void;
  /** A hub invite from a /join/<token> link, handled before anything else. */
  inviteToken?: string | null;
  onInviteHandled?: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [groupDetailsOpen, setGroupDetailsOpen] = useState(false);
  /** Which hub's panel is open, by hub id -- the channel-class sibling of
   *  groupDetailsOpen. */
  const [hubDetailsFor, setHubDetailsFor] = useState<string | null>(null);
  /** Which channel's pin list is open. */
  const [pinsFor, setPinsFor] = useState<string | null>(null);
  /** A message id the open timeline should scroll to -- search/pin jumps. */
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  // Owned here rather than by Timeline or Composer, because it is the one
  // piece of state they share: the bar's Reply action sets it, the
  // composer renders and consumes it. Reset on switching conversations --
  // a reply drafted in one thread must not attach to another.
  const [replyDraft, setReplyDraft] = useState<ReplyDraft | null>(null);
  // Edit shares the composer's context-bar slot, so the two are exclusive:
  // starting either clears the other.
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  useEffect(() => {
    setReplyDraft(null);
    setEditDraft(null);
  }, [selected]);
  const [muteBusy, setMuteBusy] = useState(false);
  const { conversations } = useConversations();
  const { hubs } = useHubs();
  const isDesktop = useIsDesktop();
  // Only the count; the list itself renders in Settings. Zero whenever the
  // announcements flag is off, so the dot is dark exactly when the feature is.
  const { unread: unreadAnnouncements } = useAnnouncements();

  // Only when a thread is actually on screen. On a phone that is the same
  // thing as being selected; on desktop both panes are visible at once.
  useMarkRead(selected, session.user.id);

  // Open the newest conversation on first load, so the app does not start on
  // an empty panel when there is something to show.
  //
  // Desktop only. On a phone the two panes are two screens, and pre-selecting
  // means opening the app *inside* a thread with a back button as the only
  // clue that a list exists.
  //
  // Fires once per MOUNT, not once per isDesktop-becomes-true: `isDesktop` is
  // a width media query, and an iPhone in landscape is wider than `md`, so
  // without the ref below this effect re-ran on every rotation past the
  // breakpoint and wrote `selected` again. Rotating back to portrait then
  // left that selection standing -- the phone landed inside a thread it
  // never opened. The ref latches only once the selection actually happens
  // (conversations can still be loading when this first runs), so a genuine
  // first desktop load still works.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (!isDesktop) return;
    if (selected !== null || !conversations[0]) return;
    autoSelectedRef.current = true;
    setSelected(conversations[0].id);
  }, [conversations, selected, isDesktop]);

  const current = conversations.find((c) => c.id === selected);

  // The channel's hub-side settings and the viewer's role, from the hubs
  // summary the engine keeps -- the mirror of the server's matrix, for
  // showing controls; the server enforces for real.
  const currentHub = hubs.find((hub) => hub.id === current?.hubId);
  const channelInfo = currentHub?.channels.find(
    (channel) => channel.id === selected,
  );
  const canModerate =
    currentHub !== undefined && currentHub.role !== "member";
  const restricted =
    channelInfo?.posting === "moderators" && !canModerate;

  /**
   * The jump half of search and pins: store the archived message locally (a
   * public channel's payload is handed over readable), pull a little context
   * around it, then open the channel scrolled to it. A private pin carries
   * no payload; the jump then shows whatever this device already holds.
   */
  async function jumpToArchived(target: {
    conversationId: string;
    messageId: string;
    payload: string | null;
    senderUserId: string;
    senderDeviceId: string;
    sentAt: string;
  }): Promise<void> {
    if (target.payload !== null) {
      await store.putMessages([
        {
          messageId: target.messageId,
          conversationId: target.conversationId,
          senderUserId: target.senderUserId,
          senderDeviceId: target.senderDeviceId,
          protocolVersion: PROTOCOL_PUBLIC,
          payload: decodeBase64(target.payload),
          sentAt: target.sentAt,
        },
      ]);
      try {
        const [older, newer] = await Promise.all([
          fetchArchive({
            conversationId: target.conversationId,
            cursor: target.messageId,
            limit: 25,
          }),
          fetchArchive({
            conversationId: target.conversationId,
            after: target.messageId,
            limit: 25,
          }),
        ]);
        const context = [...older.entries, ...newer.entries]
          .filter((entry) => entry.protocolVersion === PROTOCOL_PUBLIC)
          .map((entry) => ({
            messageId: entry.messageId,
            conversationId: entry.conversationId,
            senderUserId: entry.senderUserId,
            senderDeviceId: entry.senderDeviceId,
            protocolVersion: entry.protocolVersion,
            payload: decodeBase64(entry.payload),
            sentAt: entry.sentAt,
          }));
        if (context.length > 0) await store.putMessages(context);
      } catch {
        // Context is a nicety; the hit itself is already stored.
      }
      sync.notifyMessagesChanged([target.conversationId]);
    }
    setSelected(target.conversationId);
    setJumpTarget(target.messageId);
  }

  /**
   * Mutation + refresh, the same shape as GroupDetails' saveTitle/removeOne:
   * call the endpoint, then nudge the conversation list so the toggle's new
   * state is what the store reports, rather than optimistically flipping
   * local state that a failed request would leave wrong.
   */
  async function toggleMute(conversationId: string, muted: boolean): Promise<void> {
    setMuteBusy(true);
    try {
      if (muted) await unmuteConversation(conversationId);
      else await muteConversation(conversationId);
      sync.invalidateConversations();
    } catch (caught) {
      console.warn("mute toggle failed", caught);
    } finally {
      setMuteBusy(false);
    }
  }

  // Nothing resets the selection any more, on purpose.
  //
  // It used to, to rescue a phone from a thread pane with no way out. That was
  // treating the symptom: the pane is now driven by the selected *id*, which
  // is all the timeline and composer ever needed, so it renders -- with its
  // back button -- whether or not the metadata has arrived. `current` is only
  // consulted for the title.
  //
  // Which matters most in the case that produced the bug: starting a new
  // conversation selects an id the list has not been refreshed with yet, and
  // on a brand new account the list is empty, so the old guard
  // (`conversations.length > 0`) declined to rescue exactly the person who
  // most needed rescuing.

  // One pane at a time below md, both above it. Rendered rather than hidden:
  // the list and the thread each hold a subscription per conversation, and
  // there is no reason to run the one nobody can see.
  const showList = isDesktop || selected === null;
  const showThread = isDesktop || selected !== null;

  if (inviteToken) {
    return (
      <JoinInvite
        token={inviteToken}
        onDone={(channelId) => {
          onInviteHandled();
          if (channelId) setSelected(channelId);
        }}
      />
    );
  }

  if (pinsFor !== null && current?.hubId) {
    return (
      <PinsPanel
        hubId={current.hubId}
        conversationId={pinsFor}
        canModerate={canModerate}
        onClose={() => setPinsFor(null)}
        onJump={(pin) => {
          setPinsFor(null);
          void jumpToArchived({
            conversationId: pin.conversationId,
            messageId: pin.messageId,
            payload: pin.payload,
            senderUserId: pin.senderUserId,
            senderDeviceId: pin.senderDeviceId,
            sentAt: pin.sentAt,
          });
        }}
      />
    );
  }

  if (friendsOpen) {
    return (
      <Friends
        onClose={() => setFriendsOpen(false)}
        onOpenConversation={(id) => {
          setSelected(id);
          setFriendsOpen(false);
        }}
      />
    );
  }

  if (settingsOpen) {
    return (
      <Settings
        session={session}
        onClose={() => setSettingsOpen(false)}
        // Revoking this device already invalidated the session server-side, so
        // the only honest thing left is the same local teardown as a sign-out.
        onSignedOut={onSignOut}
      />
    );
  }

  if (groupDetailsOpen && current) {
    return (
      <GroupDetails
        conversation={current}
        selfUserId={session.user.id}
        onClose={() => setGroupDetailsOpen(false)}
      />
    );
  }

  if (hubDetailsFor !== null) {
    return (
      <HubDetails
        hubId={hubDetailsFor}
        selfUserId={session.user.id}
        onClose={() => setHubDetailsFor(null)}
        onOpenChannel={(conversationId, jumpToHit) => {
          setHubDetailsFor(null);
          if (jumpToHit) {
            void jumpToArchived({
              conversationId,
              messageId: jumpToHit.messageId,
              payload: jumpToHit.payload,
              senderUserId: jumpToHit.senderUserId,
              senderDeviceId: jumpToHit.senderDeviceId,
              sentAt: jumpToHit.sentAt,
            });
          } else {
            setSelected(conversationId);
          }
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-neutral-50 dark:bg-neutral-950">
      {/* The app header is the LIST's header: a title and two controls, the
          shape a phone expects, instead of the row of webpage links this
          used to be. On a phone with a thread open it does not render at
          all -- the thread's own header is the only chrome -- which is what
          `showList` already means. Sign out moved into Settings; it is a
          rare act and was sitting on the most valuable row of the screen. */}
      {showList && (
        <header className="flex items-center justify-between border-b border-neutral-200 bg-white py-2 pl-4 pr-2 dark:border-neutral-800 dark:bg-neutral-900">
          <span className="text-lg font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
            Chats
          </span>
          <span className="flex items-center gap-1">
            <IconButton label="Friends" onClick={() => setFriendsOpen(true)}>
              <UsersIcon />
            </IconButton>
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label={
                unreadAnnouncements > 0
                  ? `Settings — ${unreadAnnouncements} unread ${
                      unreadAnnouncements === 1 ? "announcement" : "announcements"
                    }`
                  : "Settings"
              }
              className="relative rounded-full p-1 transition-opacity hover:opacity-80"
            >
              <Avatar
                size="sm"
                name={session.user.displayName}
                userId={session.user.id}
              />
              {unreadAnnouncements > 0 && (
                <span className="absolute right-0 top-0 block h-2.5 w-2.5 rounded-full border-2 border-white bg-accent-600 dark:border-neutral-900" />
              )}
            </button>
          </span>
        </header>
      )}

      <StatusLine />
      <UpdateBanner />

      <div className="flex min-h-0 flex-1">
        {showList && (
          <ConversationList
            session={session}
            selected={selected}
            onSelect={setSelected}
            onOpenHub={setHubDetailsFor}
          />
        )}

        {showThread && (
          <main className="flex min-w-0 flex-1 flex-col bg-white motion-safe:animate-panel-in dark:bg-neutral-900">
            {selected !== null ? (
              <>
                <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
                  {!isDesktop && (
                    <BackButton
                      onClick={() => setSelected(null)}
                      label="Back to conversations"
                    />
                  )}
                  {current && (
                    <Avatar
                      size="sm"
                      name={conversationTitle(current, session.user.id)}
                      userId={avatarSeed(current, session.user.id)}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      <span className="min-w-0 truncate">
                        {current?.kind === "channel" && (
                          <span className="mr-0.5 text-neutral-400 dark:text-neutral-500">
                            #
                          </span>
                        )}
                        {channelInfo?.posting === "moderators" && (
                          <LockIcon className="mr-0.5 inline h-3.5 w-3.5 align-[-2px] text-neutral-400 dark:text-neutral-500" />
                        )}
                        {current
                          ? conversationTitle(current, session.user.id)
                          : "Conversation"}
                      </span>
                      {/* The standing public-class label -- every surface a
                          public channel has, per the rule-1/9 amendment. */}
                      {current?.hubVisibility === "public" && (
                        <span className="shrink-0 rounded-full border border-neutral-300 px-1.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                          Public
                        </span>
                      )}
                    </span>
                    {channelInfo?.topic && (
                      <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                        {channelInfo.topic}
                      </span>
                    )}
                    <Presence
                      conversationId={selected}
                      conversation={current}
                    />
                  </span>
                  {current?.kind === "channel" && current.hubId && (
                    <IconButton
                      label="Pinned messages"
                      onClick={() => setPinsFor(selected)}
                      className="shrink-0"
                    >
                      <PinIcon />
                    </IconButton>
                  )}
                  {current && (
                    <IconButton
                      label={current.muted ? "Unmute conversation" : "Mute conversation"}
                      onClick={() => toggleMute(current.id, current.muted)}
                      disabled={muteBusy}
                      className="shrink-0"
                    >
                      {current.muted ? <BellOffIcon /> : <BellIcon />}
                    </IconButton>
                  )}
                  {current?.kind === "group" && (
                    <Button
                      variant="ghost"
                      onClick={() => setGroupDetailsOpen(true)}
                      className="shrink-0"
                    >
                      Details
                    </Button>
                  )}
                  {current?.kind === "channel" && current.hubId && (
                    <Button
                      variant="ghost"
                      onClick={() => setHubDetailsFor(current.hubId!)}
                      className="shrink-0"
                    >
                      Hub
                    </Button>
                  )}
                </div>
                <Timeline
                  conversationId={selected}
                  session={session}
                  conversation={current}
                  onReply={(draft) => {
                    setEditDraft(null);
                    setReplyDraft(draft);
                  }}
                  onEdit={(draft) => {
                    setReplyDraft(null);
                    setEditDraft(draft);
                  }}
                  moderation={
                    current?.kind === "channel" && current.hubId && canModerate
                      ? {
                          hubId: current.hubId,
                          isPublic: current.hubVisibility === "public",
                        }
                      : undefined
                  }
                  canPost={!restricted}
                  jumpTo={jumpTarget}
                  onJumped={() => setJumpTarget(null)}
                />
                <TypingLine
                  conversationId={selected}
                  conversation={current}
                />
                {restricted ? (
                  <div className="border-t border-neutral-200 p-3 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                    Only moderators can post in this channel.
                  </div>
                ) : (
                  <Composer
                    conversationId={selected}
                    publicChannel={current?.hubVisibility === "public"}
                    members={(current?.members ?? [])
                      .filter((member) => member.userId !== session.user.id)
                      .map((member) => ({
                        userId: member.userId,
                        name: member.displayName || member.username,
                      }))}
                    slowmodeSeconds={
                      canModerate ? null : (channelInfo?.slowmodeSeconds ?? null)
                    }
                    reply={replyDraft}
                    onClearReply={() => setReplyDraft(null)}
                    edit={editDraft}
                    onClearEdit={() => setEditDraft(null)}
                  />
                )}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">
                Pick a conversation, or start a new one.
              </div>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
