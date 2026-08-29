// One tab does the syncing; the others watch.
//
// ---------------------------------------------------------------------------
// The problem
// ---------------------------------------------------------------------------
//
// Three tabs open is three poll loops against the same device's inbox. That is
// three times the requests against a 300/min budget, three copies of every
// envelope decoded and written, and three tabs racing to ack the same ids.
// Nothing corrupts -- acks are idempotent and IndexedDB writes are upserts --
// but it is waste, and concurrent writes of the same records are contention
// for no gain.
//
// ---------------------------------------------------------------------------
// Why the Web Locks API and not a BroadcastChannel election
// ---------------------------------------------------------------------------
//
// The obvious alternative is a heartbeat: tabs announce themselves on a
// BroadcastChannel, the oldest wins, the leader re-announces every second, and
// the others take over if it goes quiet. That works, and every part of it is a
// thing to get wrong -- how long to wait before deciding the leader is gone,
// what happens when two tabs decide simultaneously, what a tab does when it
// wakes from being throttled in the background and its clock is stale.
//
// `navigator.locks.request` with a promise that never settles gives the same
// result with none of that. The holder keeps the lock; other tabs queue. When
// the leader's tab closes -- or crashes, or is killed by the OS -- the browser
// releases the lock and promotes the next waiter. There is no heartbeat, no
// timeout to tune, and no stale-leader state to detect, because the browser
// already knows exactly when a page is gone and we do not.
//
// Available everywhere current (Safari 15.4+). Where it is missing the
// fallback is to run anyway, which is the pre-existing behaviour of every tab
// polling -- degraded, not broken.

export type LeaderTask = (signal: AbortSignal) => Promise<void>;

export type LeaderHandle = {
  /** Releases the lock and aborts the task. Safe to call more than once. */
  stop(): void;
  /** True once this tab actually holds the lock. */
  isLeader(): boolean;
};

/**
 * Runs `task` in exactly one tab at a time.
 *
 * The task is handed an AbortSignal and is expected to run until it fires --
 * a poll loop, not a one-shot. Returning early releases the lock and promotes
 * another tab, which is the correct behaviour if the task decides it is done
 * (a dead session, say).
 */
// How often the leader says it is alive, and how long a follower waits in
// silence before concluding the holder is wedged.
//
// Four missed beats rather than one: a busy main thread can skip a beat, and
// stealing the lock from a healthy leader is churn, not a fix.
const HEARTBEAT_MS = 2_000;
const STALE_MS = 8_000;

/**
 * Runs `task` in exactly one tab at a time.
 *
 * The task is handed an AbortSignal and is expected to run until it fires --
 * a poll loop, not a one-shot. Returning early releases the lock and promotes
 * another tab, which is the correct behaviour if the task decides it is done
 * (a dead session, say).
 */
