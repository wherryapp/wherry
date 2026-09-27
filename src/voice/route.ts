// Which path a call's media took: direct to the SFU, or through the TURN
// relay (docs/prompts/turn-relay-plan.md §6, T3a). Read from WebRTC's own
// stats so that every relay row has a value to read in Details on an
// installed build, not only in chrome://webrtc-internals.
//
// Two halves, both pure:
//
// - `parseRoute` walks one stats report (an array of the dictionaries
//   `RTCStatsReport.values()` yields) to the selected candidate pair's local
//   candidate, and keeps three fields of it. The webview transport calls it;
//   the shell emits the same three fields itself from libwebrtc's stats,
//   whose serde names are the spec's (`candidateType`, `protocol`,
//   `relayProtocol`, values lowercase), so one label serves both engines.
// - `routeLabel` turns those three fields into the words Details shows. The
//   label is a decision, so it lives here and not in Rust (CLAUDE.md,
//   `src-tauri/`: decisions in TypeScript, mechanism in Rust).
//
// **No address leaves this file.** A candidate carries the client's IP, the
// relay's IP and (for a relay) the TURN server's URL; none of them is copied
// into the result, and the test asserts it. The route is a kind of path, not
// a place.
//
// A relay candidate's `protocol` is the relay's leg to the SFU (always UDP
// with our coturn: `no-tcp-relay`), not the client's leg to the relay. The
// client's leg is `relayProtocol`, which is what the label must read.

/** The selected pair's local candidate, reduced to what the label needs.
 *  Values are the spec's strings, lowercased; `null` where the engine did
 *  not report one. */
export type RouteRaw = {
  /** `host`, `srflx`, `prflx` or `relay`. */
  candidateType: string | null;
  /** `udp` or `tcp`: the candidate's own transport. */
  protocol: string | null;
  /** For a relay candidate only: the client-to-relay transport, `udp`,
   *  `tcp` or `tls`. */
  relayProtocol: string | null;
};

/** What Details shows on its Route row. `relay` alone is a relay whose
 *  engine reported no client-to-relay transport (kept apart from `unknown`,
 *  which is what a call with no working path reads — row W-112's control). */
export type RouteLabel =
  | "direct · udp"
  | "direct · tcp"
  | "relay · udp"
  | "relay · tcp"
  | "relay · tls"
  | "relay"
  | "unknown";

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function lower(value: unknown): string | null {
  const s = str(value);
  return s === null ? null : s.toLowerCase();
}

/**
 * The client-to-relay transport from a relay candidate's ICE server URL, for
 * an engine that reports `url` but not `relayProtocol`. `turns:` is TLS;
 * `turn:` is TCP when `?transport=tcp` says so and UDP otherwise (RFC 7065's
 * default). The URL itself is never kept.
 */
function relayProtocolFromUrl(url: string | null): string | null {
  if (url === null) return null;
  const lowered = url.toLowerCase();
  if (lowered.startsWith("turns:")) return "tls";
  if (!lowered.startsWith("turn:")) return null;
  return /[?&]transport=tcp(?:&|$)/.test(lowered) ? "tcp" : "udp";
}

/**
 * The route the media is taking, from one stats report, or `null` when the
 * report names no selected pair (not connected yet, or no media path at all).
 *
 * The selected pair is found the spec's way first: the `transport`
 * dictionary's `selectedCandidatePairId`. Firefox has no such field, so the
 * fallback is a `candidate-pair` marked `selected` (Firefox's own flag), and
 * after that one that is `nominated` and `succeeded`. A report can hold more
 * than one transport; the first that resolves wins.
 */
export function parseRoute(stats: Iterable<unknown>): RouteRaw | null {
  const all = Array.from(stats).filter(isDict);
  const byId = new Map<string, Dict>();
  for (const entry of all) {
    const id = str(entry["id"]);
    if (id !== null) byId.set(id, entry);
  }
  const pairs = all.filter((entry) => entry["type"] === "candidate-pair");

  let pair: Dict | undefined;
  for (const transport of all) {
    if (transport["type"] !== "transport") continue;
    const selectedId = str(transport["selectedCandidatePairId"]);
    const candidate = selectedId === null ? undefined : byId.get(selectedId);
    if (candidate?.["type"] === "candidate-pair") {
      pair = candidate;
      break;
    }
  }
  pair ??= pairs.find((p) => p["selected"] === true);
  pair ??= pairs.find((p) => p["nominated"] === true && p["state"] === "succeeded");
  if (!pair) return null;

  const localId = str(pair["localCandidateId"]);
  const local = localId === null ? undefined : byId.get(localId);
  if (!local || local["type"] !== "local-candidate") return null;

  const candidateType = lower(local["candidateType"]);
  const relayProtocol =
    candidateType === "relay"
      ? (lower(local["relayProtocol"]) ?? relayProtocolFromUrl(str(local["url"])))
      : null;
  return { candidateType, protocol: lower(local["protocol"]), relayProtocol };
}

const RELAY_LABELS: ReadonlyMap<string, RouteLabel> = new Map([
  ["udp", "relay · udp"],
  ["tcp", "relay · tcp"],
  ["tls", "relay · tls"],
]);
const DIRECT_LABELS: ReadonlyMap<string, RouteLabel> = new Map([
  ["udp", "direct · udp"],
  ["tcp", "direct · tcp"],
]);
// host, server-reflexive and peer-reflexive all reach the SFU with no relay
// between: which of them won says something about NAT, nothing about TURN.
const DIRECT_TYPES: ReadonlySet<string> = new Set(["host", "srflx", "prflx"]);

/**
 * The words for a route. Anything not recognised is `unknown` rather than a
 * guess, so a new engine's spelling shows up as a finding and not as a
 * plausible wrong answer.
 */
export function routeLabel(raw: RouteRaw | null | undefined): RouteLabel {
  if (!raw) return "unknown";
  const type = raw.candidateType?.toLowerCase();
  if (type === "relay") {
    return RELAY_LABELS.get(raw.relayProtocol?.toLowerCase() ?? "") ?? "relay";
  }
  if (type !== undefined && DIRECT_TYPES.has(type)) {
    return DIRECT_LABELS.get(raw.protocol?.toLowerCase() ?? "") ?? "unknown";
  }
  return "unknown";
}
