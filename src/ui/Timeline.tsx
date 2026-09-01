// The message timeline: bubbles, notices, presence and the typing line --
// extracted from Chat.tsx as part of breaking that file up. Bubble is only
// ever rendered by Timeline, so it stays in this file rather than getting
// its own; the display helpers below it (eventText, the receipt labels,
// time, highlightMentions) are likewise timeline-only and travel with it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Attachment } from "./Attachment";
import { PhotoViewer } from "./PhotoViewer";
import {
  encodeOp,
  type AttachmentRef,
  type RenderableContent,
} from "../api/payload";
import { deleteHubMessage, pinHubMessage } from "../api/client";
import { store } from "../store";
import { sync } from "../sync/engine";
import type { StoredSession } from "../api/session";
import type { StoredConversation, StoredEvent } from "../store/types";
import {
  useDeliveredMarks,
  usePresence,
  useTimeline,
  useTyping,
  type MessageMarks,
  type TimelineItem,
} from "./hooks";
import { memberName } from "./format";
import { excerptOf, type EditDraft, type ReplyDraft } from "./drafts";
import { unreadBoundary } from "./unread";
import {
  freshAnchor,
  planAnchor,
  type AnchorSignal,
  type AnchorState,
} from "./anchor";
import {
  PencilIcon,
  PinIcon,
  ReplyIcon,
  TrashIcon,
  useConfirm,
  PhoneIcon,
} from "./kit";
import { callNotice } from "../voice/rules";
import { voice } from "../voice/session";

// ---------------------------------------------------------------------------
// Rendering content
// ---------------------------------------------------------------------------

// Decoding no longer happens here: useTimeline and useLatestMessages hand
// this file already-decoded content (RenderableContent | null, where null is
// a decrypt still waiting for keys), because the same decode pass is what
// aggregates reactions, edits and retractions onto their targets. See the
// aggregation notes on useTimeline in hooks.ts.

