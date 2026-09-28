// The phones' native call pieces, from the page's side: the `PhoneCalls`
// interface (docs/prompts/phone-calls-plan.md §5.2) and its one
// implementation over the `wherry-calls` Tauri plugin.
//
// Why a plugin at all: a webview cannot ring a locked or killed phone, and
// on Android it loses the microphone when the app is backgrounded unless a
// foreground service runs. Those are the gaps; the plugin
// (client/src-tauri/plugins/wherry-calls/) is the native mechanism, and this
// file is the named boundary the shell's rule asks for -- decisions in
// TypeScript (phone-rules.ts, phone-bridge.ts), mechanism in Kotlin and
// Swift.
//
// The command set is fixed here, by stage PC1, so the Android stages (A1,
// A2) and CallKit (I1) fill native bodies without editing a shared file.
// Adding a command is a PC1 follow-up through the integrator (the plan's §9).
//
// Same posture as vault.ts: best-effort, and a failure is absorbed. Outside
// the phone shells -- the web, and the desktop shell, which does not carry
// the plugin -- every call is inert and `capabilities()` answers
// `{ ringUi: "page" }`, so callers never branch on a platform. Presence is
// feature-detected: the first `capabilities()` either answers or rejects,
// and a rejection means "no plugin here" for the rest of the page's life.

import { isTauriShell } from "../api/shell";
import {
  PAGE_ONLY,
  readAction,
  readCapabilities,
  readIncomingAnswer,
  readVoipToken,
} from "./phone-rules";

/** Which surface rings on this device. "page" is the in-app sheet
 *  (IncomingCall.tsx) and nothing native; "notification" is Android's
 *  CallStyle ring, posted only while the activity is not resumed (the page
 *  still rings when it is); "callkit" is iOS's system call screen. Whether
 *  the native surface took a *given* ring is that ring's `reportIncoming`
 *  answer, and phone-rules.ts's `pageRingDuties` decides from both what the
 *  page itself still draws, sounds and posts (one ring UI per device, plan
 *  §2.7). */
export type RingUi = "page" | "notification" | "callkit";

/** What the native side can do *as built*. A stub answers `"page"` and
 *  false everywhere; each stage flips its own field when its native body
 *  lands (A1 `callService`, A2 `"notification"`, I1 `"callkit"` and
 *  `voip`), so a half-built plugin never silences the page's ring. */
export type PhoneCapabilities = {
  ringUi: RingUi;
  /** Android: a `microphone` foreground service runs for every call. */
  callService: boolean;
  /** iOS: PushKit issues a VoIP token (the `push-token` event). */
  voip: boolean;
};

/**
 * Why a ring the page reported has gone from the page's rings, as the page
 * tells the native side (`reportEnded`). **Not every reason ends a call.**
 * The page sends `answered` right after *every* Answer on this device --
 * the sheet's, and one pressed on CallKit or on Android's notification --
 * because the ring leaves the page's rings either way. What each reason
 * must do natively:
 *
 * | reason               | iOS (CallKit)                                         | Android                      |
 * |----------------------|-------------------------------------------------------|------------------------------|
 * | `answered`           | **end nothing.** A CallKit call answered here stays up; its end arrives later as `ended`, `setActive({active: false})`, or `setActive({pageOwnsAudio: true})` once the page's call is up in front (branch B of I-58) | cancel the ring notification |
 * | `answered_elsewhere` | `reportCall(with:endedAt:reason: .answeredElsewhere)` | cancel the ring notification |
 * | `declined_elsewhere` | `reportCall(…, reason: .declinedElsewhere)`           | cancel the ring notification |
 * | `cancelled`          | `reportCall(…, reason: .remoteEnded)` (the caller hung up) | cancel the ring notification |
 * | `unanswered`         | `reportCall(…, reason: .unanswered)`                  | cancel the ring notification |
 * | `declined`           | declined on this device: a call CallKit still holds for it ends as a *local* end (`CXEndCallAction`), not with a remote reason | cancel the ring notification |
 * | `ended`              | `reportCall(…, reason: .remoteEnded)` for a call CallKit still holds | cancel the ring notification |
 * | `failed`             | `reportCall(…, reason: .failed)`                      | cancel the ring notification |
 *
 * The first five spellings are also the server's `ring_ended` reasons (plan
 * §4.2), which the native push handler reads on its own; here they come from
 * the page, and `answered` always means *this* device. Mapping every reason
 * to a `CXCallEndedReason` is the mistake the table is for: it hangs up the
 * call the person has just answered on CallKit.
 */
export type PhoneEndReason =
  /** This device took it: its sheet, or a native Answer the page carried
   *  out. Stops a ring; never ends a call. */
  | "answered"
  | "answered_elsewhere"
  | "declined_elsewhere"
  | "cancelled"
  | "unanswered"
  /** Declined on this device, through the sheet or a native Decline. */
  | "declined"
  /** Gone for a reason the page cannot name more precisely, or an answered
   *  call is over. */
  | "ended"
  /** The call could not be joined. */
  | "failed";

