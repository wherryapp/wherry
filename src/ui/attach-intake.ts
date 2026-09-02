// What a paste, a drop, a picker or a widget is allowed to put in the
// composer.
//
// The picker used to answer this by itself: `accept="image/*"` in the markup,
// enforced by the browser's dialog before anything reached us. That stopped
// being enough twice. First because paste and drop have no markup to inherit
// from -- a DataTransfer can carry a folder, a PDF, a .zip, or the
// `text/html` fragment that rides along whenever an image is copied out of a
// web page. Then because attachments stopped being images at all, and the
// rule became an operator's policy served from `GET /attachments/usage`,
// which `accept` cannot express in its blocklist form at all (see
// file-policy.ts's acceptAttribute).
//
// So the rule lives here, applied to whatever comes back, and the four
// gestures share it.
//
// Pure and tested for the usual reason: the interesting part is a decision
// about a handful of items, and the part that is hard to test is the DOM
// event that carries them. Keeping the decision out of the handler means
// the handler has nothing left to get wrong.

import { isFileAllowed, type FilePolicy } from "./file-policy";

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
 * A dropped *folder* lands here as a file with an empty type and no
 * extension, which the default blocklist would happily permit -- so folders
 * are refused explicitly rather than left to the policy. Nothing downstream
 * could upload one, and that is true whatever an operator has configured.
 */
export function acceptFiles(
  files: readonly File[],
  policy: FilePolicy,
): Intake {
  const accepted = files.filter((file) => !isFolder(file) && isFileAllowed(file.name, policy));
  return { accepted, rejected: files.length - accepted.length };
}

/**
 * A directory, as far as anything here can tell.
 *
 * There is no reliable flag: a dropped folder arrives as a `File` with an
 * empty `type` and a size the browser makes up. An empty type plus no
 * extension is the closest honest test, and it costs an extensionless file
 * like `Makefile` -- which is the right way round to be wrong, since letting
 * a folder through produces an upload that fails much later with nothing
 * useful to say.
 */
function isFolder(file: File): boolean {
  return file.type === "" && !file.name.includes(".");
}

export function intakeError(intake: Intake): string | null {
  if (intake.rejected === 0) return null;
  if (intake.accepted.length === 0) {
    return intake.rejected === 1
      ? "That file type cannot be attached."
      : "Those file types cannot be attached.";
  }
  return intake.rejected === 1
    ? "One of those cannot be attached, so it was left out."
    : `${intake.rejected} of those cannot be attached, so they were left out.`;
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
