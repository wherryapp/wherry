// What the forward archive sync does with the pending-decrypt record after
// reading a page of archive rows.
//
// Its own module because the decision is pure and sync/engine.ts cannot load
// under Node's test runner.
//
// The record (`messageId -> conversationId`, meta `pendingDecrypt`) is where
// the forward sync starts: every run begins just before the smallest pending
// id and reads at most five pages. An id whose archive row was read and still
// did not open used to stay pending forever, so from then on every run
// re-read the same thousand rows and never reached any failure newer than
// that window (sweep 1001, client-core-10). A lost account key after "start
// fresh", a v2 row under a key that is gone, or a garbage envelope whose
// archive payload is garbage too are all rows no retry will open.
//
// So a row read and still failed is given up after FORWARD_SYNC_ATTEMPTS
// reads, not at once: the first read can simply be early (a history key a
// rotation minted seconds ago, not yet refreshed), and a few runs cover
// that. Anything that heals later is re-recorded anyway -- the generation
// walk re-reads a conversation's rows when a new history key arrives, and
// records what still fails.

export const FORWARD_SYNC_ATTEMPTS = 3;

/**
 * Settles one page against the pending record, in place: a healed id is
 * removed, and a still-failed one is counted and removed once it has been
 * read FORWARD_SYNC_ATTEMPTS times. `attempts` is the caller's count, kept in
 * memory -- a reload restarting it costs a few more reads, not a stuck sync.
 *
 * Returns the conversations with a healed message, for the re-render.
 */
export function settlePendingDecrypts(
  pending: Record<string, string>,
  page: readonly { messageId: string; conversationId: string; decryptFailed?: boolean }[],
  attempts: Map<string, number>,
): Set<string> {
  const healed = new Set<string>();
  for (const message of page) {
    if (pending[message.messageId] === undefined) continue;
    if (!message.decryptFailed) {
      delete pending[message.messageId];
      attempts.delete(message.messageId);
      healed.add(message.conversationId);
      continue;
    }
    const tries = (attempts.get(message.messageId) ?? 0) + 1;
    if (tries >= FORWARD_SYNC_ATTEMPTS) {
      delete pending[message.messageId];
      attempts.delete(message.messageId);
    } else {
      attempts.set(message.messageId, tries);
    }
  }
  return healed;
}
