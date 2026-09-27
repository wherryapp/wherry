// The page's half of the phones' call integration: what it tells the
// native side (plugins/wherry-calls, through phone-calls.ts) and what it
// does with what the native side tells it (docs/prompts/phone-calls-plan.md
// §5.3). phone-rules.ts holds every decision; this file only feeds it and
// carries the answers out.
//
// Told to the native side:
//   - `configure` (where `decline-signed` goes, and this device's id) and
//     the label cache (`setLabels`), when an account's run starts and
//     whenever the conversation list changes; `resetAccount` when it ends;
//   - every ring the page holds (`reportIncoming`, whose answer says whether
//     the native side took it) and why it went (`reportEnded`);
//   - the call's lifetime (`setActive`), and an outgoing call's start.
// Taken from the native side:
//   - presses on CallKit or on Android's notification (the `action` event,
//     and `takePendingActions` for the ones made before the page listened),
//     carried out through the voice session exactly as the sheet's buttons
//     are;
//   - the PushKit token, registered through the push plan's one
//     registration path;
//   - CallKit's mute button.
//
// Nothing here may throw into React or the sync loop (CLAUDE.md: a throw
// there can wedge every tap). Every native call is already best-effort
// (phone-calls.ts); the handlers below absorb the rest.
//
// Where it runs. Two lifetimes, neither of them a component's, because the
// sheet (IncomingCall.tsx) mounts only while a ring shows:
//   - The page's: installed when this module loads, which is at boot
//     (App.tsx imports Chat.tsx, which imports the sheet, statically). It
//     probes the plugin at once, so the sheet's first render already knows
//     whether CallKit may own the ring, and mirrors the voice session into
//     `setActive` from then on, so an outgoing call on a page that has
//     never rung still starts Android's call service.
//   - The account's: a *run*, started when the sync engine starts for a
//     signed-in account and ended when it stops. Sign-out does not reload
//     the page (App.tsx's signOutLocally), so the run is what keeps one
//     account's labels, frames, self id and token registration from
//     serving the next (phone-rules.ts's `bridgeRunStep`). The run is what
//     configures the plugin, registers the VoIP token and drains the queued
//     actions -- at sign-in, not at the first ring.
// The rings come from React, because the page's ring list is React state
// (voice/hooks.ts's useVoiceSignals, held by Chat.tsx). `usePhoneCallBridge`
// takes the whole list from Chat.tsx's body, beside that hook, so every ring
// is reported, not only the one the sheet shows. The sheet's own one-ring
// feed (`usePhoneSheetRing`) is ignored while the whole list is fed; it
// stays for a page that mounts the sheet without it.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { API_BASE } from "../api/base";
import { declineCall } from "../api/client";
import { loadSession, storedDeviceId } from "../api/session";
import { isTauriShell } from "../api/shell";
import { store } from "../store";
import type { StoredConversation } from "../store/types";
import { sync, type SyncEvent, type SyncState } from "../sync/engine";
import { withNativePush } from "../sync/push";
import { requestOpen } from "../ui/open-request";
import {
  phoneCalls,
  type PhoneAction,
  type PhoneCalls,
  type PhoneCapabilities,
  type VoipToken,
} from "./phone-calls";
import {
  ACTION_TTL_MS,
  bridgeRunStep,
  labelsKey,
  nativeActiveCall,
  nativeApiBase,
  nativeEndReason,
  PAGE_ONLY,
  pendingActionVerdict,
  PROBE_PATIENCE_MS,
  REPORT_PATIENCE_MS,
  ringDisplay,
  ringExpiry,
  ringGoneReason,
  ringLabels,
  ringsDiff,
  type CallFrame,
} from "./phone-rules";
import type { Ring } from "./rules";
import { voice } from "./session";

/**
 * What the bridge needs from the push plan's client (PUSH-P4,
 * native-push-plan.md §7.1 and coordination §4): its one token
 * registration path, and its one "open this conversation from outside"
 * store. A seam rather than two direct calls, so the bridge's class never
 * names the push module itself.
 */
