// The realtime socket: a wake-up line, not a transport.
//
// The only thing the server ever says down this socket is "you may have
// something", and the only thing this module does about it is call `notify`
// -- which the engine wires to `poke()`, scheduling the same full sync pass
// a poll timer would have. No payload ever rides the socket, no ordering
// depends on it, and losing it silently degrades to the poll loop at its
// short cadence. Every delivery guarantee lives where it always did, in the
// fetch -> store -> ack drain.
//
// Auth is the first frame, not a header: a browser cannot set Authorization
// on `new WebSocket()`, and the token must not ride in the URL (the server
// logs request URLs). The server answers `ready`, or closes with 4401/4403
// (dead token / unverified email -- terminal, stop reconnecting; the HTTP
// poll's 401 handling owns signing out) or 4408 (we dawdled).
//
// Liveness is JSON ping/pong because browser JS cannot observe protocol-level
// pings. The server pings every 30s; if nothing at all arrives for STALE_MS
// the socket is presumed half-open -- a network change TCP has not noticed --
// and closed, which routes into the ordinary reconnect path. This check is
// the only thing standing between "healthy-looking socket, 30-second poll,
// nothing arriving" and actual delivery.
//
// Everything is constructor-injected (socket factory, token source, clock
// intervals) so the whole state machine runs under node:test with no browser
// and no server.

import { Backoff } from "./backoff.js";

/** Matches the server's sweep: 2 missed 30s pings plus grace. */
export const STALE_MS = 75_000;
const STALE_CHECK_MS = 15_000;

const WIRE_VERSION = 1;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_EMAIL_NOT_VERIFIED = 4403;

/** The slice of a WebSocket this module uses; tests fake it. The event is
 *  structural rather than MessageEvent/CloseEvent so the fakes need no DOM. */
export type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close",
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void;
};

export type SocketManagerOptions = {
  /** Defaults to `new WebSocket(...)` against the page's own origin. */
  createSocket?: (url: string) => SocketLike;
  url?: string;
  getToken: () => string | null;
  /** "Run a sync pass." The engine passes poke; never anything heavier. */
  notify: () => void;
  /**
   * Any frame beyond the core ready/wake/ping vocabulary -- delivered ticks,
   * and whatever the versioned protocol adds next. The socket stays dumb:
   * it hands the parsed object over and the engine decides what it means.
   * Best-effort by contract; nothing here retries or queues.
   */
  onFrame?: (frame: { type: string } & Record<string, unknown>) => void;
  backoff?: Backoff;
  staleMs?: number;
  staleCheckMs?: number;
};

function defaultUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/ws`;
}

export class SocketManager {
  readonly #options: SocketManagerOptions;
  readonly #backoff: Backoff;
  readonly #staleMs: number;

  #socket: SocketLike | null = null;
  #healthy = false;
  #stopped = false;
  #lastSeenAt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SocketManagerOptions) {
    this.#options = options;
    this.#backoff = options.backoff ?? new Backoff();
    this.#staleMs = options.staleMs ?? STALE_MS;
  }

  /** True while a socket is open and past the auth handshake. The engine
   *  reads this to pick its poll cadence, every tick, so it must be cheap. */
  isHealthy(): boolean {
    return this.#healthy;
  }

  /**
   * Sends an ephemeral frame -- typing, a presence ask -- when the socket is
   * healthy, and reports whether it was. False means the frame is gone, and
   * that is the contract: everything sent this way must mean nothing when
   * absent. Nothing here queues, retries, or waits for a reconnect.
   */
  send(frame: string): boolean {
    if (!this.#healthy || this.#socket === null) return false;
    try {
      this.#socket.send(frame);
      return true;
    } catch {
      // A socket dying between the health check and the send. The close
      // handler owns the state transition; the frame is simply lost.
      return false;
    }
  }

  start(): void {
    if (this.#stopped) return;
    this.#connect();
    this.#staleTimer = setInterval(() => {
      if (
        this.#healthy &&
        this.#socket &&
        Date.now() - this.#lastSeenAt > this.#staleMs
      ) {
        // Half-open: looks connected, hears nothing. Close and let the
        // ordinary close handling reconnect; the unhealthy transition also
        // notifies, so the poll snaps back to its short cadence at once.
        this.#socket.close();
      }
    }, this.#options.staleCheckMs ?? STALE_CHECK_MS);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    if (this.#staleTimer !== null) clearInterval(this.#staleTimer);
    this.#reconnectTimer = null;
    this.#staleTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    this.#healthy = false;
    try {
      socket?.close();
    } catch {
      // A socket already dead throws on close in some implementations, and
      // stopping must always succeed.
    }
  }

  #connect(): void {
    if (this.#stopped) return;

    const token = this.#options.getToken();
    if (token === null) {
      // Not signed in. The engine does not run a loop without a session, so
      // this is a race at best; give up quietly rather than retry into 4401.
      return;
    }

    let socket: SocketLike;
    try {
      socket = (this.#options.createSocket ?? ((url) => new WebSocket(url)))(
        this.#options.url ?? defaultUrl(),
      );
    } catch {
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;
    this.#lastSeenAt = Date.now();

    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return; // superseded meanwhile
      socket.send(JSON.stringify({ v: WIRE_VERSION, type: "auth", token }));
    });

    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      this.#lastSeenAt = Date.now();

      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return; // not this protocol; the server never sends such a thing
      }
      const type =
        typeof frame === "object" && frame !== null
          ? (frame as { type?: unknown }).type
          : undefined;

      switch (type) {
        case "ready":
          this.#healthy = true;
          this.#backoff.reset();
          // The reconnect drain: anything sent while this socket was down
          // (a deploy restart, a dead wifi) is sitting in the inbox, and
          // this one call is what fetches it without waiting for a poll.
          this.#options.notify();
          break;
        case "wake":
          this.#options.notify();
          break;
        case "ping":
          socket.send(JSON.stringify({ type: "pong" }));
          break;
        default:
          // Not part of the core vocabulary. Hand it to the engine if it
          // wants such frames; otherwise ignoring it is the forward
          // compatibility story, same as the server's post-auth stance.
          if (typeof type === "string") {
            this.#options.onFrame?.(
              frame as { type: string } & Record<string, unknown>,
            );
          }
          break;
      }
    });

    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;

      const wasHealthy = this.#healthy;
      this.#healthy = false;

      if (
        event.code === CLOSE_UNAUTHORIZED ||
        event.code === CLOSE_EMAIL_NOT_VERIFIED
      ) {
        // Terminal. Reconnecting would loop forever on the same answer.
        // Deciding what a dead session *means* stays with the HTTP path:
        // its 401 stops the engine and signs the user out; the socket only
        // steps aside.
        this.stop();
        return;
      }

      if (wasHealthy) {
        // The engine may be parked in a 30s socket-cadence wait that is no
        // longer justified. One notify snaps it back to polling now.
        this.#options.notify();
      }

      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== null) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, this.#backoff.next());
  }
}
