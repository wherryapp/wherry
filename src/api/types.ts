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
  /** Chosen oklch hue in [0, 360), or null for id-derived -- kit's Avatar
   *  hashes the id when this is null, which is every account until it
   *  touches the swatch row in Settings. */
  avatarHue: number | null;
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
  /**
   * The epoch of the server's stored GroupInfo, or null when none has been
   * published. Current (=== epoch) means an external join is possible;
   * anything else means wait for a welcome, and a member holding current
   * state should re-publish.
   */
  groupInfoEpoch: number | null;
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
  avatarHue: number | null;
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
  /**
   * 'voice' for a hub voice channel -- a room with no timeline, rendered as
   * a joinable room rather than a thread; 'text' for everything else,
   * forever. Settings class, like topic. Never inferred from the title.
   */
  channelKind: ChannelKind;
  /**
   * Voice channels only: joining a room already holding MORE than this
   * many people mutes you on entry (null: nobody is auto-muted). The
   * server applies it and answers `joinMuted`; the client's own join-mute
   * preference (voice/prefs.ts) can override either way.
   */
  joinMutedAbove: number | null;
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
  | "renamed"
  /** A call opened here: a join banner while it is still open, nothing
   *  once it has ended (the call_ended line carries the summary). */
  | "call_started"
  /** "Call · 12 min", "Missed call from …", "Declined call". */
  | "call_ended";

/** What a call_* event says about its call, joined server-side at read. */
export type ConversationEventCall = {
  startedByUserId: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  /** Everyone who was handed a token or seen by the SFU. */
  participantUserIds: string[];
};

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
  /** call_started / call_ended only; null for every other kind. */
  callId: string | null;
  call: ConversationEventCall | null;
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

/** 'moderators' makes a channel announcement-only. */
export type ChannelPosting = "everyone" | "moderators";

export type ChannelKind = "text" | "voice";

export type HubChannel = {
  /** The channel's conversation id -- a channel IS a conversation. */
  id: string;
  title: string | null;
  /** 'voice' is a room (join, no timeline); 'text' is a channel. */
  kind: ChannelKind;
  /** Voice channels only; see Conversation.joinMutedAbove. */
  joinMutedAbove: number | null;
  /** Roster-class metadata like title; null when unset. */
  topic: string | null;
  posting: ChannelPosting;
  /** Public channels only; null means off. Moderators are exempt. */
  slowmodeSeconds: number | null;
  createdAt: string;
};

export type HubMember = {
  userId: string;
  username: string;
  displayName: string;
  avatarHue: number | null;
  role: HubRole;
  joinedAt: string;
};

export type HubBanned = {
  userId: string;
  username: string;
  displayName: string;
  avatarHue: number | null;
  bannedAt: string;
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
  /** Populated only when the caller is moderator+; empty array otherwise. */
  banned: HubBanned[];
  channels: HubChannel[];
};

export type HubEventKind =
  | "member_added"
  | "member_removed"
  | "member_banned"
  | "member_unbanned"
  | "role_changed"
  | "renamed"
  | "channel_created"
  | "channel_renamed"
  | "channel_topic"
  | "channel_posting"
  | "channel_slowmode"
  | "message_deleted"
  | "message_pinned"
  | "message_unpinned"
  | "invite_created"
  | "invite_revoked"
  // The server may add kinds this build has never heard of; render nothing
  // rather than crash, same posture as ApiErrorCode.
  | (string & {});

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
  /**
   * Set for message-scoped kinds. message_deleted is load-bearing: the sync
   * engine tombstones the local copy when it sees one.
   */
  messageId: string | null;
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
  senderDeviceId: string;
  senderUsername: string;
  senderDisplayName: string;
  snippet: string;
  /** The hit's full v4 payload, base64 -- storable, so a tap can jump to it. */
  payload: string;
  sentAt: string;
};

export type HubSearchPage = {
  results: HubSearchResult[];
  nextCursor: string | null;
};

export type HubInvite = {
  id: string;
  /** The bearer credential itself; shown only to moderators. */
  token: string;
  createdByUserId: string;
  createdByUsername: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
};

/** What a token discloses before joining: enough to decide, nothing more. */
export type HubInvitePreview = {
  hubId: string;
  name: string;
  visibility: HubVisibility;
  memberCount: number;
};

export type HubPin = {
  messageId: string;
  conversationId: string;
  pinnedByUserId: string;
  pinnedByUsername: string;
  pinnedByDisplayName: string;
  pinnedAt: string;
  senderUserId: string;
  senderDeviceId: string;
  senderUsername: string;
  senderDisplayName: string;
  sentAt: string;
  /** base64 v4 payload for public channels; null for private ones, where
   * each client renders (or declines to render) its own local copy. */
  payload: string | null;
};

/**
 * The `error` field of a failure response.
 *
 * Match on this, never on `message` -- the text is for humans and will change.
 * Widened with a string branch because the server may add codes this build
 * has never heard of, and a client that crashes on an unknown one is worse
 * than a client that reports it.
 */
// ---------------------------------------------------------------------------
// Voice (docs/prompts/voice-plan.md §5.6)
// ---------------------------------------------------------------------------

export type CallKind = "call" | "room";
export type CallStatus = "ringing" | "active" | "ended";

export type CallParticipant = {
  userId: string;
  /** The device that answered or joined; null while merely invited. */
  deviceId: string | null;
  invitedAt: string | null;
  answeredAt: string | null;
  declinedAt: string | null;
  /** From the SFU's webhooks -- "actually in the room". */
  joinedAt: string | null;
  leftAt: string | null;
};

/**
 * A call (direct/group, rings) or one occupied session of a hub voice
 * channel (kind 'room', never rings). Metadata only; the media is E2EE or
 * relayed unrecorded -- the server never holds content of a call.
 */
export type Call = {
  id: string;
  conversationId: string;
  kind: CallKind;
  status: CallStatus;
  startedByUserId: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  participants: CallParticipant[];
};

/** What every join hands back: the SFU to connect to, and a token for it. */
export type JoinResult = {
  call: Call;
  token: string;
  /** VOICE_PUBLIC_URL -- the hostname that survives the SFU moving. */
  url: string;
  /** The server's join-mute verdict for a room; always false for a call. */
  joinMuted: boolean;
};

export type RoomOccupancy = { conversationId: string; occupants: string[] };

/** GET /voice/active: every open call in the caller's conversations (rings
 *  included -- a ring is an open call this user is merely invited to) and
 *  who is in the voice channels they belong to. The self-heal read. */
export type VoiceActive = {
  enabled: boolean;
  calls: Call[];
  rooms: RoomOccupancy[];
};

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

