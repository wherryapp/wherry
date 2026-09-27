// The ring: who is calling, from which conversation, Answer or Decline.
// Shown on every device of the callee until one of them answers, the
// caller cancels, or the window closes -- voice/rules.ts decides which
// rings are live; this only draws the first of them and plays the tone.
//
// On a phone it is also where the ring meets the native call pieces
// (voice/phone-bridge.ts; docs/prompts/phone-calls-plan.md §5.3): the ring
// is reported to the plugin, and where the plugin owns ringing (CallKit)
// the sheet, its tone and its back layer stand down while the bridge keeps
// running.

import { useEffect } from "react";
import { declineCall } from "../../api/client";
import type { StoredConversation } from "../../store/types";
import { conversationTitle } from "../format";
import { Button, PhoneIcon, PhoneOffIcon } from "../kit";
import { UserAvatar } from "../UserAvatar";
import type { Ring } from "../../voice/rules";
import { shouldRingAudibly } from "../../voice/rules";
import { startRing } from "../../voice/sounds";
import { useVoicePrefs } from "../../voice/hooks";
import { useSelfStatus } from "../hooks";
import { voice } from "../../voice/session";
import { notifyDesktopCall, windowIsFocused } from "../../sync/desktop-notify";
import { useBackLayer } from "../back";
import {
  notePhoneAnswered,
  notePhoneDeclined,
  usePhoneCallBridge,
  usePhoneCapabilities,
} from "../../voice/phone-bridge";
import { ringUiOwnsRinging } from "../../voice/phone-rules";

export function IncomingCall({
  ring,
  conversation,
  selfUserId,
  onDismiss,
}: {
  ring: Ring;
  /** May be undefined for a beat while the list catches up. */
  conversation: StoredConversation | undefined;
  selfUserId: string;
  onDismiss: (callId: string) => void;
}) {
  const prefs = useVoicePrefs();
  const caller = conversation?.members.find((m) => m.userId === ring.byUserId);
  const callerName = caller ? caller.displayName || caller.username : "Someone";
  const title = conversation ? conversationTitle(conversation, selfUserId) : "";
  const isGroup = (conversation?.members.length ?? 0) > 2;
  const selfStatus = useSelfStatus();
  // CallKit rings on its own screen in every app state; a second ring on
  // the page would be two answers to one call.
  const nativeOwnsRing = ringUiOwnsRinging(usePhoneCapabilities());
  usePhoneCallBridge({ ring, selfUserId, onDismiss });
  const audible = !nativeOwnsRing && shouldRingAudibly({
    conversationMuted: conversation?.muted ?? false,
    ringtoneEnabled: prefs.ringtone,
    // Do-not-disturb: the ring still shows, silently -- the server already
    // skipped the push for the same reason.
    dnd: selfStatus.status === "dnd",
  });

  useEffect(() => {
    if (!audible) return;
    const loop = startRing();
    return () => loop?.stop();
  }, [audible, ring.callId]);

  // The desktop shell has no push: a ring that lands while the window is
  // in the background gets the plugin's notification instead.
  useEffect(() => {
    if (nativeOwnsRing || windowIsFocused()) return;
    void notifyDesktopCall(callerName);
  }, [ring.callId, callerName, nativeOwnsRing]);

  const answer = (): void => {
    if (!conversation) return;
    notePhoneAnswered(ring.callId);
    onDismiss(ring.callId);
    void voice.answerCall(ring.callId, conversation);
  };

  const decline = (): void => {
    notePhoneDeclined(ring.callId);
    onDismiss(ring.callId);
    void declineCall(ring.callId).catch(() => {});
  };

  // Back declines. This sheet was the one dismissible layer that never
  // registered, so on Android a back press during a ring at the top level
  // had no entry of ours to spend and quit the app with the far end still
  // ringing (found 2026-09-08, reading the code). Decline rather than a
  // swallowed press: dismissing a ring is what back means on a phone, and
  // a press that did nothing would read as a hung screen.
  //
  // Escape is the other way round: it declines nothing and closes nothing
  // (`"never"`). A ring arrives unasked, often mid-keystroke -- somebody
  // pressing Escape to leave Settings as it lands must not turn a call away
  // -- and the sheet is modal, so the key must not reach the screen under it
  // either, which it did while every layer listened for itself.
  //
  // Not while CallKit owns the ring: nothing is drawn, so there is no layer
  // for back to close.
  useBackLayer(!nativeOwnsRing, decline, { escape: "never" });

  if (nativeOwnsRing) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Incoming call from ${callerName}`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-neutral-900/40 p-4 sm:items-center"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl dark:bg-neutral-900">
        <div className="flex justify-center">
          <UserAvatar
            size="lg"
            name={callerName}
            userId={ring.byUserId}
            hue={caller?.avatarHue ?? null}
            avatarKey={caller?.avatarKey ?? null}
          />
        </div>
        <p className="mt-4 text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {callerName}
        </p>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {isGroup ? `is calling ${title}` : "is calling you"}
        </p>
        <div className="mt-6 flex justify-center gap-4">
          <Button
            variant="secondary"
            onClick={decline}
            className="flex min-w-[7rem] items-center justify-center gap-2 !bg-red-600 !text-white hover:!bg-red-700"
          >
            <PhoneOffIcon className="h-4 w-4" />
            Decline
          </Button>
          <Button
            onClick={answer}
            disabled={!conversation}
            className="flex min-w-[7rem] items-center justify-center gap-2 !bg-emerald-600 hover:!bg-emerald-700"
          >
            <PhoneIcon className="h-4 w-4" />
            Answer
          </Button>
        </div>
      </div>
    </div>
  );
}
