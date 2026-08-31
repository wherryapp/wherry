// React bindings over the store and the sync engine.
//
// The shape every one of these follows: read from IndexedDB, then re-read when
// the engine says something changed. Components never call the API directly
// and never poll -- there is one loop, it runs in one tab, and everything else
// is a view over local storage. That is what makes the leader election
// invisible to the UI, and it is what made Phase 4's realtime socket a change
// to the engine alone: no component here knows it exists.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { store } from "../store";
import type { Announcement } from "../api/client";
import {
  decodeContent,
  isMessageOp,
  type MessageOp,
  type RenderableContent,
} from "../api/payload";
import {
  META_ANNOUNCEMENTS,
  META_ANNOUNCEMENTS_SEEN,
  META_DELIVERED_PREFIX,
  type OutboxEntry,
  type StoredConversation,
  type StoredEvent,
  type StoredMessage,
} from "../store/types";
import { sync, type SyncEvent, type SyncStatus } from "../sync/engine";
import { broadcast, subscribeToBroadcasts } from "../sync/leader";

/**
 * Subscribes to change notifications from both sources.
 *
 * Two sources because only the leader tab runs the engine. In the leader,
 * events arrive from the engine directly; in every other tab they arrive over
 * BroadcastChannel. Both say the same thing -- "local storage changed" -- and
 * a component should not have to care which tab it is in.
 */
function useSyncEvents(handler: (event: SyncEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    const unsubscribeEngine = sync.subscribe((event) => ref.current(event));
    const unsubscribeChannel = subscribeToBroadcasts((message) => {
      if (message.type === "messages") {
        ref.current({ type: "messages", conversationIds: message.conversationIds });
      } else if (message.type === "conversations") {
        ref.current({ type: "conversations" });
      } else if (message.type === "announcements") {
        ref.current({ type: "announcements" });
      } else if (message.type === "receipts") {
        ref.current({
          type: "receipts",
          conversationId: message.conversationId,
        });
      } else if (message.type === "typing") {
        ref.current({
          type: "typing",
          conversationId: message.conversationId,
          byUserId: message.byUserId,
        });
      } else if (message.type === "presence") {
        ref.current({
          type: "presence",
          conversationId: message.conversationId,
          online: message.online,
        });
      }
    });
    return () => {
      unsubscribeEngine();
      unsubscribeChannel();
    };
  }, []);
}

export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(sync.status);
  useSyncEvents((event) => {
    if (event.type === "status") setStatus(event.status);
  });
  return status;
}

export function useConversations(): {
  conversations: StoredConversation[];
  reload: () => void;
} {
  const [conversations, setConversations] = useState<StoredConversation[]>([]);

  const reload = useCallback(() => {
    void store.listConversations().then((list) => {
      // Newest first. Conversation ids are UUIDv7, so this is creation order
      // without needing a stored timestamp -- the same property the server
      // relies on for cursors.
      setConversations([...list].sort((a, b) => b.id.localeCompare(a.id)));
    });
  }, []);

  useEffect(reload, [reload]);
  useSyncEvents((event) => {
    if (event.type === "conversations" || event.type === "messages") reload();
  });

  return { conversations, reload };
}

const PAGE = 50;

/**
 * What the operations targeting a message add up to, aggregated at render
 * time. Absence of marks is the overwhelmingly common case, so the timeline
 * carries null rather than an empty object per message.
 */
export type MessageMarks = {
  /** emoji -> reactor user ids, ordered by each emoji's first appearance. */
  reactions: [string, string[]][];
  /** Replacement text from the sender's latest edit. */
  editedText?: string;
  /** Renders as a tombstone. Beats any edit, and hides reactions. */
  retracted?: boolean;
};

export type TimelineItem =
  | {
      kind: "sent";
      message: StoredMessage;
      /** Decoded once here; null when decrypt failed (payload is wire bytes). */
      content: RenderableContent | null;
      marks: MessageMarks | null;
    }
  | { kind: "pending"; entry: OutboxEntry; content: RenderableContent }
  | { kind: "event"; event: StoredEvent };

