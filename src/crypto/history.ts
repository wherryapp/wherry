// History keys: unwrap, mint, and share (protocol v3).
//
// The primitives the sync layer drives. Everything secret stays behind
// crypto/ -- the wrapped keys come in off the wire, the unwrapped 32-byte
// keys land in crypto/db.ts, and what leaves this module toward the server
// is HPKE ciphertext only. The exception is a freshly minted rotation key,
// which the caller holds just long enough to post the wrapped copies and
// then hands back to `saveRotatedKey` -- local state must not record a
// generation the server refused (409, somebody else's rotation won), the
// same discipline HandshakeOps applies to commits.
//
// Deliberately conversation-generic: nothing here knows what kind of
// conversation a key belongs to, or how many members it has.

import {
  generateHistoryKey,
  openArchive,
  sealForUser,
  KeysError,
} from "./keys.js";
import {
  listHistoryKeyIds,
  loadAccountKeypair,
  loadHistoryKey,
  saveHistoryKey,
} from "./db.js";

export type WrappedHistoryKey = {
  conversationId: string;
  generation: number;
  wrappedKey: Uint8Array;
};

export type HistoryKeyRecipient = {
  userId: string;
  /** The account public key from GET /conversations/:id/recipients. */
  publicKey: Uint8Array;
};

export type WrappedForUser = { userId: string; wrappedKey: Uint8Array };

/**
 * Unwraps and caches every wrapped key not already held, returning the
 * newly-seen (conversation, generation) pairs.
 *
 * That return value is load-bearing: a generation this device has never
 * held is the trigger for the engine's generation walk -- historical
 * messages produce no envelope, so nothing else will ever pull them.
 *
 * Returns [] without complaint when the account key is not unlocked; the
 * poll loop calls again next round. A key that fails to unwrap is skipped
 * with a warning rather than aborting the batch -- one corrupt row must not
 * stop every other conversation's keys from landing.
 */
export async function ingestWrappedKeys(
  entries: readonly WrappedHistoryKey[],
): Promise<{ conversationId: string; generation: number }[]> {
  if (entries.length === 0) return [];

  const keypair = await loadAccountKeypair();
  if (!keypair) return [];

  const held = new Set(
    (await listHistoryKeyIds()).map(
      (id) => `${id.conversationId}:${id.generation}`,
    ),
  );

  const fresh: { conversationId: string; generation: number }[] = [];
  for (const entry of entries) {
    if (held.has(`${entry.conversationId}:${entry.generation}`)) continue;
    try {
      const key = await openArchive(keypair.privateKey, entry.wrappedKey);
      await saveHistoryKey(entry.conversationId, entry.generation, key);
      fresh.push({
        conversationId: entry.conversationId,
        generation: entry.generation,
      });
    } catch (error) {
      if (error instanceof KeysError) {
        console.warn(
          "history key could not be unwrapped",
          entry.conversationId,
          entry.generation,
          error.code,
        );
        continue;
      }
      throw error;
    }
  }
  return fresh;
}

/**
 * Mints a fresh history key and seals it to every recipient.
 *
 * The caller posts `wrapped` as generation N+1 and, only on success, hands
 * `key` to `saveRotatedKey` -- see the module note. On a conflict the key is
 * simply dropped; the winner's copy arrives with the next ingest.
 */
export async function mintRotation(
  recipients: readonly HistoryKeyRecipient[],
): Promise<{ key: Uint8Array; wrapped: WrappedForUser[] }> {
  const key = generateHistoryKey();
  const wrapped = await Promise.all(
    recipients.map(async (recipient) => ({
      userId: recipient.userId,
      wrappedKey: await sealForUser(recipient.publicKey, key),
    })),
  );
  return { key, wrapped };
}

/** Records a rotation the server accepted. */
export async function saveRotatedKey(
  conversationId: string,
  generation: number,
  key: Uint8Array,
): Promise<void> {
  await saveHistoryKey(conversationId, generation, key);
}

/**
 * Seals every generation this device holds for a conversation to each new
 * member -- the "share previous messages" backfill. One entry per held
 * generation, ready to POST; the honest limit is right here in the
 * signature: an adder can only share what they hold, so somebody who joined
 * late shares only from their own join point.
 */
export async function mintBackfill(
  conversationId: string,
  recipients: readonly HistoryKeyRecipient[],
): Promise<{ generation: number; keys: WrappedForUser[] }[]> {
  const held = (await listHistoryKeyIds())
    .filter((id) => id.conversationId === conversationId)
    .map((id) => id.generation)
    .sort((a, b) => a - b);

  const batches: { generation: number; keys: WrappedForUser[] }[] = [];
  for (const generation of held) {
    const key = await loadHistoryKey(conversationId, generation);
    if (!key) continue;
    batches.push({
      generation,
      keys: await Promise.all(
        recipients.map(async (recipient) => ({
          userId: recipient.userId,
          wrappedKey: await sealForUser(recipient.publicKey, key),
        })),
      ),
    });
  }
  return batches;
}
