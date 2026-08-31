// Sidebar ordering, as pure functions: how DM rows rank and how the user's
// manual hub order is applied. Deliberately structural -- everything here is
// generic over "has an id" / "has a message sent time" rather than importing
// the store's types, so the module has no runtime dependencies and the tests
// beside it run under bare node:test (`pnpm test` from client/, no DOM, no
// IndexedDB).

/** Higher ranks sort earlier. The sidebar's current metric is recency; a
 *  future one (frecency, pinned-first) is a new ranker factory, not a change
 *  to rankConversations. */
export type ConversationRanker<T extends { id: string }> = (c: T) => number;

/**
 * The millisecond timestamp a UUIDv7 carries in its first 48 bits. Recency
 * fallback for a conversation with no preview (brand new, or its newest
 * window is all ops): creation time, which is exactly what the sidebar
 * sorted by before recency existed.
 */
export function uuidv7Ms(id: string): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/**
 * Rank by the latest renderable message's sent time, falling back to the
 * conversation's own creation time. `latest` is useLatestMessages' map,
 * narrowed to the one field this needs.
 */
export function recencyRanker<T extends { id: string }>(
  latest: ReadonlyMap<string, { message: { sentAt: string } }>,
): ConversationRanker<T> {
  return (c) => {
    const preview = latest.get(c.id);
    return preview ? Date.parse(preview.message.sentAt) : uuidv7Ms(c.id);
  };
}

/**
 * Sort descending by rank. Ties break by id descending -- deterministic,
 * and identical to the pre-recency order, so equal-ranked rows sit exactly
 * where they always did.
 */
export function rankConversations<T extends { id: string }>(
  list: readonly T[],
  rank: ConversationRanker<T>,
): T[] {
  return [...list].sort(
    (a, b) => rank(b) - rank(a) || b.id.localeCompare(a.id),
  );
}

/**
 * Apply the user's manual hub order. Hubs the stored order knows sort by
 * their stored position; hubs it does not (joined since the last reorder)
 * append after them in server order. Stale stored ids -- hubs since left --
 * simply match nothing here; the next reorder writes only present ids,
 * which is what prunes them.
 */
/**
 * Move a list item to an insertion slot, drag-and-drop style: `overIndex`
 * counts gaps (0 = before the first item, length = after the last), so the
 * two slots hugging the item itself are the no-op positions.
 */
export function moveItem<T>(
  list: readonly T[],
  fromIndex: number,
  overIndex: number,
): T[] {
  const target = overIndex > fromIndex ? overIndex - 1 : overIndex;
  const moved = list[fromIndex];
  if (target === fromIndex || moved === undefined) return [...list];
  const next = [...list];
  next.splice(fromIndex, 1);
  next.splice(target, 0, moved);
  return next;
}

export function orderHubs<T extends { id: string }>(
  hubs: readonly T[],
  order: readonly string[],
): T[] {
  const pos = new Map(order.map((id, index) => [id, index] as const));
  const known: T[] = [];
  const unknown: T[] = [];
  for (const hub of hubs) (pos.has(hub.id) ? known : unknown).push(hub);
  known.sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
  return [...known, ...unknown];
}
