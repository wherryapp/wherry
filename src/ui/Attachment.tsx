// Rendering an attachment somebody sent.
//
// Downloaded once and cached in IndexedDB, so an image that has been seen is
// there forever regardless of what the server does with the bytes afterwards.
// That is the durable half of the retention story: the server expires things,
// devices keep what they were given, and the two never have to agree.

import { useEffect, useState, type CSSProperties } from "react";
import { downloadAttachment } from "../api/client";
import type { AttachmentRef } from "../api/payload";
import { openAttachmentBytes } from "../crypto/blob";
import { store } from "../store";
import { FileChip } from "./FileChip";
import type { StoredBlob } from "../store/types";

type Status =
  | { state: "loading" }
  | { state: "ok"; url: string }
  | { state: "expired" }
  | { state: "unknown" }
  /** A network problem rather than a verdict. Worth retrying, unlike the above. */
  | { state: "failed" };

export function Attachment({
  attachment,
  onOpen,
}: {
  attachment: AttachmentRef;
  /**
   * Makes the loaded image tappable -- the timeline passes this to open the
   * full-screen viewer. A *button* specifically, and that is the whole
   * integration: Bubble's press handler already ignores any tap landing
   * inside one (the same seam that lets the quote block coexist with the
   * action bar), so a photo tap opens the photo instead of also toggling
   * reactions. Omitted, the markup is exactly what it always was.
   */
  onOpen?: (() => void) | undefined;
}) {
  const [status, setStatus] = useState<Status>({ state: "loading" });

  /**
   * Bumped to ask again. The effect below keys on it, so incrementing it is
   * the whole retry -- there is nothing to invalidate first, because a
   * failure is deliberately never cached (see the catch). `expired` and
   * `unknown` *are* cached, which is exactly why neither of them offers this:
   * asking again would re-read the same stored verdict and change nothing,
   * so a button there would be a control that visibly does not work.
   */
  const [attempt, setAttempt] = useState(0);

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
  }, [attachment.id, attachment.mediaType, attempt]);

  // Hold the right shape while loading, so a timeline does not jump about as
  // images arrive. Falls back to a square when the sender's client did not say.
  /**
   * Offered for `failed` and nothing else.
   *
   * `failed` is a network problem -- the request did not complete -- and is
   * the only state where asking again can produce a different answer. The
   * terminal states must stay button-free: the roadmap item this closes says
   * so, and the reason is that a Retry which cannot succeed is worse than no
   * Retry at all.
   */
  const retry =
    status.state === "failed"
      ? (): void => {
          setStatus({ state: "loading" });
          setAttempt((n) => n + 1);
        }
      : undefined;

  // Everything below this point is about reserving and filling a photo's box.
  // Anything else is a file chip, which has a fixed height and therefore none
  // of the placeholder arithmetic -- and, deliberately, no inline preview of
  // any kind. See FileChip.tsx.
  if (!attachment.mediaType.startsWith("image/")) {
    return (
      <FileChip
        // Old attachments predate the payload's `name` field and will never
        // have one; the media type is the only thing left to say about them.
        name={attachment.name ?? `Attachment (${attachment.mediaType})`}
        byteSize={attachment.byteSize}
        url={status.state === "ok" ? status.url : null}
        note={fileNote(status.state)}
        onRetry={retry}
      />
    );
  }

  const ratio =
    attachment.width && attachment.height
      ? attachment.width / attachment.height
      : 1;

  /**
   * The placeholder's *width*, which an `aspect-ratio` alone does not give it.
   *
   * A message bubble is shrink-to-fit (`max-w-[70%]` on a flex item), so its
   * width is the widest thing inside it -- and a `<div style="width:100%">`,
   * which is what this placeholder used to be, contributes **nothing** to
   * that. So the bubble sized itself to the caption text, and the reserved box
   * took its height from an aspect ratio applied to a bubble far narrower than
   * the photo was about to make it. When the real `<img>` arrived it brought
   * its intrinsic width with it, the bubble jumped out to its full width, and
   * the box recomputed taller: **187px for a 1200x1600 photo with a short
   * caption, 230px for a landscape one, 215px with no caption at all**,
   * measured against this exact markup. Every photo did this, on load, after
   * the scroll had already been positioned.
   *
   * That is why "it opens in the middle" was a conversation-with-images bug,
   * and the two halves of the fix are independent: `anchor.ts` repairs the
   * anchor that failed to correct for the shift, and this stops there being a
   * shift to correct.
   *
   * The width stated here is what the loaded `<img>` will actually use: its
   * natural width, or what `max-h-80` allows at this aspect ratio, whichever
   * is smaller -- then `max-width: 100%` for the bubble it has to fit inside.
   * Verified to reserve the exact loaded height across portrait, landscape,
   * square, panoramic, small and very tall photos.
   *
   * Two things here are deliberate and worth not "simplifying":
   *
   * - **`20rem`, not `320px`.** It has to be the same length as `max-h-80`,
   *   which is `20rem` and is therefore only 320px at the default root font
   *   size. Hard-coding the pixels would silently mis-reserve for anyone who
   *   has changed it.
   * - **`max-width` separately, not folded into the `min()`.** A percentage
   *   inside `min()` does not contribute to intrinsic sizing, so
   *   `min(100%, …)` measures as *worse* than doing nothing -- tested.
   *
   * Falling back to `100%` when the sender's client recorded no dimensions:
   * there is nothing to reserve, and the old behaviour is the honest one.
   */
  const reserved: CSSProperties =
    attachment.width && attachment.height
      ? {
          aspectRatio: String(ratio),
          width: `min(${attachment.width}px, calc(20rem * ${ratio}))`,
          maxWidth: "100%",
        }
      : { aspectRatio: String(ratio), width: "100%" };

  if (status.state === "ok") {
    const image = (
      <img
        src={status.url}
        alt=""
        className="max-h-80 w-full rounded-lg object-cover"
        style={{ aspectRatio: String(ratio) }}
      />
    );
    if (!onOpen) return image;
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label="View photo"
        className="block w-full"
      >
        {image}
      </button>
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
    // The label sits *over* the reserved box rather than inside it: the box is
    // exactly the photo's, and no amount of message text can stretch it.
    <div className="relative">
      <div
        style={reserved}
        className="max-h-80 rounded-lg bg-neutral-300/60 dark:bg-neutral-700/60"
      />
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-3 text-center text-xs text-neutral-700 dark:text-neutral-200">
        {label}
        {retry && (
          // A real <button>, which is also what keeps it from toggling the
          // bubble's reactions: Bubble's press handler ignores any tap
          // landing inside one. That is the same seam the photo viewer and
          // the quote block use.
          <button
            type="button"
            onClick={retry}
            className="rounded-full bg-neutral-900/80 px-3 py-1 text-xs font-medium text-white transition hover:bg-neutral-900 motion-safe:active:scale-95 dark:bg-neutral-100/90 dark:text-neutral-900 dark:hover:bg-neutral-100"
          >
            Try again
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * What a file chip says instead of its size while there are no bytes.
 *
 * Undefined once loaded, so the chip falls back to showing the size -- which
 * is the useful thing when the file is actually there, and useless while it
 * is not.
 */
function fileNote(state: Status["state"]): string | undefined {
  switch (state) {
    case "ok":
      return undefined;
    case "loading":
      return "Loading…";
    case "expired":
      return "This attachment has expired";
    case "unknown":
      return "This attachment is no longer available";
    case "failed":
      return "Could not load — check your connection";
  }
}