export type PushContract = {
  /** Fire-and-forget: a failure is logged, never thrown into the run. */
  registerNativeToken(provider: "apns_voip", voip: VoipToken): void;
  requestOpen(request: { kind: "call"; conversationId: string }): void;
};

const NATIVE_PUSH: PushContract = {
  registerNativeToken: (provider, voip) => {
    // Through push.ts's `withNativePush`, the one way into
    // sync/native-push.ts: a dynamic import behind the phone-shell guard, so
    // the web bundle never fetches it (row W-107). The three-argument form
    // (hunk H4): PushKit needs no notification permission, so the push
    // plugin may have no alert token and so no environment to report, and
    // the keys are the calls plugin's own pair (M-1 = E). Missing either,
    // `registerNativeToken` throws before any request, which lands here.
    withNativePush((native) =>
      native
        .registerNativeToken(provider, voip.token, {
          environment: voip.environment,
          keys: voip.keys,
        })
        .catch((error: unknown) => {
          console.warn("[wherry] calls: VoIP token registration failed", error);
        }),
    );
  },
  requestOpen: (request) => requestOpen(request),
};

/** How many recent `call_state` frames are kept for the end reason. */
const FRAMES_KEPT = 32;

function log(message: string): void {
  console.info(`[wherry] calls: ${message}`);
}

/** Who feeds the page's rings: the whole list from an always-rendered
 *  place, or the one ring the sheet shows until that place exists. */
type FeedSource = "page" | "sheet";

/** One signed-in account's time with the bridge. Async work started for a
 *  run checks `alive` after every await, so a run that has ended never
 *  writes into the next account's state. */
type Run = {
  userId: string;
  alive: boolean;
  /** Native listeners to drop when the run ends. */
  cleanups: (() => void)[];
};

class PhoneBridge {
  readonly #native: PhoneCalls;
  readonly #push: PushContract;
  #uninstall: (() => void) | null = null;
  /** Capabilities and ring answers, for the sheet's synchronous render. */
  #listeners = new Set<() => void>();

  // -- the page's lifetime --------------------------------------------------

  /** Whether the plugin answered; null until the probe settles. */
  #present: boolean | null = null;
  /** Null while a shell's plugin has not answered: the sheet then waits
   *  (`pageRingDuties`). Known at once outside a shell. */
  #capabilities: PhoneCapabilities | null = isTauriShell() ? null : PAGE_ONLY;
  #capabilityProbe: Promise<void> | null = null;

  /** The page's rings as last fed, by whichever feed is authoritative. */
  #liveRings: Ring[] = [];
  /** The whole list is being fed, so the sheet's one-ring feed is ignored. */
  #pageFeed = false;
  /** A ring's end, deferred one tick so a remount can cancel it. */
  #goneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #dismissBy: Record<FeedSource, ((callId: string) => void) | null> = { page: null, sheet: null };
  /** Per ring: whether the native side took it (`reportIncoming`'s answer,
   *  or false once `REPORT_PATIENCE_MS` passed without one). Absent until
   *  then. */
  #shown = new Map<string, boolean>();
  #shownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #activeKey = "";

  // -- the account's run ----------------------------------------------------

  #run: Run | null = null;
  #stopTimer: ReturnType<typeof setTimeout> | null = null;
  #conversations: StoredConversation[] = [];
  #labels: Record<string, string> = {};
  #labelsKey = "";
  #frames = new Map<string, CallFrame>();
  /** Rings reported to the native side and when this device learned of them. */
  #reported = new Map<string, number>();
  /** What this device did to a ring itself: the only certain end reason. */
  #marked = new Map<string, "answered" | "declined">();
  #waiting: PhoneAction[] = [];
  #waitingTimer: ReturnType<typeof setTimeout> | null = null;
  #outgoingReported = new Set<string>();

