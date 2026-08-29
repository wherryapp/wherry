// The HTTP surface, one function per endpoint in docs/api.md.
//
// Every URL is a relative path under /api. There is no host, no port and no
// environment variable, because the app is always same-origin with the API:
// Vite proxies /api to :3000 in development, and in production Caddy serves the
// built assets and reverse-proxies /api on the same hostname. Same origin both
// times means CORS does not exist in this system, and there is no base URL that
// can be wrong in a build.
//
// The prefix is what lets one Caddy rule separate the API from the client's
// static files. See server.ts, where it is applied.

import { currentToken } from "./session";
import type {
  ApiErrorCode,
  ArchivePage,
  AuthResult,
  Conversation,
  DeviceDescriptor,
  InboxEnvelope,
  MessagesPage,
  PublicDevice,
  PublicUser,
  SendResult,
} from "./types";

/**
 * Every request goes under here.
 *
 * One constant rather than the prefix being written into each path below, so
 * moving it is a one-line change on both sides -- this and API_PREFIX in the
 * server's server.ts.
 */
const API = "/api";

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
  method?: "GET" | "POST";
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

export function me(): Promise<{
  user: PublicUser;
  device: PublicDevice;
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
}): Promise<SendResult> {
  return request<SendResult>(
    `${API}/conversations/${input.conversationId}/messages`,
    {
      method: "POST",
      body: {
        clientMessageId: input.clientMessageId,
        payload: input.payload,
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
  input: { cursor?: string | undefined; limit?: number | undefined } = {},
  options: { signal?: AbortSignal } = {},
): Promise<ArchivePage> {
  const params = new URLSearchParams();
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit) params.set("limit", String(input.limit));
  const query = params.toString();
  return request<ArchivePage>(
    `${API}/archive${query ? `?${query}` : ""}`,
    options.signal ? { signal: options.signal } : {},
  );
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
