// Full-screen viewing of a photo somebody sent, over the timeline.
//
// Reads the bytes from the store and nowhere else. That is not a
// convenience: the server holds attachment ciphertext it cannot open, so
// there is no "fetch the full-size original" path to reach for, and there
// must never be one. Attachment.tsx has already downloaded, verified,
// decrypted and cached the plaintext by the time a photo is on screen to
// tap; this reads that cache. Missing or terminal means the viewer simply
// closes -- a viewer that starts its own download would be a second network
// path to bytes that only differ from the timeline's by being bigger.
//
// Pinch-zoom and pan are deliberately not here. Doing them properly is a
// gesture surface of its own (two-pointer tracking, momentum, bounds), and
// a fake -- a CSS scale on double-tap -- would be worse than the browser's
// own behaviour. Deferred, not forgotten.

import { useEffect, useRef, useState } from "react";
import type { AttachmentRef } from "../api/payload";
import { store } from "../store";
import { XIcon } from "./kit";

/** What a saved file is called. The id makes it unique; the type comes from
 *  the payload, since the server never learned it. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function fileNameFor(attachment: AttachmentRef): string {
  return `photo-${attachment.id}.${EXTENSIONS[attachment.mediaType] ?? "bin"}`;
}

export function PhotoViewer({
  attachment,
  onClose,
}: {
  attachment: AttachmentRef;
  onClose: () => void;
}) {
  const [shown, setShown] = useState<{ url: string; file: File } | null>(null);
  const [shareable, setShareable] = useState(false);

  // Through a ref, because the caller's onClose is an inline arrow: taking
  // it as an effect dependency directly would re-run the load -- and rebuild
  // and revoke the object URL -- on every render of the timeline underneath.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      const blob = await store.getBlob(attachment.id);
      if (cancelled) return;
      if (!blob || blob.state !== "ok") {
        // No bytes, or a terminal verdict there will never be any. Nothing
        // to show and nothing to fetch, so this closes rather than
        // explaining -- the bubble underneath already says why.
        close.current();
        return;
      }

      // A copy, for the same reason Attachment.tsx takes one: the object URL
      // outlives this call and a view onto a larger buffer would pin all of
      // it. One File serves both the URL and the share sheet.
      const file = new File([blob.bytes.slice()], fileNameFor(attachment), {
        type: blob.mediaType,
      });
      objectUrl = URL.createObjectURL(file);
      setShown({ url: objectUrl, file });
      setShareable(navigator.canShare?.({ files: [file] }) === true);
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment]);

  // Escape closes the viewer and must not also close whatever is underneath
  // it -- the same capture-phase-and-stop shape useConfirm uses, and for the
  // same reason: the panel below listens on the document's bubble phase.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () =>
      document.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  if (!shown) return null;

  const share = async (): Promise<void> => {
    try {
      await navigator.share({ files: [shown.file] });
    } catch {
      // A dismissed share sheet rejects. That is somebody changing their
      // mind, not a failure worth saying anything about.
    }
  };

  // The kit has no button variant for a dark overlay and this is the only
  // surface that wants one, so these three are styled here rather than
  // adding a variant with one caller.
  const control =
    "rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
    >
      <div
        className="absolute right-3 top-3 flex items-center gap-2"
        onClick={(event) => event.stopPropagation()}
      >
        <a
          href={shown.url}
          download={fileNameFor(attachment)}
          aria-label="Download photo"
          className={control}
        >
          <DownloadIcon />
        </a>
        {shareable && (
          <button
            type="button"
            onClick={() => void share()}
            aria-label="Share photo"
            className={control}
          >
            <ShareIcon />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close photo"
          className={control}
        >
          <XIcon />
        </button>
      </div>
      <img
        src={shown.url}
        alt=""
        onClick={(event) => event.stopPropagation()}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}

// Local to this file: the kit's icon set is what the app's own chrome uses,
// and neither of these appears anywhere else.

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M10 3v10m0 0 4-4m-4 4-4-4M4 16h12" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5" />
      <path d="M5 10H4v7h12v-7h-1" />
    </svg>
  );
}