  constructor(native: PhoneCalls, push: PushContract) {
    this.#native = native;
    this.#push = push;
  }

  // -- install --------------------------------------------------------------

  /** Once per page, at module load. */
  install(): void {
    if (this.#uninstall) return;
    void this.#probeCapabilities();
    const offSync = sync.subscribe((event) => this.#onSyncEvent(event));
    const offVoice = voice.subscribe(() => this.#onVoice());
    this.#uninstall = () => {
      offSync();
      offVoice();
      this.#cancelStop();
      this.#stopRun();
    };
    // Caught up in case the engine was already running when this loaded
    // (it is not today: App.tsx starts it after the first render).
    this.#onSyncStatus(sync.status.state);
  }

  /** A dev hot reload's replacement module installs its own bridge. */
  uninstall(): void {
    this.#uninstall?.();
    this.#uninstall = null;
  }

  // -- what the sheet reads ---------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  capabilities = (): PhoneCapabilities | null => this.#capabilities;

  ringShown(callId: string): boolean | null {
    return this.#shown.get(callId) ?? null;
  }

  #probeCapabilities(): Promise<void> {
    this.#capabilityProbe ??= (async () => {
      // A missing plugin rejects at once; one that never answers must not
      // keep the sheet silent for good.
      const patience = setTimeout(() => {
        if (this.#capabilities !== null) return;
        log(`no answer from the plugin in ${PROBE_PATIENCE_MS} ms; the page rings meanwhile`);
        this.#capabilities = PAGE_ONLY;
        this.#notify();
      }, PROBE_PATIENCE_MS);
      let present = false;
      let capabilities = PAGE_ONLY;
      try {
        present = await this.#native.available();
        if (present) capabilities = await this.#native.capabilities();
      } catch {
        present = false;
      }
      clearTimeout(patience);
      this.#present = present;
      this.#capabilities = capabilities;
      this.#notify();
    })();
    return this.#capabilityProbe;
  }

  // -- the account's run ------------------------------------------------------

