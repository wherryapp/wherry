// The HTTP surface, one function per endpoint in docs/api.md.
//
// Every URL is a relative path under /api. There is no host and no port,
// because the app is always same-origin with the API: Vite proxies /api to
// :3000 in development, and in production Caddy serves the built assets and
// reverse-proxies /api on the same hostname. Same origin both times means
// CORS does not exist in this system, and there is no base URL that can be
// wrong in a build.
//
// One exception since Phase 5: the desktop (Tauri) build cannot be
// same-origin with anything, so base.ts resolves the prefix -- still "/api"
// everywhere except that build. See its header for the whole story.
//
// The prefix is what lets one Caddy rule separate the API from the client's
// static files. See server.ts, where it is applied.

import { API_BASE, HEALTH_URL } from "./base";
import { currentToken } from "./session";
import type {
  AccountKeysResponse,
  AccountKeysWire,
  ApiErrorCode,
  ArchivePage,
  AuthResult,
  CommitEntry,
  Conversation,
  DeviceDescriptor,
  ChannelPosting,
  EventsPage,
  HistoryKeyEntry,
  HubChannel,
  HubDetail,
  HubEventsPage,
  HubInvite,
  HubInvitePreview,
  HubPin,
  HubSearchPage,
  HubSummary,
  HubVisibility,
  InboxEnvelope,
  MessagesPage,
  PasswordWrapWire,
  PublicDevice,
  PublicUser,
  RecipientsResponse,
  SendResult,
  WelcomeEntry,
  ChannelKind,
  Call,
  JoinResult,
  VoiceActive,
} from "./types";

/**
 * Every request goes under here.
 *
 * One constant rather than the prefix being written into each path below, so
 * moving it is a one-line change on both sides -- this and API_PREFIX in the
 * server's server.ts.
 */
const API = API_BASE;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The server answered, and said no.
 *
 * Carries the machine-readable `code` rather than only the message, because
 * docs/api.md is explicit that the text is for humans and will change.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** From the Retry-After header on a 429, when the server sends one. */
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The request never got an answer -- offline, DNS, the server down, a dropped
 * connection mid-flight.
 *
 * Distinct from ApiError on purpose. The sync engine treats them differently:
 * this is always worth retrying with backoff, whereas some ApiErrors (401)
 * must stop the loop rather than retry it forever.
 */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("The server could not be reached");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/** A dead or missing session. The one error that must stop a poll loop. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/**
 * Whether this means "the server is not there", however it was reported.
 *
 * Not every unreachable server produces a NetworkError. When something sits
 * between the browser and the app -- Vite's dev proxy, and Caddy in production
 * -- a dead upstream comes back as a perfectly well-formed 502, 503 or 504
 * from the proxy itself. The fetch succeeded; there was simply nothing behind
 * it.
 *
 * Worth collapsing because the distinction is invisible and irrelevant to the
 * person reading it. "Request failed with 502" describes the proxy's
 * bookkeeping; "cannot reach the server" describes their situation.
 */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return (
    error instanceof ApiError &&
    (error.status === 502 || error.status === 503 || error.status === 504)
  );
}

// ---------------------------------------------------------------------------
// The request helper
// ---------------------------------------------------------------------------

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Skips the Authorization header. Register and login are the only two. */
  anonymous?: boolean;
  signal?: AbortSignal;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  if (!options.anonymous) {
    const token = currentToken();
    if (token) headers["authorization"] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    // An AbortError is a deliberate cancellation, not a failure to reach the
    // server. Rethrowing it as a NetworkError would make the poll loop back
    // off after every navigation.
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new NetworkError(cause);
  }

  if (response.status === 204) return undefined as T;

  // Read the body once, as text, then decide. Calling .json() on an error
  // response that happens to be HTML (a proxy error page, say) throws a
  // SyntaxError that says nothing about what actually went wrong.
  const raw = await response.text();
  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const shape = parsed as { error?: string; message?: string } | null;
    const retryAfter = response.headers.get("retry-after");
    throw new ApiError(
      response.status,
      shape?.error ?? "REQUEST_FAILED",
      shape?.message ?? `Request failed with ${response.status}`,
      retryAfter ? Number(retryAfter) || null : null,
    );
  }

  return parsed as T;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function register(input: {
  username: string;
  displayName: string;
  password: string;
  device: DeviceDescriptor;
  /** Required: every account needs a verified address to do anything past
   * the verification gate. See requireVerifiedEmail on the server. */
  email: string;
  /** The wrapped account keypair, generated by crypto/account.ts. */
  accountKeys?: AccountKeysWire;
}): Promise<AuthResult> {
  return request<AuthResult>(`${API}/auth/register`, {
    method: "POST",
    body: input,
    anonymous: true,
  });
}

export function login(input: {
  username: string;
  password: string;
  device: DeviceDescriptor;
}): Promise<AuthResult> {
  return request<AuthResult>(`${API}/auth/login`, {
    method: "POST",
    body: input,
    anonymous: true,
  });
}

export function logout(): Promise<void> {
  return request<void>(`${API}/auth/logout`, { method: "POST" });
}

