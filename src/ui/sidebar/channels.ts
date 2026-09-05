// A hub's channels grouped under its categories, as a pure function.
//
// Structural like rank.ts -- generic over "has an id and a categoryId" so
// the test beside it runs under bare node:test -- and shared by the sidebar
// (both the vertical list and the folded rail) and the hub panel, which is
// what keeps "where does this channel sit?" answered once.

export type Grouped<C, K> = {
  /** Null for the uncategorised group, which always comes first. */
  category: K | null;
  channels: C[];
};

/**
 * Uncategorised channels first with no heading, then each category in the
 * order given (the server's `position`), each holding its channels in the
 * order given (creation order -- channels are not reordered within a
 * category). A channel whose categoryId names nothing in `categories` --
 * a category deleted on another device before this one refreshed -- is
 * treated as uncategorised rather than dropped: a channel is never hidden
 * by its heading going away.
 *
 * `includeEmpty` keeps categories with no channels -- the hub panel wants
 * to show a category that was just created so it can be filed into; the
 * sidebar does not want a heading over nothing.
 */
export function groupChannels<
  C extends { categoryId: string | null },
  K extends { id: string },
>(
  channels: readonly C[],
  categories: readonly K[],
  options: { includeEmpty?: boolean } = {},
): Grouped<C, K>[] {
  const known = new Map<string, C[]>(
    categories.map((category) => [category.id, [] as C[]]),
  );
  const loose: C[] = [];
  for (const channel of channels) {
    const bucket =
      channel.categoryId === null ? undefined : known.get(channel.categoryId);
    (bucket ?? loose).push(channel);
  }

  const groups: Grouped<C, K>[] = [];
  // Always present when a hub has no categories at all, so a hub that has
  // never made one renders exactly the flat list it always had -- and
  // dropped when it would be an empty first group above real headings.
  if (loose.length > 0 || categories.length === 0) {
    groups.push({ category: null, channels: loose });
  }
  for (const category of categories) {
    const list = known.get(category.id) ?? [];
    if (list.length > 0 || options.includeEmpty) {
      groups.push({ category, channels: list });
    }
  }
  return groups;
}

/**
 * A hub's roll-up for a folded surface: unread count and mention flag
 * across its channels, so a rail icon or a collapsed header still carries
 * the signal the fold hides. Muted channels are excluded from the count --
 * that is what mute means -- but a mention surfaces regardless, the
 * stronger signal, same reasoning as mention-gated push.
 */
export function hubAggregate(
  hub: { channels: readonly { id: string }[] },
  unread: ReadonlyMap<string, number>,
  mentions: ReadonlySet<string>,
  muted: ReadonlySet<string>,
): { count: number; mentioned: boolean } {
  let count = 0;
  let mentioned = false;
  for (const channel of hub.channels) {
    if (!muted.has(channel.id)) count += unread.get(channel.id) ?? 0;
    if (mentions.has(channel.id)) mentioned = true;
  }
  return { count, mentioned };
}