  #onSyncStatus(state: SyncState): void {
    const step = bridgeRunStep({
      syncState: state,
      sessionUserId: loadSession()?.user.id ?? null,
      runUserId: this.#run?.userId ?? null,
    });
    switch (step) {
      case "keep":
        // The same account running again within the tick: a re-run effect,
        // not a sign-out.
        if (this.#run) this.#cancelStop();
        return;
      case "stop":
        this.#stopTimer ??= setTimeout(() => {
          this.#stopTimer = null;
          this.#stopRun();
        }, 0);
        return;
      case "switch":
      case "start": {
        this.#cancelStop();
        this.#stopRun();
        const userId = loadSession()?.user.id;
        if (userId) this.#startRun(userId);
        return;
      }
    }
  }

  #cancelStop(): void {
    if (this.#stopTimer === null) return;
    clearTimeout(this.#stopTimer);
    this.#stopTimer = null;
  }

  #startRun(userId: string): void {
    const run: Run = { userId, alive: true, cleanups: [] };
    this.#run = run;
    void this.#runStart(run).catch((error: unknown) => {
      console.warn("[wherry] calls: bridge start failed", error);
    });
  }

  /** A native listener the run owns, or dropped at once if it has ended. */
  #hold(run: Run, cleanup: () => void): void {
    if (run.alive) run.cleanups.push(cleanup);
    else cleanup();
  }

  async #runStart(run: Run): Promise<void> {
    await this.#probeCapabilities();
    if (!this.#present || !run.alive) return;
    log(`bridge started (ringUi=${this.#capabilities?.ringUi ?? "unknown"})`);

    const apiBase = nativeApiBase(API_BASE);
    const deviceId = storedDeviceId();
    if (apiBase && deviceId) await this.#native.configure({ apiBase, deviceId });

    await this.#refreshLabels(run);
    if (!run.alive) return;
    // The call's state afresh, with this account's label; and any ring the
    // page showed before the run could report it.
    this.#activeKey = "";
    this.#onVoice();
    for (const ring of this.#liveRings) this.#report(ring, run);

    if (this.#capabilities?.voip) {
      // Every run registers the token again: the push plan's logout deletes
      // the device's tokens server-side, so the next account's sign-in is
      // what makes the phone ringable again.
      const register = (voip: VoipToken): void => {
        if (!run.alive) return;
        this.#push.registerNativeToken("apns_voip", voip);
      };
      this.#hold(run, await this.#native.onPushToken(register));
      const token = run.alive ? await this.#native.pushToken() : null;
      if (token) register(token);
    }

    this.#hold(
      run,
      await this.#native.onAction((action) => {
        if (run.alive) this.#handle(action);
      }),
    );
    this.#hold(
      run,
      await this.#native.onMute(({ callId, muted }) => {
        if (!run.alive || voice.getState().call?.id !== callId) return;
        void voice.setMicMuted(muted).catch(() => {});
      }),
    );
    if (!run.alive) return;
    for (const action of await this.#native.takePendingActions()) {
      if (run.alive) this.#handle(action);
    }
  }

  /** Sign-out, a 401, the version wall, or another account. The native side
   *  forgets the account (`resetAccount`: its labels, queued actions and
   *  rings), and so does the bridge. */
  #stopRun(): void {
    const run = this.#run;
    if (!run) return;
    run.alive = false;
    this.#run = null;
    for (const cleanup of run.cleanups) {
      try {
        cleanup();
      } catch {
        // Best-effort, like every native call.
      }
    }
    this.#reported.clear();
    this.#marked.clear();
    this.#frames.clear();
    this.#waiting = [];
    if (this.#waitingTimer !== null) {
      clearTimeout(this.#waitingTimer);
      this.#waitingTimer = null;
    }
    this.#outgoingReported.clear();
    this.#conversations = [];
    this.#labels = {};
    this.#labelsKey = "";
    if (this.#present) {
      // The label cache names this account's conversations, and nothing of
      // it may outlive the sign-out -- store.clear()'s reasoning, on the
      // native side.
      void this.#native.resetAccount();
      log("bridge stopped");
    }
    // A call still up loses its label with the account.
    this.#onVoice();
  }

  // -- labels ---------------------------------------------------------------

  async #refreshLabels(run: Run): Promise<void> {
    let list: StoredConversation[];
    try {
      list = await store.listConversations();
    } catch {
      return;
    }
    if (!run.alive) return;
    // Newest first, as the sidebar's hook orders them: ids are UUIDv7.
    this.#conversations = [...list].sort((a, b) => b.id.localeCompare(a.id));
    this.#retryWaiting();
    const labels = ringLabels(this.#conversations, run.userId);
    const key = labelsKey(labels);
    this.#labels = labels;
    if (key === this.#labelsKey) return;
    this.#labelsKey = key;
    await this.#native.setLabels(labels);
  }

  // -- sync and voice events ------------------------------------------------

  #onSyncEvent(event: SyncEvent): void {
    try {
      if (event.type === "status") {
        this.#onSyncStatus(event.status.state);
        return;
      }
      const run = this.#run;
      if (!run) return;
      if (event.type === "conversations") {
        void this.#refreshLabels(run);
      } else if (event.type === "call_state") {
        this.#frames.delete(event.callId);
        this.#frames.set(event.callId, {
          status: event.status,
          reason: event.reason,
          participants: event.participants,
        });
        while (this.#frames.size > FRAMES_KEPT) {
          const oldest = this.#frames.keys().next().value;
          if (oldest === undefined) break;
          this.#frames.delete(oldest);
        }
        this.#retryWaiting();
      }
    } catch (error) {
      console.warn("[wherry] calls: sync event not handled", error);
    }
  }

  #onVoice(): void {
    if (this.#present === false) return;
    try {
      const state = voice.getState();
      const report = nativeActiveCall(state, this.#labels);
      const key = JSON.stringify(report);
      if (key !== this.#activeKey) {
        this.#activeKey = key;
        void this.#native.setActive(report);
      }
      // An outgoing call, once the server has given it an id: CallKit (N1)
      // and Android's telecom (A3) want to hear of it. A no-op until then.
      const run = this.#run;
      const call = state.call;
      if (
        run &&
        report.active &&
        call &&
        call.kind === "call" &&
        call.startedByUserId === run.userId &&
        !this.#outgoingReported.has(call.id)
      ) {
        this.#outgoingReported.add(call.id);
        void this.#native.startOutgoing({ callId: call.id, label: report.label ?? "" });
      }
    } catch (error) {
      console.warn("[wherry] calls: voice state not mirrored", error);
    }
  }

  // -- rings ----------------------------------------------------------------

  openFeed(source: FeedSource): void {
    if (source === "page") this.#pageFeed = true;
  }

  closeFeed(source: FeedSource): void {
    if (source === "sheet" && this.#pageFeed) return;
    this.feedRings(source, []);
    if (source === "page") this.#pageFeed = false;
  }

  /** The page's rings, whole: new ones are reported natively, gone ones
   *  ended (a tick later, so a remount that brings them back cancels it). */
  feedRings(source: FeedSource, rings: readonly Ring[]): void {
    if (source === "sheet" && this.#pageFeed) return;
    const { shown, gone } = ringsDiff(this.#liveRings, rings);
    this.#liveRings = [...rings];
    for (const ring of gone) this.#ringGone(ring);
    for (const ring of shown) this.#ringShown(ring);
    this.#retryWaiting();
  }

  setDismiss(source: FeedSource, dismiss: ((callId: string) => void) | null): void {
    this.#dismissBy[source] = dismiss;
  }

  #dismiss(callId: string): void {
    const dismiss = this.#pageFeed ? this.#dismissBy.page : this.#dismissBy.sheet;
    dismiss?.(callId);
  }

  #ringShown(ring: Ring): void {
    // The same ring back within a tick -- React's StrictMode remount in a
    // dev shell -- is not a new ring, and must not have ended the old one:
    // CallKit would refuse a UUID it was just told had ended.
    const pending = this.#goneTimers.get(ring.callId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.#goneTimers.delete(ring.callId);
    }
    const run = this.#run;
    if (run && this.#present !== false) this.#report(ring, run);
    // Nobody to report it: nothing native rings, so the page must.
    else this.#setShown(ring.callId, false);
  }

  #setShown(callId: string, shown: boolean): void {
    const timer = this.#shownTimers.get(callId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#shownTimers.delete(callId);
    }
    if (this.#shown.get(callId) === shown) return;
    this.#shown.set(callId, shown);
    this.#notify();
  }

  #forgetShown(callId: string): void {
    const timer = this.#shownTimers.get(callId);
    if (timer !== undefined) clearTimeout(timer);
    this.#shownTimers.delete(callId);
    if (this.#shown.delete(callId)) this.#notify();
  }

  #report(ring: Ring, run: Run): void {
    if (this.#reported.has(ring.callId)) return;
    this.#reported.set(ring.callId, ring.receivedAt);
    // The page rings if the answer is slow; a late `shown: true` still
    // stands it down.
    if (!this.#shown.has(ring.callId) && !this.#shownTimers.has(ring.callId)) {
      this.#shownTimers.set(
        ring.callId,
        setTimeout(() => {
          this.#shownTimers.delete(ring.callId);
          if (!this.#shown.has(ring.callId)) this.#setShown(ring.callId, false);
        }, REPORT_PATIENCE_MS),
      );
    }
    void (async () => {
      if (!(await this.#native.available()) || !run.alive) {
        if (run.alive) this.#setShown(ring.callId, false);
        return;
      }
      if (!this.#conversations.some((c) => c.id === ring.conversationId)) {
        await this.#refreshLabels(run);
        if (!run.alive) return;
      }
      // Gone while the labels loaded: its `reportEnded` has already been
      // sent, and a report now would ring a dead call until `exp`.
      if (!this.#reported.has(ring.callId)) return;
      const conversation = this.#conversations.find((c) => c.id === ring.conversationId);
      const { label, group } = ringDisplay(conversation, run.userId);
      const answer = await this.#native.reportIncoming({
        callId: ring.callId,
        conversationId: ring.conversationId,
        label,
        group,
        exp: ringExpiry(ring.receivedAt),
      });
      // Only while the ring is still the page's: a late answer for one that
      // has gone must not bring its entry back.
      if (run.alive && this.#reported.has(ring.callId)) this.#setShown(ring.callId, answer.shown);
    })().catch(() => {
      if (run.alive && this.#reported.has(ring.callId)) this.#setShown(ring.callId, false);
    });
  }

  #ringGone(ring: Ring): void {
    if (this.#goneTimers.has(ring.callId)) return;
    this.#goneTimers.set(
      ring.callId,
      setTimeout(() => {
        this.#goneTimers.delete(ring.callId);
        this.#forgetShown(ring.callId);
        this.#finishRing(ring);
      }, 0),
    );
  }

  #finishRing(ring: Ring): void {
    const receivedAt = this.#reported.get(ring.callId);
    const run = this.#run;
    if (receivedAt === undefined || !run) {
      this.#marked.delete(ring.callId);
      return;
    }
    const frame = this.#frames.get(ring.callId);
    const reason = ringGoneReason({
      marked: this.#marked.get(ring.callId) ?? null,
      frameReason: frame ? nativeEndReason(frame, run.userId, storedDeviceId()) : null,
      receivedAt,
      now: Date.now(),
    });
    this.#marked.delete(ring.callId);
    this.#reported.delete(ring.callId);
    // `answered` ends no call natively (phone-calls.ts's PhoneEndReason):
    // it follows every Answer here, CallKit's own included.
    void this.#native.reportEnded({ callId: ring.callId, reason });
  }

  /** The sheet's own buttons, so the end reason is certain. */
  markAnswered(callId: string): void {
    this.#marked.set(callId, "answered");
  }

  markDeclined(callId: string): void {
    this.#marked.set(callId, "declined");
  }

  // -- native actions -------------------------------------------------------

  #handle(action: PhoneAction): void {
    if (!this.#run) return;
    try {
      const state = voice.getState();
      const verdict = pendingActionVerdict(
        action,
        {
          ringing: this.#liveRings.some((r) => r.callId === action.callId),
          inCall: state.phase !== "idle" && state.call?.id === action.callId,
          ended: this.#frames.get(action.callId)?.status === "ended",
        },
        Date.now(),
      );
      switch (verdict.act) {
        case "answer":
          this.#answer(action);
          return;
        case "decline":
          this.markDeclined(action.callId);
          this.#dismiss(action.callId);
          void declineCall(action.callId).catch(() => {});
          return;
        case "hangup":
          void voice.leave().catch(() => {});
          return;
        case "wait":
          this.#wait(action);
          return;
        case "drop":
          log(`dropped ${action.kind} for ${action.callId} (${verdict.reason})`);
          return;
      }
    } catch (error) {
      console.warn("[wherry] calls: action not handled", error);
    }
  }

  #answer(action: PhoneAction): void {
    const ring = this.#liveRings.find((r) => r.callId === action.callId);
    const conversationId = ring?.conversationId ?? action.conversationId ?? null;
    const conversation = conversationId
      ? this.#conversations.find((c) => c.id === conversationId)
      : undefined;
    if (!conversation) {
      // Rings can outrun the conversation list on a cold start; the next
      // refresh retries it.
      this.#wait(action);
      return;
    }
    this.markAnswered(action.callId);
    this.#dismiss(action.callId);
    this.#push.requestOpen({ kind: "call", conversationId: conversation.id });
    void voice.answerCall(action.callId, conversation).catch(() => {});
  }

  /** Held until the rings or the conversation list change, and dropped by
   *  `pendingActionVerdict` once it is older than `ACTION_TTL_MS`. */
  #wait(action: PhoneAction): void {
    if (!this.#waiting.some((w) => w.callId === action.callId && w.kind === action.kind)) {
      // Stamp it now if the native side did not, so the wait ends.
      this.#waiting.push({ ...action, at: action.at ?? Date.now() });
    }
    if (this.#waitingTimer !== null) return;
    this.#waitingTimer = setTimeout(() => {
      this.#waitingTimer = null;
      this.#retryWaiting();
    }, ACTION_TTL_MS + 1_000);
  }

  #retryWaiting(): void {
    if (this.#waiting.length === 0) return;
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const action of waiting) this.#handle(action);
  }
}