export type PhoneActionKind = "answer" | "decline" | "hangup";

/** A press on the native call UI (CallKit, or Android's notification),
 *  delivered live as the `action` event or, when the page was not
 *  listening, queued natively and drained by `takePendingActions()`. */
export type PhoneAction = {
  kind: PhoneActionKind;
  callId: string;
  /** From the ring payload (`conv`), so an Answer can bring the
   *  conversation up before the page has listed its rings. Absent when the
   *  native side never saw a payload for the call. */
  conversationId?: string | null;
  /** When the press happened, ms since the epoch on this device's clock.
   *  A queued Answer older than the ring window is dropped
   *  (`pendingActionVerdict`). */
  at?: number | null;
};

export type IncomingReport = {
  callId: string;
  conversationId: string;
  /** Names only, never content (rule 1; the push plan's D1). */
  label: string;
  group: boolean;
  /** When the ring window closes, seconds since the epoch -- the same unit
   *  as the push payload's `exp`. */
  exp: number;
};

/**
 * What `reportIncoming` answers. `shown` is true when the native side has
 * taken this ring, so the page must not ring over it:
 * - iOS: CallKit is showing it, including a UUID it already had from a VoIP
 *   push (`callUUIDAlreadyExists`), or the system filtered it on purpose
 *   (`filteredByDoNotDisturb`, `filteredByBlockList`), which the page must
 *   not override;
 * - Android: the ring notification was posted.
 *
 * False when nothing native rings for it -- a stub, Android while the
 * activity is resumed, any other CallKit refusal, or any failure -- and the
 * page's sheet then rings exactly as it does without a plugin. A native
 * side that cannot tell answers false: a double ring is a defect, a missed
 * one is a missed call.
 */
export type IncomingAnswer = { shown: boolean };

/**
 * The PushKit token and what its registration needs (plan §5.2, hunk H4),
 * as `pushToken()` answers and the `push-token` event carries it:
 * `{ token, environment, p256dh, auth }` on the wire.
 * - `environment`: the APNs host of this signed build, which the page must
 *   pass because PushKit needs no notification permission, so the push
 *   plugin may never have obtained the alert token its own report of the
 *   environment waits on.
 * - `keys`: the public half of the key pair the plugin decrypts rings with
 *   (M-1 = E), unpadded base64url.
 * Either may be null on the page's side; `registerNativeToken` then refuses
 * the registration before any request, naming what is missing.
 */
export type VoipToken = {
  /** Hex. */
  token: string;
  environment: "sandbox" | "production" | null;
  keys: { p256dh: string; auth: string } | null;
};

export type ActiveReport = {
  active: boolean;
  callId: string | null;
  label: string | null;
  /** No camera or screen either way: Android holds a proximity wake lock,
   *  iOS turns proximity monitoring on. */
  audioOnly: boolean;
  /** The page's call is connected and the page is in front: CallKit has
   *  carried the ring, and the iOS plugin ends its call without ending the
   *  page's (branch B of row I-58; phone-rules.ts's `nativeActiveCall`). */
  pageOwnsAudio: boolean;
};

export interface PhoneCalls {
  /** Whether the plugin is in this build and answering. False on the web
   *  and in the desktop shell; the one question a caller may ask before
   *  doing any work for the native side. */
  available(): Promise<boolean>;
  capabilities(): Promise<PhoneCapabilities>;
  /** Where `decline-signed` goes, and whose device this is. */
  configure(input: { apiBase: string; deviceId: string }): Promise<void>;
  /** The on-device label cache that names a ring the page never saw
   *  (conversation id to display name, at most 500 entries). */
  setLabels(labels: Readonly<Record<string, string>>): Promise<void>;
  /** The PushKit token with its environment and keys; null where there is
   *  none (Android, a stub, or PushKit has not issued one yet -- the
   *  `push-token` event follows). */
  pushToken(): Promise<VoipToken | null>;
  /** A ring that reached the page (over the socket). Android: no-op while
   *  the activity is resumed, else its ring notification. iOS: CallKit,
   *  deduplicated by the call's UUID. Answers whether the native side took
   *  it; never rejects, and any failure reads as `{ shown: false }`. */
  reportIncoming(input: IncomingReport): Promise<IncomingAnswer>;
  /** The call's lifetime: Android's foreground service, iOS proximity (and,
   *  from N1, CallKit's connected state). */
  setActive(input: ActiveReport): Promise<void>;
  reportEnded(input: { callId: string; reason: PhoneEndReason }): Promise<void>;
  /** An outgoing call, for CallKit (N1) and later Android's telecom (A3). */
  startOutgoing(input: { callId: string; label: string }): Promise<void>;
  takePendingActions(): Promise<PhoneAction[]>;
  /** The account signed out of this page, which stays loaded (App.tsx's
   *  signOutLocally does not reload it). Forget what belonged to it: the
   *  label cache, queued actions, and any ring still showing. `configure`'s
   *  values stay -- the API base and the device id are the device's, and the
   *  device id outlives a sign-out on purpose (api/session.ts). */
  resetAccount(): Promise<void>;
  /** Runs the native push handler on a payload without APNs or FCM. Debug
   *  builds only; a release build rejects, and this resolves anyway. */
  debugIncoming(payload: Readonly<Record<string, unknown>>): Promise<void>;
  onAction(listener: (action: PhoneAction) => void): Promise<() => void>;
  onPushToken(listener: (token: VoipToken) => void): Promise<() => void>;
  /** CallKit's own mute button (I1). */
  onMute(listener: (event: { callId: string; muted: boolean }) => void): Promise<() => void>;
}