/**
 * Unauthenticated and outside `/api` -- see server.ts and deploy/Caddyfile,
 * where it gets its own `handle` block rather than falling under the API
 * prefix or the client's SPA fallback. `commit` is what the sync engine
 * compares against this build's own `VITE_COMMIT_SHA` to prompt a reload;
 * see `docs/history-key-runbook.md` for why an open tab does not pick up a
 * deploy on its own otherwise. `version` is the tag-derived counterpart
 * (docs/roadmap.md's "Version numbers: soon, not yet") -- optional because
 * older deployed servers (or a hand-rolled health check) may not send it.
 */
export function fetchHealth(): Promise<{
  status: string;
  database: string;
  commit: string;
  version?: string;
  /**
   * The minimum client version, when the operator has set one -- the
   * version floor's hard stop, normally null/absent. Optional for the same
   * reason as `version`: older deployed servers do not send it.
   */
  minVersion?: string | null;
  time: string;
}> {
  return request(HEALTH_URL, { anonymous: true });
}

export function me(): Promise<{
  user: PublicUser;
  device: PublicDevice;
  /** The caller's own address, not part of PublicUser -- see routes/auth.ts. */
  email: string | null;
  emailVerified: boolean;
  session: { id: string; expiresAt: string };
}> {
  return request(`${API}/auth/me`);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Exact match, case-insensitive. Throws ApiError with code UNKNOWN_USER and
 * status 404 when there is no such account -- which is a normal outcome of
 * someone typing a name, not an exceptional one, so callers should expect to
 * catch it.
 */
export function lookupUser(username: string): Promise<PublicUser> {
  return request<PublicUser>(
    `${API}/users/lookup?username=${encodeURIComponent(username)}`,
  );
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** Find-or-create for `direct`, so calling it twice is safe and expected. */
export function createConversation(input: {
  kind: "direct" | "group";
  memberUserIds: string[];
}): Promise<Conversation> {
  return request<Conversation>(`${API}/conversations`, {
    method: "POST",
    body: input,
  });
}

export async function listConversations(): Promise<Conversation[]> {
  const page = await request<{ conversations: Conversation[] }>(`${API}/conversations`);
  return page.conversations;
}

/**
 * Adds people to an existing group. No MLS call needed alongside this: the
 * reconciliation sweep in sync/mls.ts diffs the server's membership record
 * against the local group on its own cadence and issues the Add and welcome.
 */
export function addMembers(input: {
  conversationId: string;
  memberUserIds: string[];
  /** Recorded on the notice event; the key backfill itself is
   * mlsSync.shareHistory, run by the adder's client after this succeeds. */
  shareHistory?: boolean;
}): Promise<Conversation> {
  return request<Conversation>(
    `${API}/conversations/${input.conversationId}/members`,
    {
      method: "POST",
      body: {
        memberUserIds: input.memberUserIds,
        shareHistory: input.shareHistory ?? false,
      },
    },
  );
}

/**
 * Removes another member from a group. Any current member may remove any
 * other. No MLS call rides alongside this either -- same reconciliation
 * sweep that handles addMembers issues the Remove commit and rotates the
 * history key on its own cadence. The removed member's own client keeps its
 * local copy of the conversation and everything sent before this.
 */
export function removeMember(input: {
  conversationId: string;
  userId: string;
}): Promise<Conversation> {
  return request<Conversation>(
    `${API}/conversations/${input.conversationId}/members/${input.userId}`,
    { method: "DELETE" },
  );
}

/** Leaves a group -- self-removal, always allowed. */
export function leaveConversation(conversationId: string): Promise<void> {
  return request<void>(`${API}/conversations/${conversationId}/leave`, {
    method: "POST",
  });
}

/**
 * Mutes/unmutes this conversation for the caller. Idempotent either way.
 * Silences push only -- socket wakes and unread badges are unaffected, so a
 * refresh after this call is what picks up the new `muted` flag rather than
 * anything this call returns.
 */
export function muteConversation(conversationId: string): Promise<void> {
  return request<void>(`${API}/conversations/${conversationId}/mute`, {
    method: "POST",
  });
}

export function unmuteConversation(conversationId: string): Promise<void> {
  return request<void>(`${API}/conversations/${conversationId}/mute`, {
    method: "DELETE",
  });
}

/** Null clears the title back to the member-list default. */
export function renameConversation(input: {
  conversationId: string;
  title: string | null;
}): Promise<Conversation> {
  return request<Conversation>(`${API}/conversations/${input.conversationId}`, {
    method: "PATCH",
    body: { title: input.title },
  });
}

/** Notice-line history: who added or removed whom, and renames. */
export function fetchEvents(input: {
  conversationId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<EventsPage> {
  const params = new URLSearchParams();
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit) params.set("limit", String(input.limit));
  const query = params.toString();
  return request<EventsPage>(
    `${API}/conversations/${input.conversationId}/events${query ? `?${query}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Idempotent on `clientMessageId`. Reuse the same one on every retry of the
 * same composed message; generating a fresh one sends the message twice.
 */
export function sendMessage(input: {
  conversationId: string;
  clientMessageId: string;
  /** base64. */
  payload: string;
  /** The epoch the payload was sealed under (409 EPOCH_STALE otherwise). */
  epoch?: number;
  /** v3 pair: the history-key generation the archive payload was sealed
   * under (409 HISTORY_KEY_STALE otherwise), and ONE archive payload for the
   * whole message -- the per-recipient array died with protocol v2's sends. */
  archiveGeneration?: number;
  /** base64. */
  archivePayload?: string;
  /** Ask the server to skip push for this send (operation payloads). The
   * socket wake is never skipped; see docs/api.md for the disclosure. */
  silent?: boolean;
}): Promise<SendResult> {
  return request<SendResult>(
    `${API}/conversations/${input.conversationId}/messages`,
    {
      method: "POST",
      body: {
        clientMessageId: input.clientMessageId,
        payload: input.payload,
        ...(input.silent ? { silent: true } : {}),
        ...(input.epoch !== undefined &&
        input.archiveGeneration !== undefined &&
        input.archivePayload
          ? {
              epoch: input.epoch,
              archiveGeneration: input.archiveGeneration,
              archivePayload: input.archivePayload,
            }
          : {}),
      },
    },
  );
}

/** Metadata only. For gap-filling against local storage, never for content. */
export function listConversationMessages(input: {
  conversationId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<MessagesPage> {
  const params = new URLSearchParams();
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit) params.set("limit", String(input.limit));
  const query = params.toString();
  return request<MessagesPage>(
    `${API}/conversations/${input.conversationId}/messages${query ? `?${query}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Everything queued for *this device*, oldest first. */
export async function fetchInbox(
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<InboxEnvelope[]> {
  const query = options.limit ? `?limit=${options.limit}` : "";
  const page = await request<{ envelopes: InboxEnvelope[] }>(
    `${API}/inbox${query}`,
    options.signal ? { signal: options.signal } : {},
  );
  return page.envelopes;
}

/**
 * Removes envelopes from this device's inbox. Call only after the messages are
 * durably stored -- delivery is at-least-once and this is the only thing that
 * stops redelivery.
 */
export function ackEnvelopes(
  envelopeIds: string[],
  options: { signal?: AbortSignal } = {},
): Promise<{ acked: number }> {
  return request<{ acked: number }>(`${API}/inbox/ack`, {
    method: "POST",
    body: { envelopeIds },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * History for *this user*, newest first. A plain read: no ack, replayable,
 * and the only way to recover after local storage is lost.
 *
 * Walk it by passing `nextCursor` back as `cursor` and stopping when it is
 * null. Stopping on an empty page instead happens to work, but `nextCursor` is
 * the contract.
 */
export function fetchArchive(
  input: {
    cursor?: string | undefined;
    /** Ascending mode: entries after this message id, oldest first. The
     * forward gap-fill; mutually exclusive with cursor. */
    after?: string | undefined;
    /** Restrict to one conversation -- what bounds the generation walk. */
    conversationId?: string | undefined;
    limit?: number | undefined;
  } = {},
  options: { signal?: AbortSignal } = {},
): Promise<ArchivePage> {
  const params = new URLSearchParams();
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.after) params.set("after", input.after);
  if (input.conversationId) params.set("conversationId", input.conversationId);
  if (input.limit) params.set("limit", String(input.limit));
  const query = params.toString();
  return request<ArchivePage>(
    `${API}/archive${query ? `?${query}` : ""}`,
    options.signal ? { signal: options.signal } : {},
  );
}

// ---------------------------------------------------------------------------
// MLS delivery
// ---------------------------------------------------------------------------

/** Publish fresh key packages plus this device's MLS signature key. */
export function publishKeyPackages(input: {
  identityPublicKey: string;
  keyPackages: string[];
}): Promise<{ available: number }> {
  return request(`${API}/devices/key-packages`, {
    method: "POST",
    body: input,
  });
}

export function countKeyPackages(): Promise<{ available: number }> {
  return request(`${API}/devices/key-packages/count`);
}

/** One single-use key package per device, or null where none can be handed out. */
export function claimKeyPackages(
  deviceIds: string[],
): Promise<{ keyPackages: { deviceId: string; keyPackage: string | null }[] }> {
  return request(`${API}/key-packages/claim`, {
    method: "POST",
    body: { deviceIds },
  });
}

/** The roster authority: members × unrevoked devices, keys, current epoch. */
export function fetchRecipients(
  conversationId: string,
  options: { signal?: AbortSignal } = {},
): Promise<RecipientsResponse> {
  return request<RecipientsResponse>(
    `${API}/conversations/${conversationId}/recipients`,
    options.signal ? { signal: options.signal } : {},
  );
}

/**
 * The stored GroupInfo for an external join, or null when nobody has
 * published one. Compare its epoch against what `recipients` reports before
 * building a join on it -- a stale one can only lose the epoch race.
 */
export function fetchGroupInfo(
  conversationId: string,
): Promise<{ groupInfo: { epoch: number; payload: string } | null }> {
  return request(`${API}/conversations/${conversationId}/group-info`);
}

/**
 * Publish the current epoch's GroupInfo. Committers call this after every
 * accepted commit; `stored: false` means a newer epoch's copy was already
 * there, which is fine -- the point is that SOMEBODY current published.
 */
export function putGroupInfo(input: {
  conversationId: string;
  epoch: number;
  payload: string;
}): Promise<{ stored: boolean }> {
  return request(`${API}/conversations/${input.conversationId}/group-info`, {
    method: "PUT",
    body: { epoch: input.epoch, payload: input.payload },
  });
}

/** Post a commit and its welcomes. 409 EPOCH_CONFLICT means rebase and retry. */
export function postCommit(input: {
  conversationId: string;
  epoch: number;
  payload: string;
  welcomes: { deviceId: string; payload: string }[];
}): Promise<{ epoch: number }> {
  return request(`${API}/conversations/${input.conversationId}/commits`, {
    method: "POST",
    body: {
      epoch: input.epoch,
      payload: input.payload,
      welcomes: input.welcomes,
    },
  });
}

/**
 * Every wrapped history key addressed to this user, across all
 * conversations. Bulk, because nothing can be decrypted until the keys are
 * held; replayable, like the archive.
 */
export function fetchHistoryKeys(
  options: { signal?: AbortSignal } = {},
): Promise<{ keys: HistoryKeyEntry[] }> {
  return request<{ keys: HistoryKeyEntry[] }>(
    `${API}/history-keys`,
    options.signal ? { signal: options.signal } : {},
  );
}

/**
 * Post wrapped history keys for one generation. generation = current + 1 is
 * a rotation (must cover exactly the current members; 409
 * GENERATION_CONFLICT means somebody else's rotation won -- drop the minted
 * key and ingest theirs). generation <= current is a backfill (additive,
 * subset fine).
 */
export function postHistoryKeys(input: {
  conversationId: string;
  generation: number;
  keys: { userId: string; wrappedKey: string }[];
}): Promise<{ generation: number }> {
  return request(`${API}/conversations/${input.conversationId}/history-keys`, {
    method: "POST",
    body: { generation: input.generation, keys: input.keys },
  });
}

/** Commits after the given epoch, ascending. Replayable. */
export function fetchCommits(
  input: { conversationId: string; afterEpoch: number; limit?: number },
  options: { signal?: AbortSignal } = {},
): Promise<{ commits: CommitEntry[] }> {
  const params = new URLSearchParams({ afterEpoch: String(input.afterEpoch) });
  if (input.limit) params.set("limit", String(input.limit));
  return request(
    `${API}/conversations/${input.conversationId}/commits?${params}`,
    options.signal ? { signal: options.signal } : {},
  );
}

/** The per-device welcome drain. Fetch, join durably, then ack. */
export function fetchWelcomes(
  options: { signal?: AbortSignal } = {},
): Promise<{ welcomes: WelcomeEntry[] }> {
  return request(
    `${API}/mls/welcomes`,
    options.signal ? { signal: options.signal } : {},
  );
}

export function ackWelcomes(welcomeIds: string[]): Promise<{ acked: number }> {
  return request(`${API}/mls/welcomes/ack`, {
    method: "POST",
    body: { welcomeIds },
  });
}

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

/**
 * The application server's public key, which a browser subscribes against.
 *
 * 503 with `PUSH_DISABLED` is a real answer rather than an outage: a server
 * can be deployed before its VAPID keys are installed, and the difference
 * between "not configured here" and "you declined" is something the UI has to
 * be able to say.
 */
export function fetchPushKey(): Promise<{ publicKey: string }> {
  return request<{ publicKey: string }>(`${API}/push/key`);
}

/** Registers this browser's subscription against the current device. */
export function subscribeToPush(subscription: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<void> {
  return request<void>(`${API}/push/subscribe`, {
    method: "POST",
    body: subscription,
  });
}

/** Forgets this browser's subscription. */
export function unsubscribeFromPush(endpoint: string): Promise<void> {
  return request<void>(`${API}/push/unsubscribe`, {
    method: "POST",
    body: { endpoint },
  });
}

/**
 * Moves this user's read marker in a conversation.
 *
 * The server only ever moves it forward, so calling this with an older message
 * than the marker already holds is harmless -- which is what makes it safe to
 * fire whenever a conversation is on screen rather than tracking whether it
 * would be a no-op.
 */
export function markConversationRead(
  conversationId: string,
  messageId: string,
): Promise<void> {
  return request<void>(`${API}/conversations/${conversationId}/read`, {
    method: "POST",
    body: { messageId },
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export type UploadedAttachment = {
  id: string;
  byteSize: number;
  expiresAt: string;
};

export type AttachmentUsage = {
  usedBytes: number;
  quotaBytes: number;
  maxBytes: number;
  retentionDays: number;
  /**
   * Which file types this account may attach.
   *
   * Optional because an older server does not send it, and the client must
   * keep working against one -- `ui/file-policy.ts` supplies the fallback.
   * Advisory in any case: the server cannot see an attachment's type, so it
   * is a rail for the sender, never enforcement.
   */
  files?: { mode: "block" | "allow"; extensions: string[] };
};

/**
 * Uploads bytes and returns the id to put in a message payload.
 *
 * Raw octet-stream rather than JSON: base64 costs a third more on the wire and
 * pushes a whole photo through a string, for no benefit when the payload is
 * opaque either way. Written against fetch directly because `request` assumes
 * a JSON body and a JSON response.
 */
export async function uploadAttachment(
  conversationId: string,
  bytes: Uint8Array,
  options: { signal?: AbortSignal } = {},
): Promise<UploadedAttachment> {
  const token = currentToken();
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  };
  if (token) headers["authorization"] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(
      `${API}/attachments?conversationId=${encodeURIComponent(conversationId)}`,
      {
        method: "POST",
        headers,
        // Copied, because a Uint8Array that is a view onto a larger buffer
        // would otherwise upload the whole buffer.
        body: new Blob([bytes.slice()]),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new NetworkError(cause);
  }

  const raw = await response.text();
  const parsed: unknown = raw.length > 0 ? safeParse(raw) : null;

  if (!response.ok) {
    const shape = parsed as { error?: string; message?: string } | null;
    throw new ApiError(
      response.status,
      shape?.error ?? "REQUEST_FAILED",
      shape?.message ?? `Upload failed with ${response.status}`,
      null,
    );
  }

  return parsed as UploadedAttachment;
}

/** Whether an attachment is still on the server, and its bytes if so. */
export type AttachmentFetch =
  | { state: "ok"; bytes: Uint8Array }
  /**
   * 410. It existed, this account was entitled to it, and retention removed
   * it. Terminal, and worth recording so it is never asked for again.
   */
  | { state: "expired" }
  /** 404. No such attachment, or not in that conversation. Also terminal. */
  | { state: "unknown" };

export async function downloadAttachment(
  attachmentId: string,
  options: { signal?: AbortSignal } = {},
): Promise<AttachmentFetch> {
  const token = currentToken();
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API}/attachments/${attachmentId}`, {
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new NetworkError(cause);
  }

  if (response.status === 410) return { state: "expired" };
  if (response.status === 404) return { state: "unknown" };

  if (!response.ok) {
    // A 401 or a 502 is worth trying again later, so it throws rather than
    // being recorded as a state that stops anyone ever asking again.
    throw new ApiError(
      response.status,
      "REQUEST_FAILED",
      `Download failed with ${response.status}`,
      null,
    );
  }

  return { state: "ok", bytes: new Uint8Array(await response.arrayBuffer()) };
}

export function fetchAttachmentUsage(): Promise<AttachmentUsage> {
  return request<AttachmentUsage>(`${API}/attachments/usage`);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Account settings
// ---------------------------------------------------------------------------

export type AccountSettings = {
  displayName: string;
  avatarHue: number | null;
  readReceiptsEnabled: boolean;
  email: string | null;
  emailVerified: boolean;
  /**
   * Server-side feature flags (server/src/services/flags.ts), fetched fresh
   * every time Settings opens rather than cached -- toggling one takes
   * effect on the next open, no reload or rebuild needed.
   */
  features: {
    tipJar: boolean;
    announcements: boolean;
    hubs: boolean;
    /** The voice flag. Advisory: whether the server CAN do voice at all is
     *  /health's `voice`; the controls show only when both say yes. */
    voice: boolean;
    /**
     * The call audio quality picker (Settings → Voice). Seeded off for
     * everyone by migration 0021 and switched on per account: the first
     * plan-gated control, ahead of any plan. Advisory like the rest -- it
     * hides a picker, and nothing server-side caps an audio bitrate.
     */
    voiceQuality: boolean;
    /**
     * The composer's GIF widget. Already ANDed by the server with whether
     * this deploy has a GIPHY_API_KEY at all, so it is one answer rather
     * than the two `voice` needs -- true here means the widget will work.
     */
    gifs: boolean;
  };
};

export type AccountDevice = {
  id: string;
  displayName: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  current: boolean;
};

export function fetchAccountSettings(): Promise<AccountSettings> {
  return request<AccountSettings>(`${API}/account/settings`);
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

/**
 * Operator-published release notes and news -- server-readable plaintext by
 * design (operator content, not user content; see docs/roadmap.md). While
 * the `announcements` feature flag is off the server answers an empty page,
 * so a caller needs no flag check of its own: dark looks exactly like
 * "nothing published yet".
 */
export type Announcement = {
  id: string;
  kind: "release" | "news";
  title: string;
  /** Markdown; rendered client-side. */
  body: string;
  version: string | null;
  publishedAt: string;
};

export function fetchAnnouncements(options?: {
  cursor?: string;
  limit?: number;
}): Promise<{ announcements: Announcement[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options?.cursor) params.set("cursor", options.cursor);
  if (options?.limit) params.set("limit", String(options.limit));
  const query = params.size > 0 ? `?${params}` : "";
  return request(`${API}/announcements${query}`);
}

export function changeAvatarColor(
  hue: number | null,
): Promise<{ avatarHue: number | null }> {
  // `body` is the value, not the serialised body -- `request` above does the
  // JSON.stringify. Passing a string here double-encoded it, so the server
  // parsed a JSON *string* where the schema wanted an object and answered
  // "body must be object", which reads like a schema bug and is not one.
  return request(`${API}/account/avatar-color`, {
    method: "POST",
    body: { hue },
  });
}

export function changeDisplayName(
  displayName: string,
): Promise<{ displayName: string }> {
  return request(`${API}/account/display-name`, {
    method: "POST",
    body: { displayName },
  });
}

/** Resolves with how many other sessions were signed out. */
export function changePassword(
  currentPassword: string,
  newPassword: string,
  /** The account key re-wrapped under the new password, when the client holds one. */
  passwordWrap?: PasswordWrapWire,
): Promise<{ otherSessionsRevoked: number }> {
  return request(`${API}/account/password`, {
    method: "POST",
    body: {
      currentPassword,
      newPassword,
      ...(passwordWrap ? { passwordWrap } : {}),
    },
  });
}

/**
 * The login-time read of the wrapped account keypair.
 *
 * 404 (KEYS_NOT_FOUND) is expected for accounts registered before v2 --
 * callers treat it as "this account predates encryption", not a failure.
 */
export function fetchAccountKeys(): Promise<AccountKeysResponse> {
  return request<AccountKeysResponse>(`${API}/account/keys`);
}

/**
 * Full replacement: the re-wrap after a password reset, and the
 * "start fresh" rotation. Requires the password even with a live session.
 */
export function putAccountKeys(
  password: string,
  keys: AccountKeysWire,
): Promise<void> {
  return request<void>(`${API}/account/keys`, {
    method: "PUT",
    body: { password, keys },
  });
}

export function fetchDevices(): Promise<{ devices: AccountDevice[] }> {
  return request(`${API}/account/devices`);
}

export function revokeDevice(deviceId: string): Promise<void> {
  return request<void>(`${API}/account/devices/${deviceId}/revoke`, {
    method: "POST",
    body: {},
  });
}

export function setReadReceipts(enabled: boolean): Promise<void> {
  return request<void>(`${API}/account/read-receipts`, {
    method: "POST",
    body: { enabled },
  });
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export type Friend = {
  userId: string;
  username: string;
  displayName: string;
  avatarHue: number | null;
  since: string | null;
};

export type FriendRequest = Friend & { requestedAt: string };

export type FriendLists = {
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  blocked: Friend[];
};

export function fetchFriends(): Promise<FriendLists> {
  return request<FriendLists>(`${API}/friends`);
}

/** `mutual` is true when this met a request coming the other way. */
export function requestFriend(
  userId: string,
): Promise<{ status: string; mutual: boolean }> {
  return request(`${API}/friends/request`, { method: "POST", body: { userId } });
}

export function acceptFriend(userId: string): Promise<void> {
  return request<void>(`${API}/friends/accept`, { method: "POST", body: { userId } });
}

/** Declines a request or removes a contact -- the same operation either way. */
export function removeFriend(userId: string): Promise<void> {
  return request<void>(`${API}/friends/remove`, { method: "POST", body: { userId } });
}

export function blockUser(userId: string): Promise<void> {
  return request<void>(`${API}/friends/block`, { method: "POST", body: { userId } });
}

export function unblockUser(userId: string): Promise<void> {
  return request<void>(`${API}/friends/unblock`, { method: "POST", body: { userId } });
}

// ---------------------------------------------------------------------------
// Hubs
// ---------------------------------------------------------------------------
//
// All flag-gated server-side (`hubs`, dark by default): the list answers
// empty and everything else answers 404 while the flag is off, so none of
// these need a capability check of their own -- but the UI entry points are
// gated on AccountSettings.features.hubs so a person is never shown a door
// that 404s.

export async function fetchHubs(): Promise<HubSummary[]> {
  const page = await request<{ hubs: HubSummary[] }>(`${API}/hubs`);
  return page.hubs;
}

export function createHub(input: {
  name: string;
  /** Immutable after creation; 'public' means server-readable content. */
  visibility: HubVisibility;
}): Promise<HubDetail> {
  return request<HubDetail>(`${API}/hubs`, { method: "POST", body: input });
}

export function fetchHub(hubId: string): Promise<HubDetail> {
  return request<HubDetail>(`${API}/hubs/${hubId}`);
}

export function renameHub(input: {
  hubId: string;
  name: string;
}): Promise<HubDetail> {
  return request<HubDetail>(`${API}/hubs/${input.hubId}`, {
    method: "PATCH",
    body: { name: input.name },
  });
}

/** Owner only. Soft-deletes the hub and every channel in it. */
export function deleteHub(hubId: string): Promise<void> {
  return request<void>(`${API}/hubs/${hubId}`, { method: "DELETE" });
}

export function createHubChannel(input: {
  hubId: string;
  name: string;
  /** Absent means text -- what every client before voice sent. */
  kind?: ChannelKind;
}): Promise<HubChannel> {
  return request<HubChannel>(`${API}/hubs/${input.hubId}/channels`, {
    method: "POST",
    body: { name: input.name, ...(input.kind ? { kind: input.kind } : {}) },
  });
}

/**
 * One PATCH for everything a moderator sets on a channel; send only the
 * field being changed. An empty topic clears it; a null slowmodeSeconds
 * turns slowmode off (public hubs only -- elsewhere it answers NOT_PUBLIC).
 */
export function updateHubChannel(input: {
  hubId: string;
  conversationId: string;
  name?: string;
  topic?: string;
  posting?: ChannelPosting;
  slowmodeSeconds?: number | null;
  /** Voice channels only, both hub classes. Null turns auto-mute off. */
  joinMutedAbove?: number | null;
}): Promise<HubChannel> {
  const { hubId, conversationId, ...body } = input;
  return request<HubChannel>(
    `${API}/hubs/${hubId}/channels/${conversationId}`,
    { method: "PATCH", body },
  );
}

/**
 * Moderator+ add, both classes. For a private hub the MLS Adds and the
 * history backfill follow on the members' sweeps, exactly as for a group.
 */
export function addHubMembers(input: {
  hubId: string;
  memberUserIds: string[];
  shareHistory?: boolean;
}): Promise<HubDetail> {
  return request<HubDetail>(`${API}/hubs/${input.hubId}/members`, {
    method: "POST",
    body: {
      memberUserIds: input.memberUserIds,
      shareHistory: input.shareHistory ?? false,
    },
  });
}

/** Self-serve, public hubs only; a private hub answers the same 404 a wrong
 * id does. Idempotent. */
export function joinHub(hubId: string): Promise<HubDetail> {
  return request<HubDetail>(`${API}/hubs/${hubId}/join`, {
    method: "POST",
    body: {},
  });
}

/** Self-removal. The owner cannot leave -- transfer ownership or delete. */
export function leaveHub(hubId: string): Promise<void> {
  return request<void>(`${API}/hubs/${hubId}/leave`, {
    method: "POST",
    body: {},
  });
}

export function kickHubMember(input: {
  hubId: string;
  userId: string;
  /** Also ban: they cannot self-serve rejoin a public hub afterward. */
  ban?: boolean;
}): Promise<HubDetail> {
  return request<HubDetail>(
    `${API}/hubs/${input.hubId}/members/${input.userId}${input.ban ? "?ban=true" : ""}`,
    { method: "DELETE" },
  );
}

/** Owner only. Setting 'owner' transfers ownership (actor becomes moderator). */
export function setHubRole(input: {
  hubId: string;
  userId: string;
  role: "owner" | "moderator" | "member";
}): Promise<HubDetail> {
  return request<HubDetail>(
    `${API}/hubs/${input.hubId}/members/${input.userId}`,
    { method: "PATCH", body: { role: input.role } },
  );
}

export function fetchHubEvents(input: {
  hubId: string;
  cursor?: string;
  limit?: number;
}): Promise<HubEventsPage> {
  const params = new URLSearchParams();
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit) params.set("limit", String(input.limit));
  const query = params.size > 0 ? `?${params}` : "";
  return request<HubEventsPage>(`${API}/hubs/${input.hubId}/events${query}`);
}

/**
 * Full-text search over a public hub's channels -- the server-side feature
 * the public class exists for. A private hub answers an empty page.
 */
export function searchHub(input: {
  hubId: string;
  query: string;
  cursor?: string;
  limit?: number;
}): Promise<HubSearchPage> {
  const params = new URLSearchParams({ q: input.query });
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit) params.set("limit", String(input.limit));
  return request<HubSearchPage>(`${API}/hubs/${input.hubId}/search?${params}`);
}

/**
 * Moderator soft-delete in a public channel. The server writes a
 * message_deleted hub event alongside it, which every member's sync engine
 * turns into a local tombstone -- deletion propagates now.
 */
export function deleteHubMessage(input: {
  hubId: string;
  conversationId: string;
  messageId: string;
}): Promise<void> {
  return request<void>(
    `${API}/hubs/${input.hubId}/channels/${input.conversationId}/messages/${input.messageId}`,
    { method: "DELETE" },
  );
}

/** Moderator+. Clears the ban WITHOUT re-membering -- they may rejoin or be
 * re-added, but are not put back in the room by this call. */
export function unbanHubMember(input: {
  hubId: string;
  userId: string;
}): Promise<HubDetail> {
  return request<HubDetail>(
    `${API}/hubs/${input.hubId}/bans/${input.userId}`,
    { method: "DELETE" },
  );
}

export function createHubInvite(input: {
  hubId: string;
  /** Omit for a link that never expires. */
  expiresInSeconds?: number;
  /** Omit for unlimited uses. */
  maxUses?: number;
}): Promise<HubInvite> {
  const { hubId, ...body } = input;
  return request<HubInvite>(`${API}/hubs/${hubId}/invites`, {
    method: "POST",
    body,
  });
}

export async function fetchHubInvites(hubId: string): Promise<HubInvite[]> {
  const page = await request<{ invites: HubInvite[] }>(
    `${API}/hubs/${hubId}/invites`,
  );
  return page.invites;
}

export function revokeHubInvite(input: {
  hubId: string;
  inviteId: string;
}): Promise<void> {
  return request<void>(
    `${API}/hubs/${input.hubId}/invites/${input.inviteId}`,
    { method: "DELETE" },
  );
}

/** POSTed, not GET, so the token stays out of logs and history. Any dead
 * token -- wrong, expired, revoked, exhausted -- answers the same 404. */
export function previewHubInvite(token: string): Promise<HubInvitePreview> {
  return request<HubInvitePreview>(`${API}/hubs/invite-preview`, {
    method: "POST",
    body: { token },
  });
}

/** Join by invite, both classes. No history is shared on an invite join. */
export function redeemHubInvite(token: string): Promise<HubDetail> {
  return request<HubDetail>(`${API}/hubs/join-invite`, {
    method: "POST",
    body: { token },
  });
}

/** Moderator+. Both classes -- a pin is a reference, never a copy. */
export function pinHubMessage(input: {
  hubId: string;
  conversationId: string;
  messageId: string;
}): Promise<void> {
  return request<void>(
    `${API}/hubs/${input.hubId}/channels/${input.conversationId}/pins/${input.messageId}`,
    { method: "POST", body: {} },
  );
}

export function unpinHubMessage(input: {
  hubId: string;
  conversationId: string;
  messageId: string;
}): Promise<void> {
  return request<void>(
    `${API}/hubs/${input.hubId}/channels/${input.conversationId}/pins/${input.messageId}`,
    { method: "DELETE" },
  );
}

export async function fetchHubPins(input: {
  hubId: string;
  conversationId: string;
}): Promise<HubPin[]> {
  const page = await request<{ pins: HubPin[] }>(
    `${API}/hubs/${input.hubId}/channels/${input.conversationId}/pins`,
  );
  return page.pins;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Sets or changes the address, and triggers a verification email.
 *
 * 204 even when somebody else already uses that address -- the server mails
 * *them* instead of telling this caller, so that this endpoint cannot be used
 * to discover whether an address is registered. A client cannot distinguish
 * the two cases and should not try to.
 */
export function setEmail(email: string): Promise<void> {
  return request<void>(`${API}/account/email`, { method: "POST", body: { email } });
}

export function resendVerification(): Promise<void> {
  return request<void>(`${API}/account/email/resend`, { method: "POST", body: {} });
}

export function verifyEmail(token: string): Promise<{ email: string }> {
  return request(`${API}/auth/verify-email`, { method: "POST", body: { token } });
}

/** Always resolves, whether or not that address has an account. */
export function requestPasswordReset(email: string): Promise<void> {
  return request<void>(`${API}/auth/password-reset`, {
    method: "POST",
    body: { email },
  });
}

export function confirmPasswordReset(
  token: string,
  newPassword: string,
): Promise<void> {
  return request<void>(`${API}/auth/password-reset/confirm`, {
    method: "POST",
    body: { token, newPassword },
  });
}

// ---------------------------------------------------------------------------
// Voice (docs/prompts/voice-plan.md §5.6)
// ---------------------------------------------------------------------------
//
// Every call here is the app server's side of a call: minting a token,
// recording an answer, a decline, a leave. The media and the signalling go
// to the SFU directly (voice/session.ts) -- nothing about a call in
// progress needs these endpoints, which is what lets a call survive a
// server deploy.

/** Starts a call in a direct/group conversation, or joins the open one. */
export function startCall(conversationId: string): Promise<JoinResult> {
  return request<JoinResult>(`${API}/conversations/${conversationId}/call`, {
    method: "POST",
  });
}

export function answerCall(callId: string): Promise<JoinResult> {
  return request<JoinResult>(`${API}/calls/${callId}/answer`, { method: "POST" });
}

export function declineCall(callId: string): Promise<void> {
  return request<void>(`${API}/calls/${callId}/decline`, { method: "POST" });
}

/** Leaving is also the starter's cancel while it still rings. */
export function leaveCall(callId: string): Promise<void> {
  return request<void>(`${API}/calls/${callId}/leave`, { method: "POST" });
}

export function fetchCall(callId: string): Promise<{ call: Call }> {
  return request<{ call: Call }>(`${API}/calls/${callId}`);
}

/** The self-heal read: everything voice-shaped about this account now. */
export function fetchVoiceActive(): Promise<VoiceActive> {
  return request<VoiceActive>(`${API}/voice/active`);
}

export function joinVoiceRoom(conversationId: string): Promise<JoinResult> {
  return request<JoinResult>(`${API}/conversations/${conversationId}/voice/join`, {
    method: "POST",
  });
}

export function leaveVoiceRoom(conversationId: string): Promise<void> {
  return request<void>(`${API}/conversations/${conversationId}/voice/leave`, {
    method: "POST",
  });
}

/** Moderator+ in the hub, seniority enforced server-side. */
export function moderateVoice(input: {
  hubId: string;
  conversationId: string;
  userId: string;
  action: "mute" | "disconnect";
}): Promise<void> {
  const base = `${API}/hubs/${input.hubId}/voice/${input.conversationId}`;
  return input.action === "mute"
    ? request<void>(`${base}/mute/${input.userId}`, { method: "POST" })
    : request<void>(`${base}/participants/${input.userId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// GIFs
// ---------------------------------------------------------------------------

/**
 * One size of one GIF. `url` points at the library's own CDN and is fetched
 * by this device directly -- see the note on searchGifs.
 */
export type GifRendition = {
  url: string;
  width: number;
  height: number;
  byteSize: number;
};

export type Gif = {
  id: string;
  title: string;
  /** Small, for the picker grid. */
  preview: GifRendition;
  /** Downloaded, sealed and uploaded as an attachment when picked. */
  full: GifRendition;
};

/**
 * Searches the GIF library through our own server.
 *
 * The search text goes to our server and on to the library from there; the
 * API key never reaches this device. The thumbnails in the results, though,
 * are fetched from the library's CDN by this browser, so opening the picker
 * does show that CDN this device's address. That is disclosed in
 * docs/data-inventory.md and is the reason the picker is a deliberate tap
 * rather than something the composer opens on its own.
 *
 * None of that reaches the people a GIF is sent TO: a picked GIF is
 * downloaded once, here, and sent as an ordinary sealed attachment.
 */
export function searchGifs(query: string, signal?: AbortSignal): Promise<{ results: Gif[] }> {
  const path = `${API}/gifs/search?q=${encodeURIComponent(query)}`;
  return request<{ results: Gif[] }>(path, signal ? { signal } : {});
}

export function fetchTrendingGifs(signal?: AbortSignal): Promise<{ results: Gif[] }> {
  return request<{ results: Gif[] }>(`${API}/gifs/trending`, signal ? { signal } : {});
}
