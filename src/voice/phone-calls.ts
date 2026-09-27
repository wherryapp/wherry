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
import { PAGE_ONLY, readAction, readCapabilities } from "./phone-rules";

/** Which surface rings on this device. "page" is the in-app sheet
 *  (IncomingCall.tsx) and nothing native; "notification" is Android's
 *  CallStyle ring, posted only while the activity is not resumed (the page
 *  still rings when it is); "callkit" is iOS's system call screen, which
 *  then owns ringing in every app state and the page's sheet stands down
 *  (phone-rules.ts's `ringUiOwnsRinging`). */
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

/** Why a ring (or a call) ended, in the vocabulary the native side maps to
 *  CallKit's `CXCallEndedReason` or to cancelling Android's notification.
 *  The first five are the server's `ring_ended` reasons (plan §4.2); the
 *  last three the page alone can know. */
export type PhoneEndReason =
  | "answered"
  | "answered_elsewhere"
  | "declined_elsewhere"
  | "cancelled"
  | "unanswered"
  /** Declined on this device, through the page's sheet. */
  | "declined"
  /** An answered call is over (hung up here or by the far end). */
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

export type ActiveReport = {
  active: boolean;
  callId: string | null;
  label: string | null;
  /** No camera or screen either way: Android holds a proximity wake lock,
   *  iOS turns proximity monitoring on. */
  audioOnly: boolean;
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
  /** The PushKit token, hex; null where there is none (Android, a stub, or
   *  PushKit has not issued one yet -- the `push-token` event follows). */
  pushToken(): Promise<string | null>;
  /** A ring that reached the page (over the socket). Android: no-op while
   *  the activity is resumed, else its ring notification. iOS: CallKit,
   *  deduplicated by the call's UUID. */
  reportIncoming(input: IncomingReport): Promise<void>;
  /** The call's lifetime: Android's foreground service, iOS proximity (and,
   *  from N1, CallKit's connected state). */
  setActive(input: ActiveReport): Promise<void>;
  reportEnded(input: { callId: string; reason: PhoneEndReason }): Promise<void>;
  /** An outgoing call, for CallKit (N1) and later Android's telecom (A3). */
  startOutgoing(input: { callId: string; label: string }): Promise<void>;
  takePendingActions(): Promise<PhoneAction[]>;
  /** Runs the native push handler on a payload without APNs or FCM. Debug
   *  builds only; a release build rejects, and this resolves anyway. */
  debugIncoming(payload: Readonly<Record<string, unknown>>): Promise<void>;
  onAction(listener: (action: PhoneAction) => void): Promise<() => void>;
  onPushToken(listener: (token: string) => void): Promise<() => void>;
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

  async pushToken(): Promise<string | null> {
    const raw = await this.#call("push_token");
    if (typeof raw !== "object" || raw === null) return null;
    const token = (raw as Record<string, unknown>)["token"];
    return typeof token === "string" && token.length > 0 ? token : null;
  }

  async reportIncoming(input: IncomingReport): Promise<void> {
    await this.#call("report_incoming", input);
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

  async debugIncoming(payload: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#call("debug_incoming", { payload });
  }

  async onAction(listener: (action: PhoneAction) => void): Promise<() => void> {
    return this.#listen<unknown>("action", (raw) => {
      const action = readAction(raw);
      if (action) listener(action);
    });
  }

  async onPushToken(listener: (token: string) => void): Promise<() => void> {
    return this.#listen<unknown>("push-token", (raw) => {
      const token =
        typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["token"] : null;
      if (typeof token === "string" && token.length > 0) listener(token);
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
