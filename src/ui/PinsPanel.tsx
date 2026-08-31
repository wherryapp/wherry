// A channel's pinned messages -- extracted from Chat.tsx as part of breaking
// that file up.

import { useEffect, useState } from "react";
import { decodeContent, isMessageOp } from "../api/payload";
import { decodeBase64 } from "../api/base64";
import { fetchHubPins, unpinHubMessage } from "../api/client";
import type { HubPin } from "../api/types";
import { excerptOf } from "./drafts";
import { Button, ErrorText, Panel } from "./kit";

/**
 * A channel's pinned messages. Public pins carry their payload (the server
 * can hand readable content to a proven member); private pins are
 * references only, rendered from whatever this device holds -- here, as a
 * line naming the sender, with the jump showing the local copy.
 */
export function PinsPanel({
  hubId,
  conversationId,
  canModerate,
  onClose,
  onJump,
}: {
  hubId: string;
  conversationId: string;
  canModerate: boolean;
  onClose: () => void;
  onJump: (pin: HubPin) => void;
}) {
  const [pins, setPins] = useState<HubPin[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchHubPins({ hubId, conversationId })
      .then(setPins)
      .catch(() => setError("Could not load the pins."));
  }, [hubId, conversationId]);

  async function unpin(messageId: string): Promise<void> {
    try {
      await unpinHubMessage({ hubId, conversationId, messageId });
      setPins((current) =>
        (current ?? []).filter((pin) => pin.messageId !== messageId),
      );
    } catch {
      setError("Could not unpin that.");
    }
  }

  return (
    <Panel title="Pinned messages" onClose={onClose}>
      <div className="p-4">
        {error && <ErrorText>{error}</ErrorText>}
        {pins !== null && pins.length === 0 && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Nothing pinned in this channel yet.
          </p>
        )}
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {(pins ?? []).map((pin) => {
            const content = pin.payload
              ? decodeContent(decodeBase64(pin.payload))
              : null;
            const line =
              content !== null &&
              content !== "unsupported" &&
              !isMessageOp(content)
                ? excerptOf(content)
                : "Pinned message";
            return (
              <li key={pin.messageId} className="py-2">
                <button
                  onClick={() => onJump(pin)}
                  className="block w-full text-left"
                >
                  <span className="block text-xs font-medium text-neutral-900 dark:text-neutral-100">
                    {pin.senderDisplayName || pin.senderUsername}
                    <span className="ml-2 font-normal text-neutral-500 dark:text-neutral-400">
                      {new Date(pin.sentAt).toLocaleDateString()}
                    </span>
                  </span>
                  <span className="block truncate text-xs text-neutral-600 dark:text-neutral-300">
                    {line}
                  </span>
                </button>
                {canModerate && (
                  <Button
                    variant="ghost-danger"
                    size="sm"
                    onClick={() => unpin(pin.messageId)}
                    className="mt-0.5 hover:underline"
                  >
                    Unpin
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}
