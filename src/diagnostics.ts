// Measuring the freeze, rather than guessing at it again.
//
// The 2026-09-01 report was the app going completely unresponsive on an
// iPhone -- taps dead, and SCROLLING dead with them. That last part is the
// whole reason this file exists: iOS scrolls off the main thread, so a
// freeze that takes scrolling with it is a main thread with no cycles left,
// not an event handler that failed to run. Two fixes had already been spent
// on the event-handling reading before that detail arrived.
//
// So this measures two things and displays them in Settings:
//
//   - **Stalls.** A timer that should fire every second, and how late it
//     actually was. Lateness IS main-thread blockage; there is no other way
//     for a timer to be late.
//   - **Slow crypto calls.** Timed at the one seam rule 7 already
//     guarantees (`crypto/index.ts` owns the choice of provider and nothing
//     bypasses it), so every call is covered without touching a call site.
//
// The hypothesis it exists to confirm or kill: the 2026-08-31 patch that
// stopped Safari throwing -- swapping the missing native WebCrypto X25519
// for the pure-JS `@hpke/dhkem-x25519` -- traded a crash for arithmetic
// that is far slower than the native call, on a main thread with no worker
// behind it. Chrome has had native X25519 since 133 and is the browser that
// never showed the problem. If that is right, the worst stall and the worst
// crypto call will line up, and this is a performance bug with a crypto
// cause rather than the error-handling bug it has been filed as.
//
// If they do NOT line up, that is just as useful: it means the freeze is
// something else entirely, and two sessions of suspicion can be dropped.

/** Findings survive the freeze and a reload, which is the point -- nothing
 *  can be read off a screen that is not repainting. localStorage rather
 *  than the store because it is synchronous: the record has to be written
 *  in the moment the thread comes back, not queued behind IndexedDB. */
const KEY = "messenger.diagnostics.v1";

/** How often the heartbeat should fire. A stall shorter than this cannot be
 *  seen at all, which is fine -- nothing under a second reads as a freeze,
 *  and a busier timer costs battery for resolution nobody needs. */
const TICK_MS = 1000;

/** Report a tick that arrived this much later than promised. Half a second
 *  of jank is already visible as a stutter; below that is noise. */
const STALL_MS = 500;

/** A crypto call worth naming. Native WebCrypto answers in single-digit
 *  milliseconds, so anything at this scale is already the interesting case. */
const SLOW_CALL_MS = 150;

/** Keep the worst few of each rather than a log. Bounded storage, and the
 *  worst case is the one that answers the question -- an average would hide
 *  exactly the outlier being hunted. */
const KEEP = 8;

export type Stall = { at: number; lateMs: number };
export type SlowCall = { at: number; label: string; ms: number };

export type Diagnostics = {
  /** When the current app instance started, so a report can be read against
   *  how long it was running. */
  since: number;
  stalls: Stall[];
  slowCalls: SlowCall[];
  /** Totals, since the kept lists are only the worst few. */
  stallCount: number;
  slowCallCount: number;
};

function empty(): Diagnostics {
  return {
    since: Date.now(),
    stalls: [],
    slowCalls: [],
    stallCount: 0,
    slowCallCount: 0,
  };
}

/** Every read and write is guarded: localStorage throws outright in some
 *  private-browsing configurations, and a diagnostic that can crash the app
 *  it is diagnosing would be worse than no diagnostic. */
function read(): Diagnostics {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty();
    const d = parsed as Partial<Diagnostics>;
    return {
      since: typeof d.since === "number" ? d.since : Date.now(),
      stalls: Array.isArray(d.stalls) ? d.stalls : [],
      slowCalls: Array.isArray(d.slowCalls) ? d.slowCalls : [],
      stallCount: typeof d.stallCount === "number" ? d.stallCount : 0,
      slowCallCount:
        typeof d.slowCallCount === "number" ? d.slowCallCount : 0,
    };
  } catch {
    return empty();
  }
}

function write(d: Diagnostics): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // Full, or blocked. Nothing to do and nothing worth saying.
  }
}

/** Worst first, capped. Exported for its test: "keeps the worst, not the
 *  most recent" is the property that makes a bounded report useful. */
export function keepWorst<T>(items: T[], by: (item: T) => number): T[] {
  return [...items].sort((a, b) => by(b) - by(a)).slice(0, KEEP);
}

/**
 * Whether a heartbeat gap is a stall worth recording, and how late it was.
 *
 * Pure, and its own function, because the browser is a bad place to pin this:
 * a tab's visibility is not something a test can set, and the visibility rule
 * is the half most likely to be "simplified" away by someone who has not hit
 * the false positives. Same treatment as `notify-rules.ts`'s `shouldNotify`
 * and `unread.ts`'s boundary -- the decision is testable, the plumbing is not.
 *
 * Returns null for "not a stall", including in every non-visible state:
 * browsers throttle timers in a background tab deliberately and iOS stops
 * running a backgrounded app altogether, so counting either would fill the
 * report with minutes-long "freezes" that are just the phone being in a
 * pocket -- and bury the real one, which is the entire point of keeping only
 * the worst few.
 */
export function stallFrom(
  gapMs: number,
  visibility: DocumentVisibilityState,
): number | null {
  const lateMs = gapMs - TICK_MS;
  if (lateMs < STALL_MS) return null;
  if (visibility !== "visible") return null;
  return lateMs;
}

/** Whether a call is slow enough to name. Pure for the same reason. */
export function isSlowCall(ms: number): boolean {
  return ms >= SLOW_CALL_MS;
}

export function readDiagnostics(): Diagnostics {
  return read();
}

export function clearDiagnostics(): void {
  write(empty());
}

/**
 * Record a call that took long enough to be worth naming.
 *
 * Called from the provider wrapper in `crypto/index.ts`. Fast calls are not
 * recorded at all -- the interesting shape is the tail, and writing every
 * call to localStorage would itself become a source of jank.
 */
export function recordCall(label: string, ms: number): void {
  if (!isSlowCall(ms)) return;
  const d = read();
  d.slowCallCount += 1;
  d.slowCalls = keepWorst([...d.slowCalls, { at: Date.now(), label, ms }], (c) => c.ms);
  write(d);
}

let started = false;

/**
 * Start the heartbeat. Idempotent, and safe to call before anything else
 * exists -- it holds no references to the app.
 *
 * A stall is only recorded while the document is VISIBLE. Browsers throttle
 * timers in a background tab deliberately, and on iOS a backgrounded app
 * stops running altogether; counting either as a stall would fill the
 * report with false positives and bury the real one.
 */
export function startStallDetector(): void {
  if (started) return;
  started = true;

  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lateMs = stallFrom(now - last, document.visibilityState);
    last = now;
    if (lateMs === null) return;

    const d = read();
    d.stallCount += 1;
    d.stalls = keepWorst([...d.stalls, { at: now, lateMs }], (s) => s.lateMs);
    write(d);
  }, TICK_MS);

  // A tab coming back from the background would otherwise measure the whole
  // hidden period as one enormous stall on its next tick.
  document.addEventListener("visibilitychange", () => {
    last = Date.now();
  });
}