const PLUGIN = "wherry-calls";

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(`plugin:${PLUGIN}|${command}`, args);
}

async function listen<T>(event: string, listener: (payload: T) => void): Promise<() => void> {
  const core = await import("@tauri-apps/api/core");
  const handle = await core.addPluginListener<T>(PLUGIN, event, listener);
  return () => {
    void handle.unregister().catch(() => {});
  };
}

const NOTHING = (): void => {};

class PluginPhoneCalls implements PhoneCalls {
  /** Resolves true once the plugin has answered; false where it is absent
   *  (the web, the desktop shell, or a phone build without it). */
  #present: Promise<boolean> | null = null;
  #capabilities: PhoneCapabilities = PAGE_ONLY;

  #probe(): Promise<boolean> {
    this.#present ??= (async () => {
      if (!isTauriShell()) return false;
      try {
        this.#capabilities = readCapabilities(await invoke<unknown>("capabilities"));
        return true;
      } catch {
        return false;
      }
    })();
    return this.#present;
  }

  async #call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!(await this.#probe())) return null;
    try {
      return await invoke<unknown>(command, args);
    } catch {
      // Best-effort, like the vault: a native failure costs the native
      // nicety, never the page's own call.
      return null;
    }
  }

  available(): Promise<boolean> {
    return this.#probe();
  }

  async capabilities(): Promise<PhoneCapabilities> {
    await this.#probe();
    return this.#capabilities;
  }

  async configure(input: { apiBase: string; deviceId: string }): Promise<void> {
    await this.#call("configure", input);
  }

  async setLabels(labels: Readonly<Record<string, string>>): Promise<void> {
    await this.#call("set_labels", { labels });
  }

  async pushToken(): Promise<VoipToken | null> {
    return readVoipToken(await this.#call("push_token"));
  }

  async reportIncoming(input: IncomingReport): Promise<IncomingAnswer> {
    return readIncomingAnswer(await this.#call("report_incoming", input));
  }

  async setActive(input: ActiveReport): Promise<void> {
    await this.#call("set_active", input);
  }

  async reportEnded(input: { callId: string; reason: PhoneEndReason }): Promise<void> {
    await this.#call("report_ended", input);
  }

  async startOutgoing(input: { callId: string; label: string }): Promise<void> {
    await this.#call("start_outgoing", input);
  }

  async takePendingActions(): Promise<PhoneAction[]> {
    const raw = await this.#call("take_pending_actions");
    if (typeof raw !== "object" || raw === null) return [];
    const actions = (raw as Record<string, unknown>)["actions"];
    if (!Array.isArray(actions)) return [];
    return actions.map(readAction).filter((a): a is PhoneAction => a !== null);
  }

  async resetAccount(): Promise<void> {
    await this.#call("reset_account");
  }

  async debugIncoming(payload: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#call("debug_incoming", { payload });
  }

  async onAction(listener: (action: PhoneAction) => void): Promise<() => void> {
    return this.#listen<unknown>("action", (raw) => {
      const action = readAction(raw);
      if (action) listener(action);
    });
  }

  async onPushToken(listener: (token: VoipToken) => void): Promise<() => void> {
    return this.#listen<unknown>("push-token", (raw) => {
      const token = readVoipToken(raw);
      if (token) listener(token);
    });
  }

  async onMute(
    listener: (event: { callId: string; muted: boolean }) => void,
  ): Promise<() => void> {
    return this.#listen<unknown>("mute", (raw) => {
      if (typeof raw !== "object" || raw === null) return;
      const record = raw as Record<string, unknown>;
      const callId = record["callId"];
      const muted = record["muted"];
      if (typeof callId === "string" && typeof muted === "boolean") listener({ callId, muted });
    });
  }

  async #listen<T>(event: string, listener: (payload: T) => void): Promise<() => void> {
    if (!(await this.#probe())) return NOTHING;
    try {
      return await listen<T>(event, listener);
    } catch {
      return NOTHING;
    }
  }
}

export const phoneCalls: PhoneCalls = new PluginPhoneCalls();
