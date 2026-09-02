import { test } from "node:test";
import assert from "node:assert/strict";
import { type FilePolicy } from "./file-policy.js";
import {
  acceptFiles,
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

// The default policy: everything except things a double-click runs.
const DEFAULT: FilePolicy = { mode: "block", extensions: ["exe", "bat"] };

test("a document is accepted now -- attachments are not images any more", () => {
  const pdf = new File([], "notes.pdf", { type: "application/pdf" });
  const intake = acceptFiles([image(), pdf], DEFAULT);
  assert.equal(intake.accepted.length, 2);
  assert.equal(intake.rejected, 0);
});

test("what the policy blocks is counted, not attached", () => {
  const keep = image();
  const intake = acceptFiles([keep, new File([], "setup.exe")], DEFAULT);
  assert.deepEqual(intake.accepted, [keep]);
  assert.equal(intake.rejected, 1);
});

test("an allowlist admits only what it names", () => {
  const policy: FilePolicy = { mode: "allow", extensions: ["pdf"] };
  const pdf = new File([], "notes.pdf", { type: "application/pdf" });
  const intake = acceptFiles([image(), pdf], policy);
  assert.deepEqual(intake.accepted, [pdf]);
  assert.equal(intake.rejected, 1);
});

test("a dropped folder is refused whatever the policy permits", () => {
  // It arrives as an empty-typed, extensionless File that a blocklist would
  // happily allow -- and nothing downstream could upload one.
  const permissive: FilePolicy = { mode: "block", extensions: [] };
  const intake = acceptFiles([folder()], permissive);
  assert.equal(intake.accepted.length, 0);
  assert.equal(intake.rejected, 1);
});

test("a clean drop says nothing", () => {
  assert.equal(intakeError(acceptFiles([image(), image()], DEFAULT)), null);
});

test("a drop with nothing usable says so plainly", () => {
  assert.equal(
    intakeError(acceptFiles([folder()], DEFAULT)),
    "That file type cannot be attached.",
  );
});

test("a partial drop names what was left out, rather than looking like it worked", () => {
  assert.equal(
    intakeError(acceptFiles([image(), folder()], DEFAULT)),
    "One of those cannot be attached, so it was left out.",
  );
  assert.equal(
    intakeError(acceptFiles([image(), folder(), folder()], DEFAULT)),
    "2 of those cannot be attached, so they were left out.",
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
