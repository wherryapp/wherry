// Where the server lives.
//
// The web client never needs this file to say anything interesting: the same
// host serves the assets and /api (Caddy in production, Vite's proxy in dev),
// so every URL is a relative path and CORS never exists -- see client.ts's
// header comment. When VITE_API_BASE is unset, everything below collapses to
// exactly that behaviour.
//
// The desktop build breaks the assumption on purpose. Tauri serves the
// bundled assets from its own origin (tauri://localhost), so the API must be
// named absolutely: `pnpm build:desktop` bakes VITE_API_BASE in at build
// time, and the server allowlists the Tauri origins for CORS (Bearer auth,
// no cookies, so no credentialed CORS). Anything that constructs a URL from
// the page's own location instead of this file is a desktop bug waiting.
//
// `?.` on import.meta.env because tsx-run tests have no Vite: any module a
// test can transitively import must survive `env` being undefined.

/** "/api", or an absolute "https://host/api" in the desktop build. */
export const API_BASE: string = import.meta.env?.VITE_API_BASE ?? "/api";

const absolute = API_BASE.startsWith("http");

/** The origin serving the API -- "" when same-origin, so it prefixes away. */
export const API_ORIGIN: string = absolute ? new URL(API_BASE).origin : "";

/** `/health` sits outside the API prefix (its own Caddy handle block). */
export const HEALTH_URL: string = `${API_ORIGIN}/health`;

/**
 * The realtime socket. Same-origin builds derive it from the page address,
 * as socket.ts always did; absolute builds swap http(s) for ws(s) on the
 * API origin. A function, not a constant: `location` must not be touched at
 * module scope or importing this under node:test throws.
 */
export function socketUrl(): string {
  if (absolute) {
    return `${API_ORIGIN.replace(/^http/, "ws")}${new URL(API_BASE).pathname}/ws`;
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${API_BASE}/ws`;
}

/**
 * Where share links point. Hub invite links handed to other people must name
 * the web host -- a tauri://localhost link is useless to anyone it is sent
 * to -- so the desktop build uses the API's origin, which is the same host.
 */
export function webOrigin(): string {
  return absolute ? API_ORIGIN : location.origin;
}