/**
 * A conversation's messages, oldest at the top, with unsent ones at the end,
 * and notice lines (added/removed/renamed) interleaved among the sent ones.
 *
 * Stored messages and outbox entries are rendered together so a composed
 * message appears the instant it is typed rather than after a round trip. They
 * stay separate in storage because an outbox entry has no server id until the
 * send succeeds, and `messages` is keyed on exactly that.
 *
 * Notices are not paged with the messages: they are rare, the store holds a
 * conversation's whole notice history, and mixing a second cursor into the
 * "load older" walk would be real complexity for a handful of extra rows.
 *
 * ---------------------------------------------------------------------------
 * Operations aggregate here, at read time
 * ---------------------------------------------------------------------------
 *
 * A reaction, an edit or a retraction is stored as an ordinary message; this
 * hook is where it stops being one. Ops never appear as items -- they fold
 * into the `marks` of the message they target. Aggregating at read rather
 * than materializing onto the target at write time is self-healing by
 * construction: an op that arrives before its target (archive walk, decrypt
 * healing) simply applies on the next render, with no reconciliation code.
 *
 * The loaded page bounds both cost and correctness, and the bound is sound:
 * pages load as a contiguous newest-first suffix, and an op is always newer
 * than its target (it names an existing id), so a loaded target's ops are
 * always loaded with it. Ops in the outbox are aggregated too -- that is
 * what makes a retraction tombstone instantly instead of after the round
 * trip.
 *
 * Authority is client-enforced, honor-system, like every E2E messenger --
 * the server cannot read who an op targets, so the *reader* checks: an edit
 * or retraction applies only when its sender is the target's sender. A
 * reaction applies from any member. "Latest wins" is uuidv7 order for stored
 * ops, with pending ones last.
 */
