import type { ConversationEventCall, ConversationEventKind } from "../api/types";
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
  /** 2 (MLS) on everything since the cutover; 1 was the plaintext era. */
  protocolVersion: number;
  /**
   * The message content as bytes, already decrypted by `E2EProvider.decrypt`
   * (crypto/provider.ts) at ingest time -- not the wire payload.
   *
   * Decrypted once and stored, rather than decrypted again on every render,
   * because a ratcheting protocol may no longer hold the key for an old epoch
   * by the time something is displayed. Bytes rather than a decoded string,
   * because `decodeContent` (api/payload.ts) still has to run on it and a
   * string would have to be re-encoded first for no reason. IndexedDB
   * persists typed arrays natively through structured clone, so this costs
   * nothing over base64 and is smaller on disk.
   *
   * If decrypt failed -- a protocol version this build's provider does not
   * understand -- this holds the raw undecrypted wire bytes instead, and
   * `protocolVersion` is what says not to read them. See `toStored` in
   * sync/engine.ts.
   */
  payload: Uint8Array;
  /**
   * Set when decrypt could not produce content and `payload` still holds the
   * wire bytes. The explicit flag replaces inferring "readable" from
   * `protocolVersion` -- under v2 a version-2 message is usually readable
   * and occasionally not (sealed to an epoch this device never held), and
   * only decrypt knows which. Healed by the forward archive sync: a
   * successful re-store clears it, and `putMessages` never lets a failed
   * record overwrite a decrypted one.
   */
  decryptFailed?: true;
  /** ISO-8601, from the server. Display ordering uses messageId, not this. */
  sentAt: string;
};

/**
 * A downloaded attachment, or the reason there will never be one.
 *
 * The terminal states are stored rather than inferred, and that is the point:
 * without them a device that has never had the bytes asks for them on every
 * render of a message that will never have any, forever. `expired` in
 * particular is the normal end state of every attachment, not an error --
 * retention removing bytes a device already holds changes nothing, and
 * retention removing bytes it does not is exactly this.
 */
export type StoredBlob =
  | { state: "ok"; mediaType: string; bytes: Uint8Array }
  | { state: "expired" }
  | { state: "unknown" };

export type StoredConversation = {
  id: string;
  kind: "direct" | "group" | "channel";
  /** Null uses the default (member names joined) rather than a real name. */
  title: string | null;
  createdAt: string;
  /** The owning hub for a channel; null (or absent, for rows stored before
   * hubs existed) otherwise. Mirrors the wire field. */
  hubId?: string | null;
  /**
   * The channel's content class, straight off the wire -- 'public' is what
   * routes a send around the E2E seal (sync/engine.ts enqueue) and what the
   * UI labels. Absent on pre-hubs rows, which are all sealed.
   */
  hubVisibility?: "private" | "public" | null;
  /** 'voice' for a hub voice channel; absent on rows stored before voice
   *  existed, which are all text. Mirrors the wire field. */
  channelKind?: "text" | "voice";
  /** The room's join-mute threshold; absent or null means none. */
  joinMutedAbove?: number | null;
  members: {
    userId: string;
    username: string;
    displayName: string;
    /** Chosen avatar hue, or null for id-derived. Optional because rows
     *  stored before the column existed come back without it -- treat
     *  undefined exactly like null. */
    avatarHue?: number | null;
    /** See the wire type in api/types.ts. Null until they have read anything. */
    lastReadMessageId: string | null;
    lastReadAt: string | null;
  }[];
  /**
   * Whether the caller has muted this conversation. Mirrors the wire field
   * in api/types.ts -- push-silencing only, never affects unread counting or
   * the sync loop.
   */
  muted: boolean;
};

/**
 * A notice line, server-authored -- see api/types.ts's ConversationEvent for
 * why. Interleaves with StoredMessage in the timeline by id alone, since both
 * are uuidv7.
 */
