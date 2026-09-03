// A hub voice channel's view -- what the thread area shows when a voice
// channel is selected. A room has no timeline: who is in it, a way in and
// out, the join-mute rule, and for moderators the two controls.

import { useState } from "react";
import { moderateVoice } from "../../api/client";
import type { StoredConversation } from "../../store/types";
import { Button, ClassPill, LockIcon, MicIcon, MicOffIcon, PhoneOffIcon } from "../kit";
import { UserAvatar } from "../UserAvatar";
import { classLabel, isServerReadable } from "../hub-class";
import { mediaSupported } from "../../voice/devices";
import { useVoice } from "../../voice/hooks";
import { voice } from "../../voice/session";

export function VoiceRoom({
  conversation,
  occupants,
  selfUserId,
  canModerate,
}: {
  conversation: StoredConversation;
  /** User ids the server says are in the room (voice_presence). */
  occupants: readonly string[];
  selfUserId: string;
  canModerate: boolean;
}) {
  const state = useVoice();
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const here =
    state.conversationId === conversation.id &&
    (state.phase === "connected" || state.phase === "reconnecting");
  const joining = state.conversationId === conversation.id && state.phase === "connecting";
  // Readability decides the media class too: a readable hub has no MLS
  // group, so there is no exporter to derive a call key from and the SFU
  // relays frames it CAN open. Same label, same disclosure, both classes.
  const isPublic = isServerReadable(conversation.hubVisibility);

  // While connected, the SFU's roster is live (speaking, muted); before
  // that, the server's occupancy is what there is.
  const live = new Map(state.participants.map((p) => [p.userId, p]));
  const listed = here
    ? [selfUserId, ...state.participants.map((p) => p.userId)]
    : [...occupants];
  const names = new Map(
    conversation.members.map((m) => [m.userId, m.displayName || m.username] as const),
  );
  const hues = new Map(conversation.members.map((m) => [m.userId, m.avatarHue] as const));
  const keys = new Map(
    conversation.members.map((m) => [m.userId, m.avatarKey ?? null] as const),
  );

  const moderate = async (userId: string, action: "mute" | "disconnect"): Promise<void> => {
    if (!conversation.hubId) return;
    setBusyUser(userId);
    setError(null);
    try {
      await moderateVoice({ hubId: conversation.hubId, conversationId: conversation.id, userId, action });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work");
    } finally {
      setBusyUser(null);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-4">
      <div className="mx-auto w-full max-w-md">
        <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
          {isPublic ? (
            <>
              <ClassPill
                label={classLabel(conversation.hubVisibility ?? "public")}
              />
              <span>
                Voice in a {classLabel(conversation.hubVisibility ?? "public").toLowerCase()}{" "}
                hub is relayed by the server and not end-to-end encrypted.
              </span>
            </>
          ) : (
            <>
              <LockIcon className="h-4 w-4 text-accent-600 dark:text-accent-400" />
              <span>End-to-end encrypted, keyed from this channel's group.</span>
            </>
          )}
        </div>
        {conversation.joinMutedAbove !== null && (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {conversation.joinMutedAbove === 0
              ? "Everyone joins muted."
              : `Joining mutes you once more than ${conversation.joinMutedAbove} people are in.`}
          </p>
        )}

        <ul className="mt-4 divide-y divide-neutral-100 dark:divide-neutral-800">
          {listed.length === 0 && (
            <li className="py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
              Nobody is in here yet.
            </li>
          )}
          {listed.map((userId) => {
            const participant = live.get(userId);
            const me = userId === selfUserId;
            const speaking = participant?.speaking ?? false;
            const muted = me ? state.micMuted : (participant?.micMuted ?? false);
            return (
              <li key={userId} className="flex items-center gap-3 py-2">
                <span
                  className={`rounded-full ring-2 ring-offset-1 ring-offset-white dark:ring-offset-neutral-900 ${
                    speaking ? "ring-emerald-500" : "ring-transparent"
                  }`}
                >
                  <UserAvatar size="sm" name={names.get(userId) ?? "Someone"} userId={userId} hue={hues.get(userId) ?? null} avatarKey={keys.get(userId) ?? null} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-neutral-900 dark:text-neutral-100">
                  {me ? "You" : (names.get(userId) ?? "Someone")}
                </span>
                {(here || me) && (
                  <span className={`shrink-0 ${muted ? "text-neutral-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                    {muted ? <MicOffIcon className="h-4 w-4" /> : <MicIcon className="h-4 w-4" />}
                  </span>
                )}
                {canModerate && !me && (
                  <span className="flex shrink-0 gap-2 text-xs">
                    <button
                      onClick={() => void moderate(userId, "mute")}
                      disabled={busyUser === userId}
                      className="text-neutral-500 hover:underline disabled:opacity-50 dark:text-neutral-400"
                    >
                      Mute
                    </button>
                    <button
                      onClick={() => void moderate(userId, "disconnect")}
                      disabled={busyUser === userId}
                      className="text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                    >
                      Disconnect
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-6 flex justify-center">
          {here ? (
            <Button
              variant="secondary"
              onClick={() => void voice.leave()}
              className="flex items-center gap-2 !bg-red-600 !text-white hover:!bg-red-700"
            >
              <PhoneOffIcon className="h-4 w-4" />
              Leave
            </Button>
          ) : (
            <Button
              onClick={() => void voice.joinRoom(conversation)}
              loading={joining}
              disabled={!mediaSupported()}
            >
              {mediaSupported() ? "Join voice" : "Voice is not supported here"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
