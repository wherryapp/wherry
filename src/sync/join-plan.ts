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

  // No commits and no usable GroupInfo: nobody has made the group. Exactly
  // one device must, and the total order every member computes identically
  // from the same roster picks which.
  const smallest = [...input.memberDeviceIds].sort()[0];
  return smallest === input.myDeviceId
    ? { action: "create" }
    : { action: "wait" };
}
