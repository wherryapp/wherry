// Asks the SFU whether a call's room still exists: one `rtc/validate` request
// with the call's own token, to the SFU the token names. The native transport
// asks while the shell is reconnecting (`probeRoom`); the session keeps asking
// after a call ended with no reason the server already knows
// (`followUpRoom`). Nothing is decided here: `transport-rules.ts` reads each
// answer (`roomProbeVerdict`, `roomFollowUpStep`), and `session.ts` decides
// what to tell the server.
//
// Why the page asks rather than the shell: the Rust SDK makes the same request
// on each refused reconnect and keeps the answer to itself (its validate is
// private, and it treats the 404 as retryable), and the shell has no HTTP
// client of its own. The page already holds the URL and the token, the
// desktop CSP already allows the SFU's origins (`tauri.conf.json`'s
// connect-src: voice.wherry.app, and localhost for the dev stack and the rig),
// and livekit-client makes this exact request from the same webview.

import type { RoomEndpoint } from "./transport";
import {
  ROOM_FOLLOW_UP_EVERY_MS,
  ROOM_PROBE_TIMEOUT_MS,
  roomFollowUpStep,
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

/** How a follow-up finished: the room was gone and `onGone` ran, the answers
 *  said to stop (present, refused, or out of time), or the caller cancelled. */
export type RoomFollowUpOutcome = "left" | "stopped" | "cancelled";

export type RoomFollowUp = {
  cancel(): void;
  done: Promise<RoomFollowUpOutcome>;
};

/**
 * Keeps asking whether an ended call's room still exists, at once and then
 * every `ROOM_FOLLOW_UP_EVERY_MS`, until `roomFollowUpStep` says leave or
 * stop; `onGone` runs on "leave". Time is read from `now()` rather than
 * counted in ticks, so a hidden page whose timers the browser slows still
 * stops on time.
 *
 * Why after the end and not only at it: a client gives up on an SFU it cannot
 * reach, so the moment the call ends is the moment a single question is most
 * likely to go unanswered (an SFU host rebooting, a container down longer
 * than the SDK's retries, a forced stop that is still stopping). One probe
 * there left the call open on the server until the sweep's hour.
 */
export function followUpRoom(
  endpoint: RoomEndpoint,
  sfuStopping: boolean,
  options: {
    onGone: () => Promise<void>;
    probe?: (url: string, token: string) => Promise<RoomProbeVerdict>;
    wait?: (ms: number, cancelled: AbortSignal) => Promise<void>;
    now?: () => number;
  },
): RoomFollowUp {
  const probe = options.probe ?? ((url: string, token: string) => probeRoom(url, token));
  const wait = options.wait ?? sleep;
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  const started = now();
  const done = (async (): Promise<RoomFollowUpOutcome> => {
    for (;;) {
      if (controller.signal.aborted) return "cancelled";
      const verdict = await probe(endpoint.url, endpoint.token);
      if (controller.signal.aborted) return "cancelled";
      const step = roomFollowUpStep(verdict, now() - started, sfuStopping);
      if (step === "leave") {
        await options.onGone();
        return "left";
      }
      if (step === "stop") return "stopped";
      await wait(ROOM_FOLLOW_UP_EVERY_MS, controller.signal);
    }
  })();
  return { cancel: () => controller.abort(), done };
}

/** A timer that a cancel ends early; the loop then returns "cancelled". */
function sleep(ms: number, cancelled: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (cancelled.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      cancelled.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    cancelled.addEventListener("abort", onAbort, { once: true });
  });
}
