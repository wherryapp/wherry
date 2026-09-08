// Stage 0 of docs/prompts/video-plan.md: the token and room service the
// spike page talks to. Throwaway, like the audio spike before it -- this
// whole directory is deleted once the go/no-go table in the plan's §3 is
// filled in.
//
// It exists because the dev SFU sets `auto_create: false`
// (deploy/livekit/livekit.dev.yaml), so a token alone cannot bring a room
// into being; something has to call CreateRoom first. The real server does
// that in services/voice.ts, and the spike deliberately does not go through
// the real server: stage 0's question is what livekit-client and the SFU do
// with encrypted *video*, and putting our own auth, MLS and conversation
// membership in front of that question only adds ways for it to fail for
// reasons that are not the question.
//
// Run from the repo root (livekit-server-sdk lives in server/node_modules):
//
//   node client/spike/token.mjs
//
// then GET http://localhost:9998/token?room=spike&identity=alice
// -> { url, token, room, identity }

import { createRequire } from "node:module";
import http from "node:http";

// The SDK is a server dependency; resolve it from there rather than adding
// one to the client for a directory that is about to be deleted.
const require = createRequire(new URL("../../server/package.json", import.meta.url));
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");

// deploy/livekit/livekit.dev.yaml. Dev-only, and public in the repo already.
const KEY = "devkey";
const SECRET = "secret";
const HTTP_URL = "http://localhost:7880";
const WS_URL = "ws://localhost:7880";
const PORT = 9998;

const rooms = new RoomServiceClient(HTTP_URL, KEY, SECRET);
const created = new Set();

/** CreateRoom is idempotent enough for a spike: a second call on a live
 *  room throws, and that is the same as success for our purposes. */
async function ensureRoom(name) {
  if (created.has(name)) return;
  try {
    await rooms.createRoom({ name, emptyTimeout: 300, maxParticipants: 10 });
  } catch (error) {
    // Already exists: fine. Anything else is worth seeing in the log.
    if (!String(error).includes("already exists")) console.warn("createRoom:", String(error));
  }
  created.add(name);
}

async function mint(room, identity) {
  const at = new AccessToken(KEY, SECRET, { identity, ttl: "2h" });
  at.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    // Video is the whole point; the source list is what the real server
    // will narrow per the plan's §5.1 policy, and the spike grants all of
    // it so the client is the only thing that can refuse.
    canPublishSources: [],
  });
  return await at.toJwt();
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("access-control-allow-origin", "*");
    if (url.pathname !== "/token") {
      res.writeHead(404).end("no");
      return;
    }
    const room = url.searchParams.get("room") ?? "spike";
    const identity = url.searchParams.get("identity") ?? `id-${Date.now()}`;
    try {
      await ensureRoom(room);
      const token = await mint(room, identity);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: WS_URL, token, room, identity }));
      console.log(`minted ${identity} for ${room}`);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
      console.error("mint failed:", error);
    }
  })
  .listen(PORT, () => console.log(`spike token service on :${PORT}`));
