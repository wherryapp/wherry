// The MLS orchestrator: everything that moves handshake material over HTTP.
//
// The provider (crypto/mls.ts) is bytes and state; this file is the traffic
// between it and the delivery service -- key package publication, the
// welcome drain, commit catch-up, and the reconciliation sweep that keeps
// each group's roster matching the server's record of who should read the
// conversation. The engine calls into it at fixed points in the poll loop
// and stays ignorant of every MLS concept beyond "this ran".
//
// Everything here is a no-op when the provider has no handshake capability:
// `mlsEnabled()` is the one switch, and it reads `e2e.handshake`.

import {
  ackWelcomes,
  claimKeyPackages,
  countKeyPackages,
  fetchCommits,
  fetchGroupInfo,
  fetchRecipients,
  fetchWelcomes,
  postCommit,
  postHistoryKeys,
  publishKeyPackages,
  putGroupInfo,
  ApiError,
} from "../api/client";
import type { RecipientsResponse } from "../api/types";
import { decodeBase64, encodeBase64 } from "../api/base64";
import { E2EError, e2e } from "../crypto";
import {
  mintBackfill,
  mintRotation,
  saveRotatedKey,
} from "../crypto/history";
import { store } from "../store";
import { planJoin } from "./join-plan";

/** Cached per conversation so enqueue can seal archive rows offline. */
export type CachedRecipient = { userId: string; publicKey: string };

const META_RECIPIENTS_PREFIX = "mls.recipients.";

// Replenishment: top up to TARGET when below LOW. Checked once per session
// and after every sweep that might have consumed packages elsewhere.
const KEY_PACKAGE_TARGET = 20;
const KEY_PACKAGE_LOW = 10;

// The sweep hits /recipients (and possibly /commits) once per conversation,
// so it runs on the conversation-refresh cadence, not the poll cadence.
const RECONCILE_INTERVAL_MS = 30_000;

export type Identity = { userId: string; deviceId: string };

export function mlsEnabled(): boolean {
  return e2e.handshake !== undefined;
}

export async function cachedRecipients(
  conversationId: string,
): Promise<CachedRecipient[] | undefined> {
  return await store.getMeta<CachedRecipient[]>(
    META_RECIPIENTS_PREFIX + conversationId,
  );
}

/**
 * The cache, or a live fetch that fills it, or null when neither works.
 * Enqueue calls this: the cache keeps composing offline-capable once the
 * sweep has run at least once, and the live fetch covers a brand-new
 * conversation the sweep has not seen.
 */
export async function ensureRecipients(
  conversationId: string,
): Promise<CachedRecipient[] | null> {
  const cached = await cachedRecipients(conversationId);
  if (cached) return cached;

  try {
    const recipients = await fetchRecipients(conversationId);
    const usable = recipients.members
      .filter((member) => member.accountPublicKey !== null)
      .map((member) => ({
        userId: member.userId,
        publicKey: member.accountPublicKey!,
      }));
    await store.setMeta(META_RECIPIENTS_PREFIX + conversationId, usable);
    return usable;
  } catch {
    return null;
  }
}

export class MlsSync {
  #lastReconcile = 0;
  #publishedThisSession = false;
  /**
   * conversationId -> the timestamp a rate-limited conversation may be
   * retried again. Without this, a new device joining N groups at once
   * re-issues a claim for every still-unadded conversation on every 30s
   * sweep -- faster than CLAIM_RATE_LIMIT's 15-minute window can ever
   * clear, so the sweep never succeeds and every send behind it stays
   * stuck. Honouring the server's Retry-After here is the same fix
   * engine.ts's #delayAfter already applies to the outer poll loop.
   */
  #reconcileCooldownUntil = new Map<string, number>();
  /**
   * conversationId -> when this device first saw it with no group in it.
   * Feeds planJoin's creation grace: deferring to the designated creator is
   * right until it is clear nobody is coming. In memory deliberately -- a
   * restart restarting the grace costs one more minute in a case that is
   * already rare, and it is not worth a store write on every sweep.
   */
  #missingGroupSince = new Map<string, number>();
  /**
   * Conversations the server no longer serves to us -- deleted, or we are
   * no longer a member. Their local rows survive (a removed member keeps
   * their history, by design), but reconciling them can only 404 forever,
   * so the sweep stops asking. Session-scoped: a restart re-asks once,
   * which is the right cadence for a fact that changes this rarely.
   */
  #goneConversations = new Set<string>();

  /** Forces the next tick to run the full sweep. */
  invalidate(): void {
    this.#lastReconcile = 0;
  }

