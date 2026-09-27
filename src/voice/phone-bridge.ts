// The page's half of the phones' call integration: what it tells the
// native side (plugins/wherry-calls, through phone-calls.ts) and what it
// does with what the native side tells it (docs/prompts/phone-calls-plan.md
// §5.3). phone-rules.ts holds every decision; this file only feeds it and
// carries the answers out.
//
// Told to the native side:
//   - `configure` (where `decline-signed` goes, and this device's id) and
//     the label cache (`setLabels`), at start and whenever the conversation
//     list changes;
//   - every ring the page shows (`reportIncoming`) and why it went
//     (`reportEnded`);
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
// Where it runs: `usePhoneCallBridge` is mounted by IncomingCall.tsx, as
// the plan's §5.3 says, and the controller it starts then runs for the
// page's life. IncomingCall only mounts while a ring is showing, so on a
// page that has never rung, nothing here has started -- see the stage log
// (PC1) for the always-mounted start this still owes.

import { useEffect, useSyncExternalStore } from "react";
import { API_BASE } from "../api/base";
import { declineCall } from "../api/client";
import { storedDeviceId } from "../api/session";
import { store } from "../store";
import type { StoredConversation } from "../store/types";
import { sync, type SyncEvent } from "../sync/engine";
import { phoneCalls, type PhoneAction, type PhoneCalls, type PhoneCapabilities } from "./phone-calls";
import {
  ACTION_TTL_MS,
  labelsKey,
  nativeActiveCall,
  nativeApiBase,
  nativeEndReason,
  PAGE_ONLY,
  pendingActionVerdict,
  ringDisplay,
  ringExpiry,
  ringGoneReason,
  ringLabels,
  type CallFrame,
} from "./phone-rules";
import type { Ring } from "./rules";
import { voice } from "./session";

/**
 * What the bridge needs from the push plan's client (PUSH-P4,
 * native-push-plan.md §7.1 and coordination §4): its one token
 * registration path, and its one "open this conversation from outside"
 * store. Injected rather than imported because PC1 merges before P4
 * (coordination §6); once P4 is on `next/native-gaps`, a PC1 follow-up
 * replaces `PUSH_PENDING` with `registerNativeToken` from
 * `sync/native-push.ts` and `requestOpen` from `ui/open-request.ts`.
 */
export type PushContract = {
  registerNativeToken(provider: "apns_voip", token: string): Promise<unknown>;
  requestOpen(request: { kind: "call"; conversationId: string }): void;
};

const PUSH_PENDING: PushContract = {
  registerNativeToken: async () => {
    console.info("[wherry] calls: VoIP token held; registration arrives with PUSH-P4");
  },
  requestOpen: () => {},
};

/** How many recent `call_state` frames are kept for the end reason. */
const FRAMES_KEPT = 32;

function log(message: string): void {
  console.info(`[wherry] calls: ${message}`);
}

class PhoneBridge {
  readonly #native: PhoneCalls;
  readonly #push: PushContract;
  #started = false;
  #selfUserId: string | null = null;
  #capabilities: PhoneCapabilities = PAGE_ONLY;
  #capabilityListeners = new Set<() => void>();
  #capabilityProbe: Promise<void> | null = null;

  #conversations: StoredConversation[] = [];
  #labels: Record<string, string> = {};
  #labelsKey = "";

  #frames = new Map<string, CallFrame>();
  /** Rings reported to the native side and when this device learned of them. */
  #reported = new Map<string, number>();
  /** What this device did to a ring itself: the only certain end reason. */
  #marked = new Map<string, "answered" | "declined">();
  #liveRings: Ring[] = [];
  /** A ring's end, deferred one tick so a remount can cancel it. */
  #goneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #dismiss: ((callId: string) => void) | null = null;
  #waiting: PhoneAction[] = [];
  #waitingTimer: ReturnType<typeof setTimeout> | null = null;

  #activeKey = "";
  #outgoingReported = new Set<string>();

  constructor(native: PhoneCalls, push: PushContract) {
    this.#native = native;
    this.#push = push;
  }

  // -- capabilities, for the sheet's synchronous render -------------------

  capabilities = (): PhoneCapabilities => this.#capabilities;

  subscribeCapabilities = (listener: () => void): (() => void) => {
    this.#capabilityListeners.add(listener);
    this.#probeCapabilities();
    return () => this.#capabilityListeners.delete(listener);
  };

