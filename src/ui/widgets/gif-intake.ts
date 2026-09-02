// What a picked GIF has to satisfy before it becomes a pending attachment.
//
// Pure and tested, for the same reason attach-intake.ts is: the composer
// already decides once what may be attached, and a GIF arriving from a search
// result is a third gesture with no markup of its own to inherit an `accept`
// from. This is that rule written out for it -- plus the two things a
// downloaded file has that a picked one does not, namely an upstream's claim
// about its size and a title that has to survive becoming a filename.

/** The library's own claim about a rendition, before anything is fetched. */
export type GifChoice = {
  id: string;
  title: string;
  byteSize: number;
  width: number;
  height: number;
};

export type GifRefusal = { reason: string };

/**
 * Whether this is worth downloading at all.
 *
 * Checked against the upstream's stated size *before* spending the bytes, so
 * somebody on a phone is told immediately rather than after a slow download
 * that was always going to be refused. The claim is advisory -- the real
 * check is on what actually arrived (see `fileForGif`) -- which is why both
 * exist rather than only this one.
 */
export function canDownloadGif(
  choice: GifChoice,
  maxBytes: number,
): GifRefusal | null {
  if (choice.byteSize > maxBytes) {
    return { reason: "That GIF is too large to send." };
  }
  return null;
}

/**
 * A filename for a downloaded GIF.
 *
 * The title is upstream text, so it is sanitised rather than trusted: it ends
 * up as a File name, which reaches a download dialog and a filesystem. Path
 * separators and control characters are the ones that matter; the length cap
 * is ordinary hygiene.
 */
export function gifFileName(title: string, id: string): string {
  const cleaned = title
    // Anything that is not a letter, digit, space, dash or underscore. This
    // is an allowlist on purpose -- a denylist of "/" and "\" would still
    // pass "..", NUL, and whatever the next filesystem objects to.
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  // The id is the fallback rather than a constant, so two untitled GIFs in
  // one conversation do not both arrive as "gif.gif".
  const stem = cleaned.length > 0 ? cleaned : `gif-${id}`;
  return `${stem}.gif`;
}

/**
 * Turns downloaded bytes into a File, or says why not.
 *
 * The type check is on what the CDN actually served, not on what the search
 * result promised. An `image/` prefix rather than exactly `image/gif`,
 * because the library serves WebP for some renditions and both animate in an
 * `<img>` -- what is being excluded is a redirect that landed on an error
 * page, which is what a non-image content type here would mean.
 */
export function fileForGif(
  blob: Blob,
  choice: GifChoice,
  maxBytes: number,
): File | GifRefusal {
  if (!blob.type.startsWith("image/")) {
    return { reason: "That GIF could not be downloaded." };
  }
  if (blob.size > maxBytes) {
    return { reason: "That GIF is too large to send." };
  }
  return new File([blob], gifFileName(choice.title, choice.id), {
    type: blob.type,
  });
}
