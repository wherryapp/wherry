// Mints a join token against the local dev SFU for the stage-0 spike, with
// the same grant server/src/voice/livekit.ts issues (one room, publish and
// subscribe, microphone only), and creates the room first because the dev
// config has auto_create off. Reads LIVEKIT_* from the repo's .env; uses
// the server's own livekit-server-sdk install so nothing is added.
//
//   node client/spike/token.mjs <room> <identity> [name]
//
// Throwaway, with the rest of client/spike/.

import { readFileSync } from "node:fs";

const [room, identity, name = identity] = process.argv.slice(2);
if (!room || !identity) {
  console.error("usage: node token.mjs <room> <identity> [name]");
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

const sdk = await import(
  new URL("../../server/node_modules/livekit-server-sdk/dist/index.js", import.meta.url).href
);
const { AccessToken, RoomServiceClient, TrackSource } = sdk;

const rooms = new RoomServiceClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
try {
  await rooms.createRoom({ name: room, emptyTimeout: 300, departureTimeout: 20, maxParticipants: 50 });
} catch (error) {
  if (!/exist/i.test(String(error))) throw error;
}

const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
  identity,
  name,
  metadata: JSON.stringify({ userId: identity }),
  ttl: 4 * 3600,
});
token.addGrant({
  room,
  roomJoin: true,
  canPublish: true,
  canSubscribe: true,
  canPublishData: false,
  canUpdateOwnMetadata: false,
  canPublishSources: [TrackSource.MICROPHONE],
});
process.stdout.write(await token.toJwt());
