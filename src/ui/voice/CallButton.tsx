// The thread header's call control for direct and group conversations:
// start a call, join the one already open, or hang up the one you are in.

import type { StoredConversation } from "../../store/types";
import { Button, IconButton, PhoneIcon, PhoneOffIcon } from "../kit";
import { mediaSupported } from "../../voice/devices";
import { useVoice, type OpenCall } from "../../voice/hooks";
import { voice } from "../../voice/session";

export function CallButton({
  conversation,
  openCall,
}: {
  conversation: StoredConversation;
  openCall: OpenCall | undefined;
}) {
  const state = useVoice();
  if (!mediaSupported()) return null;
  const busy = state.phase === "connecting";
  const inThisCall =
    state.conversationId === conversation.id &&
    (state.phase === "connected" || state.phase === "reconnecting" || busy);

  if (inThisCall) {
    return (
      <IconButton
        label="Hang up"
        onClick={() => void voice.leave()}
        className="shrink-0 text-red-600 dark:text-red-400"
      >
        <PhoneOffIcon />
      </IconButton>
    );
  }

  if (openCall) {
    return (
      <Button
        size="sm"
        onClick={() => void voice.startCall(conversation)}
        disabled={busy}
        className="flex shrink-0 items-center gap-1.5 !bg-emerald-600 hover:!bg-emerald-700"
      >
        <PhoneIcon className="h-4 w-4" />
        Join call
        {openCall.joinedUserIds.length > 0 && (
          <span className="opacity-80">· {openCall.joinedUserIds.length}</span>
        )}
      </Button>
    );
  }

  return (
    <IconButton
      label="Start a call"
      onClick={() => void voice.startCall(conversation)}
      disabled={busy}
      className="shrink-0"
    >
      <PhoneIcon />
    </IconButton>
  );
}