export type StoredEvent = {
  id: string;
  conversationId: string;
  kind: ConversationEventKind;
  actorUserId: string;
  actorUsername: string;
  actorDisplayName: string;
  targetUserId: string | null;
  targetUsername: string | null;
  targetDisplayName: string | null;
  title: string | null;
  historyShared: boolean;
  /** call_started / call_ended only (voice); null otherwise. Mirrors the
   *  wire event -- the server joins the call's facts at read time, so a
   *  refresh after the call ends updates the stored row's `call`. */
  callId: string | null;
  call: ConversationEventCall | null;
  createdAt: string;
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
  /** Set once at enqueue time by the E2E provider. A retry never changes it. */
  protocolVersion: number;
  /**
   * The group epoch the payload was sealed under. Named on the send request
   * so the server can refuse a stale-roster message. A retry MAY change it:
   * a 409 EPOCH_STALE (or HISTORY_KEY_STALE) re-encrypts from `content`,
   * replacing payload, epoch and the archive fields together -- the
   * sanctioned exception to encrypt-once, safe because the server created
   * no message row for the refused send.
   */
  epoch?: number;
  /**
   * The history-key generation `archivePayload` was sealed under (v3).
   * Refused by the server when a rotation has advanced past it.
   */
  archiveGeneration?: number;
  /** ONE archive payload for the whole message, sealed at enqueue time. */
  archivePayload?: Uint8Array;
  /**
   * The v2-era shape: one payload per recipient user. Nothing writes this
   * any more and the server refuses it; an entry still carrying it was
   * queued before the v3 deploy, and the flush re-seals it from `content`
   * instead of sending it.
   */
  archive?: { userId: string; payload: Uint8Array }[];
  /**
   * Set when enqueue could not encrypt yet -- no group state (not joined,
   * group not created) or no cached recipients. `payload` is empty and
   * `content` holds the plaintext; the outbox flush encrypts when it can,
   * and entries behind one of these in the same conversation wait so the
   * conversation's order is preserved.
   */
  pendingEncryption?: true;
  /**
   * Already encrypted -- see `E2EProvider.encrypt` in crypto/provider.ts.
   * This is what a retry resends: fixed once at enqueue time, never
   * recomputed from `content`.
   */
  payload: Uint8Array;
  /**
   * The plaintext `encrypt` was called with, kept only for rendering the
   * pending bubble before the server confirms the send. Nothing else reads
   * this -- the moment the send succeeds, the confirmed `StoredMessage` takes
   * over and carries its own decrypted content, produced the same way an
   * inbound message's is. See `toStored` and `#flushOutbox` in
   * sync/engine.ts.
   */
  content: Uint8Array;
  /**
   * Ask the server not to push for this send -- set at enqueue time for
   * operation payloads (reactions, edits, retractions), which should never
   * ring a phone. Rides every retry unchanged; the socket wake is unaffected.
   * See docs/api.md for the metadata disclosure this flag is.
   */
  silent?: true;
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

  /**
   * Removes messages outright. The one caller is the moderation tombstone:
   * a message_deleted hub event means the server no longer serves the
   * message, so a local copy cannot be re-added by any later read -- removal
   * here is final the same way the server's soft delete is.
   */
  deleteMessages(ids: readonly string[]): Promise<void>;

  /**
   * Which of these ids the store already holds. The dedup-before-decrypt
   * check: a redelivered envelope must be acked without a second decrypt,
   * because under a ratcheting protocol the key that opened it the first
   * time no longer exists.
   */
  existingMessageIds(ids: readonly string[]): Promise<Set<string>>;

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

  /** Upserts notice lines, keyed on id. Same at-least-once shape as messages. */
  putEvents(events: readonly StoredEvent[]): Promise<void>;

  /** Every notice line stored for a conversation. Rare enough not to page. */
  getConversationEvents(conversationId: string): Promise<StoredEvent[]>;

  /**
   * Moves a member's read marker in the locally stored conversation.
   *
   * So the unread badge clears the instant somebody opens a conversation,
   * rather than on the next conversation refresh up to 30 seconds later. The
   * server is the authority and its copy arrives shortly after; this exists
   * because a badge that lingers after you have plainly read the thing reads
   * as broken.
   *
   * Forward only, mirroring the server, so an out-of-order refresh cannot
   * resurrect a cleared badge.
   */
  mergeReadMarker(
    conversationId: string,
    userId: string,
    messageId: string,
    at: string,
  ): Promise<void>;

  /**
   * How many messages in this conversation arrived after `afterMessageId` and
   * were not sent by `excludeSenderUserId`.
   *
   * Counted rather than derived from a flag because there is no per-message
   * read state to derive it from -- a marker plus an ordered index is the
   * whole mechanism. Bounded by `cap`: a badge showing "99+" and one showing
   * 4,312 say the same thing to a person, and only one of them walks four
   * thousand records to say it.
   *
   * Operation payloads (api/payload.ts's MessageOp kinds) do not count --
   * a reaction is not something a person has left unread. Every
   * implementation of this interface owes the same filter.
   */
  /** A downloaded attachment, or a recorded terminal state, or undefined. */
  getBlob(attachmentId: string): Promise<StoredBlob | undefined>;

  /**
   * Records bytes, or the fact that there will never be any.
   *
   * Written once and never revisited: an attachment's bytes are immutable and
   * its terminal states are terminal, so there is no invalidation to think
   * about.
   */
  putBlob(attachmentId: string, blob: StoredBlob): Promise<void>;

  countUnread(
    conversationId: string,
    afterMessageId: string | null,
    excludeSenderUserId: string,
    cap?: number,
  ): Promise<number>;
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

/**
 * The newest page of operator announcements, as fetched (an Announcement[]
 * from api/client.ts). A meta entry rather than an object store of its own:
 * the list is small, always replaced whole, and never queried by key -- a
 * schema version bump would buy nothing. Written by the engine on the
 * conversation-refresh cadence; read by useAnnouncements in ui/hooks.ts.
 */
export const META_ANNOUNCEMENTS = "announcements";

/**
 * The newest announcement id the user has actually seen, for the unread
 * indicator. Client-local by design -- see docs/roadmap.md: a per-user
 * column on the server is only worth it if the unread dot must sync across
 * devices, which it does not yet.
 */
export const META_ANNOUNCEMENTS_SEEN = "announcements.seen";

/**
 * The caller's hubs, as fetched (a HubSummary[] from api/types.ts). A meta
 * entry rather than an object store for the same reasons announcements are:
 * small, replaced whole, never queried by key -- and it spares a DB_VERSION
 * bump. Written by the engine on the conversation-refresh cadence; read by
 * useHubs in ui/hooks.ts. Empty while the `hubs` flag is off, which is
 * indistinguishable from having none -- deliberately.
 */
export const META_HUBS = "hubs";

/**
 * Per-PUBLIC-channel sync watermarks: conversationId -> the newest v4
 * message id this device holds. Public channels have no envelopes and no
 * inbox -- delivery is a cursor read (`/archive?conversationId=&after=`) --
 * so this is their whole "what have I seen" state. A channel absent from
 * the map has never been synced and gets one newest-first page rather than
 * the full backlog: the hydration-depth decision from the hubs plan, applied
 * on day one. Older history loads on demand.
 */
export const META_PUBLIC_CHANNELS = "public.channels";

export type PublicChannelState = Record<
  string,
  { latest: string | null }
>;

/**
 * Per-hub event-sync watermarks: hubId -> the newest hub event id this
 * device has processed. The engine reads new events on the hub-refresh
 * cadence and acts on the actionable kinds (message_deleted tombstones the
 * local copy); the panel's own event listing stays a plain on-demand fetch.
 */
export const META_HUB_EVENTS = "hubs.events";

export type HubEventState = Record<string, { latest: string | null }>;

/**
 * Per-conversation newest message id that mentions this account:
 * conversationId -> messageId. Written by the engine when it stores a
 * message whose payload names the user; read by the sidebar, which shows
 * the stronger unread treatment while this id is ahead of the user's own
 * read marker. Never cleared -- the comparison against the marker is what
 * ends the highlight, so stale entries are inert.
 */
export const META_MENTIONS = "mentions";

export type MentionState = Record<string, string>;

/**
 * Per-conversation delivered watermarks: `delivered.<conversationId>` holds
 * a Record of recipient user id -> the newest of this account's message ids
 * that user has acked. Fed by "delivered" frames off the realtime socket
 * (sync/engine.ts), monotone -- an entry only ever moves forward, so a
 * missed frame is repaired by the next one. Rendered by the timeline as the
 * "Delivered" receipt when nobody has read yet; a read receipt (which rides
 * the conversation listing, persistently) always wins over it.
 */
export const META_DELIVERED_PREFIX = "delivered.";

/**
 * Device-local sidebar layout preferences: the hubs/DMs split height, which
 * hubs are collapsed, and the manual hub order. Deliberately not synced --
 * the same class as `announcements.seen`: a server column is only worth it
 * if layout must follow the account across devices, which it does not.
 * Dying with store.clear() is correct rather than a loss, because the hub
 * ids inside are account-scoped -- surviving into another account's session
 * on this browser would be wrong. Read/written only through
 * ui/sidebar/prefs.ts, which owns its own invalidation: no sync event ever
 * fires for a local write, so the hooks.ts pattern does not apply.
 */
export const META_SIDEBAR_PREFS = "sidebar.prefs";

export type SidebarPrefs = {
  /**
   * Fixed pixel height of the hubs section on desktop; null means auto
   * (content-sized, capped by the sidebar's own max). Clamping when the
   * window is too small happens in CSS, so this value is never rewritten
   * by a resize the user didn't drag.
   */
  hubsHeightPx: number | null;
  /** Hubs whose channel lists are hidden. */
  collapsedHubIds: string[];
  /**
   * Manual hub order. Hubs not listed append in server order; ids of hubs
   * since left are inert and get pruned on the next reorder, which writes
   * only currently-present ids.
   */
  hubOrder: string[];
};