const bridge = new PhoneBridge(phoneCalls, NATIVE_PUSH);
bridge.install();
if (import.meta.hot) import.meta.hot.dispose(() => bridge.uninstall());

/**
 * The page's whole ring list, from an always-rendered place: Chat.tsx's
 * body, beside `useVoiceSignals`, which owns the list --
 * `usePhoneCallBridge({ rings, onDismiss: dismissRing })`. Every ring is
 * then reported natively and every native Answer or Decline finds its ring,
 * not only the first. While this runs, the sheet's own feed is ignored.
 * In the body rather than in `withChrome`: a hook cannot be called from a
 * render helper, and the body also covers the one return without the
 * chrome (the invite landing page), where a ring must keep ringing natively.
 */
export function usePhoneCallBridge(input: {
  rings: readonly Ring[];
  onDismiss: (callId: string) => void;
}): void {
  const { rings, onDismiss } = input;

  useEffect(() => {
    bridge.openFeed("page");
    return () => bridge.closeFeed("page");
  }, []);

  useEffect(() => {
    bridge.feedRings("page", rings);
  }, [rings]);

  useEffect(() => {
    bridge.setDismiss("page", onDismiss);
    return () => bridge.setDismiss("page", null);
  }, [onDismiss]);
}

/**
 * The sheet's one ring (IncomingCall.tsx): ignored while `usePhoneCallBridge`
 * feeds the whole list, which Chat.tsx does; the fallback for a page that
 * shows the sheet without it. The sheet's `onDismiss` is then how a native
 * Answer or Decline takes the page's ring down too.
 */
