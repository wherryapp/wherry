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
};

export type DeviceDescriptor = {
  /** Omitted on a device's first login, sent on every later one. */
  id?: string;
  displayName: string;
  platform: Platform;
};

export type ConversationKind = "direct" | "group";

export type ConversationMember = {
  userId: string;
  username: string;
  displayName: string;
};

export type Conversation = {
  id: string;
  kind: ConversationKind;
  createdAt: string;
  members: ConversationMember[];
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
  payload: string;
  sentAt: string;
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
  | "NO_RECIPIENTS"
  | "RATE_LIMITED"
  | "REQUEST_FAILED"
  | "INTERNAL_ERROR"
  | (string & {});

/** Protocol version 1 is plaintext. 2 will be ciphertext. Dispatch on it. */
export const PROTOCOL_PLAINTEXT = 1;
