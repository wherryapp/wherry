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
export function runAsLeader(name: string, task: LeaderTask): LeaderHandle {
  const controller = new AbortController();
  let holding = false;

  const stop = () => {
    if (!controller.signal.aborted) controller.abort(new DOMException("stopped", "AbortError"));
  };

  if (!navigator.locks) {
    // No Web Locks. Run without coordination rather than not at all.
    holding = true;
    void task(controller.signal).catch(() => {});
    return { stop, isLeader: () => holding };
  }

  void navigator.locks
    .request(name, { signal: controller.signal }, async () => {
      holding = true;
      try {
        // Held for as long as this promise is pending. The lock is what makes
        // us the leader, so the task *is* the lock's lifetime.
        await task(controller.signal);
      } finally {
        holding = false;
      }
    })
    .catch((error: unknown) => {
      // AbortError is stop() being called, including while still queued
      // waiting to become leader. Anything else is genuinely unexpected.
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("leader task failed", error);
    });

  return { stop, isLeader: () => holding };
}

// ---------------------------------------------------------------------------
// Telling the other tabs
// ---------------------------------------------------------------------------

export type SyncBroadcast =
  | { type: "messages"; conversationIds: string[] }
  | { type: "conversations" }
  | { type: "signed-out" };

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
