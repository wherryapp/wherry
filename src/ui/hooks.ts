// React bindings over the store and the sync engine.
//
// The shape every one of these follows: read from IndexedDB, then re-read when
// the engine says something changed. Components never call the API directly
// and never poll -- there is one loop, it runs in one tab, and everything else
// is a view over local storage. That is what makes the leader election
// invisible to the UI and what will make the Phase 4 switch to WebSockets a
// change to the engine alone.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { store } from "../store";
import type { OutboxEntry, StoredConversation, StoredMessage } from "../store/types";
import { sync, type SyncEvent, type SyncStatus } from "../sync/engine";
import { subscribeToBroadcasts } from "../sync/leader";

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
  | { kind: "pending"; entry: OutboxEntry };

/**
 * A conversation's messages, oldest at the top, with unsent ones at the end.
 *
 * Stored messages and outbox entries are rendered together so a composed
 * message appears the instant it is typed rather than after a round trip. They
 * stay separate in storage because an outbox entry has no server id until the
 * send succeeds, and `messages` is keyed on exactly that.
 */
export function useTimeline(conversationId: string | null): {
  items: TimelineItem[];
  hasMore: boolean;
  loadOlder: () => void;
} {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [pending, setPending] = useState<OutboxEntry[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [hasMore, setHasMore] = useState(false);

  const reload = useCallback(() => {
    if (!conversationId) {
      setMessages([]);
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

    void store.listOutbox(conversationId).then(setPending);
  }, [conversationId, limit]);

  useEffect(reload, [reload]);

  useSyncEvents((event) => {
    if (event.type === "messages") {
      if (!conversationId) return;
      if (!event.conversationIds.includes(conversationId)) return;
      reload();
    }
  });

  const items = useMemo<TimelineItem[]>(
    () => [
      ...messages.map((message) => ({ kind: "sent" as const, message })),
      ...pending.map((entry) => ({ kind: "pending" as const, entry })),
    ],
    [messages, pending],
  );

  const loadOlder = useCallback(() => setLimit((n) => n + PAGE), []);

  useEffect(() => setLimit(PAGE), [conversationId]);

  return { items, hasMore, loadOlder };
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
