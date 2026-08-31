// Where the read/unread boundary falls in a rendered timeline.
//
// Its own file, and pure, so the rules can be pinned by node:test -- the
// divider is the visible half of a number the sidebar badge already shows,
// and the two disagreeing would be worse than neither existing. Everything
// here therefore mirrors store.countUnread exactly; see the comments below.

import type { TimelineItem } from "./hooks";

/**
 * The divider's anchor: the first item strictly after the marker that
 * somebody else sent, and how many qualify.
 *
 * The three rules are store.countUnread's, restated over rendered items
 * rather than over the index:
 *
 * - **Exclusive** lower bound. The marked message has been read; everything
 *   strictly after it has not. A null marker means nothing has been read.
 * - **Your own messages never count.** Sending is not news to the sender.
 * - Operations (reactions, edits, retractions) do not count. That one is
 *   free here: useTimeline has already folded ops into their targets' marks,
 *   so an op is never a `sent` item in the first place.
 *
 * Message ids are UUIDv7, so "after the marker" is a plain code-unit string
 * compare -- the same ordering countUnread's IDBKeyRange walks. Not
 * localeCompare: that is locale-sensitive about punctuation, and these ids
 * carry dashes.
 *
 * Returns null when nothing qualifies, which is the ordinary case of an
 * already-read conversation.
 */
export function unreadBoundary(
  items: readonly TimelineItem[],
  lastReadMessageId: string | null,
  selfUserId: string,
): { firstUnreadId: string; count: number } | null {
  let firstUnreadId: string | null = null;
  let count = 0;

  for (const item of items) {
    // Notices carry no read state and pending entries have no server id yet,
    // so neither can sit on either side of a boundary.
    if (item.kind !== "sent") continue;

    const { messageId, senderUserId } = item.message;
    if (lastReadMessageId !== null && messageId <= lastReadMessageId) continue;
    if (senderUserId === selfUserId) continue;

    if (firstUnreadId === null) firstUnreadId = messageId;
    count += 1;
  }

  return firstUnreadId === null ? null : { firstUnreadId, count };
}
