// A non-image attachment in the timeline.
//
// Purely presentational: Attachment.tsx owns the download, the decryption and
// the cache, and hands the result here. That split is deliberate -- the
// loading logic is identical for a photo and a PDF, and only the last step
// differs, so duplicating the fetch to render a different box would be the
// expensive way to change one line.
//
// The rule this file exists to keep: an attachment is DATA, never something
// the app runs or renders as markup. A photo gets an `<img>` because an
// `<img>` cannot execute; everything else gets a download link and nothing
// more. No preview iframe, no PDF viewer, no `srcdoc` -- each of those hands
// bytes the server has never seen (and cannot inspect, by design) to an
// interpreter inside the app's own origin.

import { DownloadIcon, FileIcon } from "./kit";
import { displayFileName, isExecutable } from "./file-policy";
import { formatBytes } from "./format";

export function FileChip({
  name,
  byteSize,
  /** An object URL once the bytes are in hand; null while loading or failed. */
  url,
  /** Shown instead of the size when the bytes are not available. */
  note,
}: {
  name: string;
  byteSize: number;
  url: string | null;
  note?: string | undefined;
}) {
  // The name is the sender's filesystem text, so it is sanitised rather than
  // trusted -- a right-to-left override in it would otherwise make the
  // extension shown differ from the extension the OS acts on.
  const shown = displayFileName(name) || "Attachment";
  const dangerous = isExecutable(name);

  const body = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
        <FileIcon />
      </span>
      <span className="min-w-0 flex-1">
        {/* break-all rather than truncate: a filename's distinguishing part is
            as often at the end ("...-final-v3.pdf") as the start, and the
            timeline already wraps long words this way. */}
        <span className="block break-all text-sm font-medium">{shown}</span>
        <span className="block text-xs text-neutral-500 dark:text-neutral-400">
          {note ?? formatBytes(byteSize)}
        </span>
      </span>
      {url && (
        <span className="shrink-0 text-neutral-500 dark:text-neutral-400">
          <DownloadIcon />
        </span>
      )}
    </>
  );

  const shell =
    "flex w-full max-w-xs items-center gap-3 rounded-lg border border-neutral-300 bg-white/60 p-2 text-left dark:border-neutral-600 dark:bg-neutral-800/60";

  return (
    <span className="block">
      {url ? (
        // An anchor, not a button calling into script. The browser performs
        // the save itself, which is one fewer layer that can be broken -- the
        // same reasoning as the update banner's escape hatch, and it is what
        // makes `download` name the file rather than the object URL's uuid.
        <a href={url} download={shown} className={`${shell} hover:bg-neutral-100 dark:hover:bg-neutral-800`}>
          {body}
        </a>
      ) : (
        <span className={shell}>{body}</span>
      )}

      {dangerous && (
        // Deliberately not conditional on the operator's policy. Somebody's
        // instance permitting a file type is a decision about what may be
        // carried, not a decision that a recipient should be handed one with
        // no indication of what it is -- and the sender's instance is not
        // necessarily this one. See file-policy.ts's isExecutable.
        <span className="mt-1 block max-w-xs text-xs text-amber-700 dark:text-amber-400">
          This file type can run programs on your device. Only open it if you
          trust who sent it.
        </span>
      )}
    </span>
  );
}
