// The ring: who is calling, from which conversation, Answer or Decline.
// Shown on every device of the callee until one of them answers, the
// caller cancels, or the window closes -- voice/rules.ts decides which
// rings are live; this only draws the first of them and plays the tone.

import { useEffect } from "react";
import { declineCall } from "../../api/client";
import type { StoredConversation } from "../../store/types";
import { conversationTitle } from "../format";
import { Avatar, Button, PhoneIcon, PhoneOffIcon } from "../kit";
import type { Ring } from "../../voice/rules";
import { shouldRingAudibly } from "../../voice/rules";
import { startRing } from "../../voice/sounds";
import { useVoicePrefs } from "../../voice/hooks";
import { useSelfStatus } from "../hooks";
import { voice } from "../../voice/session";
import { notifyDesktopCall } from "../../sync/desktop-notify";

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
  const audible = shouldRingAudibly({
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
    if (document.hasFocus()) return;
    void notifyDesktopCall(callerName);
  }, [ring.callId, callerName]);

  const answer = (): void => {
    if (!conversation) return;
    onDismiss(ring.callId);
    void voice.answerCall(ring.callId, conversation);
  };

  const decline = (): void => {
    onDismiss(ring.callId);
    void declineCall(ring.callId).catch(() => {});
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Incoming call from ${callerName}`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-neutral-900/40 p-4 sm:items-center"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl dark:bg-neutral-900">
        <div className="flex justify-center">
          <Avatar
            size="lg"
            name={callerName}
            userId={ring.byUserId}
            hue={caller?.avatarHue ?? null}
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
