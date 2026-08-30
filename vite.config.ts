import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    // One rule, because the whole API lives under /api.
    //
    // It used to be a list of every route prefix the server owns, which had to
    // be kept in step with the Caddyfile doing the same job in production --
    // and a route missing from either 404s there while working here. The
    // server moved its routes under a prefix precisely so this could be a
    // single line that never needs touching again. See server.ts.
    //
    // Why a proxy rather than CORS on the server: Vite serves the app on :5173
    // and Fastify listens on :3000, so a direct fetch would be cross-origin and
    // would need @fastify/cors, a preflight on every non-simple request, and an
    // allowed-origin list that differs between dev and production. Proxying
    // means the browser only ever talks to :5173, and in production Caddy
    // serves the built assets and reverse-proxies /api on one hostname. Same
    // origin both times, so CORS never exists in this system.
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        // Proxy WebSocket upgrades too, for the realtime channel at /api/ws.
        ws: true,
      },
    },
  },
});
