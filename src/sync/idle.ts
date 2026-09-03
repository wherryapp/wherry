// Idle detection: is anybody at this device?
//
// The client is the only thing that can answer -- the server sees requests
// and frames, never that the keyboard has been untouched for five minutes
// with the window open -- so the client measures and reports, and the
// server stores the answer against the connection (realtime/registry.ts)
// where it dies with the socket. Transitions only: one `activity` frame
// when the device goes idle and one when it comes back, never a heartbeat.
// A device sends a handful of these an hour, and the server keeps no clock.
//
// "Idle" is input-based -- pointer, key, touch, wheel -- the Discord/Slack
// rule. Somebody reading a long thread for six minutes turns away in front
// of their own eyes, and that is accepted: counting a visible tab as active
// would make a forgotten open window look present forever, the worse lie.
//
// Several tabs of one browser profile are one device with one socket (the
// leader's), and a person is not idle in a tab they are typing in because
// another tab is quiet. So the last-input clock is shared through
// localStorage: every tab writes it on input (throttled), every tab reads
// it on the same tick, and they all reach the same verdict. Only the
// leader's report reaches the server; the others fall on a socket that is
// not there, which is fine.
//
// The verdict is also mirrored into sync/self-status.ts so your own dot
// shows away, the same rule the server applies to everyone else's.

import { sync } from "./engine";
import { selfStatus } from "./self-status";

/** No input for this long is idle. Discord uses ~5 minutes; so does this. */
export const IDLE_AFTER_MS = 5 * 60_000;
/** How often the verdict is re-derived. Coarse on purpose -- the transition
 *  is seen at most this late, and a minute of lag on a five-minute rule is
 *  nothing against waking every tab's timer more often. */
const TICK_MS = 30_000;
/** Writes to the shared clock are throttled to this: pointer moves arrive
 *  at 60 Hz and localStorage is synchronous. */
const WRITE_THROTTLE_MS = 10_000;

const STORAGE_KEY = "messenger.lastActivity";

let lastWriteAt = 0;
let reportedIdle = false;
let reportedOnSocket = false;
let installed = false;

function readLastActivity(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : Date.now();
  } catch {
    // No storage: treat now as the last input, which errs to "active".
    return Date.now();
  }
}

function noteActivity(): void {
  const now = Date.now();
  if (now - lastWriteAt < WRITE_THROTTLE_MS && !reportedIdle) return;
  lastWriteAt = now;
  try {
    localStorage.setItem(STORAGE_KEY, String(now));
  } catch {
    // See readLastActivity.
  }
  // Coming back from idle is reported at once rather than on the next
  // tick: the person is here, and a dot that stays amber for half a minute
  // after the first keystroke reads as broken.
  if (reportedIdle) apply(false);
}

/** Pushes a verdict to the server (leader only) and to the local mirror.
 *  Re-sent on a socket that has come back, since the flag died with the
 *  old one. */
function apply(idle: boolean): void {
  const healthy = sync.socketHealthy();
  const changed = idle !== reportedIdle;
  if (changed || (healthy && !reportedOnSocket)) {
    reportedOnSocket = healthy && sync.sendActivity(idle);
  }
  if (!healthy) reportedOnSocket = false;
  reportedIdle = idle;
  selfStatus.setIdle(idle);
}

function tick(): void {
  apply(Date.now() - readLastActivity() >= IDLE_AFTER_MS);
}

/**
 * Starts measuring. Called once from main.tsx and never torn down; the
 * listeners live as long as the page. Idempotent, because a hot reload in
 * dev evaluates the module twice.
 */
export function startIdleTracking(): void {
  if (installed) return;
  installed = true;

  // Passive and on the window, capture phase: nothing here reads the event
  // and nothing may stop it reaching the app.
  const options = { passive: true, capture: true } as const;
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(type, noteActivity, options);
  }
  // Coming back to the tab counts as input -- it took a click or a tap
  // somewhere the page could not see.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") noteActivity();
  });

  noteActivity();
  setInterval(tick, TICK_MS);

  // The flag lives on the server's side of the socket and dies with it, so
  // a reconnect starts "active" whatever this device was. Re-send at once.
  sync.subscribe((event) => {
    if (event.type === "socket_ready") {
      reportedOnSocket = false;
      apply(reportedIdle);
    }
  });
}

/** For tests and devtools: the verdict as last applied. */
export function isIdleNow(): boolean {
  return reportedIdle;
}