export function useTimeline(
  conversationId: string | null,
  selfUserId: string,
): {
  items: TimelineItem[];
  hasMore: boolean;
  loadOlder: () => void;
} {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [pending, setPending] = useState<OutboxEntry[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [hasMore, setHasMore] = useState(false);

  const reload = useCallback(() => {
    if (!conversationId) {
      setMessages([]);
      setEvents([]);
      setPending([]);
      return;
    }

    // One extra row than asked for, purely to answer "is there more?" without
    // a second count query.
    void store
      .getConversationPage(conversationId, { limit: limit + 1 })
      .then((page) => {
        setHasMore(page.length > limit);
        // The store returns newest first because that is the efficient
        // direction to walk the index. A timeline reads the other way.
        setMessages(page.slice(0, limit).reverse());
      });

    void store.getConversationEvents(conversationId).then(setEvents);
    void store.listOutbox(conversationId).then(setPending);
  }, [conversationId, limit]);

  useEffect(reload, [reload]);

  useSyncEvents((event) => {
    if (event.type === "messages") {
      if (!conversationId) return;
      if (!event.conversationIds.includes(conversationId)) return;
      reload();
    } else if (event.type === "conversations") {
      // Notices refresh on the conversation-refresh cadence (see
      // sync/engine.ts's #refreshEvents), which is what fires this event.
      reload();
    }
  });

  const items = useMemo<TimelineItem[]>(() => {
    // One decode per message per reload -- the payloads are small and the
    // page is bounded, so this is cheaper than it reads.
    const decoded = messages.map((message) => ({
      message,
      content: message.decryptFailed ? null : decodeContent(message.payload),
    }));

    // Who sent each renderable message, for the authority check below.
    const senderOf = new Map<string, string>();
    for (const { message, content } of decoded) {
      if (content === null || !isMessageOp(content)) {
        senderOf.set(message.messageId, message.senderUserId);
      }
    }

    // Ops in application order: stored ones are already ascending by id
    // (send order), pending ones follow (they are newer than anything
    // stored, and listOutbox returns them oldest first).
    const ops: { op: MessageOp; senderUserId: string }[] = [];
    for (const { message, content } of decoded) {
      if (content !== null && isMessageOp(content)) {
        ops.push({ op: content, senderUserId: message.senderUserId });
      }
    }
    const pendingRenderable: { entry: OutboxEntry; content: RenderableContent }[] =
      [];
    for (const entry of pending) {
      const content = decodeContent(entry.content);
      if (isMessageOp(content)) {
        // An unsent op still applies -- optimistically, to this user's own
        // view. That is what makes "Delete" tombstone instantly.
        ops.push({ op: content, senderUserId: selfUserId });
      } else {
        pendingRenderable.push({ entry, content });
      }
    }

    // Latest wins by construction: later applications overwrite earlier.
    const reactionsByTarget = new Map<string, Map<string, string | null>>();
    const editByTarget = new Map<string, string>();
    const retractedTargets = new Set<string>();
    for (const { op, senderUserId } of ops) {
      if (op.kind === "reaction") {
        let perReactor = reactionsByTarget.get(op.target);
        if (!perReactor) {
          perReactor = new Map();
          reactionsByTarget.set(op.target, perReactor);
        }
        perReactor.set(senderUserId, op.emoji);
      } else if (senderOf.get(op.target) === senderUserId) {
        // Edit and retract only from the target's own sender. An op failing
        // this check is dropped silently -- it could not have been produced
        // by a well-behaved client.
        if (op.kind === "edit") editByTarget.set(op.target, op.text);
        else retractedTargets.add(op.target);
      }
    }

    const marksFor = (messageId: string): MessageMarks | null => {
      const perReactor = reactionsByTarget.get(messageId);
      const editedText = editByTarget.get(messageId);
      const retracted = retractedTargets.has(messageId);
      if (!perReactor && editedText === undefined && !retracted) return null;

      // Group per-reactor state into chips, dropping removals (emoji null),
      // keyed by each emoji's first appearance so chips do not jump around.
      const grouped = new Map<string, string[]>();
      if (perReactor) {
        for (const [userId, emoji] of perReactor) {
          if (emoji === null) continue;
          const users = grouped.get(emoji) ?? [];
          users.push(userId);
          grouped.set(emoji, users);
        }
      }

      const marks: MessageMarks = { reactions: [...grouped.entries()] };
      if (retracted) marks.retracted = true;
      else if (editedText !== undefined) marks.editedText = editedText;
      return marks;
    };

    return [
      ...decoded
        .filter(
          (
            d,
          ): d is { message: StoredMessage; content: RenderableContent | null } =>
            d.content === null || !isMessageOp(d.content),
        )
        .map(({ message, content }) => ({
          kind: "sent" as const,
          message,
          content,
          marks: marksFor(message.messageId),
        })),
      ...events.map((event) => ({ kind: "event" as const, event })),
      ...pendingRenderable.map(({ entry, content }) => ({
        kind: "pending" as const,
        entry,
        content,
      })),
    ].sort((a, b) => {
      // Pending entries have no server id yet and always sort last, after
      // everything with one. Sent messages and notices interleave by id --
      // both are uuidv7, so id order is send order.
      const idOf = (item: TimelineItem) =>
        item.kind === "sent"
          ? item.message.messageId
          : item.kind === "event"
            ? item.event.id
            : null;
      const aId = idOf(a);
      const bId = idOf(b);
      if (aId === null && bId === null) return 0;
      if (aId === null) return 1;
      if (bId === null) return -1;
      return aId.localeCompare(bId);
    });
  }, [messages, events, pending, selfUserId]);

  const loadOlder = useCallback(() => setLimit((n) => n + PAGE), []);

  useEffect(() => setLimit(PAGE), [conversationId]);

  return { items, hasMore, loadOlder };
}

/**
 * Unread counts per conversation, for this user.
 *
 * Recomputed on the same events as everything else: new messages arriving, and
 * the conversation refresh that carries read markers back from the server. The
 * marker is per *user*, so reading on a phone clears the badge on a laptop --
 * which a device-local flag could never do, and is the reason the marker lives
 * on the server at all.
 */
export function useUnread(
  conversations: readonly StoredConversation[],
  selfUserId: string,
): Map<string, number> {
  const [unread, setUnread] = useState<Map<string, number>>(new Map());

  // Depends on the markers as well as the ids, so that a marker arriving from
  // the server recomputes without waiting for the next message.
  const signature = conversations
    .map(
      (conversation) =>
        `${conversation.id}:${
          conversation.members.find((m) => m.userId === selfUserId)
            ?.lastReadMessageId ?? ""
        }`,
    )
    .join(",");

  const reload = useCallback(() => {
    const entries = signature ? signature.split(",") : [];

    void Promise.all(
      entries.map(async (entry) => {
        const [id, marker] = entry.split(":");
        const count = await store.countUnread(
          id as string,
          marker ? marker : null,
          selfUserId,
        );
        return [id as string, count] as const;
      }),
    ).then((pairs) => {
      const next = new Map<string, number>();
      for (const [id, count] of pairs) if (count > 0) next.set(id, count);
      setUnread(next);
    });
  }, [signature, selfUserId]);

  useEffect(reload, [reload]);
  useSyncEvents((event) => {
    if (event.type === "messages") reload();
  });

  return unread;
}

/**
 * How far back the preview walk looks for a renderable message. Ops are
 * skipped, so a reaction-heavy burst must not push the real latest message
 * out of reach -- but the walk still has to end somewhere. A window this
 * deep being *all* ops means there is nothing sensible to preview anyway.
 */
const PREVIEW_WINDOW = 30;

export type ConversationPreview = {
  /** The newest renderable (non-op) message -- the preview's anchor. */
  message: StoredMessage;
  /** Decoded, with any authorised edit applied. Null when decrypt failed. */
  content: RenderableContent | null;
  /** Renders as "Message deleted" rather than the retracted text. */
  retracted: boolean;
};

/**
 * The most recent renderable message per conversation, for the list's
 * preview line.
 *
 * Walks a small newest-first window rather than taking the newest row,
 * because the newest row may be an op -- and "reacted 👍" is not what the
 * preview line is for. Ops seen on the way down are applied to the anchor
 * they land on: a retracted latest message previews as deleted instead of
 * leaking the text it no longer shows, and an edited one previews its
 * current text. Same authority rule as the timeline.
 */
export function useLatestMessages(
  conversations: readonly StoredConversation[],
): Map<string, ConversationPreview> {
  const [latest, setLatest] = useState<Map<string, ConversationPreview>>(
    new Map(),
  );
  const ids = conversations.map((c) => c.id).join(",");

  const reload = useCallback(() => {
    const list = ids ? ids.split(",") : [];
    void Promise.all(
      list.map(async (id) => {
        const page = await store.getConversationPage(id, {
          limit: PREVIEW_WINDOW,
        });

        // Newest first, so ops are seen before the targets they modify (an
        // op is always newer than its target). First edit seen per target is
        // the newest and wins.
        const retractedBy = new Map<string, Set<string>>();
        const editSeen = new Map<string, { text: string; by: string }>();
        for (const message of page) {
          const content = message.decryptFailed
            ? null
            : decodeContent(message.payload);

          if (content !== null && isMessageOp(content)) {
            if (content.kind === "retract") {
              const senders = retractedBy.get(content.target) ?? new Set();
              senders.add(message.senderUserId);
              retractedBy.set(content.target, senders);
            } else if (
              content.kind === "edit" &&
              !editSeen.has(content.target)
            ) {
              editSeen.set(content.target, {
                text: content.text,
                by: message.senderUserId,
              });
            }
            continue;
          }

          // The anchor: the newest message that is itself renderable.
          const retracted =
            retractedBy.get(message.messageId)?.has(message.senderUserId) ??
            false;
          const edit = editSeen.get(message.messageId);
          const withEdit =
            content !== null &&
            content !== "unsupported" &&
            edit !== undefined &&
            edit.by === message.senderUserId
              ? { ...content, text: edit.text }
              : content;
          return [
            id,
            { message, content: withEdit, retracted } satisfies ConversationPreview,
          ] as const;
        }
        return [id, undefined] as const;
      }),
    ).then((pairs) => {
      const next = new Map<string, ConversationPreview>();
      for (const [id, preview] of pairs) if (preview) next.set(id, preview);
      setLatest(next);
    });
  }, [ids]);

  useEffect(reload, [reload]);
  useSyncEvents((event) => {
    if (event.type === "messages") reload();
  });

  return latest;
}

/** How long a typing signal lives without renewal. Comfortably above the
 *  sender's 3s resend floor, so continuous typing renders continuously. */
const TYPING_TTL_MS = 6_000;

/**
 * Who is typing in a conversation right now, as user ids.
 *
 * Ephemeral by design -- this is the one kind of state that deliberately
 * does NOT live in IndexedDB: a typing signal five seconds old is already
 * stale, so there is nothing worth re-reading. State is a map of user id to
 * expiry deadline, renewed by each frame and pruned on a short timer;
 * silence is "stopped typing", because there is no stop frame. A message
 * arriving in the conversation clears its typers -- the composed thing
 * showed up, which is better information than the signal.
 */
export function useTyping(conversationId: string | null): string[] {
  const [typing, setTyping] = useState<string[]>([]);
  const deadlines = useRef(new Map<string, number>());

  // Reset when switching conversations; the map is per-conversation state.
  useEffect(() => {
    deadlines.current.clear();
    setTyping([]);
  }, [conversationId]);

  useSyncEvents((event) => {
    if (conversationId === null) return;
    if (event.type === "typing" && event.conversationId === conversationId) {
      deadlines.current.set(event.byUserId, Date.now() + TYPING_TTL_MS);
      setTyping([...deadlines.current.keys()]);
    } else if (
      event.type === "messages" &&
      event.conversationIds.includes(conversationId)
    ) {
      if (deadlines.current.size === 0) return;
      deadlines.current.clear();
      setTyping([]);
    }
  });

  // Prune expired entries. The timer only runs while somebody is typing,
  // and this is component state expiring, not data being polled for.
  useEffect(() => {
    if (typing.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [userId, deadline] of deadlines.current) {
        if (deadline <= now) {
          deadlines.current.delete(userId);
          changed = true;
        }
      }
      if (changed) setTyping([...deadlines.current.keys()]);
    }, 1_000);
    return () => clearInterval(timer);
  }, [typing.length]);

  return typing;
}

