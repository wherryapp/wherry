import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Settings } from "./Settings";
import { Friends } from "./Friends";
import { HubDetails } from "./HubDetails";
import { GroupDetails } from "./GroupDetails";
import { JoinInvite } from "./JoinInvite";
import { PinsPanel } from "./PinsPanel";
import { Presence, Timeline, TypingLine } from "./Timeline";
import { type EditDraft, type ReplyDraft } from "./drafts";
import { avatarSeed, conversationTitle } from "./format";
import { useIsDesktop } from "./viewport";
import { ConversationList } from "./sidebar/Sidebar";
import { encodeContent, encodeOp, type AttachmentRef } from "../api/payload";
import { prepareForUpload } from "./media";
import {
  ApiError,
  fetchArchive,
  fetchAttachmentUsage,
  markConversationRead,
  muteConversation,
  unmuteConversation,
  uploadAttachment,
} from "../api/client";
import { decodeBase64 } from "../api/base64";
import { PROTOCOL_PUBLIC } from "../crypto/provider";
import { e2e } from "../crypto";
import { encryptBlob } from "../crypto/blob";
import { store } from "../store";
import type { StoredSession } from "../api/session";
import { sync } from "../sync/engine";
import {
  useAnnouncements,
  useConversations,
  useHubs,
  useSyncStatus,
  useTimeline,
  useUnread,
} from "./hooks";
import { QuickSwitcher } from "./QuickSwitcher";
import {
  Avatar,
  BackButton,
  BellIcon,
  BellOffIcon,
  Button,
  ErrorText,
  IconButton,
  LockIcon,
  Note,
  PinIcon,
  PlusIcon,
  PublicPill,
  SendIcon,
  XIcon,
  UsersIcon,
} from "./kit";

// eventText, readCount, readLabel, deliveredCount, deliveredLabel, time,
// escapeRegex and highlightMentions moved to Timeline.tsx, the only file
// that used them.

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

// GroupDetails moved to GroupDetails.tsx.

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

// JoinInvite moved to JoinInvite.tsx; PinsPanel moved to PinsPanel.tsx.
// ReplyDraft, EditDraft and excerptOf moved to drafts.ts -- PinsPanel needs
// excerptOf too, and it moved out of this file before the timeline did.

// ConversationList (with NewConversation, NewHub and HubsSection) moved to
// sidebar/Sidebar.tsx, sidebar/NewConversation.tsx, sidebar/NewHub.tsx and
// sidebar/HubsSection.tsx.

// QUICK_REACTIONS, myReaction, PressPointerEvent, TAP_MOVE_PX, TAP_MAX_MS,
// Bubble, Notice, RUN_GAP_MS, runIdentity, sameRun, Timeline, Presence and
// TypingLine all moved to Timeline.tsx.

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
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // The browser tab carries the total unread, the way every messenger's tab
  // does. Muted conversations are excluded -- for the count, mute means what
  // it means for push and for the collapsed-hub roll-up: not worth waking
  // anybody for. The store's own unread bookkeeping is untouched by mute.
  const unreadByConversation = useUnread(conversations, session.user.id);
  useEffect(() => {
    let total = 0;
    for (const conversation of conversations) {
      if (conversation.muted) continue;
      total += unreadByConversation.get(conversation.id) ?? 0;
    }
    document.title =
      total > 0 ? `(${total > 99 ? "99+" : total}) messenger` : "messenger";
    return () => {
      document.title = "messenger";
    };
  }, [conversations, unreadByConversation]);

  // Global keys. Ctrl/Cmd+K opens the switcher from anywhere in the main
  // view, composer included; it stays out of the full-screen panels because
  // they early-return their own trees and the dialog could not render over
  // them. Plain Escape backs out of a thread only on a phone -- desktop
  // shows both panes, so deselecting would just empty one -- and only when
  // the key is not already someone else's: a focused field, an open panel,
  // or the switcher itself all take precedence.
  useEffect(() => {
    const panelOpen =
      settingsOpen ||
      friendsOpen ||
      groupDetailsOpen ||
      hubDetailsFor !== null ||
      pinsFor !== null;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        if (panelOpen) return;
        event.preventDefault();
        setSwitcherOpen((open) => !open);
        return;
      }
      if (event.key !== "Escape" || switcherOpen || panelOpen) return;
      if (isDesktop || selected === null) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    switcherOpen,
    isDesktop,
    selected,
    settingsOpen,
    friendsOpen,
    groupDetailsOpen,
    hubDetailsFor,
    pinsFor,
  ]);

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
                      {current?.hubVisibility === "public" && <PublicPill />}
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

      {switcherOpen && (
        <QuickSwitcher
          conversations={conversations}
          hubs={hubs}
          selfId={session.user.id}
          onPick={setSelected}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
    </div>
  );
}
