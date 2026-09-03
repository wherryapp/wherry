// What the composer says while a send is working.
//
// Sending an attachment is four sequential stages -- read the limits, prepare
// the bytes, seal them, upload them -- and until now it said nothing at all
// about any of them. The send button greyed out and the app went quiet, which
// on a large file reads as a crash rather than as work in progress. That was
// the report, and it is a feedback bug rather than a slowness bug: the upload
// was always going to take that long.
//
// Pure and tested because the wording has to stay honest at the edges. A
// percentage that reaches 100 while bytes are still moving is the specific
// thing that makes somebody decide the app has hung -- they watched it finish
// and then watched it keep going.

export type UploadStage =
  /** Reading the file, and re-encoding it if it is a photo. */
  | "preparing"
  /** Sealing it to the conversation. */
  | "sealing"
  /** Actually on the wire. The only stage with a meaningful fraction. */
  | "uploading";

export type UploadProgress = {
  /** 0-based, so the display adds one. */
  index: number;
  total: number;
  stage: UploadStage;
  /** 0..1. Only `uploading` reports one; the others are indeterminate. */
  fraction: number;
};

/**
 * The percentage to show, as an integer.
 *
 * Floored, never rounded. `Math.round(0.996 * 100)` is 100, and showing 100%
 * while the last bytes are still going out is exactly what makes a slow
 * upload look stuck -- the number says done and nothing happens. Flooring
 * means 100 appears only when the fraction genuinely reaches 1, which the
 * upload states explicitly rather than inferring from a progress event.
 */
export function uploadPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(100, Math.floor(fraction * 100)));
}

/**
 * One line describing where a send has got to.
 *
 * The count is only mentioned when there is more than one attachment: "1 of 1"
 * is noise, and this line sits under a composer somebody is waiting at.
 */
export function uploadStatusLine(progress: UploadProgress): string {
  const position =
    progress.total > 1 ? ` ${progress.index + 1} of ${progress.total}` : "";

  switch (progress.stage) {
    case "preparing":
      return `Preparing${position}…`;
    case "sealing":
      return `Encrypting${position}…`;
    case "uploading":
      return `Uploading${position} — ${uploadPercent(progress.fraction)}%`;
  }
}
