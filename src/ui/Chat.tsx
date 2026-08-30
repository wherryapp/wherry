import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { Attachment } from "./Attachment";
import { Settings } from "./Settings";
import { Friends } from "./Friends";
import {
  decodeContent,
  type DecodedContent,
  encodeContent,
  type AttachmentRef,
} from "../api/payload";
import { prepareForUpload } from "./media";
import {
  ApiError,
  addMembers,
  createConversation,
  fetchAttachmentUsage,
  fetchFriends,
  leaveConversation,
  lookupUser,
  markConversationRead,
  removeMember,
  renameConversation,
  uploadAttachment,
  type Friend,
} from "../api/client";
import { e2e } from "../crypto";
import { encryptBlob } from "../crypto/blob";
import { store } from "../store";
import type { StoredSession } from "../api/session";
import type { StoredConversation, StoredEvent, StoredMessage } from "../store/types";
import { sync } from "../sync/engine";
import { mlsEnabled, mlsSync } from "../sync/mls";
import {
  useAnnouncements,
  useConversations,
  useDeliveredMarks,
  useLatestMessages,
  usePresence,
  useSyncStatus,
  useTimeline,
  useTyping,
  useUnread,
  type TimelineItem,
} from "./hooks";
import {
  Avatar,
  BackButton,
  Badge,
  Button,
  ErrorText,
  IconButton,
  Input,
  Panel,
  PanelSection,
  PlusIcon,
  SendIcon,
  UsersIcon,
} from "./kit";

// ---------------------------------------------------------------------------
// Rendering content
// ---------------------------------------------------------------------------

/**
 * What to render for a message, or null when it cannot be rendered at all.
 *
 * Null is kept distinct from empty content on purpose: a payload whose
 * decrypt failed is ciphertext this device holds no key for (yet), which is
 * a different thing to say than a message with no text, and the two look
 * identical if they share a return value. `"unsupported"` is a third state
 * for the same reason -- a payload kind from a newer client is fixed by
 * updating, not by waiting for keys.
 */
function messageContent(message: StoredMessage): DecodedContent | null {
  // The explicit flag, not the version number: under v2 most version-2
  // messages are readable and a few are not (sealed to an epoch this device
  // never held), and only decrypt-at-ingest knew which. The forward archive
  // sync heals these, so null here is usually a placeholder for seconds.
  if (message.decryptFailed) return null;
  return decodeContent(message.payload);
}

function conversationTitle(
  conversation: StoredConversation,
  selfUserId: string,
): string {
  if (conversation.title) return conversation.title;
  const others = conversation.members.filter((m) => m.userId !== selfUserId);
  if (others.length === 0) return "You";
  return others.map((m) => m.displayName || m.username).join(", ");
}

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

