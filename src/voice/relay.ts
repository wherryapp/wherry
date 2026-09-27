// `?devrelay=1`: make the webview engine use the TURN relay and nothing else,
// so that a relay row can be read on a network where direct paths work
// (docs/prompts/turn-relay-plan.md §5.1, rows W-110, W-112, I-70, A-70).
//
// Dev servers only. The check sits inside `if (import.meta.env?.DEV)`, which
// Vite replaces with a literal, so in every built bundle — `tauri build
// --debug` included — the branch and the query string it reads are gone and
// `devRelayOnly()` is `false`. It is parsed here and not in `devtools.ts`
// because that file belongs to the phone-calls plan
// (docs/prompts/native-gaps-coordination.md §2), and because nothing needs
// to be installed at start-up: the transport asks at connect time.
//
// What the caller does with a `true` is pass `{ rtcConfig: {
// iceTransportPolicy: "relay" } }` to `room.connect` and **never
// `iceServers`**: livekit-client uses the SFU's TURN list only when the
// caller gave none (turn-relay-plan.md §1), so passing any list would drop
// the one under test.
//
// The shell's native engine has its own knob, `WHERRY_FORCE_RELAY=1`, under
// `debug_assertions` in `src-tauri/src/voice/mod.rs` (T3b).

/** Whether a query string asks for relay-only ICE. Only `devrelay=1` does;
 *  any other value, or none, leaves ICE alone. */
export function relayRequested(search: string): boolean {
  return new URLSearchParams(search).get("devrelay") === "1";
}

/**
 * True only in a Vite dev server whose page URL carries `?devrelay=1`.
 *
 * Read on every call rather than once at load, so it answers for the URL the
 * call was placed from; the dev instruments strip only their own parameters
 * (`devtools.ts`), so `devrelay` survives `?devlogin` and `?devcall`.
 */
export function devRelayOnly(): boolean {
  // `?.` because tsx-run tests have no Vite (`api/base.ts`'s convention), so
  // this answers `false` there instead of throwing. Vite 8.2.2 still folds
  // it: a production build of this function read `function aG(){return!1}`
  // with no `devrelay` string anywhere in the bundle (2026-09-27). And were a
  // later Vite to stop folding it, the replaced `import.meta.env` would still
  // say `DEV: false` at run time, so a build can never relay-force; only the
  // dead branch would ship.
  if (import.meta.env?.DEV) {
    return relayRequested(globalThis.location?.search ?? "");
  }
  return false;
}
