// What a device with no local group state should do about it.
//
// Its own module, with no imports, for two reasons: the decision is pure,
// and `sync/mls.ts` cannot be loaded under Node's test runner (it reaches
// the crypto provider, which reads Vite's `import.meta.env`). Keeping the
// three conditions testable is worth a file.

/** The epoch a joinable GroupInfo describes; `create`/`wait` carry none. */
export type JoinPlan =
  | { action: "external-join"; epoch: number }
  | { action: "create" }
  | { action: "wait" };

/**
 * How long a device defers to the designated creator before making the
 * group itself.
 *
 * Two sweeps' worth. The smallest-device-id rule is a good fast path -- one
 * device creates and adds everyone in a single commit, which is what keeps
 * a 50-member group from turning into fifty concurrent creations -- but as
 * the *only* path it makes one specific device a single point of failure
 * for every new conversation. A device that is simply never opened (an old
 * browser profile, a phone in a drawer) can hold the smallest id, and then
 * nothing anybody else does will ever create the group: every send parks
 * as pendingEncryption, forever, with no error raised. That is a real
 * report, not a hypothetical.
 *
 * After the grace, anybody may create. The concurrent-creation race that
 * rule existed to avoid is now cheaply survivable -- the loser's epoch-0
 * state is discarded by the EPOCH_UNAVAILABLE path in `#applyCommits` and
 * it rejoins by welcome or external commit -- so a rare, self-healing race
 * is the better trade against a permanent deadlock.
 */
export const CREATION_GRACE_MS = 60_000;

/**
 * Decides between joining an existing group by external commit, creating
 * the group, and waiting for a welcome.
 *
 * This was wrong once already, silently: the first cut of external joins
 * gated them on `serverEpoch > 0`, which skipped exactly the state a
 * brand-new conversation is in -- created, GroupInfo published, no commits
 * yet, so the server's epoch is still 0. Every member device but the
 * creator went to "wait", and if the creator was a closed browser tab
 * nothing could ever unblock them: sends parked as `pendingEncryption`
 * with no error raised anywhere.
 *
 * The question is never "has anybody committed?" but "is there a GroupInfo
 * describing the epoch the server is actually at?" -- epoch 0 answers that
 * as legitimately as epoch 9.
 */
export function planJoin(input: {
  /** The server's current epoch: max committed epoch, 0 before any commit. */
  serverEpoch: number;
  /** Epoch of the stored GroupInfo, or null when none is published. */
  groupInfoEpoch: number | null;
  myDeviceId: string;
  /** Every member's unrevoked devices, per the server's roster. */
  memberDeviceIds: readonly string[];
  /**
   * How long this device has been watching this conversation with no group
   * in it. Past CREATION_GRACE_MS, this device stops deferring to the
   * designated creator -- see that constant for why.
   */
  msWaitingForCreation: number;
}): JoinPlan {
  // A GroupInfo naming the current epoch means a group exists and can be
  // joined with nobody else awake. Checked first, because a
  // created-but-uncommitted group satisfies this and the epoch-0 branch
  // below.
  if (
    input.groupInfoEpoch !== null &&
    input.groupInfoEpoch === input.serverEpoch
  ) {
    return { action: "external-join", epoch: input.serverEpoch };
  }

  // Commits exist, so the group does -- but nothing published a GroupInfo
  // for its current epoch (a committer on a build older than the feature,
  // or a publish that failed). Wait for a welcome, the pre-feature
  // behaviour, until some current member's sweep republishes.
  if (input.serverEpoch > 0) return { action: "wait" };

  // No commits and no usable GroupInfo: nobody has made the group. The
  // total order every member computes identically from the same roster
  // nominates one device to do it, so the common case is a single creation
  // followed by a single commit adding everybody.
  const smallest = [...input.memberDeviceIds].sort()[0];
  if (smallest === input.myDeviceId) return { action: "create" };

  // ...but the nominee may not exist in any meaningful sense -- an old
  // browser profile that is never opened still holds its device id. Deferring
  // forever is how a brand-new conversation ends up permanently unsendable
  // for every other device, so the deference expires.
  if (input.msWaitingForCreation >= CREATION_GRACE_MS) {
    return { action: "create" };
  }

  return { action: "wait" };
}
