// When marking the announcements seen has anything to write.
//
// Pure, because the answer is the whole of the guard against a loop that
// shipped once: `useAnnouncements`' markSeen is called from an effect, the
// write it makes is re-read by every instance of the hook, and a mark that
// wrote unconditionally went round forever (sweep 1001, client-ui-2).

/**
 * The id to record as seen, or null when there is nothing to do.
 *
 * Nothing to do when there are no announcements, or when the stored "seen" is
 * already the newest -- or newer: ids are uuidv7, and a stored mark ahead of
 * the list (an announcement withdrawn since) must not be moved backwards,
 * which would light the unread dot for something already read.
 */
export function markSeenTarget(
  newestId: string | undefined,
  lastSeen: string | null,
): string | null {
  if (!newestId) return null;
  if (lastSeen !== null && lastSeen >= newestId) return null;
  return newestId;
}
