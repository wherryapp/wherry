// The landing surface for /join/<token> links -- extracted from Chat.tsx as
// part of breaking that file up.

import { useEffect, useState } from "react";
import { ApiError, previewHubInvite, redeemHubInvite } from "../api/client";
import type { HubInvitePreview } from "../api/types";
import { sync } from "../sync/engine";
import { Button, ErrorText, Note, Panel } from "./kit";
import { classLabel, classSentence, isServerReadable } from "./hub-class";

/**
 * The landing surface for /join/<token> links. Previews before joining --
 * nobody should enter a room on a tap they could not inspect -- and carries
 * the privacy-class label, since an invited stranger has seen none of the
 * other surfaces that say it.
 */
export function JoinInvite({
  token,
  onDone,
}: {
  token: string;
  /** Called with the hub's first channel to open, or null on dismiss. */
  onDone: (channelId: string | null) => void;
}) {
  const [preview, setPreview] = useState<HubInvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void previewHubInvite(token)
      .then(setPreview)
      .catch((caught) => {
        // Wrong, expired, revoked and exhausted all answer the same 404 --
        // so this is the one honest sentence for all of them.
        setError(
          caught instanceof ApiError && caught.status === 404
            ? "This invite link isn't valid anymore."
            : "Could not check that invite. Try again in a moment.",
        );
      });
  }, [token]);

  async function join(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const detail = await redeemHubInvite(token);
      sync.invalidateConversations();
      onDone(detail.channels[0]?.id ?? null);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 404
          ? "This invite link isn't valid anymore."
          : caught instanceof ApiError
            ? caught.message
            : "Could not join. Check your connection.",
      );
      setBusy(false);
    }
  }

  return (
    <Panel title="Hub invite" onClose={() => onDone(null)}>
      <div className="space-y-3 p-4">
        {error ? (
          <ErrorText>{error}</ErrorText>
        ) : preview === null ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Checking the invite…
          </p>
        ) : (
          <>
            <p className="text-sm text-neutral-900 dark:text-neutral-100">
              You're invited to{" "}
              <span className="font-semibold">{preview.name}</span> —{" "}
              {preview.memberCount}{" "}
              {preview.memberCount === 1 ? "member" : "members"}.
            </p>
            {/* The class, in the same words as everywhere else, at the one
                moment somebody is deciding whether to be in this room. An
                invite-only hub is the case this matters most for: the link
                somebody was sent looks exactly like a private hub's. */}
            <Note>
              {classLabel(preview.visibility)} hub — {classSentence(preview.visibility)}
              {!isServerReadable(preview.visibility) &&
                " Joining by link shares none of the earlier messages."}
            </Note>
            <Button onClick={join} loading={busy} className="w-full">
              Join hub
            </Button>
          </>
        )}
      </div>
    </Panel>
  );
}
