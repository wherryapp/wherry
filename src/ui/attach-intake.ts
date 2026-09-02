// What a paste or a drop is allowed to put in the composer.
//
// The file picker never had to think about this: `accept="image/*"` in the
// markup did it, and the browser's dialog enforced it before anything
// reached us. Paste and drop have no such filter -- a DataTransfer can
// carry a folder, a PDF, a .zip, or the `text/html` fragment that rides
// along whenever an image is copied out of a web page -- so the rule the
// picker implied is written out here, in the one place both new paths
// share.
//
// Pure and tested for the usual reason: the interesting part is a decision
// about a handful of items, and the part that is hard to test is the DOM
// event that carries them. Keeping the decision out of the handler means
// the handler has nothing left to get wrong.

export type Intake = {
  accepted: File[];
  /** How many items came with them that the composer cannot attach. */
  rejected: number;
};

/**
 * The shape both gestures hand over -- `DataTransfer` for a drop,
 * `ClipboardData` for a paste. Structural rather than the DOM types so the
 * test can build one without a browser.
 */
export type TransferLike = {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile: () => File | null }> | null;
};

/**
 * Everything the transfer is carrying as a file.
 *
 * `files` first, `items` as the fallback: both are specified, but a pasted
 * image reaches `items` in browsers where `files` is empty, and reading
 * only one of the two is how "paste works in Chrome but not Safari"
 * happens. They describe the same payload, so the first non-empty one is
 * the whole answer rather than something to merge.
 */
export function filesFromTransfer(transfer: TransferLike | null | undefined): File[] {
  if (!transfer) return [];

  const direct = Array.from(transfer.files ?? []);
  if (direct.length > 0) return direct;

  return Array.from(transfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/**
 * Splits what arrived into what can be attached and how much cannot.
 *
 * A dropped *folder* lands here as a file with an empty type, so it is
 * rejected by the same check that rejects a PDF -- which is the honest
 * answer, since nothing downstream could upload one.
 */
export function acceptImages(files: readonly File[]): Intake {
  const accepted = files.filter((file) => file.type.startsWith("image/"));
  return { accepted, rejected: files.length - accepted.length };
}

/**
 * What to tell somebody about the part that was refused, or null when
 * there is nothing to say.
 *
 * Silence is the wrong answer here. Dropping four photos and a PDF and
 * getting four thumbnails looks like it worked, and the missing one is
 * only noticed by the person who was expecting it at the other end.
 */
export function intakeError(intake: Intake): string | null {
  if (intake.rejected === 0) return null;
  if (intake.accepted.length === 0) return "Only images can be attached.";
  return intake.rejected === 1
    ? "One of those was not an image, so it was left out."
    : `${intake.rejected} of those were not images, so they were left out.`;
}

/**
 * Whether a drag in progress is carrying files.
 *
 * `types` is deliberately all there is to go on: a page may not read what
 * is merely hovering over it, so the contents only become readable on the
 * drop itself. Which means the overlay has to be decided from this alone
 * -- and it is why dragging *text* across the window does not raise it.
 */
export function transferHasFiles(types: readonly string[] | undefined): boolean {
  return (types ?? []).includes("Files");
}
