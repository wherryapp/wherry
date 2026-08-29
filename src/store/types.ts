// What the client keeps locally, and the interface it keeps it behind.
//
// ---------------------------------------------------------------------------
// Why this is an interface
// ---------------------------------------------------------------------------
//
// The same move the server makes twice -- `E2EProvider` for crypto (rule 7)
// and `Storage` for blobs (rule 8). The implementation today is IndexedDB,
// because that is the only general-purpose persistent store a browser offers.
// In Phase 5 the app is wrapped in Tauri and history moves to native SQLite,
// which is a different engine with a different query model.
//
// If components called IndexedDB directly, that swap would be a rewrite of
// every component. Behind this interface it is one new file and one changed
// line in store/index.ts, exactly as switching the crypto provider is.
//
// The interface is also the constraint, not just the indirection: nothing can
// grow a dependency on an IndexedDB-shaped detail if it can only see these
// methods.
//
// ---------------------------------------------------------------------------
// Why not SQLite-over-WASM now
// ---------------------------------------------------------------------------
//
// Tempting, because it would be the same engine as Phase 5 and real SQL. It
// costs about a megabyte of WASM on first load, has to run in a Worker because
// the OPFS sync-access-handle VFS is unavailable on the main thread, and some
// VFS configurations need cross-origin isolation headers. That is a large
// amount of Phase 2 spent on plumbing for a data model of four stores and no
// joins. Take it in Phase 5, where the WASM tax disappears.

export type StoredMessage = {
  /** The server's message id. UUIDv7, so it sorts by time. */
  messageId: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  /** 1 is plaintext, 2 will be ciphertext. Never assume. */
  protocolVersion: number;
  /**
   * The message content as bytes.
   *
   * Bytes rather than a decoded string, deliberately. Under version 2 this is
   * ciphertext and there is no string to store; keeping it as bytes now means
   * the store does not change shape then. IndexedDB persists typed arrays
   * natively through structured clone, so this costs nothing over base64 and
   * is smaller on disk.
   */
  payload: Uint8Array;
  /** ISO-8601, from the server. Display ordering uses messageId, not this. */
  sentAt: string;
};

export type StoredConversation = {
  id: string;
  kind: "direct" | "group";
  createdAt: string;
  members: { userId: string; username: string; displayName: string }[];
};

/**
 * A message composed locally that the server has not confirmed yet.
 *
 * Separate from `messages` because it has no server id until the send
 * succeeds, and `messageId` is what the message store is keyed on. The UI
 * renders the two together so a composed message appears instantly.
 */
export type OutboxEntry = {
  /** Generated once per composed message and reused on every retry. */
  clientMessageId: string;
  conversationId: string;
  payload: Uint8Array;
  /** Local clock, for ordering pending messages after delivered ones. */
  createdAt: string;
  attempts: number;
  lastError?: string;
  /**
   * Set when the server rejected this in a way retrying cannot fix -- removed
   * from the conversation, payload over the ceiling, every recipient device
   * revoked. Such an entry is skipped by the flush rather than retried, so one
   * dead message cannot stall everything queued behind it. The UI surfaces it
   * for the user to discard or edit; nothing else clears it.
   */
  failedPermanently?: boolean;
};

export type ConversationPageOptions = {
  /**
   * Return messages strictly older than this id. Absent means start at the
   * newest. UUIDv7 sorts by time, so this is both the cursor and the ordering.
   */
  before?: string | undefined;
  limit?: number | undefined;
};

/**
 * Local history.
 *
 * Every write method resolves only once the data is durable. That is not a
 * stylistic promise -- the sync engine acks envelopes when these resolve, and
 * acking is what stops the server redelivering. A method that resolved early
 * would silently turn at-least-once delivery into at-most-once.
 */
export interface MessageStore {
  /**
   * Upserts messages, keyed on messageId.
   *
   * Upsert rather than insert because delivery is at-least-once and the same
   * message legitimately arrives more than once -- redelivered after a failed
   * ack, and again from `/archive` on a device that also drained it. Dedupe is
   * therefore a property of the key, not something callers have to remember.
   *
   * Resolves after the transaction commits. See the note above.
   */
  putMessages(messages: readonly StoredMessage[]): Promise<void>;

  /** A conversation's messages, newest first. */
  getConversationPage(
    conversationId: string,
    options?: ConversationPageOptions,
  ): Promise<StoredMessage[]>;

  /** The most recent message in a conversation, for the conversation list. */
  getLatestMessage(conversationId: string): Promise<StoredMessage | undefined>;

  /** How many messages are stored, for a conversation or in total. */
  countMessages(conversationId?: string): Promise<number>;

  putConversations(conversations: readonly StoredConversation[]): Promise<void>;
  listConversations(): Promise<StoredConversation[]>;
  getConversation(id: string): Promise<StoredConversation | undefined>;

  enqueueOutbox(entry: OutboxEntry): Promise<void>;
  listOutbox(conversationId?: string): Promise<OutboxEntry[]>;

  /**
   * Atomically replaces an outbox entry with the confirmed message.
   *
   * One transaction across both stores, because the two failure modes of doing
   * it in two steps are both bad: delete-then-write can lose the message, and
   * write-then-delete can leave a duplicate rendered forever.
   */
  resolveOutbox(clientMessageId: string, message: StoredMessage): Promise<void>;

  recordOutboxFailure(
    clientMessageId: string,
    error: string,
    permanent?: boolean,
  ): Promise<void>;
  removeOutbox(clientMessageId: string): Promise<void>;

  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;

  /**
   * Drops everything.
   *
   * Called on logout, because local history is per account and the next person
   * to log in on this browser must not see it. Note what this does *not* touch:
   * the device id in localStorage, which outlives the session on purpose.
   */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Meta keys
// ---------------------------------------------------------------------------

/**
 * Whether this device has finished its one-time walk of `/archive`.
 *
 * Stored rather than inferred, because "no messages yet" and "never hydrated"
 * look identical from an empty store and mean opposite things -- one needs a
 * full history read, the other must not do one on every launch.
 */
export const META_HYDRATION = "hydration";

export type HydrationState = {
  complete: boolean;
  /** Where the walk got to, so an interrupted one resumes instead of restarting. */
  cursor: string | null;
  updatedAt: string;
};