/** How often an open thread re-asks who is connected. Presence is a
 *  snapshot, not a subscription, so staleness between asks is the deal. */
const PRESENCE_REFRESH_MS = 60_000;

/**
 * Which other members of a conversation are connected, as user ids -- or
 * null while no answer has arrived, which means "unknown", never "nobody".
 *
 * Asks on mount and on a slow interval. The interval is a request for
 * ephemeral socket state, not a data fetch -- the rendering model's
 * "components never poll the API" rule guards IndexedDB-backed data, and
 * presence deliberately has no stored form to poll for.
 */
export function usePresence(conversationId: string | null): string[] | null {
  const [online, setOnline] = useState<string[] | null>(null);

  useEffect(() => {
    setOnline(null);
    if (conversationId === null) return;
    sync.requestPresence(conversationId);
    const timer = setInterval(
      () => sync.requestPresence(conversationId),
      PRESENCE_REFRESH_MS,
    );
    return () => clearInterval(timer);
  }, [conversationId]);

  useSyncEvents((event) => {
    if (
      event.type === "presence" &&
      conversationId !== null &&
      event.conversationId === conversationId
    ) {
      setOnline(event.online);
    }
  });

  return online;
}

/**
 * The delivered watermarks for one conversation: recipient user id -> the
 * newest of this account's message ids that user has acked. Fed by the
 * engine off "delivered" socket frames; empty until the first one arrives,
 * which is the honest state -- ticks are best-effort by design, and a read
 * receipt (from the conversation listing) always outranks them.
 */