export function runAsLeader(name: string, task: LeaderTask): LeaderHandle {
  const locks = navigator.locks;

  if (!locks) {
    // No Web Locks. Run without coordination rather than not at all.
    const solo = new AbortController();
    return {
      stop: () => {
        if (!solo.signal.aborted) {
          solo.abort(new DOMException("stopped", "AbortError"));
        }
      },
      isLeader: () => !solo.signal.aborted,
    };
  }

  let stopped = false;
  let paused = false;
  let holding = false;
  let controller: AbortController | null = null;
  let lastSeenLeaderAt = Date.now();

  const release = (): void => {
    controller?.abort(new DOMException("released", "AbortError"));
    controller = null;
  };

  const acquire = (steal: boolean): void => {
    if (stopped || paused || controller) return;

    const own = new AbortController();
    controller = own;
    let completed = false;

    // `steal` and `signal` are mutually exclusive in the Web Locks spec, and
    // a steal never queues, so there is nothing to cancel while waiting.
    const options: LockOptions = steal
      ? { steal: true }
      : { signal: own.signal };

    void locks
      .request(name, options, async () => {
        holding = true;
        lastSeenLeaderAt = Date.now();
        try {
          // Held for as long as this promise is pending. The lock is what
          // makes us the leader, so the task *is* the lock's lifetime.
          await task(own.signal);
          completed = true;
        } finally {
          holding = false;
        }
      })
      .catch((error: unknown) => {
        // AbortError is stop(), pause(), or this lock being stolen from us --
        // all of them ordinary. Anything else is genuinely unexpected.
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("leader task failed", error);
      })
      .finally(() => {
        // Being stolen from releases the lock but does *not* stop the task:
        // the callback is still awaiting it, and a former leader still polling
        // is the two-writers case the lock exists to prevent.
        if (!own.signal.aborted) {
          own.abort(new DOMException("superseded", "AbortError"));
        }
        if (controller === own) controller = null;

        // Queue for the lock again -- but only when the task did not finish on
        // its own. A loop that returned deliberately (an expired session) must
        // stay finished, or it is restarted straight into the failure that
        // ended it.
        if (!stopped && !paused && !completed) acquire(false);
      });
  };

  // -- lifecycle -----------------------------------------------------------

  // A frozen page keeps its Web Lock. Not a hypothetical: Android freezes
  // background tabs, and someone who opened the site in Chrome to install it
  // leaves that tab holding the lock while its JavaScript is suspended. The
  // installed app then sits as a follower forever -- nothing sends, nothing
  // arrives, and because a follower is a perfectly ordinary state there is
  // nothing on screen to say so.
  //
  // The comment this replaces said the browser already knows when a page is
  // gone, which is true and was the wrong property to rely on. Frozen is not
  // gone.
  const onFreeze = (): void => {
    paused = true;
    release();
  };

  const onResume = (): void => {
    paused = false;
    acquire(false);
  };

  const onPageHide = (event: PageTransitionEvent): void => {
    // Only the bfcache case. A real unload releases the lock anyway, and
    // pausing on it would be pointless work during teardown.
    if (event.persisted) onFreeze();
  };

  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) onResume();
  };

  document.addEventListener("freeze", onFreeze);
  document.addEventListener("resume", onResume);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);

  // -- liveness ------------------------------------------------------------

  // A heartbeat, which the election itself deliberately does not use. This is
  // not how a leader is chosen -- the lock still does that, with none of the
  // timeout tuning a heartbeat election needs. It is a check on a holder that
  // has stopped running without letting go, which is the one case the lock
  // cannot detect on its own.
  const heartbeat = setInterval(() => {
    if (holding) broadcast({ type: "leader-alive" });
  }, HEARTBEAT_MS);

  const unsubscribe = subscribeToBroadcasts((message) => {
    if (message.type === "leader-alive") lastSeenLeaderAt = Date.now();
  });

  const watchdog = setInterval(() => {
    if (stopped || paused || holding) return;
    // Only a page somebody is looking at takes over. A background tab that
    // stole the lock would be the same bug wearing different clothes.
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastSeenLeaderAt < STALE_MS) return;

    // Reset first: acquiring is not instant, and a second steal while the
    // first is in flight would fight itself.
    lastSeenLeaderAt = Date.now();
    release();
    acquire(true);
  }, HEARTBEAT_MS);

  acquire(false);

  return {
    stop: () => {
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(watchdog);
      unsubscribe();
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      release();
    },
    isLeader: () => holding,
  };
}

// ---------------------------------------------------------------------------
// Telling the other tabs
// ---------------------------------------------------------------------------

export type SyncBroadcast =
  | { type: "messages"; conversationIds: string[] }
  | { type: "conversations" }
  | { type: "signed-out" }
  /** The leader saying it is still running. See the watchdog in runAsLeader. */
  | { type: "leader-alive" };

const CHANNEL = "messenger.sync";

/**
 * Notifies the other tabs that local storage changed.
 *
 * Only the leader writes, so followers cannot learn about new data from their
 * own requests -- they have to be told. What travels is a *notification*, not
 * the data: the receiving tab re-reads IndexedDB, which it can already do.
 * Sending the messages themselves would mean two copies of the truth and a
 * decision about which one wins.
 */
export function broadcast(message: SyncBroadcast): void {
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(message);
    channel.close();
  } catch {
    // No BroadcastChannel. Followers fall back to noticing on their next
    // render; nothing is lost, it is just less immediate.
  }
}

/** Subscribes to broadcasts from the leader. Returns an unsubscribe function. */
export function subscribeToBroadcasts(
  listener: (message: SyncBroadcast) => void,
): () => void {
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    return () => {};
  }

  const handler = (event: MessageEvent<SyncBroadcast>) => listener(event.data);
  channel.addEventListener("message", handler);

  return () => {
    channel.removeEventListener("message", handler);
    channel.close();
  };
}
