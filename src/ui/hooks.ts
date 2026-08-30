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

export type TimelineItem =
  | { kind: "sent"; message: StoredMessage }
  | { kind: "pending"; entry: OutboxEntry }
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
 */
export function useTimeline(conversationId: string | null): {
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

  const items = useMemo<TimelineItem[]>(
    () => [
      ...messages.map((message) => ({ kind: "sent" as const, message })),
      ...events.map((event) => ({ kind: "event" as const, event })),
      ...pending.map((entry) => ({ kind: "pending" as const, entry })),
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
    }),
    [messages, events, pending],
  );

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

/** The most recent message per conversation, for the list's preview line. */
export function useLatestMessages(
  conversations: readonly StoredConversation[],
): Map<string, StoredMessage> {
  const [latest, setLatest] = useState<Map<string, StoredMessage>>(new Map());
  const ids = conversations.map((c) => c.id).join(",");

  const reload = useCallback(() => {
    const list = ids ? ids.split(",") : [];
    void Promise.all(
      list.map(async (id) => [id, await store.getLatestMessage(id)] as const),
    ).then((pairs) => {
      const next = new Map<string, StoredMessage>();
      for (const [id, message] of pairs) if (message) next.set(id, message);
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