export function useDeliveredMarks(
  conversationId: string | null,
): Record<string, string> {
  const [marks, setMarks] = useState<Record<string, string>>({});

  const reload = useCallback(() => {
    if (conversationId === null) {
      setMarks({});
      return;
    }
    void store
      .getMeta<Record<string, string>>(META_DELIVERED_PREFIX + conversationId)
      .then((stored) => setMarks(stored ?? {}));
  }, [conversationId]);

  useEffect(reload, [reload]);
  useSyncEvents((event) => {
    if (event.type === "receipts" && event.conversationId === conversationId) {
      reload();
    }
  });

  return marks;
}

/**
 * markSeen has to reach every mounted useAnnouncements, not just its own:
 * the unread dot and the list that clears it are different components with
 * separate hook instances. Sync events cover engine writes; this covers the
 * one write a hook makes itself. Module scope, because all instances in a
 * tab share this file -- and a broadcast handles the other tabs, since a
 * BroadcastChannel deliberately does not deliver to its own sender.
 */
const announcementListeners = new Set<() => void>();

/**
 * Operator announcements, plus how many the user has not yet looked at.
 *
 * Same shape as every hook here: a view over what the engine last stored,
 * re-read when it says so. The list is empty while the feature flag is off
 * (the server answers an empty page), so a surface gated on
 * `announcements.length > 0` is dark exactly when the feature is.
 *
 * "Seen" is the newest id at the moment the surface was actually shown --
 * ids are uuidv7, so "unread" is a string comparison against it. Client-
 * local by design; see META_ANNOUNCEMENTS_SEEN in store/types.ts.
 */
export function useAnnouncements(): {
  announcements: Announcement[];
  unread: number;
  markSeen: () => void;
} {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [lastSeen, setLastSeen] = useState<string | null>(null);

  const reload = useCallback(() => {
    void Promise.all([
      store.getMeta<Announcement[]>(META_ANNOUNCEMENTS),
      store.getMeta<string>(META_ANNOUNCEMENTS_SEEN),
    ]).then(([list, seen]) => {
      setAnnouncements(list ?? []);
      setLastSeen(seen ?? null);
    });
  }, []);

  useEffect(reload, [reload]);
  useSyncEvents((event) => {
    if (event.type === "announcements") reload();
  });
  useEffect(() => {
    announcementListeners.add(reload);
    return () => {
      announcementListeners.delete(reload);
    };
  }, [reload]);

  const unread = announcements.filter(
    (entry) => lastSeen === null || entry.id > lastSeen,
  ).length;

  const markSeen = useCallback(() => {
    const newest = announcements[0]?.id;
    if (!newest) return;
    setLastSeen(newest);
    void store.setMeta(META_ANNOUNCEMENTS_SEEN, newest).then(() => {
      // After the write, not before: a listener re-reads the store, and
      // notifying first would race it into reading the old value.
      for (const listener of announcementListeners) listener();
      broadcast({ type: "announcements" });
    });
  }, [announcements]);

  return { announcements, unread, markSeen };
}