/** The words for a notice line -- see StoredEvent in store/types.ts. */
function eventText(
  event: StoredEvent,
  selfUserId: string,
  names?: ReadonlyMap<string, string>,
): string {
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
    case "call_started":
      // Rendered as a join banner while open (see the item loop), and as
      // nothing once the call_ended line exists to summarise it.
      return `${actor} started a call`;
    case "call_ended": {
      const call = event.call;
      if (!call) return `${actor} ended a call`;
      const starterName =
        call.startedByUserId === event.actorUserId
          ? event.actorDisplayName || event.actorUsername
          : (names?.get(call.startedByUserId) ?? "Someone");
      return callNotice({
        endReason: call.endReason,
        startedByUserId: call.startedByUserId,
        startedByName: starterName,
        answeredAt: call.answeredAt,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        participantUserIds: call.participantUserIds,
        selfUserId,
      });
    }
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
  onOpenAttachment,
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
  /** Opens the full-screen viewer on a photo in this message. Undefined on
   *  the pending bubble, whose bytes are not in the store yet. */
  onOpenAttachment?: ((attachment: AttachmentRef) => void) | undefined;
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
                  <Attachment
                    key={attachment.id}
                    attachment={attachment}
                    onOpen={
                      onOpenAttachment
                        ? () => onOpenAttachment(attachment)
                        : undefined
                    }
                  />
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

/**
 * The read/unread divider -- the line a conversation opens on.
 *
 * `capped` is store.countUnread's ceiling showing through: it stops walking
 * at 99, so a returned 99 is a floor rather than a number. Rendering "99+"
 * there is the same admission Badge already makes, and for the same reason.
 */
function UnreadDivider({ count, capped }: { count: number; capped: boolean }) {
  const words = capped
    ? "99+ new messages"
    : count === 1
      ? "1 new message"
      : `${count} new messages`;
  return (
    <div
      id="unread-divider"
      className="my-2 flex items-center gap-2"
      aria-label={words}
    >
      <span className="h-px flex-1 bg-accent-300 dark:bg-accent-800" />
      <span className="text-[11px] font-medium text-accent-600 dark:text-accent-400">
        {words}
      </span>
      <span className="h-px flex-1 bg-accent-300 dark:bg-accent-800" />
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

/** Close enough to the bottom that a new message should follow the reader
 *  down rather than wait to be scrolled to. About one bubble's worth. */
const NEAR_BOTTOM_PX = 120;

/** The open anchor's window, which ends on a *condition* rather than a clock:
 *  the content has stopped changing height. See the settle effect below.
 *
 *  - QUIET_MS          how still the content has to be to count as arrived.
 *  - SETTLE_FLOOR_MS   the window never closes before this, so a slow first
 *                      commit cannot beat it.
 *  - SETTLE_CEILING_MS and never after it, so nothing -- a typing indicator,
 *                      an animation -- can hold the scroll indefinitely.
 *
 *  A real gesture ends the window immediately, whichever came first. */
const QUIET_MS = 400;
const SETTLE_FLOOR_MS = 700;
const SETTLE_CEILING_MS = 4000;

/** store.countUnread's default ceiling. A count equal to it is a floor. */
const UNREAD_COUNT_CAP = 99;

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

export function Timeline({
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

  // The photo the full-screen viewer is showing, if any. Cleared on a
  // conversation switch, since the quick switcher can move under an open
  // viewer and leaving it up would be showing one thread's photo over
  // another's timeline.
  const [viewing, setViewing] = useState<AttachmentRef | null>(null);
  useEffect(() => setViewing(null), [conversationId]);

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

  const scroller = useRef<HTMLDivElement>(null);
  // Wraps everything that is scrolled, so its height can be observed. The
  // scroll container's own box never changes; what settles is its contents.
  const content = useRef<HTMLDivElement>(null);
  const count = items.length;

  // -------------------------------------------------------------------------
  // Where the unread divider goes
  // -------------------------------------------------------------------------

  /**
   * The read marker as it stood when this conversation was opened.
   *
   * A *snapshot*, never the live prop, because useMarkRead marks the
   * conversation read the moment it is open and visible and merges the new
   * marker locally -- so the live marker advances to the newest message a
   * beat after open, and a divider computed from it would erase itself in
   * front of the reader. Captured once, on the first render where the
   * conversation list has caught up, and never updated again while this
   * conversation stays open.
   *
   * The race is won by construction: useMarkRead's merge is async and lands
   * after first render. If the list were ever so slow that the merge landed
   * before `conversation` was defined at all, the divider is silently lost
   * for that one open -- accepted, because the alternative is holding a
   * marker the server has already moved past.
   */
  const [snapshot, setSnapshot] = useState<{
    conversationId: string;
    marker: string | null;
  } | null>(null);

  useEffect(() => {
    setSnapshot((current) => {
      if (current?.conversationId === conversationId) return current;
      // Switched conversations and the list has not caught up yet: reset,
      // and take the snapshot on a later run.
      if (!conversation || conversation.id !== conversationId) return null;
      return {
        conversationId,
        marker:
          conversation.members.find(
            (member) => member.userId === session.user.id,
          )?.lastReadMessageId ?? null,
      };
    });
  }, [conversation, conversationId, session.user.id]);

  /**
   * Whether `items` is this conversation's yet.
   *
   * useTimeline reloads from the store asynchronously and does not blank
   * itself first, so for a beat after a switch these are still the *previous*
   * conversation's messages -- and their ids, from a different id space
   * entirely, all compare as "after" this conversation's marker. Believing
   * them put the divider in the wrong thread and, worse, latched the open
   * anchor onto it, so the real divider never got its one shot. Also false
   * on an empty page, which is what a conversation looks like in the instant
   * before its first load lands.
   */
  const itemsAreCurrent = useMemo(() => {
    const first = items.find((item) => item.kind === "sent");
    return first?.kind === "sent"
      ? first.message.conversationId === conversationId
      : false;
  }, [items, conversationId]);

  const boundary = useMemo(
    () =>
      snapshot === null || !itemsAreCurrent
        ? null
        : unreadBoundary(items, snapshot.marker, session.user.id),
    [items, itemsAreCurrent, snapshot, session.user.id],
  );

  /**
   * True when the boundary is *above* the loaded window: the oldest message
   * on the page is already strictly after the marker, so the first unread
   * one is off the top. A hub channel with 400 unread is the case.
   *
   * Deliberately not solved by paging until the marker appears -- that is 400
   * messages fetched to place a line. The divider goes at the top of what is
   * loaded instead, with an honest count from the store, and Load older
   * stays the way to walk further back.
   */
  const clamped = useMemo(() => {
    if (snapshot === null || !itemsAreCurrent || !hasMore) return false;
    const oldest = items.find((item) => item.kind === "sent");
    if (oldest?.kind !== "sent") return false;
    return (
      snapshot.marker === null || oldest.message.messageId > snapshot.marker
    );
  }, [items, itemsAreCurrent, hasMore, snapshot]);

  // The clamped count, which only the store can answer -- it walks the whole
  // conversation rather than the loaded page. Capped at 99 by countUnread.
  const [deepCount, setDeepCount] = useState<number | null>(null);
  useEffect(() => setDeepCount(null), [conversationId]);
  useEffect(() => {
    if (!clamped || snapshot === null) return;
    let cancelled = false;
    void store
      .countUnread(conversationId, snapshot.marker, session.user.id)
      .then((total) => {
        if (!cancelled) setDeepCount(total);
      });
    return () => {
      cancelled = true;
    };
  }, [clamped, snapshot, conversationId, session.user.id]);

  /** Null when nothing is unread; `beforeId` null means "top of the page". */
  const divider = useMemo((): {
    beforeId: string | null;
    count: number;
    capped: boolean;
  } | null => {
    if (snapshot === null) return null;
    if (clamped) {
      if (deepCount === null || deepCount <= 0) return null;
      return {
        beforeId: null,
        count: deepCount,
        capped: deepCount >= UNREAD_COUNT_CAP,
      };
    }
    if (!boundary) return null;
    return {
      beforeId: boundary.firstUnreadId,
      count: boundary.count,
      capped: false,
    };
  }, [snapshot, clamped, deepCount, boundary]);

  /** Which rendered row the divider sits above; -1 for none. */
  const dividerIndex = useMemo(() => {
    if (!divider) return -1;
    if (divider.beforeId === null) return items.length > 0 ? 0 : -1;
    return items.findIndex(
      (item) =>
        item.kind === "sent" && item.message.messageId === divider.beforeId,
    );
  }, [divider, items]);

  // -------------------------------------------------------------------------
  // Scrolling
  // -------------------------------------------------------------------------

  /**
   * Whether the reader is parked at the bottom, *sampled on scroll* rather
   * than measured at the moment it is needed. Both consumers need the answer
   * from before the change that is asking:
   *
   * - an arrival has already grown scrollHeight by its own height by the time
   *   the effect below runs, so a live measurement reads a reader who was at
   *   the bottom as scrolled up;
   * - the keyboard has already shortened this pane by the time
   *   visualViewport's resize fires, which moves the bottom hundreds of
   *   pixels away for exactly the person the re-pin exists to serve.
   *
   * Neither event moves scrollTop, so the last sample is still the truth
   * about where the reader put themselves.
   *
   * **It is not sampled while the open still owns the scroll.** `scroll`
   * fires for our own programmatic scrolls too, a frame after the fact, so
   * the geometry it reads mid-open is whatever the timeline had settled to by
   * dispatch time -- which is how a sample taken *because* the anchor moved
   * the scroll used to record the reader as scrolled up. See `anchor.ts`.
   * One honest sample is taken at hand-over instead.
   */
  const anchor = useRef<AnchorState>(freshAnchor());
  const sampleNearBottom = useCallback((force = false): void => {
    const el = scroller.current;
    if (!el) return;
    if (!force && !anchor.current.settled) return;
    anchor.current.nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  /**
   * The true bottom, by assignment rather than `scrollIntoView` on a trailing
   * sentinel.
   *
   * `block: "end"` aligns the sentinel's own bottom edge with the scrollport's
   * bottom edge, which leaves this container's `p-4` bottom padding below the
   * fold: the newest message ends up with one pixel of gap under it where the
   * design has sixteen, jammed against the typing line. Measured, not
   * theorised — it is why the last message read as slightly out of frame, and
   * it showed worst on the newest message because that is the one carrying the
   * timestamp and receipt line. Assigning `scrollTop` clamps to the real
   * maximum, padding included.
   */
  const pinBottom = useCallback((): void => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const centreDivider = useCallback((): void => {
    document
      .getElementById("unread-divider")
      ?.scrollIntoView({ block: "center" });
  }, []);

  /**
   * The row the reader is actually looking at, and where it sits.
   *
   * This is the state scroll anchoring needs: `scrollTop` alone is meaningless
   * once content is inserted above it. Recorded after every scroll and after
   * every anchor action -- i.e. whenever the reader's position last changed
   * for a reason -- so that when the timeline grows, `holdPosition` can put
   * the same row back under the same pixel.
   */
  const anchorRow = useRef<{ el: Element; top: number } | null>(null);

  const recordAnchorRow = useCallback((): void => {
    const scrollEl = scroller.current;
    const contentEl = content.current;
    if (!scrollEl || !contentEl) return;
    const fold = scrollEl.getBoundingClientRect().top;
    for (const child of contentEl.children) {
      const rect = child.getBoundingClientRect();
      // The first row not yet scrolled fully past the top of the viewport.
      if (rect.bottom > fold) {
        anchorRow.current = { el: child, top: rect.top - fold };
        return;
      }
    }
    anchorRow.current = null;
  }, []);

  /**
   * Scroll anchoring, by hand, because Safari has none.
   *
   * Puts the recorded row back under the pixel it was under, absorbing
   * whatever was inserted above it. On Chromium the native implementation has
   * usually already done this, so the drift measures zero and this is a no-op
   * -- which is the point: one behaviour on both engines rather than a bug
   * that only reproduces on a phone.
   */
  const holdPosition = useCallback((): void => {
    const scrollEl = scroller.current;
    const row = anchorRow.current;
    if (!scrollEl || !row || !row.el.isConnected) return;
    const fold = scrollEl.getBoundingClientRect().top;
    const drift = row.el.getBoundingClientRect().top - fold - row.top;
    if (drift !== 0) scrollEl.scrollTop += drift;
  }, []);

  /**
   * One signal in, one scroll out. Every decision about where the open lands
   * lives in `planAnchor`, which is pure and tested; this is only the hands.
   */
  const dispatchAnchor = useCallback(
    (signal: AnchorSignal): void => {
      const { state, action } = planAnchor(anchor.current, signal);
      anchor.current = state;
      if (action === "pin-bottom") pinBottom();
      else if (action === "centre-divider") centreDivider();
      else if (action === "hold-position") holdPosition();
      // Whatever just happened, this is where the reader is now.
      recordAnchorRow();
    },
    [pinBottom, centreDivider, holdPosition, recordAnchorRow],
  );

  // A fresh conversation is a fresh anchor -- including `nearBottom`, which is
  // a fact about the reader's position in *this* conversation. It used to
  // survive the switch, so opening a chat after scrolling up in another one
  // started with the arrival gate already shut.
  //
  // A layout effect, and declared *above* the one that anchors, because
  // effects run in declaration order and both now run before paint: as a
  // passive effect this reset landed after the new conversation's first
  // commit had already been handled with the old conversation's latched
  // state.
  useLayoutEffect(() => {
    anchor.current = freshAnchor();
  }, [conversationId]);

  // True while the divider's existence is still undecided -- the conversation
  // list has not caught up, or a clamped count is still in flight. Pin to the
  // bottom meanwhile (today's behaviour) but do NOT latch, so the anchor
  // still gets its one shot when the answer lands.
  const dividerPending =
    snapshot === null || !itemsAreCurrent || (clamped && deepCount === null);

  // A layout effect, so the scroll is in place before the frame is painted.
  // As a passive effect this ran *after* paint, which showed the timeline at
  // the wrong offset for one frame on every open -- cheap to see on a phone,
  // and easy to mistake for the anchor itself moving.
  useLayoutEffect(() => {
    // A jump in progress owns the scroll position; pinning or anchoring here
    // would yank the reader away from the very message they asked for. A
    // search jump into a conversation beats the divider.
    if (jumpTo) return;
    dispatchAnchor({ kind: "render", dividerIndex, dividerPending });
  }, [count, conversationId, jumpTo, dividerIndex, dividerPending, dispatchAnchor]);

  /**
   * The anchor has to survive the timeline settling underneath it.
   *
   * `useTimeline` now lands messages, notices and the outbox in one commit,
   * which removes the largest of these by far -- three store reads used to
   * set three pieces of state, so the notice lines arrived *after* the
   * messages they sit between and inserted hundreds of pixels above an anchor
   * that had already been scrolled to (measured at 364px on a seeded
   * 40-message group with 13 notices). What is left is everything that
   * changes height *without* changing the item list: images decoding, fonts
   * swapping, a receipt line appearing, the typing indicator.
   *
   * Chromium's scroll anchoring absorbs most of it, which is exactly why this
   * is worse on a phone: Safari does not implement scroll anchoring at all,
   * so there the full insertion moves the view.
   *
   * **The window ends on a condition, not on a clock.** It used to be a flat
   * 1200 ms, which is both too long for a conversation that settled in 40 ms
   * (the anchor could still move a second later, which reads as the scroll
   * fighting back) and too short for one whose photo comes off the network on
   * a phone. Instead: re-anchor whenever the content actually changes height,
   * and hand over once it has been still for QUIET_MS -- with a floor, so a
   * slow first commit cannot settle the window before the timeline has
   * arrived, and a ceiling, so nothing can hold the scroll indefinitely.
   * Any real gesture ends it immediately, whichever came first.
   *
   * Note it is driven by the rendering pipeline, so it does not fire while the
   * document is hidden -- fine, since nobody is looking at the scroll then.
   */
  useEffect(() => {
    const el = content.current;
    // A jump owns the scroll outright; re-anchoring under it is the one thing
    // this must never do.
    if (!el || jumpTo) return;

    const openedAt = performance.now();
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let ceiling: ReturnType<typeof setTimeout> | undefined;

    // Any of these means the reader is driving now. `scroll` is not among
    // them: it fires for our own programmatic scrolls too, so it cannot tell
    // the reader apart from the anchor. `touchmove` rather than `touchstart`,
    // because on a phone the tap that opened the conversation is followed by a
    // finger that is merely *resting* at least as often as one that is
    // scrolling -- and a tap on a photo is not a request to move the view.
    const takeOver = (): void => {
      if (anchor.current.settled) return;
      clearTimeout(quiet);
      clearTimeout(ceiling);
      dispatchAnchor({ kind: "handover" });
      // The one sample that matters: from here on, arrivals are gated on it.
      sampleNearBottom(true);
    };

    const scheduleHandover = (): void => {
      clearTimeout(quiet);
      const elapsed = performance.now() - openedAt;
      quiet = setTimeout(takeOver, Math.max(QUIET_MS, SETTLE_FLOOR_MS - elapsed));
    };

    // Note this keeps observing after hand-over rather than stopping. Before,
    // the window closed at ~700ms and every later height change went
    // uncorrected -- which is the whole of the residual defect: a photo
    // arriving off the network, or a message healing its decrypt, a second or
    // two in. `planAnchor` decides what a resize *means*; after hand-over that
    // is "hold the reader's place", not "re-assert the open".
    const onResize = (): void => {
      dispatchAnchor({ kind: "resize" });
      if (!anchor.current.settled) scheduleHandover();
    };

    const observer = new ResizeObserver(onResize);
    observer.observe(el);
    scheduleHandover();
    ceiling = setTimeout(takeOver, SETTLE_CEILING_MS);

    const scrollEl = scroller.current;
    scrollEl?.addEventListener("wheel", takeOver, { passive: true });
    scrollEl?.addEventListener("touchmove", takeOver, { passive: true });
    window.addEventListener("keydown", takeOver);

    // An image finishing is the height change this exists for, and it is worth
    // hearing about directly rather than only through the observer above:
    // ResizeObserver is driven by the rendering pipeline and does not run at
    // all while the document is hidden -- which is exactly the state an app
    // being brought back to the foreground is in while its backlog lands.
    // `load` does not bubble, so this listens in the capture phase.
    scrollEl?.addEventListener("load", onResize, true);

    return () => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(ceiling);
      scrollEl?.removeEventListener("wheel", takeOver);
      scrollEl?.removeEventListener("touchmove", takeOver);
      scrollEl?.removeEventListener("load", onResize, true);
      window.removeEventListener("keydown", takeOver);
    };
  }, [conversationId, jumpTo, dispatchAnchor, sampleNearBottom]);

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
      // Through the same guard as an arrival, using the sample taken before
      // the keyboard shortened the pane (see nearBottom). The case this
      // exists for -- somebody at the bottom about to reply -- passes it by
      // definition; a reader parked further up is left where they were.
      if (!anchor.current.nearBottom) return;
      pinBottom();
    };

    viewport.addEventListener("resize", pin);
    return () => viewport.removeEventListener("resize", pin);
  }, [pinBottom]);

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

  /**
   * Slots the divider in above the row it belongs to. flatMap rather than a
   * wrapping Fragment so both stay ordinary keyed siblings -- the divider
   * appearing must not remount the message under it.
   */
  const withDivider = (index: number, row: ReactNode): ReactNode | ReactNode[] =>
    index === dividerIndex && divider
      ? [
          <UnreadDivider
            key="unread-divider"
            count={divider.count}
            capped={divider.capped}
          />,
          row,
        ]
      : row;

  return (
    <div
      ref={scroller}
      onScroll={() => {
        sampleNearBottom();
        // Where the reader put themselves, for holdPosition to restore.
        recordAnchorRow();
      }}
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
      {/* Everything scrolled lives in here, so the settle observer above has
          one box whose height it can watch. Carries no styling of its own --
          the padding and background stay on the scroll container. */}
      <div ref={content}>
      {hasMore && (
        <button
          onClick={loadOlder}
          className="mx-auto block rounded-md px-3 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          Load older messages
        </button>
      )}

      {items.flatMap((item: TimelineItem, index) => {
        if (item.kind === "event") {
          // A call still open is a door, not a notice: "Call in progress ·
          // Join". Once it has ended the call_ended line carries the
          // summary and the started line renders nothing at all.
          if (item.event.kind === "call_started") {
            const open = item.event.call !== null && item.event.call.endedAt === null;
            if (!open) return [];
            return withDivider(
              index,
              <div key={item.event.id} className="mt-3 flex justify-center">
                <button
                  onClick={() => {
                    if (conversation) void voice.startCall(conversation);
                  }}
                  className="flex items-center gap-2 rounded-full bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                >
                  <PhoneIcon className="h-3.5 w-3.5" />
                  Call in progress · Join
                </button>
              </div>,
            );
          }
          return withDivider(
            index,
            <div key={item.event.id} className="mt-3">
              <Notice text={eventText(item.event, session.user.id, names)} />
            </div>,
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
          return withDivider(
            index,
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
                onOpenAttachment={setViewing}
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
            </div>,
          );
        }
        return withDivider(
          index,
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
          </div>,
        );
      })}
      </div>
      {confirmDialog}
      {viewing && (
        <PhotoViewer
          attachment={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

/**
 * "Online", quietly, under the conversation title. Null while no presence
 * answer has arrived -- unknown is rendered as nothing, never as offline,
 * because the absence of an answer carries no information (see usePresence).
 * The reform owns this surface's real design; this is the honest minimum.
 */
export function Presence({
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
export function TypingLine({
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
