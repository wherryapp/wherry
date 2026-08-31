// The wire contract, as documented in docs/api.md.
//
// Hand-written, and deliberately not shared with the server through a
// workspace package. The client and server agree over JSON on a socket, which
// is a runtime contract; a shared type would give compile-time agreement that
// the wire does not actually enforce, and would buy it at the cost of a
// package boundary, a second build step and a lockfile move that breaks the
// server's Docker build context. See docs/architecture.md.
//
// The real consequence is that this file and the server's route schemas have
// to change together. That is the same discipline the server already runs
// under -- its TypeScript body types are a hand-written mirror of its JSON
// Schemas, with nothing generating one from the other.

export type Platform = "desktop" | "ios" | "android";

export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
};

export type PublicDevice = {
  id: string;
  displayName: string;
  platform: Platform;
};

export type AuthResult = {
  token: string;
  /** ISO-8601 UTC. */
  expiresAt: string;
  user: PublicUser;
  device: PublicDevice;
  /** Never true straight out of registration -- verifying means clicking a
   * link that has not been sent yet. */
  emailVerified: boolean;
};

// ---------------------------------------------------------------------------
// Account keys
// ---------------------------------------------------------------------------

/** KDF cost parameters, stored per wrap. `m` is KiB. */
export type KdfParamsWire = { alg: string; m: number; t: number; p: number };

/**
 * The wrapped account keypair as it crosses the wire: every key field is
 * base64 bytes the server stores without opening. See crypto/keys.ts for
 * what the fields mean; this type only says what the endpoints carry.
 */
export type AccountKeysWire = {
  publicKey: string;
  passwordWrappedKey: string;
  passwordKdfSalt: string;
  passwordKdfParams: KdfParamsWire;
  recoveryWrappedKey: string;
  recoveryKdfSalt: string;
  recoveryKdfParams: KdfParamsWire;
};

/** What GET /account/keys returns: the row plus when it last changed. */
export type AccountKeysResponse = AccountKeysWire & { updatedAt: string };

/** The re-wrap that rides along with a password change. */
export type PasswordWrapWire = {
  passwordWrappedKey: string;
  passwordKdfSalt: string;
  passwordKdfParams: KdfParamsWire;
};

// ---------------------------------------------------------------------------
// MLS delivery
// ---------------------------------------------------------------------------

/** GET /conversations/:id/recipients — the roster authority. */
export type RecipientsResponse = {
  epoch: number;
  /** The current history-key generation; 0 when none has been minted yet. */
  historyGeneration: number;
  /** True when this client should rotate: no generation exists, or user
   * membership changed since the current one was minted. */
  historyKeyStale: boolean;
  members: {
    userId: string;
    /** base64, or null for an account that predates v2. */
    accountPublicKey: string | null;
    devices: {
      deviceId: string;
      /** base64, or null until the device first publishes key packages. */
      identityPublicKey: string | null;
    }[];
  }[];
};

/** One row of GET /conversations/:id/commits. */
export type CommitEntry = {
  epoch: number;
  senderDeviceId: string;
  /** base64 MLSMessage(Commit). */
  payload: string;
  createdAt: string;
};

/** One row of GET /mls/welcomes. */
export type WelcomeEntry = {
  welcomeId: string;
  conversationId: string;
  /** The epoch the joining device's new state corresponds to. */
  epoch: number;
  /** base64 MLSMessage(Welcome). */
  payload: string;
};

export type DeviceDescriptor = {
  /** Omitted on a device's first login, sent on every later one. */
  id?: string;
  displayName: string;
  platform: Platform;
};

// 'channel' rows belong to a hub and are created only through the hub
// endpoints; the send path and timeline treat them as ordinary
// conversations, with the content class decided by `hubVisibility` below.
export type ConversationKind = "direct" | "group" | "channel";

export type HubVisibility = "private" | "public";

export type ConversationMember = {
  userId: string;
  username: string;
  displayName: string;
  /**
   * How far this member has read. Null if they never have.
   *
   * Your own row is what unread is counted against; everybody else's is a read
   * receipt. One field serves both because reading is monotonic -- see the
   * server's 0004_read_markers.sql.
   */
  lastReadMessageId: string | null;
  lastReadAt: string | null;
};

export type Conversation = {
  id: string;
  kind: ConversationKind;
  /** Null uses the default (member names joined) rather than a real name. */
  title: string | null;
  createdAt: string;
  /** The owning hub for a channel; null for direct and group, always. */
  hubId: string | null;
  /**
   * The owning hub's visibility, resolved server-side. This is THE content-
   * class switch: 'public' means sends carry plaintext (protocol v4, no
   * crypto fields) and the timeline syncs by cursor read; 'private' and null
   * mean sealed exactly as ever. Never inferred client-side from anything
   * else.
   */
  hubVisibility: HubVisibility | null;
  members: ConversationMember[];
  /**
   * Whether the caller has muted this conversation. Server column, per the
   * roadmap's mute triage -- push skips a muted member server-side, so a
   * client-local flag alone could not stop the notification. Never anyone
   * else's state.
   */
  muted: boolean;
};

