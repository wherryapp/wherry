import assert from "node:assert/strict";
import { test } from "node:test";

import { attachmentWord, excerptOf } from "./drafts";

const photo = { mediaType: "image/jpeg" };
const gif = { mediaType: "image/gif", name: "party.gif" };
const pdf = { mediaType: "application/pdf", name: "minutes.pdf" };

test("no attachments: no word", () => {
  assert.equal(attachmentWord([]), "");
});

test("only images read as a photo", () => {
  assert.equal(attachmentWord([photo]), "Photo");
  assert.equal(attachmentWord([photo, gif]), "Photo");
});

test("a single file says its name, sanitised", () => {
  assert.equal(attachmentWord([pdf]), "minutes.pdf");
  assert.equal(
    attachmentWord([{ mediaType: "application/pdf", name: "‮fdp.exe" }]),
    "fdp.exe",
  );
});

test("a file with no name, or a mix, reads as a file", () => {
  assert.equal(attachmentWord([{ mediaType: "application/pdf" }]), "File");
  assert.equal(attachmentWord([photo, pdf]), "File");
});

test("an excerpt prefers the text", () => {
  assert.equal(excerptOf({ text: "hello", attachments: [pdf] }), "hello");
  assert.equal(excerptOf({ text: "", attachments: [pdf] }), "minutes.pdf");
});
