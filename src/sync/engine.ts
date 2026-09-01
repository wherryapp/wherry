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
  fetchEvents,
  fetchHealth,
  fetchHistoryKeys,
  fetchAnnouncements,
  fetchHubEvents,
  fetchHubs,
  fetchInbox,
  isUnauthorized,
  isUnreachable,
  listConversations,
  sendMessage,
  downloadAttachment,
  type Announcement,
} from "../api/client";
import { socketUrl } from "../api/base";
import { decodeBase64, encodeBase64 } from "../api/base64";
import { currentToken, loadSession } from "../api/session";
import { decodeContent, isMessageOp } from "../api/payload";
import type { ArchiveEntry, HubSummary, InboxEnvelope } from "../api/types";
import { e2e, E2EError } from "../crypto";
import { PROTOCOL_PUBLIC } from "../crypto/provider";
import { KeysError } from "../crypto/keys";
import { ingestWrappedKeys } from "../crypto/history";
import { BlobCryptoError, openAttachmentBytes } from "../crypto/blob";
import { store } from "../store";
import {
  META_ANNOUNCEMENTS,
  META_DELIVERED_PREFIX,
  META_HUBS,
  META_HUB_EVENTS,
  META_HYDRATION,
  META_MENTIONS,
  META_PUBLIC_CHANNELS,
  type HubEventState,
  type HydrationState,
  type MentionState,
  type OutboxEntry,
  type PublicChannelState,
  type StoredMessage,
} from "../store/types";
import { Backoff, sleep } from "./backoff";
import {
  broadcast,
  runAsLeader,
  subscribeToBroadcasts,
  type LeaderHandle,
} from "./leader";
import { mlsEnabled, mlsSync, type Identity } from "./mls";
import { SocketManager } from "./socket";

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

// The cadence while the realtime socket is healthy, visible or not: pure
// fallback, because a wake arrives over the socket the moment anything is
// queued. Stretching the poll is the entire payoff of Phase 4 -- an idle
// client goes from 30 requests/min to 2 -- and it is safe only because the
// unhealthy transition pokes the loop, which re-picks the short cadence on
// its next wait.
const SOCKET_INTERVAL_MS = 30_000;

// The server caps both at 500. Large pages matter for the backlog case -- a
// client returning after a week should not drain it 100 at a time.
const INBOX_PAGE = 200;
const ARCHIVE_PAGE = 200;

// Conversation metadata changes rarely; there is no reason to re-read it on
// every 2-second tick.
const CONVERSATION_REFRESH_MS = 30_000;

// Outgoing typing frames, per conversation. Above the server's 1s floor and
// below the receiver's expiry window (TYPING_TTL_MS in ui/hooks.ts), so a
// continuously typing person renders as continuously typing with the fewest
// frames that can say so.
const TYPING_SEND_MS = 3_000;

// Stamped at build time by client/Dockerfile via the bare VITE_COMMIT_SHA
// env var Vite embeds automatically -- no custom `define` needed, the same
// way VITE_E2E already works (crypto/index.ts). "unknown" in dev and in a
// plain `pnpm build` outside Docker, which is what turns the update check
// below into a no-op there: there is nothing meaningful to compare a dev
// server's build against.
const BUILD_COMMIT: string = import.meta.env["VITE_COMMIT_SHA"] ?? "unknown";

// Same mechanism, for the tag-derived version (docs/roadmap.md's "Version
// numbers: soon, not yet") -- "unknown" until tagging starts, same as
// BUILD_COMMIT is in dev. Exported, unlike BUILD_COMMIT: this module only
// ever *compares* the commit, but Settings' footer displays the version
// directly, so it needs the value itself rather than a derived boolean.
export const APP_VERSION: string =
  import.meta.env["VITE_APP_VERSION"] ?? "unknown";

// The forward archive sync runs while any stored message is still
// undecrypted -- a state that resolves within a sweep or two, or not at all
// (a locked account key). Either way, once per interval is plenty.
const FORWARD_SYNC_INTERVAL_MS = 30_000;

// A public channel's first contact fetches this many newest messages, not
// the backlog -- the hydration-depth decision in docs/prompts/hubs-plan.md.
// Older history is a deliberate on-demand read, never an automatic walk.
const PUBLIC_FIRST_PAGE = 100;

/** messageId -> conversationId of stored messages whose decrypt failed. */
const META_PENDING_DECRYPT = "mls.pendingDecrypt";

/**
 * conversationId -> the generation walk's progress. A conversation lands
 * here when a history-key generation this device has never held is
 * unwrapped -- the one trigger that means archive rows may exist which no
 * other path will ever fetch: historical messages produce no envelope, so
 * neither `#hydrate` (one-shot, already complete) nor the forward sync
 * (driven by envelope decrypt failures) knows they exist. Cursor persisted
 * per page, so the walk is idempotent and resumable -- the reason this is
 * not a `META_HYDRATION` reset.
 */
const META_HISTORY_WALK = "history.walk";

type HistoryWalkState = Record<
  string,
  { cursor: string | null; done: boolean }