  /**
   * The per-tick entry point, called by the engine after conversations are
   * refreshed and before the outbox flushes -- membership work first, so a
   * send that needs a fresh group state gets one.
   *
   * Returns conversation ids whose messages may have become readable (a
   * join happened), so the engine can re-render.
   */
  async tick(me: Identity, signal: AbortSignal): Promise<string[]> {
    const handshake = e2e.handshake;
    if (!handshake) return [];

    if (!this.#publishedThisSession) {
      await this.#ensurePublished(me);
      this.#publishedThisSession = true;
    }

    // Welcomes drain every tick -- they are how this device starts reading
    // a conversation, and a 30-second wait there is visible.
    const joined = await this.#drainWelcomes(signal);

    const now = Date.now();
    if (now - this.#lastReconcile >= RECONCILE_INTERVAL_MS) {
      this.#lastReconcile = now;
      const conversations = await store.listConversations();

      // Which conversations have something queued that cannot be sealed
      // until a group exists. Read once for the whole sweep rather than per
      // conversation: it decides whether creating the group is a background
      // courtesy or the thing standing between a person and their message.
      const pending = new Set(
        (await store.listOutbox())
          .filter((entry) => entry.pendingEncryption && !entry.failedPermanently)
          .map((entry) => entry.conversationId),
      );

      for (const conversation of conversations) {
        if (signal.aborted) break;
        if (this.#goneConversations.has(conversation.id)) continue;
        const cooldown = this.#reconcileCooldownUntil.get(conversation.id);
        if (cooldown !== undefined && now < cooldown) continue;
        try {
          await this.reconcileConversation(conversation.id, me, {
            hasPendingSend: pending.has(conversation.id),
          });
          this.#reconcileCooldownUntil.delete(conversation.id);
        } catch (error) {
          // One conversation's trouble must not stop the sweep. Typical
          // causes are transient (a commit race, a device mid-publish).
          console.warn("mls reconcile failed", conversation.id, error);

          // 404 is not transient: the server no longer serves this
          // conversation to us -- deleted, or we were removed. Retrying
          // cannot help, and anything queued for it can never be sent, so
          // say so rather than leaving it reading "sending" forever.
          if (error instanceof ApiError && error.status === 404) {
            this.#goneConversations.add(conversation.id);
            await this.#failPendingSends(conversation.id);
            continue;
          }

          if (error instanceof ApiError && error.retryAfterSeconds) {
            this.#reconcileCooldownUntil.set(
              conversation.id,
              now + error.retryAfterSeconds * 1000,
            );
          }
        }
      }
    }

    return joined;
  }

