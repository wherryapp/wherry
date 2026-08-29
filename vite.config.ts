import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API routes the server owns. Listed explicitly rather than matched by a
// prefix like /api, because the server has no such prefix -- its routes sit at
// the root, and inventing one here would mean the client's URLs did not match
// the ones in docs/api.md.
//
// Adding a server route means adding it here. That is a real cost, and the
// alternative -- proxying everything that is not a Vite asset -- fails in a
// worse way, by swallowing typos in client-side routes into 404s from Fastify.
const API_ROUTES = [
  "/auth",
  "/users",
  "/conversations",
  "/inbox",
  "/archive",
  "/health",
];

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    // Why a proxy rather than CORS on the server.
    //
    // Vite serves the app on :5173 and Fastify listens on :3000, so a direct
    // fetch is cross-origin and would need @fastify/cors, a preflight on every
    // non-simple request, and an allowed-origin list that differs between dev
    // and production.
    //
    // Proxying instead means the browser only ever talks to :5173. Same
    // origin, no preflight, no CORS configuration anywhere in the system --
    // and in production Caddy serves the built assets and reverse-proxies
    // these same paths on chat.cjtechsystems.com, so it is same-origin there
    // too. CORS is a thing this project never has to have an opinion about.
    //
    // The payoff for the client code is that every request URL is a relative
    // path. There is no base-URL constant, and no environment variable that
    // can be wrong in a build.
    proxy: Object.fromEntries(
      API_ROUTES.map((route) => [
        route,
        {
          target: "http://localhost:3000",
          changeOrigin: true,
        },
      ]),
    ),
  },
});
