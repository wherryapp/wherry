import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptImages,
  filesFromTransfer,
  intakeError,
  transferHasFiles,
} from "./attach-intake.ts";

const image = (name = "photo.jpg", type = "image/jpeg"): File =>
  new File([new Uint8Array([1, 2, 3])], name, { type });

/** A dropped folder: a real entry with no type at all. */
const folder = (): File => new File([], "holiday", { type: "" });

test("a transfer's files are what it is carrying", () => {
  const files = [image(), image("second.png", "image/png")];
  assert.deepEqual(filesFromTransfer({ files }), files);
});

test("items are read when files is empty -- the Safari paste shape", () => {
  const pasted = image("pasted.png", "image/png");
  const files = filesFromTransfer({
    files: [],
    items: [
      // The text/html fragment that rides along with a copied image.
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => pasted },
    ],
  });
  assert.deepEqual(files, [pasted]);
});

test("an item that says file but hands over nothing is dropped, not kept as null", () => {
  const files = filesFromTransfer({
    items: [{ kind: "file", getAsFile: () => null }],
  });
  assert.deepEqual(files, []);
});

test("pasting plain text carries no files", () => {
  assert.deepEqual(filesFromTransfer({ files: [], items: [] }), []);
  assert.deepEqual(filesFromTransfer(null), []);
  assert.deepEqual(filesFromTransfer(undefined), []);
});

test("images are accepted and everything else is counted", () => {
  const keep = image();
  const intake = acceptImages([
    keep,
    new File([], "notes.pdf", { type: "application/pdf" }),
    folder(),
  ]);
  assert.deepEqual(intake.accepted, [keep]);
  assert.equal(intake.rejected, 2);
});

test("a clean drop says nothing", () => {
  assert.equal(intakeError(acceptImages([image(), image()])), null);
});

test("a drop with nothing usable says so plainly", () => {
  assert.equal(
    intakeError(acceptImages([folder()])),
    "Only images can be attached.",
  );
});

test("a partial drop names what was left out, rather than looking like it worked", () => {
  assert.equal(
    intakeError(acceptImages([image(), folder()])),
    "One of those was not an image, so it was left out.",
  );
  assert.equal(
    intakeError(acceptImages([image(), folder(), folder()])),
    "2 of those were not images, so they were left out.",
  );
});

test("the overlay is raised for files and for nothing else", () => {
  assert.equal(transferHasFiles(["Files"]), true);
  assert.equal(transferHasFiles(["text/plain", "Files"]), true);
  // Dragging selected text across the window must not offer to attach it.
  assert.equal(transferHasFiles(["text/plain", "text/html"]), false);
  assert.equal(transferHasFiles([]), false);
  assert.equal(transferHasFiles(undefined), false);
});