>;

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
  /**
   * This build's own commit does not match what the server reports it is
   * running -- see `#checkForUpdate`. Always false in dev and in a plain
   * `pnpm build`, where `BUILD_COMMIT` is "unknown". Never true on its own
   * initiative: only a leader tab's poll loop sets it, the same as every
   * other field here.
   */
  updateAvailable: boolean;
  /**
   * The server's own tag-derived version, from the same `/health` check
   * that sets `updateAvailable` -- only ever populated alongside it, and
   * null whenever `/health` has nothing meaningful to report (no tag yet,
   * or a build `/health` itself does not distinguish from one). Lets
   * UpdateBanner name the version when it can, rather than only ever
   * saying "a new version" -- see `#checkForUpdate`.
   */
  updateVersion: string | null;
};

export type SyncEvent =
  | { type: "status"; status: SyncStatus }
  | { type: "messages"; conversationIds: string[] }
  | { type: "conversations" }
  | { type: "announcements" }
  | { type: "hubs" }
  | { type: "receipts"; conversationId: string }
  /** Ephemeral, straight off the socket -- never stored, expires on the
   *  receiver's clock. Components hold these in their own state; there is
   *  deliberately nothing to re-read from IndexedDB. */
  | { type: "typing"; conversationId: string; byUserId: string }
  | { type: "presence"; conversationId: string; online: string[] };

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
  keyGeneration: number | null,
): Promise<{ payload: Uint8Array; decryptFailed: boolean }> {
  // Protocol v4 -- public hub channel content -- is not encrypted, by
  // design, so the provider is never asked: the wire bytes ARE the content.
  // Short-circuited here rather than taught to the provider, deliberately:
  // "not encrypted" is not a cipher, and the E2E seam stays crypto-only
  // (rule 7). See PROTOCOL_PUBLIC's comment in crypto/provider.ts.
  if (protocolVersion === PROTOCOL_PUBLIC) {
    return { payload: wireBytes, decryptFailed: false };
  }

  try {
    const payload = await e2e.decrypt({
      conversationId,
      protocolVersion,
      payload: wireBytes,
      source: from,
      keyGeneration,
    });
    return { payload, decryptFailed: false };
  } catch (error) {
    // KeysError alongside E2EError: openArchive and openWithHistoryKey
    // throw it, and one unopenable row must mark one message failed -- not
    // escape the page's Promise.all and abort the whole fetch, which is
    // what it did when only E2EError was caught here.
    if (error instanceof E2EError || error instanceof KeysError) {
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
    "keyGeneration" in source ? source.keyGeneration : null,
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
 * Everything a send needs, sealed -- or null when it cannot be sealed yet.
 * Shared by enqueue (compose time) and the outbox flush (the retry after
 * `pendingEncryption`, and the re-encrypt after EPOCH_STALE or
 * HISTORY_KEY_STALE).
 *
 * Archive first, wire second, deliberately: encrypting advances the MLS
 * ratchet, and a wire payload we then had to throw away because no history
 * key is cached yet would consume a key for nothing. The archive seal is
 * stateless, so this order wastes nothing either way.
 *
 * Under passthrough there is nothing that can fail and nothing to seal --
 * which is also why a passthrough build cannot talk to the v2 server: it
 * produces no epoch and no archive payload. Dev instrument only.
 */
async function sealForOutbox(
  conversationId: string,
  plaintext: Uint8Array,
): Promise<Pick<
  OutboxEntry,
  "protocolVersion" | "payload" | "epoch" | "archiveGeneration" | "archivePayload"
> | null> {
  if (!e2e.handshake) {
    const wire = await e2e.encrypt(conversationId, plaintext);
    return { protocolVersion: wire.protocolVersion, payload: wire.payload };
  }

  try {
    const archive = await e2e.encryptForArchive(conversationId, plaintext);
    const wire = await e2e.encrypt(conversationId, plaintext);

    return {
      protocolVersion: wire.protocolVersion,
      payload: wire.payload,
      ...(wire.epoch !== undefined ? { epoch: wire.epoch } : {}),
      archiveGeneration: archive.generation,
      archivePayload: archive.payload,
    };
  } catch (error) {
    // Two "not yet" states, not failures: no group state (not joined, or
    // the group is being created) and no history key cached (the sweep has
    // not bootstrapped or fetched one). Both resolve on a later tick, so
    // the entry parks as pendingEncryption.
    if (
      error instanceof E2EError &&
      (error.code === "NOT_IN_GROUP" || error.code === "HISTORY_KEY_UNAVAILABLE")
    ) {
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
  #status: SyncStatus = {
    state: "stopped",
    lastSyncAt: null,
    error: null,
    updateAvailable: false,
    updateVersion: null,
  };
  #backoff = new Backoff();
  #wake: (() => void) | null = null;
  #socket: SocketManager | null = null;
  // The latch behind poke(). #wake only exists while the loop is parked in
  // #waitForNextTick; a poke landing mid-pass -- an envelope committed just
  // after #drainInbox went by -- used to be dropped, which was invisible at
  // a 2-second cadence and would be a 30-second stall at the socket cadence.
  // Latched here, it makes the next wait return immediately instead.
  #pokePending = false;
  #lastConversationRefresh = 0;
  #lastForwardSync = 0;
  #lastHistoryKeyRefresh = 0;
  #onUnauthorized: (() => void) | null = null;
  /** Per-conversation floor on outgoing typing frames; see sendTyping. */
  #lastTypingSent = new Map<string, number>();
  #unsubscribeBroadcasts: (() => void) | null = null;

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

    // The path a follower tab's ephemeral frames take to the one socket:
    // its engine broadcasts an intent, and whichever tab is leading (and so
    // holds the socket -- the check below is what makes this leader-only)
    // forwards it. The sender's own broadcast never loops back to itself;
    // a leader sends directly and never broadcasts an intent at all.
    this.#unsubscribeBroadcasts = subscribeToBroadcasts((message) => {
      if (message.type === "typing-intent") {
        this.#socket?.send(
          JSON.stringify({
            type: "typing",
            conversationId: message.conversationId,
          }),
        );
      } else if (message.type === "presence-intent") {
        this.#socket?.send(
          JSON.stringify({
            type: "presence",
            conversationId: message.conversationId,
          }),
        );
      } else if (message.type === "presence-bulk-intent") {
        this.#socket?.send(
          JSON.stringify({
            type: "presence_bulk",
            conversationIds: message.conversationIds,
          }),
        );
      }
    });
  }

  stop(): void {
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#unsubscribeBroadcasts?.();
    this.#unsubscribeBroadcasts = null;
    this.#leader?.stop();
    this.#leader = null;
    this.#wake = null;
    this.#setStatus({ state: "stopped", error: null });
  }

  /**
   * "I am typing here." Floored to one frame per few seconds per
   * conversation -- the receiver's indicator outlives the gap, so anything
   * faster says nothing new -- and routed to the socket wherever it lives:
   * sent directly when this tab leads, broadcast as an intent for the
   * leader otherwise. Fire-and-forget end to end; a lost frame is silence,
   * which is what not typing looks like anyway.
   */
  sendTyping(conversationId: string): void {
    const now = Date.now();
    if (now - (this.#lastTypingSent.get(conversationId) ?? 0) < TYPING_SEND_MS) {
      return;
    }
    this.#lastTypingSent.set(conversationId, now);

    const sent = this.#socket?.send(
      JSON.stringify({ type: "typing", conversationId }),
    );
    if (!sent) broadcast({ type: "typing-intent", conversationId });
  }

  /**
   * Asks who in this conversation is connected. The answer arrives as a
   * presence event (or never, if no socket is healthy anywhere -- callers
   * must treat no-answer as no-information, not as everyone-offline).
   */
  requestPresence(conversationId: string): void {
    const sent = this.#socket?.send(
      JSON.stringify({ type: "presence", conversationId }),
    );
    if (!sent) broadcast({ type: "presence-intent", conversationId });
  }

  /**
   * The same question about many conversations in one frame -- the
   * sidebar's ask. Answers arrive as ordinary per-conversation presence
   * events, so nothing downstream knows bulk exists. Same no-answer
   * contract as requestPresence: a missing answer is no information,
   * never everyone-offline.
   *
   * Capped at the protocol's 50, not chunked: the server floors relays to
   * one per second per connection, so a second chunk fired in the same
   * tick would be silently eaten -- sending it would be pretending.
   * Callers pass their 50 most useful ids; the rest go dotless, which is
   * what best-effort means.
   */
  requestPresenceBulk(conversationIds: readonly string[]): void {
    if (conversationIds.length === 0) return;
    const chunk = [...conversationIds.slice(0, 50)];
    const sent = this.#socket?.send(
      JSON.stringify({ type: "presence_bulk", conversationIds: chunk }),
    );
    if (!sent) {
      broadcast({ type: "presence-bulk-intent", conversationIds: chunk });
    }
  }

  /**
   * Runs a sync now instead of waiting for the next tick.
   *
   * Never lost: if the loop is mid-pass rather than waiting, the poke is
   * latched and consumed at the top of the next wait. A poke can therefore
   * only ever schedule a full pass in its fixed order -- it cannot jump into
   * a running one, which is what keeps the outbox-before-inbox ordering safe
   * from however many wakes the socket delivers.
   */
  poke(): void {
    if (this.#wake) {
      this.#wake();
    } else {
      this.#pokePending = true;
    }
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
  async enqueue(
    conversationId: string,
    plaintext: Uint8Array,
    options: {
      /** For operation payloads: ask the server not to push. See
       *  OutboxEntry.silent -- the wake is unaffected either way. */
      silent?: boolean;
    } = {},
  ): Promise<void> {
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
      ...(options.silent ? { silent: true as const } : {}),
    };

    // A public hub channel never seals: the payload IS the content, sent
    // with no crypto fields (the flush already omits absent ones), stored
    // by the server readable as protocol v4. The class comes from the
    // stored conversation -- the server's answer, never inferred.
    const conversation = await store.getConversation(conversationId);
    if (conversation?.hubVisibility === "public") {
      await store.enqueueOutbox({
        ...base,
        protocolVersion: PROTOCOL_PUBLIC,
        payload: plaintext,
      });
      this.#emit({ type: "messages", conversationIds: [conversationId] });
      this.poke();
      return;
    }

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

    // Nothing to seal with means the group does not exist yet -- a
    // conversation created moments ago, typed into straight away. The poke
    // below wakes the loop, but the membership sweep that would *make* the
    // group runs on its own 30-second interval and a woken pass skips it if
    // one ran recently. Without this, the first message in a brand-new hub
    // sits on "sending" for up to half a minute while the only thing it
    // needs waits on a timer -- measured at 20-30s, and the first thing
    // anybody does with a new hub. Invalidating makes the woken pass sweep.
    if (entry.pendingEncryption) mlsSync.invalidate();

    this.poke();
  }

  /**
   * Tells this tab's subscribers (and every other tab) that stored messages
   * changed outside the engine's own passes -- a moderation tombstone
   * applied from the UI, a search hit written into the store before a jump.
   * The engine's own writes never need this; UI-side store writes do,
   * because components subscribe to their tab's engine instance and a
   * BroadcastChannel does not deliver to its own sender.
   */
  notifyMessagesChanged(conversationIds: string[]): void {
    this.#emit({ type: "messages", conversationIds });
    broadcast({ type: "messages", conversationIds });
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
    // The socket's lifetime is leadership's lifetime. Only the tab running
    // this loop holds one, so a browser profile has exactly one socket
    // however many tabs are open, and every way the loop ends -- abort on a
    // leadership change, a fatal 401, a thrown bug -- runs the finally and
    // closes it. The next leader's loop opens its own.
    this.#socket = new SocketManager({
      // Resolved here rather than by socket.ts's own default: the desktop
      // build's socket lives on the API origin, not the page's -- base.ts
      // owns that distinction.
      url: socketUrl(),
      getToken: currentToken,
      notify: () => this.poke(),
      onFrame: (frame) => void this.#onSignalFrame(frame),
    });
    this.#socket.start();
    try {
      await this.#runLoopBody(signal);
    } finally {
      this.#socket.stop();
      this.#socket = null;
    }
  }

  async #runLoopBody(signal: AbortSignal): Promise<void> {
    try {
      // Keys before the walk: a new device's hydration reads v3 archive
      // rows, and decrypting them on the first pass beats storing them
      // failed and healing later.
      await this.#refreshHistoryKeys(signal, true);
    } catch (error) {
      if (signal.aborted) return;
      if (this.#handleFatal(error)) return;
      console.warn("history key refresh did not finish", error);
    }

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

        // Keys before the flush and the drain: a send needs the current
        // generation to seal, and a freshly delivered v3 row needs its
        // generation to open.
        await this.#refreshHistoryKeys(signal);

        await this.#flushOutbox(signal);
        await this.#drainInbox(signal);
        await this.#publicChannelSync(signal);
        await this.#forwardArchiveSync(signal);
        await this.#historyWalk(signal);

        this.#backoff.reset();
        this.#setStatus({
          state: "idle",
          error: null,
          lastSyncAt: new Date().toISOString(),
        });
      } catch (error) {
        if (signal.aborted) return;
        if (this.#handleFatal(error)) return;

        // Logged as well as bannered. The Safari freeze diagnosis cost a
        // debugger breakpoint purely because this catch used to swallow the
        // error object -- the banner shows error.message and nothing ever
        // printed the stack. Never remove this line to reduce noise; a
        // failing sync pass IS the noise.
        console.error("sync pass failed", error);

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
    // A healthy socket makes the poll a pure fallback; without one the old
    // cadences apply unchanged. Re-evaluated every wait, so a socket dying
    // mid-wait needs only the poke its unhealthy transition fires: the wait
    // resolves, the pass runs, and this line picks 2 seconds again.
    const interval = this.#socket?.isHealthy()
      ? SOCKET_INTERVAL_MS
      : document.visibilityState === "visible"
        ? VISIBLE_INTERVAL_MS
        : HIDDEN_INTERVAL_MS;

    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      // A poke that arrived while the pass was running. Consuming it here,
      // before arming the timer, is what makes poke() lossless.
      if (this.#pokePending) {
        this.#pokePending = false;
        resolve();
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
      await this.#recordMentions(messages);

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

      // `entry.archive` is the pre-v3 shape: an entry sealed before this
      // deploy, carrying the per-recipient array the server no longer
      // accepts. Re-sealed from the retained plaintext rather than sent
      // as-is, where it would 400 and be parked as permanently failed.
      if (entry.pendingEncryption || entry.archive) {
        const sealed = await sealForOutbox(entry.conversationId, entry.content);
        if (!sealed) {
          blocked.add(entry.conversationId);
          continue;
        }
        const { pendingEncryption: _dropped, archive: _legacy, ...rest } = entry;
        entry = { ...rest, ...sealed };
        await store.enqueueOutbox(entry);
      }

      try {
        const result = await sendMessage({
          conversationId: entry.conversationId,
          clientMessageId: entry.clientMessageId,
          payload: encodeBase64(entry.payload),
          ...(entry.silent ? { silent: true } : {}),
          ...(entry.epoch !== undefined &&
          entry.archiveGeneration !== undefined &&
          entry.archivePayload
            ? {
                epoch: entry.epoch,
                archiveGeneration: entry.archiveGeneration,
                archivePayload: encodeBase64(entry.archivePayload),
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

        // The refusals that mean "repair and retry", not "give up": a
        // commit advanced the group after this entry was sealed
        // (EPOCH_STALE), or a rotation advanced the history key
        // (HISTORY_KEY_STALE; ARCHIVE_INCOMPLETE was its v2 sibling, kept
        // here so a mid-deploy server refusing the old way repairs the same
        // way). All are fixed by catching up and re-sealing from the
        // retained plaintext -- the one sanctioned exception to
        // encrypt-once, safe because the refused send created no message
        // row.
        if (
          e2e.handshake &&
          error instanceof ApiError &&
          (error.code === "EPOCH_STALE" ||
            error.code === "HISTORY_KEY_STALE" ||
            error.code === "ARCHIVE_INCOMPLETE")
        ) {
          try {
            // Keys first: the fresh generation may already exist server-side
            // (somebody else rotated), in which case fetching beats minting.
            await this.#refreshHistoryKeys(signal, true);
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

        // Slowmode: the message is fine, the moment is wrong. Parked as a
        // blocked conversation -- entries behind it hold their order, other
        // conversations flow on, and the next tick retries when the window
        // may have passed. Deliberately NOT thrown: a throw would put the
        // whole loop into backoff-with-error over one throttled channel.
        if (error instanceof ApiError && error.code === "SLOWMODE") {
          await store.recordOutboxFailure(entry.clientMessageId, error.message);
          this.#emit({
            type: "messages",
            conversationIds: [entry.conversationId],
          });
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
    await this.#refreshEvents(conversations, signal);
    this.#emit({ type: "conversations" });
    broadcast({ type: "conversations" });

    void this.#checkForUpdate();
    void this.#refreshAnnouncements();
    void this.#refreshHubs();
  }

  /**
   * The caller's hubs, riding the conversation-refresh tick like the
   * announcements read -- hubs change as often as membership does, which is
   * rarely. Replaced whole; while the `hubs` flag is off the server answers
   * an empty list and this stores exactly that, so the UI needs no flag
   * logic of its own to render nothing.
   */
  async #refreshHubs(): Promise<void> {
    let fetched: HubSummary[];
    try {
      fetched = await fetchHubs();
    } catch {
      return;
    }

    const previous = (await store.getMeta<HubSummary[]>(META_HUBS)) ?? [];
    // Cheap structural compare: the list is small and ordered, and a rename,
    // role change, member count change or channel change must all count as
    // changed -- id comparison alone would miss them.
    if (JSON.stringify(previous) !== JSON.stringify(fetched)) {
      await store.setMeta(META_HUBS, fetched);
      this.#emit({ type: "hubs" });
      broadcast({ type: "hubs" });
    }

    // Always, even when the summaries are unchanged: the actionable hub
    // events (a moderator deleting a message) change nothing in a summary.
    await this.#syncHubEvents(fetched);
  }

  /**
   * Reads each hub's new events past a per-hub watermark and acts on the
   * actionable kinds. Today that is one kind: message_deleted removes the
   * local copy -- the propagation half of moderator deletion, closing the
   * "already-synced clients keep it" gap the feature shipped with. The hub
   * panel's own event listing stays an on-demand fetch; this sweep exists
   * for side effects, not display.
   *
   * First contact records the newest event id without acting: history from
   * before this device ever synced the hub has nothing local to act on.
   */
  async #syncHubEvents(hubs: readonly HubSummary[]): Promise<void> {
    if (hubs.length === 0) return;

    const state = (await store.getMeta<HubEventState>(META_HUB_EVENTS)) ?? {};
    let stateDirty = false;

    for (const hub of hubs) {
      try {
        const watermark = state[hub.id]?.latest;
        const page = await fetchHubEvents({ hubId: hub.id });
        const newest = page.events[0]?.id ?? null;

        if (watermark === undefined) {
          state[hub.id] = { latest: newest };
          stateDirty = true;
          continue;
        }

        // Newest-first page; everything above the watermark is new. One
        // page suffices in practice -- events are rare and the sweep runs
        // every 30 s; anything older than a full page of newer events is
        // history this device slept through, and acting late on a delete
        // is still acting.
        const fresh = page.events.filter(
          (event) => watermark === null || event.id > watermark,
        );

        const deleted = fresh
          .filter(
            (event) =>
              event.kind === "message_deleted" && event.messageId !== null,
          )
          .map((event) => event.messageId!);

        if (deleted.length > 0) {
          await store.deleteMessages(deleted);
          // No per-conversation bookkeeping: the event does not name the
          // channel, and a broad "something changed" re-render is the
          // cheap, correct answer for an action this rare.
          this.#emit({ type: "conversations" });
          broadcast({ type: "conversations" });
        }

        if (newest !== watermark) {
          state[hub.id] = { latest: newest };
          stateDirty = true;
        }
      } catch (error) {
        console.warn("hub event sync failed", hub.id, error);
      }
    }

    if (stateDirty) await store.setMeta(META_HUB_EVENTS, state);
  }

  /**
   * Records the newest message that mentions this account, per conversation
   * -- what the sidebar's stronger unread treatment reads. Written before
   * the messages event fires, so subscribers re-reading on that event see
   * it. Own messages and unreadable ones never count.
   */
  async #recordMentions(messages: readonly StoredMessage[]): Promise<void> {
    const session = loadSession();
    if (!session) return;

    let latestByConversation: Map<string, string> | null = null;
    for (const message of messages) {
      if (message.decryptFailed) continue;
      if (message.senderUserId === session.user.id) continue;
      const content = decodeContent(message.payload);
      if (content === "unsupported" || isMessageOp(content)) continue;
      if (!content.mentions?.includes(session.user.id)) continue;

      latestByConversation ??= new Map();
      const current = latestByConversation.get(message.conversationId);
      if (current === undefined || message.messageId > current) {
        latestByConversation.set(message.conversationId, message.messageId);
      }
    }
    if (latestByConversation === null) return;

    const state = (await store.getMeta<MentionState>(META_MENTIONS)) ?? {};
    let dirty = false;
    for (const [conversationId, messageId] of latestByConversation) {
      const current = state[conversationId];
      if (current === undefined || messageId > current) {
        state[conversationId] = messageId;
        dirty = true;
      }
    }
    if (dirty) await store.setMeta(META_MENTIONS, state);
  }

  /**
   * Delivery for public hub channels, which have no envelopes and no inbox
   * -- protocol v4 rows are fetched by cursor from `/archive`, per channel.
   *
   * First contact fetches one newest-first page and sets the watermark; from
   * then on each pass catches up forward (`after`) until a short page. The
   * backlog behind the first page is deliberately never walked -- the
   * hydration-depth decision in docs/prompts/hubs-plan.md -- so joining a
   * hub with years of history costs one page, not a bulk download.
   *
   * One channel's trouble is logged and skipped, the #refreshEvents
   * tolerance: the poll loop must not back off because one hub hiccuped.
   */
  async #publicChannelSync(signal: AbortSignal): Promise<void> {
    const conversations = await store.listConversations();
    const channels = conversations.filter(
      (conversation) => conversation.hubVisibility === "public",
    );
    if (channels.length === 0) return;

    const state =
      (await store.getMeta<PublicChannelState>(META_PUBLIC_CHANNELS)) ?? {};

    for (const channel of channels) {
      if (signal.aborted) return;

      try {
        let latest = state[channel.id]?.latest ?? null;

        if (latest === null) {
          const page = await fetchArchive(
            { conversationId: channel.id, limit: PUBLIC_FIRST_PAGE },
            { signal },
          );
          const messages = await Promise.all(
            page.entries.map((entry) => toStored(entry, "archive")),
          );
          await store.putMessages(messages);
          await this.#recordMentions(messages);
          // Newest-first, so the first entry is the watermark. Persisted
          // after the messages are durable, like every cursor here.
          state[channel.id] = {
            latest: page.entries[0]?.messageId ?? null,
          };
          await store.setMeta(META_PUBLIC_CHANNELS, state);

          if (messages.length > 0) {
            this.#emit({ type: "messages", conversationIds: [channel.id] });
            broadcast({ type: "messages", conversationIds: [channel.id] });
          }
          continue;
        }

        for (;;) {
          if (signal.aborted) return;

          const page = await fetchArchive(
            { conversationId: channel.id, after: latest, limit: ARCHIVE_PAGE },
            { signal },
          );
          if (page.entries.length === 0) break;

          const messages = await Promise.all(
            page.entries.map((entry) => toStored(entry, "archive")),
          );
          await store.putMessages(messages);
          await this.#recordMentions(messages);
          // Ascending mode: the last entry is the newest.
          latest = page.entries[page.entries.length - 1]!.messageId;
          state[channel.id] = { latest };
          await store.setMeta(META_PUBLIC_CHANNELS, state);

          this.#emit({ type: "messages", conversationIds: [channel.id] });
          broadcast({ type: "messages", conversationIds: [channel.id] });

          if (page.entries.length < ARCHIVE_PAGE) break;
        }
      } catch (error) {
        if (isUnauthorized(error)) throw error;
        console.warn("public channel sync failed", channel.id, error);
      }
    }
  }

  /**
   * Operator announcements, riding the conversation-refresh tick the same
   * way the update check does -- one more cheap call on an existing cadence
   * rather than a second poll loop.
   *
   * One page, newest first, replaced whole. The list is operator release
   * notes -- small by nature -- so pagination is for a client that wants to
   * walk further back, not for this refresh. While the `announcements` flag
   * is off the server answers an empty page and this stores nothing new.
   *
   * Best-effort like the update check: a failure here must not affect the
   * pass it rides on, and the next tick simply tries again.
   */
  async #refreshAnnouncements(): Promise<void> {
    let fetched: Announcement[];
    try {
      const page = await fetchAnnouncements();
      fetched = page.announcements;
    } catch {
      return;
    }

    // Only write and notify on change, or every 30 s tick would re-render
    // every subscriber for nothing. Ids are uuidv7 and rows are immutable
    // once published (retraction is a soft delete, which removes the id from
    // the page), so "same ids in the same order" is "nothing changed".
    const previous =
      (await store.getMeta<Announcement[]>(META_ANNOUNCEMENTS)) ?? [];
    const unchanged =
      previous.length === fetched.length &&
      previous.every((entry, i) => entry.id === fetched[i]?.id);
    if (unchanged) return;

    await store.setMeta(META_ANNOUNCEMENTS, fetched);
    this.#emit({ type: "announcements" });
    broadcast({ type: "announcements" });
  }

  /**
   * A signal frame from the socket -- anything beyond ready/wake/ping.
   *
   * "delivered" feeds the per-conversation watermark the ticks render from:
   * a map of recipient user id to the newest of this account's message ids
   * that user has acked. Monotone by construction (ids are uuidv7, the max
   * only moves forward), which is the whole reliability story -- a frame
   * lost to a closed socket is repaired by the next ack in the conversation,
   * and a read receipt subsumes delivered anyway. Nothing here fetches; the
   * frame carries everything the watermark needs.
   *
   * Unknown types are ignored, same forward-compatibility stance as the
   * socket itself: a newer server may speak frames this build has no use
   * for yet.
   */
  async #onSignalFrame(
    frame: { type: string } & Record<string, unknown>,
  ): Promise<void> {
    // The two ephemeral kinds: validated, re-emitted, forgotten. No store
    // write on purpose -- these expire on the receiver's clock, and the
    // components that render them hold their own state.
    if (frame.type === "typing") {
      const conversationId = frame["conversationId"];
      const byUserId = frame["byUserId"];
      if (typeof conversationId !== "string" || typeof byUserId !== "string") {
        return;
      }
      this.#emit({ type: "typing", conversationId, byUserId });
      broadcast({ type: "typing", conversationId, byUserId });
      return;
    }

    if (frame.type === "presence") {
      const conversationId = frame["conversationId"];
      const online = frame["online"];
      if (
        typeof conversationId !== "string" ||
        !Array.isArray(online) ||
        !online.every((entry) => typeof entry === "string")
      ) {
        return;
      }
      this.#emit({ type: "presence", conversationId, online });
      broadcast({ type: "presence", conversationId, online });
      return;
    }

    if (frame.type !== "delivered") return;
    const conversationId = frame["conversationId"];
    const byUserId = frame["byUserId"];
    const upTo = frame["upTo"];
    if (
      typeof conversationId !== "string" ||
      typeof byUserId !== "string" ||
      typeof upTo !== "string"
    ) {
      return;
    }

    try {
      const key = META_DELIVERED_PREFIX + conversationId;
      const marks = (await store.getMeta<Record<string, string>>(key)) ?? {};
      const current = marks[byUserId];
      if (current !== undefined && current >= upTo) return;
      marks[byUserId] = upTo;
      await store.setMeta(key, marks);
      this.#emit({ type: "receipts", conversationId });
      broadcast({ type: "receipts", conversationId });
    } catch {
      // Best-effort, like everything on the signal path: a failed write
      // means a tick appears a little later, never that anything is lost.
    }
  }

  /**
   * Compares this build's own commit against what `/health` reports the
   * server is running, on the same cadence as the conversation refresh
   * above rather than its own timer -- one more cheap, unauthenticated call
   * riding along an existing tick rather than a second poll loop.
   *
   * Never auto-reloads and never surfaces as an `error` -- a deploy landing
   * mid-compose must not interrupt anything on its own; see UpdateBanner in
   * ui/Chat.tsx for the reload prompt this only turns on.
   */
  async #checkForUpdate(): Promise<void> {
    if (BUILD_COMMIT === "unknown") return;

    let stale: boolean;
    let version: string | null;
    try {
      const health = await fetchHealth();
      // "unknown" on the server side means it was not built by the same
      // pipeline either (a bare `pnpm build` on the host) -- nothing to
      // compare, so treat that the same as no mismatch rather than a false
      // positive that can never be resolved by reloading.
      stale = health.commit !== "unknown" && health.commit !== BUILD_COMMIT;
      // Only kept when it is actually informative -- there is no tag to
      // lag behind before the mismatch itself exists, so a version is
      // never attached to a banner that would not otherwise appear.
      version =
        stale && health.version && health.version !== "unknown"
          ? health.version
          : null;
    } catch {
      // Best-effort. A failed health check must not affect anything else
      // this loop does, and must not flip the banner off on a blip.
      return;
    }

    if (
      stale !== this.#status.updateAvailable ||
      version !== this.#status.updateVersion
    ) {
      this.#setStatus({ updateAvailable: stale, updateVersion: version });
    }
  }

  /**
   * Notice lines, on the same cadence as the conversation list rather than
   * the poll cadence -- they change exactly as often as membership does.
   *
   * Direct conversations never have any (only a group can be renamed or have
   * members added), so this only ever calls out for groups. Always fetches
   * the newest page rather than tracking a per-conversation cursor: notices
   * are rare, `putEvents` upserts on id, and the newest EVENTS_DEFAULT_LIMIT
   * comfortably covers a group's entire membership history in practice.
   */
  async #refreshEvents(
    conversations: readonly { id: string; kind: string }[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const conversation of conversations) {
      if (signal.aborted) return;
      // Channels rename like groups do (the hub service writes the same
      // notice row), so they get the same sweep.
      if (conversation.kind !== "group" && conversation.kind !== "channel") {
        continue;
      }
      try {
        const page = await fetchEvents({ conversationId: conversation.id });
        await store.putEvents(
          page.events.map((event) => ({
            id: event.id,
            conversationId: event.conversationId,
            kind: event.kind,
            actorUserId: event.actorUserId,
            actorUsername: event.actorUsername,
            actorDisplayName: event.actorDisplayName,
            targetUserId: event.targetUserId,
            targetUsername: event.targetUsername,
            targetDisplayName: event.targetDisplayName,
            title: event.title,
            historyShared: event.historyShared,
            createdAt: event.createdAt,
          })),
        );
      } catch (error) {
        // One conversation's trouble must not stop the sweep, the same
        // tolerance mlsSync.tick has for a single reconcile failing.
        console.warn("event refresh failed", conversation.id, error);
      }
    }
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
      .flatMap((message) => {
        // An unsupported payload kind may well carry attachments, but this
        // build cannot know where they are in it -- and an operation payload
        // carries none by definition. Nothing to prefetch either way.
        const content = decodeContent(message.payload);
        return content === "unsupported" || isMessageOp(content)
          ? []
          : content.attachments;
      });

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
   * Fetches this user's wrapped history keys and unwraps what is new.
   *
   * On the conversation-refresh cadence, not the poll cadence -- keys change
   * exactly as often as membership does. `force` bypasses the throttle for
   * the moments that cannot wait a cycle: startup before hydration, and the
   * HISTORY_KEY_STALE repair path.
   *
   * A newly-seen (conversation, generation) pair marks that conversation for
   * the generation walk below. That trigger is the whole feature for a
   * member added with shared history: their historical messages produced no
   * envelope, so no other path will ever fetch them.
   */
  async #refreshHistoryKeys(signal: AbortSignal, force = false): Promise<void> {
    if (!e2e.handshake) return;

    const now = Date.now();
    if (!force && now - this.#lastHistoryKeyRefresh < CONVERSATION_REFRESH_MS) {
      return;
    }
    if (signal.aborted) return;

    const { keys } = await fetchHistoryKeys({ signal });
    this.#lastHistoryKeyRefresh = now;

    const fresh = await ingestWrappedKeys(
      keys.map((key) => ({
        conversationId: key.conversationId,
        generation: key.generation,
        wrappedKey: decodeBase64(key.wrappedKey),
      })),
    );
    if (fresh.length === 0) return;

    // Any newly-held generation restarts its conversation's walk from the
    // top: rows sealed under it can sit anywhere in that history --
    // generations arrive out of order when a backfill follows a rotation.
    const walk =
      (await store.getMeta<HistoryWalkState>(META_HISTORY_WALK)) ?? {};
    for (const pair of fresh) {
      walk[pair.conversationId] = { cursor: null, done: false };
    }
    await store.setMeta(META_HISTORY_WALK, walk);
  }

  /**
   * The generation walk: pages one conversation's archive after its history
   * keys changed, storing what decrypts.
   *
   * `putMessages` makes this idempotent and healing-only -- a successful
   * decrypt replaces a failed record, never the reverse -- so re-reading
   * rows this device already holds is a cheap upsert, and rows that still
   * miss their key are recorded for the forward sync like any other failed
   * decrypt. Bounded pages per tick, cursor persisted per page, exactly the
   * discipline of `#hydrate` -- which cannot be reused here because its
   * completion flag is one-shot for the device, not per conversation.
   */
  async #historyWalk(signal: AbortSignal): Promise<void> {
    const walk = await store.getMeta<HistoryWalkState>(META_HISTORY_WALK);
    if (!walk) return;

    const pendingIds = Object.keys(walk).filter((id) => !walk[id]!.done);
    if (pendingIds.length === 0) return;

    let budget = 5;
    for (const conversationId of pendingIds) {
      while (budget > 0) {
        if (signal.aborted) return;

        const state = walk[conversationId]!;
        const page = await fetchArchive(
          {
            conversationId,
            ...(state.cursor ? { cursor: state.cursor } : {}),
            limit: ARCHIVE_PAGE,
          },
          { signal },
        );
        budget -= 1;

        const messages = await Promise.all(
          page.entries.map((entry) => toStored(entry, "archive")),
        );
        await store.putMessages(messages);
        await this.#recordPendingDecrypts(messages);

        // Progress is durable before the next page, so an interrupted walk
        // resumes rather than restarting.
        walk[conversationId] = {
          cursor: page.nextCursor,
          done: page.nextCursor === null,
        };
        await store.setMeta(META_HISTORY_WALK, walk);

        if (messages.length > 0) {
          this.#emit({ type: "messages", conversationIds: [conversationId] });
          broadcast({ type: "messages", conversationIds: [conversationId] });
        }

        if (page.nextCursor === null) break;
      }
      if (budget <= 0) return;
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