export type ConversationEventKind =
  | "member_added"
  | "member_removed"
  | "renamed";

/**
 * A notice line: who did what, server-authored so it stays consistent across
 * devices and survives the target having since left. Interleaves with
 * messages in the timeline by id alone -- both are uuidv7.
 */
export type ConversationEvent = {
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
  createdAt: string;
};

export type EventsPage = {
  events: ConversationEvent[];
  /** Null means the walk is finished. This, not an empty page, is the signal. */
  nextCursor: string | null;
};

export type SendResult = {
  id: string;
  conversationId: string;
  clientMessageId: string;
  createdAt: string;
  /** One per recipient *device*, the sender's own included. */
  envelopeCount: number;
  /** True when this matched an earlier send rather than creating one. */
  deduplicated: boolean;
};

/**
 * One envelope from the inbox, addressed to *this device*.
 *
 * `payload` is base64 because `envelopes.payload` is bytea and JSON cannot
 * carry bytes. It is called `payload` and not `body` because under protocol
 * version 2 it is ciphertext.
 */
export type InboxEnvelope = {
  envelopeId: string;
  messageId: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  protocolVersion: number;
  payload: string;
  sentAt: string;
};

/**
 * One row of history, addressed to *this user*.
 *
 * Identical to InboxEnvelope minus `envelopeId`, because there is no envelope
 * -- this copy is per account rather than per device. The overlap is the point:
 * both go through the same "store this message" path in the client.
 */
export type ArchiveEntry = {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  protocolVersion: number;
  /** v3 rows only: which history-key generation sealed the payload. */
  keyGeneration: number | null;
  payload: string;
  sentAt: string;
};

/** One row of GET /history-keys: a wrapped key addressed to this user. */
export type HistoryKeyEntry = {
  conversationId: string;
  generation: number;
  /** base64 HPKE ciphertext, sealed to this account's public key. */
  wrappedKey: string;
};

export type ArchivePage = {
  entries: ArchiveEntry[];
  /** Null means the walk is finished. This, not an empty page, is the signal. */
  nextCursor: string | null;
};

/** Metadata only. There is deliberately no payload field. */
export type MessageSummary = {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  createdAt: string;
};

export type MessagesPage = {
  messages: MessageSummary[];
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// Hubs
// ---------------------------------------------------------------------------

export type HubRole = "owner" | "moderator" | "member";

export type HubChannel = {
  /** The channel's conversation id -- a channel IS a conversation. */
  id: string;
  title: string | null;
  createdAt: string;
};

export type HubMember = {
  userId: string;
  username: string;
  displayName: string;
  role: HubRole;
  joinedAt: string;
};

export type HubSummary = {
  id: string;
  name: string;
  visibility: HubVisibility;
  /** The caller's own role. */
  role: HubRole;
  memberCount: number;
  channels: HubChannel[];
};

export type HubDetail = {
  id: string;
  name: string;
  visibility: HubVisibility;
  createdAt: string;
  memberLimit: number;
  channelLimit: number;
  role: HubRole;
  members: HubMember[];
  channels: HubChannel[];
};

export type HubEventKind =
  | "member_added"
  | "member_removed"
  | "member_banned"
  | "role_changed"
  | "renamed"
  | "channel_created"
  | "channel_renamed";

/** A hub-level audit line, rendered in the hub panel (not in timelines). */
export type HubEvent = {
  id: string;
  hubId: string;
  kind: HubEventKind;
  actorUserId: string;
  actorUsername: string;
  actorDisplayName: string;
  targetUserId: string | null;
  targetUsername: string | null;
  targetDisplayName: string | null;
  title: string | null;
  historyShared: boolean;
  createdAt: string;
};

export type HubEventsPage = {
  events: HubEvent[];
  nextCursor: string | null;
};

/** One full-text hit in a public hub. Snippet wraps matches in <b>..</b>. */
export type HubSearchResult = {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  senderUsername: string;
  senderDisplayName: string;
  snippet: string;
  sentAt: string;
};

export type HubSearchPage = {
  results: HubSearchResult[];
  nextCursor: string | null;
};

/**
 * The `error` field of a failure response.
 *
 * Match on this, never on `message` -- the text is for humans and will change.
 * Widened with a string branch because the server may add codes this build
 * has never heard of, and a client that crashes on an unknown one is worse
 * than a client that reports it.
 */
export type ApiErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "INVALID_CREDENTIALS"
  | "UNKNOWN_DEVICE"
  | "USERNAME_TAKEN"
  | "INVALID_MEMBERS"
  | "UNKNOWN_USER"
  | "NOT_A_MEMBER"
  | "NOT_A_GROUP"
  | "NO_RECIPIENTS"
  | "EMAIL_NOT_VERIFIED"
  | "NO_EMAIL"
  | "RATE_LIMITED"
  | "REQUEST_FAILED"
  | "INTERNAL_ERROR"
  | (string & {});

