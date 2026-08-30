// Rendering an attachment somebody sent.
//
// Downloaded once and cached in IndexedDB, so an image that has been seen is
// there forever regardless of what the server does with the bytes afterwards.
// That is the durable half of the retention story: the server expires things,
// devices keep what they were given, and the two never have to agree.

import { useEffect, useState } from "react";
import { downloadAttachment } from "../api/client";
import type { AttachmentRef } from "../api/payload";
import { openAttachmentBytes } from "../crypto/blob";
import { store } from "../store";
import type { StoredBlob } from "../store/types";

type Status =
  | { state: "loading" }
  | { state: "ok"; url: string }
  | { state: "expired" }
  | { state: "unknown" }
  /** A network problem rather than a verdict. Worth retrying, unlike the above. */
  | { state: "failed" };

export function Attachment({ attachment }: { attachment: AttachmentRef }) {
  const [status, setStatus] = useState<Status>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    const show = (blob: StoredBlob): void => {
      if (cancelled) return;

      if (blob.state !== "ok") {
        setStatus({ state: blob.state });
        return;
      }

      // A copy, because the object URL outlives this call and a view onto a
      // larger buffer would keep all of it alive.
      objectUrl = URL.createObjectURL(
        new Blob([blob.bytes.slice()], { type: blob.mediaType }),
      );
      setStatus({ state: "ok", url: objectUrl });
    };

    void (async () => {
      const cached = await store.getBlob(attachment.id);
      if (cached) {
        show(cached);
        return;
      }

      try {
        const fetched = await downloadAttachment(attachment.id);

        // A reference carrying a key is an encrypted blob: verify the
        // digest, decrypt, and cache the *plaintext* -- the cache is this
        // device's copy of content it was sent, not a mirror of the
        // server's ciphertext. Decrypt failure throws into the catch below:
        // recorded as nothing, retried on the next look, because "the bytes
        // are wrong" should stay visible rather than be cached as a verdict.
        const blob: StoredBlob =
          fetched.state === "ok"
            ? {
                state: "ok",
                mediaType: attachment.mediaType,
                bytes: await openAttachmentBytes(attachment, fetched.bytes),
              }
            : { state: fetched.state };

        // Terminal states are stored too. Without that, a message whose
        // attachment expired asks the server again on every single render, for
        // the life of the conversation.
        await store.putBlob(attachment.id, blob);
        show(blob);
      } catch {
        // Not recorded. This is "the network is down", not "there are no
        // bytes", and the difference is whether it is ever worth asking again.
        if (!cancelled) setStatus({ state: "failed" });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.mediaType]);

  // Hold the right shape while loading, so a timeline does not jump about as
  // images arrive. Falls back to a square when the sender's client did not say.
  const ratio =
    attachment.width && attachment.height
      ? attachment.width / attachment.height
      : 1;

  if (status.state === "ok") {
    return (
      <img
        src={status.url}
        alt=""
        className="max-h-80 w-full rounded-lg object-cover"
        style={{ aspectRatio: String(ratio) }}
      />
    );
  }

  const label =
    status.state === "loading"
      ? "Loading…"
      : status.state === "expired"
        ? "This attachment has expired"
        : status.state === "unknown"
          ? "This attachment is no longer available"
          : "Could not load — check your connection";

  return (
    <div
      style={{ aspectRatio: String(ratio) }}
      className="flex max-h-80 w-full items-center justify-center rounded-lg bg-neutral-300/60 px-3 text-center text-xs text-neutral-700 dark:bg-neutral-700/60 dark:text-neutral-200"
    >
      {label}
    </div>
  );
}
