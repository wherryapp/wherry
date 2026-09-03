import { execSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The build's own version, for the version floor (api/version-floor.ts).
//
// The web pipeline stamps VITE_APP_VERSION explicitly (client/Dockerfile),
// and an explicit value always wins. Everything else -- the desktop, iOS
// and Android bundles, built by `pnpm tauri ... build` straight from the
// working tree -- used to ship "unknown", which the floor deliberately
// fails safe on: an installed app that does not know its own version can
// never be walled, which defeats the floor for exactly the store builds it
// exists for. So when the env var is absent, ask git directly. `git
// describe` here mirrors what deploy.yml computes for the server; the
// try/catch covers the Docker image build (no .git in the context -- the
// Dockerfile's env var wins there anyway) and any tarball checkout, where
// "unknown" remains the honest answer.
//
// Done here rather than in the build:* scripts because package.json runs
// under cmd.exe on the Windows release runner, where $(...) substitution
// is fatal -- this file is Node everywhere.
function buildVersion(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION;
  try {
    return execSync("git describe --tags --always", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}
process.env.VITE_APP_VERSION = buildVersion();

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // ts-mls reaches for @noble/curves only when a WebCrypto algorithm is
  // missing (patches/ts-mls@1.6.4.patch: Safari has no X25519, the Android
  // System WebView no Ed25519), and it does it with a dynamic import. Vite's
  // dependency optimizer cannot produce an entry for that specifier -- the
  // dev server answers the import with "the file does not exist ... in the
  // optimize deps directory" and ts-mls reports it as the package not being
  // installed, which is the opposite of true. Excluding it hands the browser
  // the package's own ESM, which resolves.
  //
  // Dev only: `vite build` bundles the import and never consults this. It
  // matters for Android above all, because that is the platform that takes
  // the fallback on every single MLS operation.
  optimizeDeps: {
    exclude: ["@noble/curves"],
  },

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
