// Asks the SFU whether a call's room still exists: one `rtc/validate` request
// with the call's own token, to the SFU the token names. Both transports use
// it -- the native one while the shell is reconnecting, both when a call ends
// with no reason the server already knows -- and neither decides anything
// from the answer here: `transport-rules.ts` reads it (`roomProbeVerdict`),
// and `session.ts` decides what to tell the server.
//
// Why the page asks rather than the shell: the Rust SDK makes the same request
// on each refused reconnect and keeps the answer to itself (its validate is
// private, and it treats the 404 as retryable), and the shell has no HTTP
// client of its own. The page already holds the URL and the token, the
// desktop CSP already allows the SFU's origins (`tauri.conf.json`'s
// connect-src: voice.wherry.app, and localhost for the dev stack and the rig),
// and livekit-client makes this exact request from the same webview.

import {
  ROOM_PROBE_TIMEOUT_MS,
  roomProbeUrl,
  roomProbeVerdict,
  type RoomProbeVerdict,
} from "./transport-rules";

type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/** Never throws: no answer in time, a refused connection and a URL that is
 *  not an SFU's are all "unknown", which decides nothing. */
export async function probeRoom(
  url: string,
  token: string,
  options: { timeoutMs?: number; fetcher?: Fetcher } = {},
): Promise<RoomProbeVerdict> {
  const target = roomProbeUrl(url, token);
  if (!target) return "unknown";
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ROOM_PROBE_TIMEOUT_MS);
  try {
    const response = await fetcher(target, { signal: controller.signal });
    const body = response.status === 404 ? await response.text() : "";
    return roomProbeVerdict(response.status, body);
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}