  /**
   * Marks everything queued for a conversation the server will not serve us
   * as permanently failed, so the UI shows an error the person can act on
   * instead of a spinner that never resolves. The messages stay in the
   * outbox, retryable by hand, exactly like any other permanent failure.
   */
  async #failPendingSends(conversationId: string): Promise<void> {
    try {
      const entries = await store.listOutbox();
      for (const entry of entries) {
        if (entry.conversationId !== conversationId) continue;
        if (entry.failedPermanently) continue;
        await store.recordOutboxFailure(
          entry.clientMessageId,
          "This conversation is no longer available",
          true,
        );
      }
    } catch (error) {
      console.warn("could not fail sends for a gone conversation", error);
    }
  }

  /**
   * Identity + key package stock. Publishing also (re)declares the identity
   * public key, which is what other members verify this device's leaf
   * against.
   */
  async #ensurePublished(me: Identity): Promise<void> {
    const handshake = e2e.handshake!;
    const identityPublicKey = await handshake.ensureIdentity(me);

    const { available } = await countKeyPackages();
    if (available >= KEY_PACKAGE_LOW) return;

    const wires = await handshake.generateKeyPackages(
      me,
      KEY_PACKAGE_TARGET - available,
    );
    await publishKeyPackages({
      identityPublicKey: encodeBase64(identityPublicKey),
      keyPackages: wires.map(encodeBase64),
    });
  }

  /**
   * Fetch, join, ack -- in that order. The join persists group state, and
   * acking before that state is durable would turn at-least-once joining
   * into at-most-once, exactly like the inbox.
   */
  async #drainWelcomes(signal: AbortSignal): Promise<string[]> {
    const handshake = e2e.handshake!;
    const { welcomes } = await fetchWelcomes({ signal });
    if (welcomes.length === 0) return [];

    const acked: string[] = [];
    const joined: string[] = [];
    for (const welcome of welcomes) {
      try {
        await handshake.joinFromWelcome(
          welcome.conversationId,
          decodeBase64(welcome.payload),
        );
        joined.push(welcome.conversationId);
        acked.push(welcome.welcomeId);
      } catch (error) {
        if (error instanceof E2EError && error.code === "NOT_IN_GROUP") {
          // No stored key package matches -- this browser's storage was
          // cleared after the package was claimed. The welcome is dead to
          // us; ack it so it stops arriving, and the reconciliation sweep
          // on other members will re-add this device via a fresh package.
          acked.push(welcome.welcomeId);
        } else {
          throw error;
        }
      }
    }

    if (acked.length > 0) await ackWelcomes(acked);
    return joined;
  }

  /**
   * One conversation's sweep: catch up on commits, make the group roster
   * match the server's member × device record, then rotate the history key
   * if user membership drifted under it.
   *
   * Also the repair path: the outbox flush calls this directly when a send
   * bounces with EPOCH_STALE or HISTORY_KEY_STALE.
   *
   * Deliberately kind-blind, like everything in this sweep: a direct
   * conversation, a group, and any future hub channel reconcile and rotate
   * identically. No `kind` check may appear here.
   */
  async reconcileConversation(
    conversationId: string,
    me: Identity,
    options: {
      /**
       * A send is parked on this conversation's group existing. Defaults
       * false for the outbox repair path, which calls this while already
       * holding group state.
       */
      hasPendingSend?: boolean;
    } = {},
  ): Promise<void> {
    const handshake = e2e.handshake!;
    const recipients = await fetchRecipients(conversationId);

    // Cache the roster's account keys. Since v3 the archive seal no longer
    // reads these (one AEAD under the history key replaced the per-user
    // fan-out), but the cache stays warm for anything that needs the roster
    // offline. Members without account keys are cached as absent.
    await store.setMeta(
      META_RECIPIENTS_PREFIX + conversationId,
      recipients.members
        .filter((member) => member.accountPublicKey !== null)
        .map((member) => ({
          userId: member.userId,
          publicKey: member.accountPublicKey!,
        })) satisfies CachedRecipient[],
    );

    let localEpoch = await handshake.epoch(conversationId);

    // Tracks whether this sweep already published GroupInfo (after a
    // commit, a join, or a creation), so the staleness self-heal at the
    // bottom does not publish a second copy on top of it.
    let publishedThisPass = false;

    // No local state: join what exists, make it if it does not, or wait --
    // see planJoin for which and why.
    if (localEpoch === null) {
      const now = Date.now();
      const since = this.#missingGroupSince.get(conversationId) ?? now;
      this.#missingGroupSince.set(conversationId, since);

      const plan = planJoin({
        serverEpoch: recipients.epoch,
        groupInfoEpoch: recipients.groupInfoEpoch,
        myDeviceId: me.deviceId,
        memberDeviceIds: recipients.members.flatMap((member) =>
          member.devices.map((device) => device.deviceId),
        ),
        msWaitingForCreation: now - since,
        hasPendingSend: options.hasPendingSend ?? false,
      });

      if (plan.action === "wait") return;

      if (plan.action === "external-join") {
        const joined = await this.#tryExternalJoin(
          conversationId,
          me,
          plan.epoch,
        );
        if (joined === null) return;
        localEpoch = joined;
        publishedThisPass = true;
      } else {
        await handshake.createGroup(conversationId, me);
        localEpoch = 0;
        // Published at epoch 0, deliberately: it is what lets every other
        // member device -- ours and theirs -- join this brand-new group by
        // external commit instead of waiting for this device's next sweep
        // to add them one by one.
        await this.#publishGroupInfo(conversationId);
        publishedThisPass = true;
      }

      // In the group now, however we got here: the grace has nothing left
      // to time.
      this.#missingGroupSince.delete(conversationId);
    }

    // Catch up on commits before comparing rosters -- the roster of a stale
    // epoch would re-propose changes already made.
    if (recipients.epoch > localEpoch) {
      const caughtUp = await this.#applyCommits(conversationId, localEpoch);
      if (caughtUp === null) return; // removed, or divergent state discarded
      localEpoch = caughtUp;
    }

    // The comparison. Server side: current members × unrevoked devices.
    // Group side: leaves. A device on the server but not in the group needs
    // an Add; a leaf whose device the server no longer lists needs a
    // Remove. Our own leaf is never self-removed -- being removed is
    // someone else's commit, applied above.
    const roster = await handshake.roster(conversationId);
    const inGroup = new Set(roster.map((entry) => entry.deviceId));
    const onServer = new Set(
      recipients.members.flatMap((member) =>
        member.devices.map((device) => device.deviceId),
      ),
    );

    const toAdd = [...onServer].filter((deviceId) => !inGroup.has(deviceId));
    const toRemove = roster.filter(
      (entry) => !onServer.has(entry.deviceId) && entry.deviceId !== me.deviceId,
    );

    if (toAdd.length > 0) {
      const { keyPackages } = await claimKeyPackages(toAdd);
      const usable = keyPackages.filter(
        (entry): entry is { deviceId: string; keyPackage: string } =>
          entry.keyPackage !== null,
      );
      // Devices that answered null have no packages right now; the next
      // sweep tries again after they replenish.
      if (usable.length > 0) {
        const added = await handshake.commitAdd(
          conversationId,
          usable.map((entry) => decodeBase64(entry.keyPackage)),
          async ({ epoch, commit, welcome }) => {
            // The one welcome covers every added leaf; each device gets the
            // same bytes and finds its own secrets inside.
            const welcomeB64 = encodeBase64(welcome);
            return await this.#deliverCommit(conversationId, {
              epoch,
              payload: encodeBase64(commit),
              welcomes: usable.map((entry) => ({
                deviceId: entry.deviceId,
                payload: welcomeB64,
              })),
            });
          },
        );
        if (added !== null) {
          await this.#publishGroupInfo(conversationId);
          publishedThisPass = true;
        }
      }
    }

    if (toRemove.length > 0) {
      const removed = await handshake.commitRemove(
        conversationId,
        toRemove.map((entry) => entry.leafIndex),
        async ({ epoch, commit }) =>
          await this.#deliverCommit(conversationId, {
            epoch,
            payload: encodeBase64(commit),
            welcomes: [],
          }),
      );
      if (removed !== null) {
        await this.#publishGroupInfo(conversationId);
        publishedThisPass = true;
      }
    }

    // The staleness self-heal: this device holds the current epoch's state
    // and the server's GroupInfo is behind it (or absent) -- a commit made
    // by a build that predates publishing, or a conversation from before
    // the feature. One publish from any current member closes the gap and
    // quenches this branch for everybody.
    if (
      !publishedThisPass &&
      localEpoch === recipients.epoch &&
      recipients.groupInfoEpoch !== recipients.epoch
    ) {
      await this.#publishGroupInfo(conversationId);
    }

    // The history key, last: it rotates on USER membership change -- an
    // add, a re-add, a removal -- which is not the MLS epoch (a new phone
    // advances the epoch and needs no new history key, because its user
    // already holds them). The server computes staleness from the holder
    // set, so this also bootstraps generation 1 for a conversation that has
    // none -- which is what carried every existing conversation across the
    // v2->v3 boundary, no wipe, no flag day.
    if (recipients.historyKeyStale) {
      await this.#rotateHistoryKey(conversationId, recipients);
    }
  }

  /**
   * Mints generation N+1 and seals it to every current member.
   *
   * First writer wins for the whole generation: on GENERATION_CONFLICT the
   * minted key is dropped undisclosed, and the winner's copy arrives with
   * the engine's next key refresh. The local cache records the new key only
   * after the server accepts -- the same discipline commits keep.
   */
  async #rotateHistoryKey(
    conversationId: string,
    recipients: RecipientsResponse,
  ): Promise<void> {
    const sealable = recipients.members.filter(
      (member) => member.accountPublicKey !== null,
    );
    if (sealable.length !== recipients.members.length) {
      // A member with no account key cannot be sealed to, and a rotation
      // that skipped them would be refused (exact cover). Post-cutover this
      // should not exist; leave the conversation un-rotated and loud.
      console.warn(
        "history key rotation skipped: a member has no account key",
        conversationId,
      );
      return;
    }

    const { key, wrapped } = await mintRotation(
      sealable.map((member) => ({
        userId: member.userId,
        publicKey: decodeBase64(member.accountPublicKey!),
      })),
    );
    const generation = recipients.historyGeneration + 1;

    try {
      await postHistoryKeys({
        conversationId,
        generation,
        keys: wrapped.map((entry) => ({
          userId: entry.userId,
          wrappedKey: encodeBase64(entry.wrappedKey),
        })),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "GENERATION_CONFLICT") {
        return;
      }
      throw error;
    }

    await saveRotatedKey(conversationId, generation, key);
  }

  /**
   * The "share previous messages" backfill: seal every generation this
   * device holds to each listed member and post them as additive backfills.
   * Called by the UI after an add with sharing on. The honest limit: an
   * adder can only share generations they hold, so somebody who joined late
   * shares only from their own join point.
   */
  async shareHistory(
    conversationId: string,
    userIds: readonly string[],
  ): Promise<void> {
    const recipients = await fetchRecipients(conversationId);
    const targets = recipients.members
      .filter(
        (member) =>
          userIds.includes(member.userId) && member.accountPublicKey !== null,
      )
      .map((member) => ({
        userId: member.userId,
        publicKey: decodeBase64(member.accountPublicKey!),
      }));
    if (targets.length === 0) return;

    const batches = await mintBackfill(conversationId, targets);
    for (const batch of batches) {
      await postHistoryKeys({
        conversationId,
        generation: batch.generation,
        keys: batch.keys.map((entry) => ({
          userId: entry.userId,
          wrappedKey: encodeBase64(entry.wrappedKey),
        })),
      });
    }
  }

  /**
   * The external join: fetch the published GroupInfo, build an external
   * commit on it locally, post it through the ordinary commit path. Returns
   * the epoch joined at, or null when this sweep cannot join -- no current
   * GroupInfo after all (it moved between the recipients read and this
   * fetch), or the epoch race was lost. Both resolve on a later sweep, by
   * this path again or by a welcome, whichever comes first.
   */
  async #tryExternalJoin(
    conversationId: string,
    me: Identity,
    expectedEpoch: number,
  ): Promise<number | null> {
    const handshake = e2e.handshake!;

    const { groupInfo } = await fetchGroupInfo(conversationId);
    // Stale means the commit this join would build can only lose the epoch
    // race -- don't bother building it.
    if (!groupInfo || groupInfo.epoch !== expectedEpoch) return null;

    const joined = await handshake.joinExternal(
      conversationId,
      me,
      decodeBase64(groupInfo.payload),
      async ({ epoch, commit }) =>
        await this.#deliverCommit(conversationId, {
          epoch,
          payload: encodeBase64(commit),
          welcomes: [],
        }),
    );
    if (joined === null) return null;

    // The joiner holds the newest state, so the next joiner's bootstrap is
    // its to publish.
    await this.#publishGroupInfo(conversationId);
    return joined;
  }

  /**
   * Publishes the current state's GroupInfo -- the external-join bootstrap.
   * Best-effort by design: a failed publish costs nothing but the next new
   * device's fast path, the sweep it rides on must not back off over it,
   * and every later commit tries again.
   */
  async #publishGroupInfo(conversationId: string): Promise<void> {
    const handshake = e2e.handshake!;
    try {
      const exported = await handshake.exportGroupInfo(conversationId);
      if (!exported) return;
      await putGroupInfo({
        conversationId,
        epoch: exported.epoch,
        payload: encodeBase64(exported.groupInfo),
      });
    } catch (error) {
      console.warn("group info publish failed", conversationId, error);
    }
  }

  /**
   * Posts a commit; false means it lost the epoch race (the provider then
   * discards the tentative state). The next sweep catches up and retries.
   */
  async #deliverCommit(
    conversationId: string,
    body: {
      epoch: number;
      payload: string;
      welcomes: { deviceId: string; payload: string }[];
    },
  ): Promise<boolean> {
    try {
      await postCommit({ conversationId, ...body });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "EPOCH_CONFLICT") {
        this.invalidate();
        return false;
      }
      throw error;
    }
  }

  /**
   * Applies every commit after `fromEpoch`. Returns the epoch reached, or
   * null when this conversation is over for us -- removed from the group,
   * or our state turned out to be a creation-race loser and was discarded.
   */
  async #applyCommits(
    conversationId: string,
    fromEpoch: number,
  ): Promise<number | null> {
    const handshake = e2e.handshake!;
    let epoch = fromEpoch;

    for (;;) {
      const { commits } = await fetchCommits({
        conversationId,
        afterEpoch: epoch,
      });
      if (commits.length === 0) return epoch;

      for (const commit of commits) {
        try {
          const result = await handshake.applyCommit(
            conversationId,
            decodeBase64(commit.payload),
          );
          if (result.removed) return null;
          epoch = result.epoch;
        } catch (error) {
          if (
            error instanceof E2EError &&
            error.code === "EPOCH_UNAVAILABLE" &&
            epoch === 0
          ) {
            // Our epoch-0 state cannot apply the group's first commit: we
            // created a group nobody else followed -- the creation race's
            // loser. Discard it and wait to be welcomed into the real one.
            await handshake.forgetGroup(conversationId);
            return null;
          }
          throw error;
        }
      }
    }
  }
}

export const mlsSync = new MlsSync();