export function usePhoneSheetRing(input: {
  ring: Ring;
  onDismiss: (callId: string) => void;
}): void {
  const { ring, onDismiss } = input;

  useEffect(() => {
    bridge.setDismiss("sheet", onDismiss);
    return () => bridge.setDismiss("sheet", null);
  }, [onDismiss]);

  useEffect(() => {
    bridge.feedRings("sheet", [ring]);
    return () => bridge.closeFeed("sheet");
    // The ring's identity is its call; a re-render with a new object for
    // the same call is the same ring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ring.callId]);
}

/** What the native side can do, for a synchronous render: `PAGE_ONLY` on
 *  the web, null in a shell until its plugin has answered (the probe runs
 *  at page load, long before any ring), then the answer. */
export function usePhoneCapabilities(): PhoneCapabilities | null {
  return useSyncExternalStore(bridge.subscribe, bridge.capabilities, bridge.capabilities);
}

/** Whether the native side took this ring (`reportIncoming`'s answer);
 *  null until it has answered or `REPORT_PATIENCE_MS` has passed. */
export function usePhoneRingShown(callId: string): boolean | null {
  const read = useCallback(() => bridge.ringShown(callId), [callId]);
  return useSyncExternalStore(bridge.subscribe, read, read);
}

/** The sheet's Answer and Decline, so the native side hears the certain
 *  reason when the ring goes. */
export function notePhoneAnswered(callId: string): void {
  bridge.markAnswered(callId);
}

export function notePhoneDeclined(callId: string): void {
  bridge.markDeclined(callId);
}
