// The poll loop.
//
// Everything that talks to the server on a schedule lives here, and exactly
// one tab runs it (see leader.ts). Components never poll; they read IndexedDB
// and are told when it changed.
//
// ---------------------------------------------------------------------------
// The order of operations that matters
// ---------------------------------------------------------------------------
//
//   fetch -> store -> *transaction commits* -> ack
//
// Delivery is at-least-once, and acking is the only thing that stops the
// server handing an envelope over again. Acking before the write is durable
// converts that into at-most-once: a tab closed in the wrong millisecond loses
// messages the server now believes were delivered, and because `GET /inbox`
// filters on `acked_at IS NULL`, nothing will ever serve them again.
//
// This is why `store.putMessages` resolves on transaction commit rather than
// on the put requests being queued, and why the ack is a separate awaited
// step rather than fired alongside.

import {
  ApiError,
  ackEnvelopes,
  fetchArchive,
  fetchInbox,
  isUnauthorized,
  isUnreachable,
  listConversations,
  sendMessage,
  downloadAttachment,
} from "../api/client";
import { decodeBase64, encodeBase64 } from "../api/base64";
import { loadSession } from "../api/session";
import { decodeContent } from "../api/payload";
import type { ArchiveEntry, InboxEnvelope } from "../api/types";
import { e2e, E2EError } from "../crypto";
import { BlobCryptoError, openAttachmentBytes } from "../crypto/blob";
import { store } from "../store";
import {
  META_HYDRATION,
  type HydrationState,
  type OutboxEntry,
  type StoredMessage,
} from "../store/types";
import { Backoff, sleep } from "./backoff";
import { broadcast, runAsLeader, type LeaderHandle } from "./leader";
import {
  ensureRecipients,
  mlsEnabled,
  mlsSync,
  type Identity,
} from "./mls";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

// A 2-second poll spends 30 requests/min against a 300/min budget, which is
// what docs/api.md sizes the inbox allowance for. Only the leader polls, so
// this is the whole app's cost regardless of how many tabs are open.
const VISIBLE_INTERVAL_MS = 2_000;

// Backgrounded tabs get throttled by the browser anyway; asking for 2s there
// would be a request the browser declines to honour and a budget spent on
// nobody looking. Coming back to the foreground pokes immediately, so the
// slower cadence is never what the user waits on.
const HIDDEN_INTERVAL_MS = 15_000;

// The server caps both at 500. Large pages matter for the backlog case -- a
// client returning after a week should not drain it 100 at a time.
const INBOX_PAGE = 200;
const ARCHIVE_PAGE = 200;

// Conversation metadata changes rarely; there is no reason to re-read it on
// every 2-second tick.
const CONVERSATION_REFRESH_MS = 30_000;

// The forward archive sync runs while any stored message is still
// undecrypted -- a state that resolves within a sweep or two, or not at all
// (a locked account key). Either way, once per interval is plenty.
const FORWARD_SYNC_INTERVAL_MS = 30_000;

/** messageId -> conversationId of stored messages whose decrypt failed. */
const META_PENDING_DECRYPT = "mls.pendingDecrypt";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type SyncState =
  | "stopped"
  | "follower"
  | "hydrating"
  | "syncing"
  | "idle"
  | "offline"
  | "unauthorized";

export type SyncStatus = {
  state: SyncState;
  lastSyncAt: string | null;
  /** Human-readable, for a status line. Never matched on. */
  error: string | null;
};

export type SyncEvent =
  | { type: "status"; status: SyncStatus }
  | { type: "messages"; conversationIds: string[] }
  | { type: "conversations" };

type Listener = (event: SyncEvent) => void;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Inbox envelopes and archive entries become the same stored record.
 *
 * They differ only in that an envelope has an `envelopeId` -- the id of the
 * per-device copy, which is a delivery detail and not part of the message. The
 * archive has no such id because it is per user. Everything that identifies
 * the *message* is common to both, which is why one function covers them and
 * why storing the same message from both sources is a no-op rather than a
 * duplicate.
 */