/** A member's display name, for attribution in groups. */
function memberName(conversation: StoredConversation, userId: string): string {
  const member = conversation.members.find((m) => m.userId === userId);
  return member ? member.displayName || member.username : "Someone";
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
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
  if (conversation.kind !== "group" && others.length === 1) {
    return others[0]!.userId;
  }
  return conversation.id;
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
 */
function UpdateBanner() {
  const status = useSyncStatus();

  if (!status.updateAvailable) return null;

  return (
    <div className="flex items-center justify-between gap-2 border-b border-accent-100 bg-accent-50 px-4 py-1.5 text-xs text-accent-900 motion-safe:animate-fade-in dark:border-accent-900 dark:bg-accent-950 dark:text-accent-100">
      <span>A new version is available.</span>
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

/**
 * A contact row with a checkbox, used by both the new-conversation picker
 * and GroupDetails' add-people picker -- they were built as two copies of
 * the same label, which is exactly the drift kit.tsx exists to prevent.
 */
function ContactCheckboxRow({
  contact,
  checked,
  onToggle,
}: {
  contact: Friend;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50 dark:text-neutral-100 dark:hover:bg-neutral-800">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 shrink-0"
      />
      <Avatar size="sm" name={contact.displayName} userId={contact.userId} />
      <span className="min-w-0 truncate">
        {contact.displayName}
        <span className="ml-1 text-xs text-neutral-500 dark:text-neutral-400">
          @{contact.username}
        </span>
      </span>
    </label>
  );
}

/**
 * Username in, conversation out.
 *
 * Two calls, because `POST /conversations` takes ids and a person types names.
 * `GET /users/lookup` is the only thing that bridges them -- without it the
 * only ids a client ever holds are the ones already in its conversations,
 * which makes starting the first one impossible.
 */
function NewConversation({
  session,
  onOpened,
}: {
  session: StoredSession;
  onOpened: (conversationId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [contacts, setContacts] = useState<Friend[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loaded when the form opens rather than with the app. It is a handful of
  // rows, it is only needed here, and fetching it on every startup would be a
  // request per launch for a list most launches never look at.
  useEffect(() => {
    if (!open || contacts !== null) return;
    void fetchFriends()
      .then((lists) => setContacts(lists.friends))
      .catch(() => setContacts([]));
  }, [open, contacts]);

  function toggle(userId: string): void {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function reset(): void {
    setUsername("");
    setPicked(new Set());
    setError(null);
    setOpen(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      // Comma or space separated, so a group is typed the same way a single
      // name is rather than behind a mode switch. Typing is still here
      // alongside the picker, because somebody who is not a contact yet has to
      // be reachable without being added first.
      const names = [
        ...new Set(
          username
            .split(/[\s,]+/)
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        ),
      ];

      const typed = await Promise.all(names.map((name) => lookupUser(name)));

      if (typed.some((user) => user.id === session.user.id)) {
        setError("You are in every conversation you start; leave yourself out.");
        return;
      }

      // A Set, because picking somebody *and* typing their name is an easy
      // thing to do and should not send the server a duplicate member.
      const memberUserIds = [
        ...new Set([...picked, ...typed.map((user) => user.id)]),
      ];

      if (memberUserIds.length === 0) return;

      // Two people is a direct conversation and is find-or-create, so naming
      // somebody you already talk to reopens that thread rather than splitting
      // the history in two. Three or more is a group, and groups always
      // create: two groups with the same people are legitimately different
      // groups, which is why the server does not deduplicate them.
      const conversation = await createConversation({
        kind: memberUserIds.length === 1 ? "direct" : "group",
        memberUserIds,
      });

      // The list is refreshed on a timer, so nudge it rather than waiting.
      sync.invalidateConversations();
      onOpened(conversation.id);
      reset();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "UNKNOWN_USER"
          ? "No account with one of those usernames."
          : caught instanceof ApiError
            ? caught.message
            : "Cannot reach the server.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        className="w-full"
      >
        New conversation
      </Button>
    );
  }

  const canSend = picked.size > 0 || username.trim().length > 0;

  return (
    <form onSubmit={submit} className="space-y-2">
      {contacts !== null && contacts.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          {contacts.map((contact) => (
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
        autoFocus
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder={
          contacts !== null && contacts.length > 0
            ? "Or add by username"
            : "username, or several for a group"
        }
      />

      {picked.size > 1 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {picked.size} people — this will start a group.
        </p>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={busy || !canSend}
          className="flex-1"
        >
          {busy ? "…" : "Start"}
        </Button>
        <Button variant="ghost" size="sm" onClick={reset} className="px-3 py-1.5">
          Cancel
        </Button>
      </div>
    </form>
  );
}

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
            <Button type="submit" size="sm" disabled={titleBusy} className="shrink-0">
              {titleBusy ? "…" : "Save"}
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
                  <button
                    onClick={() => removeOne(member.userId)}
                    disabled={removingUserId === member.userId}
                    className="shrink-0 text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                  >
                    {removingUserId === member.userId ? "…" : "Remove"}
                  </button>
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
            disabled={leaveBusy}
            className="w-full"
          >
            {leaveBusy ? "…" : "Leave group"}
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
              disabled={addBusy || (picked.size === 0 && username.trim().length === 0)}
              className="w-full"
            >
              {addBusy ? "…" : "Add"}
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
  const { items } = useTimeline(conversationId);

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
// Viewport
// ---------------------------------------------------------------------------

// Tailwind's `md` breakpoint, expressed in JS because two things depend on the
// answer that CSS cannot express: which pane is *rendered*, and whether a
// conversation is auto-selected on load. Auto-selecting on a phone would drop
// somebody into a thread when they were expecting the list they last saw.
//
// Keep this number in step with the `md:` classes below. Tailwind's default
// md is 768px; there is no config file to read it from, by choice.
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribeToViewport(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);

  // Resize as well as the media query, which looks redundant and is not. The
  // change event does not fire in every environment that can alter a viewport
  // -- an emulated one caught this during testing, where the query read as
  // matching while the layout was still in its phone shape. Re-reading on
  // resize means the value cannot disagree with what `matchMedia` says now.
  window.addEventListener("resize", onChange);

  return () => {
    query.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
}

function useIsDesktop(): boolean {
  // useSyncExternalStore rather than state-plus-effect: the value is read
  // fresh on every notification, so there is no copy to fall out of step, and
  // no first render that shows the wrong layout before an effect corrects it.
  return useSyncExternalStore(
    subscribeToViewport,
    () => window.matchMedia(DESKTOP_QUERY).matches,
  );
}

// ---------------------------------------------------------------------------
// Conversation list
// ---------------------------------------------------------------------------

function ConversationList({
  session,
  selected,
  onSelect,
}: {
  session: StoredSession;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { conversations } = useConversations();
  const latest = useLatestMessages(conversations);
  const unread = useUnread(conversations, session.user.id);

  return (
    <aside className="flex w-full shrink-0 flex-col bg-white md:w-72 md:border-r md:border-neutral-200 dark:bg-neutral-900 dark:md:border-neutral-800">
      <div className="border-b border-neutral-200 p-3 dark:border-neutral-800">
        <NewConversation session={session} onOpened={onSelect} />
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && (
          <p className="p-4 text-sm text-neutral-500 dark:text-neutral-400">
            No conversations yet.
          </p>
        )}

        {conversations.map((conversation) => {
          const preview = latest.get(conversation.id);
          const previewContent = preview ? messageContent(preview) : null;
          // A photo with no caption still has to say something in the list,
          // and so does a message kind this build cannot render.
          const text =
            previewContent === "unsupported"
              ? "Needs a newer version"
              : previewContent
                ? previewContent.text ||
                  (previewContent.attachments.length > 0 ? "Photo" : "")
                : null;
          const count = unread.get(conversation.id) ?? 0;
          const isGroup = conversation.members.length > 2;

          // In a group the preview is ambiguous without a name -- "see you at
          // 6" from one of four people is half a message.
          const prefix =
            isGroup && preview && preview.senderUserId !== session.user.id
              ? `${memberName(conversation, preview.senderUserId)}: `
              : "";

          const title = conversationTitle(conversation, session.user.id);

          return (
            <button
              key={conversation.id}
              onClick={() => onSelect(conversation.id)}
              className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                selected === conversation.id
                  ? "bg-neutral-100 dark:bg-neutral-800"
                  : // neutral-800, not the "neutral-850" that sat here
                    // silently generating no rule -- the scale has no 850.
                    "hover:bg-neutral-50 dark:hover:bg-neutral-800"
              }`}
            >
              <Avatar
                name={title}
                userId={avatarSeed(conversation, session.user.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span
                    className={`min-w-0 flex-1 truncate text-sm text-neutral-900 dark:text-neutral-100 ${
                      count > 0 ? "font-semibold" : "font-medium"
                    }`}
                  >
                    {title}
                  </span>
                  {/* Timestamp and, one day, a mute icon share this slot --
                      the row is laid out so either fits without moving the
                      name. */}
                  {preview && (
                    <span className="shrink-0 text-[11px] text-neutral-500 dark:text-neutral-400">
                      {listTime(preview.sentAt)}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span
                    className={`min-w-0 flex-1 truncate text-xs ${
                      count > 0
                        ? "text-neutral-700 dark:text-neutral-300"
                        : "text-neutral-500 dark:text-neutral-400"
                    }`}
                  >
                    {preview
                      ? `${prefix}${text ?? "Encrypted message"}`
                      : "No messages yet"}
                  </span>
                  <Badge count={count} />
                </span>
              </span>
            </button>
          );
        })}
      </div>

    </aside>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function Bubble({
  mine,
  content,
  meta,
  muted,
  sender,
  receipt,
  first = true,
  last = true,
}: {
  mine: boolean;
  /**
   * Null when the payload cannot be read yet (no keys); `"unsupported"` when
   * it decoded fine but this build does not know the kind.
   */
  content: DecodedContent | null;
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
}) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      {/* The horizontal padding beyond the bubble is deliberate slack: the
          affordance space where hover actions and long-press targets for
          reactions/replies land later without re-laying anything out. */}
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 md:max-w-[70%] ${
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
        {content === null ? (
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
            {content.text.length > 0 && (
              <span className="whitespace-pre-wrap break-words text-sm">
                {content.text}
              </span>
            )}
          </>
        )}
        {(last || receipt) && (
          <span
            className={`mt-1 block text-[10px] ${
              mine ? "text-white/70" : "opacity-60"
            }`}
          >
            {meta}
            {receipt && ` · ${receipt}`}
          </span>
        )}
      </div>
    </div>
  );
}

/** A notice line: no bubble, no sender, no side -- centred and easy to skip. */
function Notice({ text }: { text: string }) {
  return (
    <div className="flex justify-center">
      <span className="max-w-[85%] text-center text-xs text-neutral-500 dark:text-neutral-400">
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
}: {
  conversationId: string;
  session: StoredSession;
  /** Undefined until the conversation list catches up; only names depend on it. */
  conversation: StoredConversation | undefined;
}) {
  const { items, hasMore, loadOlder } = useTimeline(conversationId);
  const delivered = useDeliveredMarks(conversationId);

  // Names by user id, so attribution is a lookup rather than a scan per
  // message. Only built for groups, since a 1:1 never shows them.
  const isGroup = (conversation?.members.length ?? 0) > 2;
  // Everybody but you. Used to decide whether "Read" means everyone.
  const others = Math.max(0, (conversation?.members.length ?? 1) - 1);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of conversation?.members ?? []) {
      map.set(member.userId, member.displayName || member.username);
    }
    return map;
  }, [conversation]);
  const bottom = useRef<HTMLDivElement>(null);
  const count = items.length;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count, conversationId]);

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
    <div className="flex-1 overflow-y-auto p-4">
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
          return (
            <div
              key={item.message.messageId}
              className={(first ? "mt-3" : "mt-0.5") + entrance}
            >
              <Bubble
                mine={item.message.senderUserId === session.user.id}
                first={first}
                last={last}
                content={messageContent(item.message)}
                meta={time(item.message.sentAt)}
                sender={
                  isGroup && item.message.senderUserId !== session.user.id
                    ? (names.get(item.message.senderUserId) ?? "Someone")
                    : undefined
                }
                receipt={
                  item.message.messageId === newestOwnId
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
              content={decodeContent(item.entry.content)}
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

  const isGroup = (conversation?.members.length ?? 0) > 2;
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

function Composer({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
    if (trimmed.length === 0 && pending.length === 0) return;
    if (busy) return;

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
        // uploading plaintext, same as the messages around it.
        const sealed = e2e.handshake ? await encryptBlob(prepared.bytes) : null;

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

      await sync.enqueue(
        conversationId,
        encodeContent({ text: trimmed, attachments }),
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

      {/* A column on purpose: the row below keeps the reply-context bar's
          slot above it (reply/quote is a known future payload kind), so
          adding one later inserts a sibling here rather than re-laying out
          the whole composer. The row itself has room for a mic button
          beside the attach one for the same reason. */}
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
        <IconButton
          label="Attach a photo"
          onClick={() => fileInput.current?.click()}
          className="rounded-full"
        >
          <PlusIcon />
        </IconButton>
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // The typing signal, on input rather than on a timer. The
            // engine floors this to one frame per few seconds, so calling
            // it per keystroke is the debounce, not a violation of one.
            if (e.target.value.length > 0) sync.sendTyping(conversationId);
          }}
          placeholder="Message"
          className="min-w-0 flex-1 rounded-full border border-neutral-300 bg-white px-4 py-2 text-base outline-none transition-colors focus:border-neutral-500 md:text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
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
    </form>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function Chat({
  session,
  onSignOut,
}: {
  session: StoredSession;
  onSignOut: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [groupDetailsOpen, setGroupDetailsOpen] = useState(false);
  const { conversations } = useConversations();
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
  useEffect(() => {
    if (!isDesktop) return;
    if (selected === null && conversations[0]) setSelected(conversations[0].id);
  }, [conversations, selected, isDesktop]);

  const current = conversations.find((c) => c.id === selected);

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
            <IconButton label="Contacts" onClick={() => setFriendsOpen(true)}>
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
                    <span className="block truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {current
                        ? conversationTitle(current, session.user.id)
                        : "Conversation"}
                    </span>
                    <Presence
                      conversationId={selected}
                      conversation={current}
                    />
                  </span>
                  {current?.kind === "group" && (
                    <Button
                      variant="ghost"
                      onClick={() => setGroupDetailsOpen(true)}
                      className="shrink-0"
                    >
                      Details
                    </Button>
                  )}
                </div>
                <Timeline
                  conversationId={selected}
                  session={session}
                  conversation={current}
                />
                <TypingLine
                  conversationId={selected}
                  conversation={current}
                />
                <Composer conversationId={selected} />
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
