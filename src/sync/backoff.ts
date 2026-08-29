// Retry pacing for the poll loop.
//
// Exponential with full jitter. The jitter is not decoration: without it,
// every client that lost its connection during a deploy reconnects at the same
// instant, and the server's first moment back up is its worst. Randomising the
// whole interval rather than adding a small wobble is what actually spreads
// them out.

export type BackoffOptions = {
  /** First delay, before any doubling. */
  baseMs?: number;
  /** The delay never exceeds this, however many failures there have been. */
  ceilingMs?: number;
};

export class Backoff {
  readonly #base: number;
  readonly #ceiling: number;
  #attempts = 0;

  constructor(options: BackoffOptions = {}) {
    this.#base = options.baseMs ?? 2_000;
    this.#ceiling = options.ceilingMs ?? 60_000;
  }

  get attempts(): number {
    return this.#attempts;
  }

  /**
   * The next delay in milliseconds, and counts a failure.
   *
   * Full jitter: a uniform random point in [0, window), where the window
   * doubles per failure up to the ceiling. The expected wait is half the
   * window, so this is not slower than a plain doubling in practice -- it is
   * the same average with the synchronisation removed.
   */
  next(): number {
    const window = Math.min(this.#ceiling, this.#base * 2 ** this.#attempts);
    this.#attempts += 1;
    return Math.random() * window;
  }

  /** Called after any success. A single good response clears the history. */
  reset(): void {
    this.#attempts = 0;
  }
}

/** A cancellable sleep. Rejects with the abort reason if the signal fires. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