/**
 * Decrypts wire bytes for storage.
 *
 * Decryption happens once, at ingest, rather than at render time -- see the
 * note on `E2EProvider.decrypt` in crypto/provider.ts. A payload the
 * provider cannot open is stored as the wire bytes with `decryptFailed`
 * set: the flag is what Chat.tsx renders a placeholder from, and what the
 * forward archive sync uses to know there is healing to do.
 */
async function decryptForStorage(
  conversationId: string,
  protocolVersion: number,
  wireBytes: Uint8Array,
  from: "envelope" | "archive",
): Promise<{ payload: Uint8Array; decryptFailed: boolean }> {
  try {
    const payload = await e2e.decrypt({
      conversationId,
      protocolVersion,
      payload: wireBytes,
      source: from,
    });
    return { payload, decryptFailed: false };
  } catch (error) {
    if (error instanceof E2EError) {
      return { payload: wireBytes, decryptFailed: true };
    }
    throw error;
  }
}

/** Turns one inbox envelope or archive entry into the record the store keeps. */
async function toStored(
  source: InboxEnvelope | ArchiveEntry,
  from: "envelope" | "archive",
): Promise<StoredMessage> {
  const wireBytes = decodeBase64(source.payload);
  const { payload, decryptFailed } = await decryptForStorage(
    source.conversationId,
    source.protocolVersion,
    wireBytes,
    from,
  );

  return {
    messageId: source.messageId,
    conversationId: source.conversationId,
    senderUserId: source.senderUserId,
    senderDeviceId: source.senderDeviceId,
    // Carried through, never assumed. What decrypt did or did not manage is
    // recorded here, not inferred from the bytes.
    protocolVersion: source.protocolVersion,
    payload,
    ...(decryptFailed ? { decryptFailed: true as const } : {}),
    sentAt: source.sentAt,
  };
}

function uniqueConversations(messages: readonly StoredMessage[]): string[] {
  return [...new Set(messages.map((m) => m.conversationId))];
}

/**
 * Everything a v2 send needs, sealed -- or null when it cannot be sealed
 * yet. Shared by enqueue (compose time) and the outbox flush (the retry
 * after `pendingEncryption`, and the re-encrypt after EPOCH_STALE).
 *
 * Under passthrough there is nothing that can fail and no archive to seal:
 * the server-side provider still does that work until the cutover.
 */
async function sealForOutbox(
  conversationId: string,
  plaintext: Uint8Array,
): Promise<Pick<
  OutboxEntry,
  "protocolVersion" | "payload" | "epoch" | "archive"
> | null> {
  if (!e2e.handshake) {
    const wire = await e2e.encrypt(conversationId, plaintext);
    return { protocolVersion: wire.protocolVersion, payload: wire.payload };
  }

  // Recipient keys first, encryption second, deliberately: encrypting
  // advances the ratchet, and a wire payload we then had to throw away
  // because the archive could not be sealed would consume a key for
  // nothing.
  const recipients = await ensureRecipients(conversationId);
  if (!recipients) return null;

  try {
    const wire = await e2e.encrypt(conversationId, plaintext);
    const archive = await e2e.encryptForArchive(
      conversationId,
      plaintext,
      recipients.map((recipient) => ({
        userId: recipient.userId,
        publicKey: decodeBase64(recipient.publicKey),
      })),
    );

    return {
      protocolVersion: wire.protocolVersion,
      payload: wire.payload,
      ...(wire.epoch !== undefined ? { epoch: wire.epoch } : {}),
      archive: archive.map((row) => ({
        userId: row.userId,
        payload: row.payload,
      })),
    };
  } catch (error) {
    if (error instanceof E2EError && error.code === "NOT_IN_GROUP") {
      return null;
    }
    throw error;
  }
}

/**
 * Whether a failed send can never succeed as written.
 *
 * A 4xx that is not a 429 is the server saying the request itself is wrong:
 * the payload is over the ceiling, the sender is no longer a member, every
 * recipient device is revoked. Retrying is pointless and, worse, blocks
 * everything queued behind it. 429 is the exception -- it means "not now",
 * which is precisely a thing worth retrying.
 */
function isPermanentSendFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429 &&
    error.status !== 401
  );
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class SyncEngine {
  #leader: LeaderHandle | null = null;
  #listeners = new Set<Listener>();
  #status: SyncStatus = { state: "stopped", lastSyncAt: null, error: null };
  #backoff = new Backoff();
  #wake: (() => void) | null = null;
  #lastConversationRefresh = 0;
  #lastForwardSync = 0;
  #onUnauthorized: (() => void) | null = null;

  // -- public surface ------------------------------------------------------

  get status(): SyncStatus {
    return this.#status;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(options: { onUnauthorized?: () => void } = {}): void {
    if (this.#leader) return;
    this.#onUnauthorized = options.onUnauthorized ?? null;

    this.#setStatus({ state: "follower", error: null });

    this.#leader = runAsLeader("messenger.sync", (signal) =>
      this.#runLoop(signal),
    );

    document.addEventListener("visibilitychange", this.#onVisibility);
  }

  stop(): void {
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#leader?.stop();
    this.#leader = null;
    this.#wake = null;
    this.#setStatus({ state: "stopped", error: null });
  }

  /** Runs a sync now instead of waiting for the next tick. */
  poke(): void {
    this.#wake?.();
  }

  /**
   * Queues a message and tries to send it immediately.
   *
   * Writing to the outbox first, before any network call, is what makes a send
   * survive a closed tab or a dead connection: the message is on disk before
   * anything can go wrong with delivering it. The UI renders the outbox
   * alongside stored messages, so it appears instantly either way.
   *
   * Any tab may call this -- sends are idempotent on clientMessageId, so a
   * race is harmless. The retry belongs to the leader, like everything else on
   * a schedule.
   *
   * Encryption happens here, once, rather than inside the retry loop. A retry
   * resends the same wire bytes; re-encrypting on every attempt would be
   * wasted work today and, under a real ratcheting protocol, would consume a
   * fresh key on every retry of what is supposed to be the same message.
   */
  async enqueue(conversationId: string, plaintext: Uint8Array): Promise<void> {
    const base = {
      // Generated once here and reused on every retry. A fresh id per attempt
      // is what turns one message into several; see docs/api.md.
      clientMessageId: crypto.randomUUID(),
      conversationId,
      // Kept alongside the encrypted payload purely so the pending bubble has
      // something to render -- see the field's comment in store/types.ts.
      content: plaintext,
      createdAt: new Date().toISOString(),
      attempts: 0,
    };

    const sealed = await sealForOutbox(conversationId, plaintext);
    const entry: OutboxEntry = sealed
      ? { ...base, ...sealed }
      : {
          // Cannot encrypt yet -- no group state (not joined, or the group
          // is still being created) or no recipient keys. Parked with the
          // plaintext; the flush seals it the moment it can. The message
          // still appears instantly, which is the outbox's whole promise.
          ...base,
          protocolVersion: e2e.protocolVersion,
          payload: new Uint8Array(0),
          pendingEncryption: true,
        };

    await store.enqueueOutbox(entry);
    this.#emit({ type: "messages", conversationIds: [conversationId] });
    this.poke();
  }

  /** Retries a send that was marked permanently failed. */
  async retry(clientMessageId: string): Promise<void> {
    const entries = await store.listOutbox();
    const entry = entries.find((e) => e.clientMessageId === clientMessageId);
    if (!entry) return;
    await store.enqueueOutbox({
      ...entry,
      attempts: 0,
      failedPermanently: false,
      ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
    });
    this.poke();
  }

  // -- the loop ------------------------------------------------------------

  #onVisibility = (): void => {
    // Coming back to a stale timeline for two seconds is the most visible way
    // polling feels slow, and it costs one request to avoid.
    if (document.visibilityState === "visible") this.poke();
  };

  async #runLoop(signal: AbortSignal): Promise<void> {
    try {
      await this.#hydrate(signal);
    } catch (error) {
      if (signal.aborted) return;
      if (this.#handleFatal(error)) return;
      // A failed hydration is not fatal: the poll loop still delivers new
      // messages, and the next start tries again from the stored cursor.
      console.warn("archive hydration did not finish", error);
    }

    while (!signal.aborted) {
      try {
        // Note `error` is deliberately not cleared here. A retry that is
        // itself in flight is not evidence the problem is over, and clearing
        // it would make the status banner flicker off and back on for every
        // attempt during an outage. Only a success clears it, below.
        this.#setStatus({ state: "syncing" });

        await this.#refreshConversations(signal);

        // Membership before messages: welcomes and commits are what make
        // the sends and reads below able to happen at all. No-op without a
        // handshake-capable provider.
        if (mlsEnabled()) {
          const session = loadSession();
          if (session) {
            const identity: Identity = {
              userId: session.user.id,
              deviceId: session.device.id,
            };
            const joined = await mlsSync.tick(identity, signal);
            if (joined.length > 0) {
              this.#emit({ type: "messages", conversationIds: joined });
              broadcast({ type: "messages", conversationIds: joined });
            }
          }
        }

        await this.#flushOutbox(signal);
        await this.#drainInbox(signal);
        await this.#forwardArchiveSync(signal);

        this.#backoff.reset();
        this.#setStatus({
          state: "idle",
          error: null,
          lastSyncAt: new Date().toISOString(),
        });
      } catch (error) {
        if (signal.aborted) return;
        if (this.#handleFatal(error)) return;

        const delay = this.#delayAfter(error);
        this.#setStatus({
          state: "offline",
          // A proxy's 502 and a failed connection are the same event to the
          // person reading this line, so they get the same words.
          error: isUnreachable(error)
            ? "Cannot reach the server"
            : error instanceof Error
              ? error.message
              : "Something went wrong",
        });

        try {
          await sleep(delay, signal);
        } catch {
          return;
        }
        continue;
      }

      try {
        await this.#waitForNextTick(signal);
      } catch {
        return;
      }
    }
  }

  /**
   * Returns true if the loop should stop entirely.
   *
   * A 401 is the one error that must not be retried. The token is dead, every
   * retry is guaranteed to fail, and each one spends login rate-limit budget
   * the user will need in a moment to sign back in. Returning from the loop
   * also releases the Web Lock, so another tab does not inherit a doomed loop.
   */
  #handleFatal(error: unknown): boolean {
    if (!isUnauthorized(error)) return false;
    this.#setStatus({ state: "unauthorized", error: "Your session expired" });
    this.#onUnauthorized?.();
    return true;
  }

  #delayAfter(error: unknown): number {
    // Honour Retry-After when the server sends one. At a 2-second poll a 429
    // should be unreachable, so seeing one means something is wrong with the
    // client rather than with the user -- back off exactly as told.
    if (error instanceof ApiError && error.retryAfterSeconds) {
      return Math.max(error.retryAfterSeconds * 1000, this.#backoff.next());
    }
    return this.#backoff.next();
  }

  /**
   * Waits for the next tick, or for a poke, whichever comes first.
   *
   * A self-scheduling wait rather than setInterval. An interval fires on a
   * fixed schedule regardless of whether the previous request finished, so a
   * slow server produces overlapping requests that pile up exactly when it can
   * least afford them. Waiting *after* the work settles cannot do that.
   */
  #waitForNextTick(signal: AbortSignal): Promise<void> {
    const interval =
      document.visibilityState === "visible"
        ? VISIBLE_INTERVAL_MS
        : HIDDEN_INTERVAL_MS;

    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.#wake = null;
      };

      const timer = setTimeout(() => {
        done();
        resolve();
      }, interval);

      const onAbort = () => {
        done();
        reject(signal.reason);
      };

      signal.addEventListener("abort", onAbort, { once: true });

      this.#wake = () => {
        done();
        resolve();
      };
    });
  }

  // -- the work ------------------------------------------------------------

  /**
   * The one-time walk of `/archive`.
   *
   * This is what gives a *new* device its history, and what recovers a browser
   * that had its site data cleared. It cannot be served out of the inbox: an
   * envelope is addressed to a device and under version 2 is sealed to that
   * device's key, so a device that did not exist at send time has no envelope
   * and the server cannot make one.
   *
   * The completion flag is stored rather than inferred, because an empty store
   * is ambiguous -- a brand new account and a device that has never hydrated
   * look identical and need opposite behaviour.
   *
   * The cursor is written after each page is stored, so an interrupted walk
   * resumes rather than restarting. Re-reading one page is harmless; the
   * archive is a plain read with no ack.
   */
  async #hydrate(signal: AbortSignal): Promise<void> {
    const state = await store.getMeta<HydrationState>(META_HYDRATION);
    if (state?.complete) return;

    this.#setStatus({ state: "hydrating", error: null });

    let cursor = state?.cursor ?? undefined;

    for (;;) {
      if (signal.aborted) return;

      const page = await fetchArchive(
        { cursor, limit: ARCHIVE_PAGE },
        { signal },
      );

      const messages = await Promise.all(
        page.entries.map((entry) => toStored(entry, "archive")),
      );
      await store.putMessages(messages);
      await this.#recordPendingDecrypts(messages);

      // Written after the messages are durable, so a crash between the two
      // costs a re-read rather than a gap.
      await store.setMeta(META_HYDRATION, {
        complete: page.nextCursor === null,
        cursor: page.nextCursor,
        updatedAt: new Date().toISOString(),
      } satisfies HydrationState);

      if (messages.length > 0) {
        const conversationIds = uniqueConversations(messages);
        this.#emit({ type: "messages", conversationIds });
        broadcast({ type: "messages", conversationIds });
      }

      // nextCursor, not an empty page. They agree here, but the cursor is the
      // documented contract and the one that stays right.
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  }

  /**
   * Drains the inbox until it comes back short.
   *
   * A poll is not one request. A client returning after a week has a backlog,
   * and draining it one page per tick would take minutes; looping until a
   * short page means the backlog clears as fast as the connection allows.
   */
  async #drainInbox(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;

      const envelopes = await fetchInbox({ limit: INBOX_PAGE, signal });
      if (envelopes.length === 0) return;

      // Dedup BEFORE decrypt, not after. Two envelopes legitimately carry a
      // message the store already has: a redelivery after a failed ack, and
      // the echo of this device's own send (already stored from the send
      // response). Under a ratcheting protocol the key that decrypted the
      // first copy is gone, so a second decrypt attempt is guaranteed to
      // fail -- the known copies are acked without one.
      const known = await store.existingMessageIds(
        envelopes.map((envelope) => envelope.messageId),
      );
      const fresh = envelopes.filter(
        (envelope) => !known.has(envelope.messageId),
      );

      const messages = await Promise.all(
        fresh.map((envelope) => toStored(envelope, "envelope")),
      );

      // Resolves on commit. Everything below depends on that.
      await store.putMessages(messages);
      await this.#recordPendingDecrypts(messages);

      // Only now, and every envelope in the page -- the known ones too.
      // See the note at the top of this file.
      await ackEnvelopes(
        envelopes.map((envelope) => envelope.envelopeId),
        { signal },
      );

      const conversationIds = uniqueConversations(messages);
      this.#emit({ type: "messages", conversationIds });
      broadcast({ type: "messages", conversationIds });

      // A message can be the first this device has heard of a conversation --
      // somebody else created it and sent to it. Storing the message is not
      // enough to make it visible, because the list is built from
      // `conversations` and there is no row to hang the thread on.
      await this.#refreshUnknownConversations(conversationIds, signal);

      // Attachments are fetched now rather than when somebody looks at them.
      // Deliberately after the ack: the messages are already durable, so a
      // failure here costs a photo that can be fetched later rather than a
      // message that has to be delivered again.
      await this.#fetchAttachments(messages, signal);

      if (envelopes.length < INBOX_PAGE) return;
    }
  }

  /**
   * Sends everything queued, oldest first.
   *
   * Sequential rather than parallel, deliberately: the outbox is a queue, and
   * sending concurrently would let a person's own messages arrive out of the
   * order they typed them.
   */
  async #flushOutbox(signal: AbortSignal): Promise<void> {
    const session = loadSession();
    if (!session) return;

    const pending = await store.listOutbox();

    // Conversations with an entry that cannot be sealed yet. Later entries
    // for the same conversation must wait behind it -- sending them first
    // would deliver a person's messages out of the order they typed them --
    // while other conversations flow on.
    const blocked = new Set<string>();

    for (let entry of pending) {
      if (signal.aborted) return;
      if (entry.failedPermanently) continue;
      if (blocked.has(entry.conversationId)) continue;

      if (entry.pendingEncryption) {
        const sealed = await sealForOutbox(entry.conversationId, entry.content);
        if (!sealed) {
          blocked.add(entry.conversationId);
          continue;
        }
        const { pendingEncryption: _dropped, ...rest } = entry;
        entry = { ...rest, ...sealed };
        await store.enqueueOutbox(entry);
      }

      try {
        const result = await sendMessage({
          conversationId: entry.conversationId,
          clientMessageId: entry.clientMessageId,
          payload: encodeBase64(entry.payload),
          ...(entry.epoch !== undefined && entry.archive
            ? {
                epoch: entry.epoch,
                archive: entry.archive.map((row) => ({
                  userId: row.userId,
                  payload: encodeBase64(row.payload),
                })),
              }
            : {}),
        });

        // Written from the send response rather than waiting for the echo
        // through the inbox. The response carries the real message id, so the
        // record is complete and the echo upserts onto the same key a moment
        // later -- no flicker, and it still works if the echo is slow.
        //
        // `deduplicated: true` lands here too, which is the point of retrying:
        // the message exists, so this is a success.
        //
        // `entry.content` rather than decrypting `entry.payload` back --
        // `enqueue` already has the plaintext, and asking the provider to
        // decrypt what it just encrypted moments ago would be a wasted round
        // trip that risks disagreeing with itself.
        await store.resolveOutbox(entry.clientMessageId, {
          messageId: result.id,
          conversationId: result.conversationId,
          senderUserId: session.user.id,
          senderDeviceId: session.device.id,
          protocolVersion: entry.protocolVersion,
          payload: entry.content,
          sentAt: result.createdAt,
        });

        this.#emit({
          type: "messages",
          conversationIds: [entry.conversationId],
        });
        broadcast({ type: "messages", conversationIds: [entry.conversationId] });
      } catch (error) {
        if (isUnauthorized(error)) throw error;

        // The two v2 refusals that mean "repair and retry", not "give up":
        // a commit advanced the group after this entry was sealed, or the
        // member set changed under the archive list. Both are fixed by
        // catching up and re-sealing from the retained plaintext -- the one
        // sanctioned exception to encrypt-once, safe because the refused
        // send created no message row.
        if (
          e2e.handshake &&
          error instanceof ApiError &&
          (error.code === "EPOCH_STALE" || error.code === "ARCHIVE_INCOMPLETE")
        ) {
          try {
            await mlsSync.reconcileConversation(entry.conversationId, {
              userId: session.user.id,
              deviceId: session.device.id,
            });
            const resealed = await sealForOutbox(
              entry.conversationId,
              entry.content,
            );
            if (resealed) {
              await store.enqueueOutbox({ ...entry, ...resealed });
            }
          } catch (repairError) {
            console.warn("re-seal after stale send failed", repairError);
          }
          // Retried next tick either way; entries behind it hold their order.
          blocked.add(entry.conversationId);
          continue;
        }

        if (isPermanentSendFailure(error)) {
          // Park it and keep going. One undeliverable message must not stop
          // the queue behind it.
          await store.recordOutboxFailure(
            entry.clientMessageId,
            error instanceof Error ? error.message : "Send failed",
            true,
          );
          this.#emit({
            type: "messages",
            conversationIds: [entry.conversationId],
          });
          continue;
        }

        await store.recordOutboxFailure(
          entry.clientMessageId,
          error instanceof Error ? error.message : "Send failed",
        );
        // Transient. Let the loop back off rather than hammering.
        throw error;
      }
    }
  }

  async #refreshConversations(signal: AbortSignal): Promise<void> {
    const now = Date.now();
    if (now - this.#lastConversationRefresh < CONVERSATION_REFRESH_MS) return;
    if (signal.aborted) return;

    const conversations = await listConversations();
    this.#lastConversationRefresh = now;

    await store.putConversations(conversations);
    this.#emit({ type: "conversations" });
    broadcast({ type: "conversations" });
  }

  /**
   * Downloads the attachments of messages that have just arrived.
   *
   * The point is retention. The server deletes attachment bytes after a
   * window; a device that only fetches when somebody scrolls to a photo will
   * find it gone if nobody scrolled for a month. Fetching on receipt is what
   * makes "you keep what was sent to you" true rather than aspirational, and
   * it is the same reason a mail client downloads a message rather than a
   * pointer to one.
   *
   * Never throws, and is not part of the delivery contract. Envelopes are
   * already acked by this point, so a photo that fails here is retried the
   * next time it is looked at -- which is exactly the on-demand path that
   * existed before this method, still there as the fallback.
   *
   * Deliberately only for messages arriving through the inbox, not for the
   * archive walk a new device does on first run. Those messages are already
   * old by definition and a good share of their attachments have expired
   * anyway, so prefetching them means a large burst of downloads to win back
   * whatever fraction is still inside the retention window. New messages are
   * where the whole window is still ahead, which is where prefetching earns
   * its bandwidth.
   */
  async #fetchAttachments(
    messages: readonly StoredMessage[],
    signal: AbortSignal,
  ): Promise<void> {
    // Somebody on a metered connection did not agree to download every photo
    // in a group chat the moment it arrives. The on-demand path still works
    // for them; they just pay for what they choose to look at.
    const connection = (
      navigator as { connection?: { saveData?: boolean } }
    ).connection;
    if (connection?.saveData) return;

    // "Decrypt succeeded" is now a recorded fact rather than a version
    // check -- exactly the change the old comment here said a real second
    // provider would force.
    const refs = messages
      .filter((message) => !message.decryptFailed)
      .flatMap((message) => decodeContent(message.payload).attachments);

    // One at a time. A burst of parallel photo downloads competes with the
    // poll loop for the same connection, and nothing here is urgent -- the
    // messages are already delivered and rendered.
    for (const ref of refs) {
      if (signal.aborted) return;
      if (await store.getBlob(ref.id)) continue;

      try {
        const fetched = await downloadAttachment(ref.id, { signal });
        await store.putBlob(
          ref.id,
          fetched.state === "ok"
            ? {
                state: "ok",
                mediaType: ref.mediaType,
                // Decrypted (or passed through, for a plaintext-era ref)
                // before caching: the blobs store holds content, never
                // ciphertext. A decrypt failure throws into the catch.
                bytes: await openAttachmentBytes(ref, fetched.bytes),
              }
            : { state: fetched.state },
        );
      } catch (error) {
        // One undecryptable blob must not stall the refs behind it; a
        // network failure ends the pass, since everything after would fail
        // the same way. Both are left unrecorded so they are tried again --
        // neither is a verdict about the attachment.
        if (error instanceof BlobCryptoError) continue;
        return;
      }
    }
  }

  /**
   * Remembers which stored messages still hold undecrypted wire bytes, so
   * the forward archive sync knows there is healing to do without scanning
   * the whole store. A best-effort record: a lost entry costs a delayed
   * heal, a stale one costs a harmless re-read.
   */
  async #recordPendingDecrypts(
    messages: readonly StoredMessage[],
  ): Promise<void> {
    const failed = messages.filter((message) => message.decryptFailed);
    if (failed.length === 0) return;

    const pending =
      (await store.getMeta<Record<string, string>>(META_PENDING_DECRYPT)) ?? {};
    for (const message of failed) {
      pending[message.messageId] = message.conversationId;
    }
    await store.setMeta(META_PENDING_DECRYPT, pending);
  }

  /**
   * The healing read: archive rows for messages whose envelopes could not
   * be decrypted.
   *
   * The canonical case is a new device added to a group mid-history. Its
   * envelopes from before the Add are sealed to epochs it never held and
   * never will -- MLS forward secrecy working as designed -- but the same
   * messages exist in the archive, sealed to the account key it unlocked at
   * login. Reading forward from just before the first failure and
   * re-storing heals them; `putMessages` lets a successful decrypt replace
   * a failed record and never the reverse.
   */
  async #forwardArchiveSync(signal: AbortSignal): Promise<void> {
    const pending = await store.getMeta<Record<string, string>>(
      META_PENDING_DECRYPT,
    );
    if (!pending || Object.keys(pending).length === 0) return;

    const now = Date.now();
    if (now - this.#lastForwardSync < FORWARD_SYNC_INTERVAL_MS) return;
    this.#lastForwardSync = now;

    // uuidv7 ids sort by time, so the smallest failed id is the earliest
    // gap. `after` is exclusive, and the failed message itself must be in
    // range -- so the cursor is its predecessor within its conversation
    // (safe: at most a little earlier than the true global predecessor), or
    // the all-zeros uuid when it has none.
    const ids = Object.keys(pending).sort();
    const firstId = ids[0]!;
    const conversationId = pending[firstId]!;
    const before = await store.getConversationPage(conversationId, {
      before: firstId,
      limit: 1,
    });
    let after = before[0]?.messageId ?? "00000000-0000-0000-0000-000000000000";

    const healedConversations = new Set<string>();

    // Bounded per tick; anything left continues next time.
    for (let page = 0; page < 5; page++) {
      if (signal.aborted) return;

      const result = await fetchArchive(
        { after, limit: ARCHIVE_PAGE },
        { signal },
      );
      if (result.entries.length === 0) break;

      const messages = await Promise.all(
        result.entries.map((entry) => toStored(entry, "archive")),
      );
      await store.putMessages(messages);

      for (const message of messages) {
        if (!message.decryptFailed && pending[message.messageId]) {
          delete pending[message.messageId];
          healedConversations.add(message.conversationId);
        }
      }

      if (result.entries.length < ARCHIVE_PAGE) break;
      after = result.entries[result.entries.length - 1]!.messageId;
    }

    await store.setMeta(META_PENDING_DECRYPT, pending);

    if (healedConversations.size > 0) {
      const conversationIds = [...healedConversations];
      this.#emit({ type: "messages", conversationIds });
      broadcast({ type: "messages", conversationIds });
    }
  }

  /**
   * Fetches conversation metadata when a message arrives for a conversation
   * this device does not know about.
   *
   * `#refreshConversations` is throttled to CONVERSATION_REFRESH_MS because
   * metadata almost never changes. That is right for a rename and wrong for a
   * first message: until the row exists locally the thread is not in the list
   * at all, so a conversation someone else starts stays invisible for up to
   * the whole refresh interval while its messages sit in storage. Reloading
   * the page appeared to fix it, which is the tell -- startup refreshes
   * unconditionally.
   *
   * Only the unknown case bypasses the throttle. A message in a conversation
   * already on file changes no metadata and is left to the timer.
   */
  async #refreshUnknownConversations(
    conversationIds: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    if (conversationIds.length === 0) return;

    const known = new Set(
      (await store.listConversations()).map((conversation) => conversation.id),
    );
    if (conversationIds.every((id) => known.has(id))) return;

    this.#lastConversationRefresh = 0;
    await this.#refreshConversations(signal);
  }

  /** Forces the next tick to re-read conversations. */
  invalidateConversations(): void {
    this.#lastConversationRefresh = 0;
    this.poke();
  }

  // -- plumbing ------------------------------------------------------------

  #setStatus(patch: Partial<SyncStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#emit({ type: "status", status: this.#status });
  }

  #emit(event: SyncEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("sync listener failed", error);
      }
    }
  }
}

/** One engine per tab, the same way there is one store. */
export const sync = new SyncEngine();