  #probeCapabilities(): Promise<void> {
    this.#capabilityProbe ??= this.#native.capabilities().then(
      (capabilities) => {
        this.#capabilities = capabilities;
        for (const listener of this.#capabilityListeners) listener();
      },
      () => {},
    );
    return this.#capabilityProbe;
  }

  // -- start ----------------------------------------------------------------

  /** Idempotent. The first caller's account is the one the bridge serves. */
  start(selfUserId: string): void {
    if (this.#started) return;
    this.#started = true;
    this.#selfUserId = selfUserId;
    void this.#start().catch((error: unknown) => {
      console.warn("[wherry] calls: bridge start failed", error);
    });
  }

  async #start(): Promise<void> {
    if (!(await this.#native.available())) return;
    await this.#probeCapabilities();
    log(`bridge started (ringUi=${this.#capabilities.ringUi})`);

    const apiBase = nativeApiBase(API_BASE);
    const deviceId = storedDeviceId();
    if (apiBase && deviceId) await this.#native.configure({ apiBase, deviceId });

    await this.#refreshLabels();
    sync.subscribe((event) => this.#onSyncEvent(event));
    voice.subscribe(() => this.#onVoice());
    this.#onVoice();

    if (this.#capabilities.voip) {
      const register = (token: string): void => {
        void this.#push.registerNativeToken("apns_voip", token).catch((error: unknown) => {
          console.warn("[wherry] calls: VoIP token registration failed", error);
        });
      };
      await this.#native.onPushToken(register);
      const token = await this.#native.pushToken();
      if (token) register(token);
    }

    await this.#native.onAction((action) => this.#handle(action));
    await this.#native.onMute(({ callId, muted }) => {
      if (voice.getState().call?.id !== callId) return;
      void voice.setMicMuted(muted).catch(() => {});
    });
    for (const action of await this.#native.takePendingActions()) this.#handle(action);
  }

  // -- labels ---------------------------------------------------------------

  async #refreshLabels(): Promise<void> {
    const selfUserId = this.#selfUserId;
    if (!selfUserId) return;
    try {
      const list = await store.listConversations();
      // Newest first, as the sidebar's hook orders them: ids are UUIDv7.
      this.#conversations = [...list].sort((a, b) => b.id.localeCompare(a.id));
    } catch {
      return;
    }
    this.#retryWaiting();
    const labels = ringLabels(this.#conversations, selfUserId);
    const key = labelsKey(labels);
    this.#labels = labels;
    if (key === this.#labelsKey) return;
    this.#labelsKey = key;
    await this.#native.setLabels(labels);
  }

  // -- sync and voice events ------------------------------------------------

  #onSyncEvent(event: SyncEvent): void {
    try {
      if (event.type === "conversations") {
        void this.#refreshLabels();
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
      const call = state.call;
      if (
        report.active &&
        call &&
        call.kind === "call" &&
        call.startedByUserId === this.#selfUserId &&
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

  setDismiss(dismiss: ((callId: string) => void) | null): void {
    this.#dismiss = dismiss;
  }

  ringShown(ring: Ring): void {
    // The same ring back within a tick -- React's StrictMode remount in a
    // dev shell -- is not a new ring, and must not have ended the old one:
    // CallKit would refuse a UUID it was just told had ended.
    const pending = this.#goneTimers.get(ring.callId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.#goneTimers.delete(ring.callId);
    }
    if (!this.#liveRings.some((r) => r.callId === ring.callId)) {
      this.#liveRings = [...this.#liveRings, ring];
    }
    this.#retryWaiting();
    if (this.#reported.has(ring.callId)) return;
    this.#reported.set(ring.callId, ring.receivedAt);
    void (async () => {
      if (!(await this.#native.available())) return;
      if (!this.#conversations.some((c) => c.id === ring.conversationId)) {
        await this.#refreshLabels();
      }
      const conversation = this.#conversations.find((c) => c.id === ring.conversationId);
      const { label, group } = ringDisplay(conversation, this.#selfUserId ?? "");
      await this.#native.reportIncoming({
        callId: ring.callId,
        conversationId: ring.conversationId,
        label,
        group,
        exp: ringExpiry(ring.receivedAt),
      });
    })().catch(() => {});
  }

  ringGone(ring: Ring): void {
    this.#liveRings = this.#liveRings.filter((r) => r.callId !== ring.callId);
    if (this.#goneTimers.has(ring.callId)) return;
    this.#goneTimers.set(
      ring.callId,
      setTimeout(() => {
        this.#goneTimers.delete(ring.callId);
        this.#finishRing(ring);
      }, 0),
    );
  }

  #finishRing(ring: Ring): void {
    const receivedAt = this.#reported.get(ring.callId);
    const marked = this.#marked.get(ring.callId) ?? null;
    this.#marked.delete(ring.callId);
    if (receivedAt === undefined) return;
    this.#reported.delete(ring.callId);
    const frame = this.#frames.get(ring.callId);
    const reason = ringGoneReason({
      marked,
      frameReason: frame
        ? nativeEndReason(frame, this.#selfUserId ?? "", storedDeviceId())
        : null,
      receivedAt,
      now: Date.now(),
    });
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
          this.#dismiss?.(action.callId);
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
    this.#dismiss?.(action.callId);
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

const bridge = new PhoneBridge(phoneCalls, PUSH_PENDING);

/**
 * Mounted where the ring is (IncomingCall.tsx): starts the bridge once for
 * the signed-in account, reports this ring natively, and reports why it
 * went when it goes. The sheet's `onDismiss` is how a native Answer or
 * Decline takes the page's ring down too.
 */
export function usePhoneCallBridge(input: {
  ring: Ring;
  selfUserId: string;
  onDismiss: (callId: string) => void;
}): void {
  const { ring, selfUserId, onDismiss } = input;

  useEffect(() => {
    bridge.start(selfUserId);
  }, [selfUserId]);

  useEffect(() => {
    bridge.setDismiss(onDismiss);
    return () => bridge.setDismiss(null);
  }, [onDismiss]);

  useEffect(() => {
    bridge.ringShown(ring);
    return () => bridge.ringGone(ring);
    // The ring's identity is its call; a re-render with a new object for
    // the same call is the same ring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ring.callId]);
}

/** What the native side can do, for a synchronous render. Reads
 *  `PAGE_ONLY` until the plugin has answered (on the web and the desktop
 *  shell, for good). */
export function usePhoneCapabilities(): PhoneCapabilities {
  return useSyncExternalStore(
    bridge.subscribeCapabilities,
    bridge.capabilities,
    bridge.capabilities,
  );
}

/** The sheet's Answer and Decline, so the native side hears the certain
 *  reason when the ring goes. */
export function notePhoneAnswered(callId: string): void {
  bridge.markAnswered(callId);
}

export function notePhoneDeclined(callId: string): void {
  bridge.markDeclined(callId);
}
