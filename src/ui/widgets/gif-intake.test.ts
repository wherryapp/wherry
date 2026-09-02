import assert from "node:assert/strict";
import { test } from "node:test";

import { canDownloadGif, fileForGif, gifFileName } from "./gif-intake.js";

const choice = { id: "abc", title: "a cat", byteSize: 500_000, width: 200, height: 150 };
const MAX = 25 * 1024 * 1024;

test("an oversized rendition is refused before it is downloaded", () => {
  const refusal = canDownloadGif({ ...choice, byteSize: MAX + 1 }, MAX);
  assert.equal(refusal?.reason, "That GIF is too large to send.");
});

test("a rendition within the limit is downloadable", () => {
  assert.equal(canDownloadGif(choice, MAX), null);
});

test("bytes larger than promised are still refused", () => {
  // The upstream's size is advisory; what actually arrived is what counts.
  const blob = new Blob([new Uint8Array(10)], { type: "image/gif" });
  const result = fileForGif(blob, choice, 5);
  assert.deepEqual(result, { reason: "That GIF is too large to send." });
});

test("a non-image response is refused rather than attached", () => {
  const blob = new Blob(["<html>error</html>"], { type: "text/html" });
  const result = fileForGif(blob, choice, MAX);
  assert.deepEqual(result, { reason: "That GIF could not be downloaded." });
});

test("a webp rendition is accepted -- it animates in an img too", () => {
  const blob = new Blob([new Uint8Array(4)], { type: "image/webp" });
  const result = fileForGif(blob, choice, MAX);
  assert.ok(result instanceof File);
  assert.equal((result as File).type, "image/webp");
});

test("the filename comes from the title", () => {
  assert.equal(gifFileName("a happy cat", "x"), "a-happy-cat.gif");
});

test("path separators and control characters cannot reach the filename", () => {
  assert.equal(gifFileName("../../etc/passwd", "x"), "etcpasswd.gif");
  assert.equal(gifFileName(`a${String.fromCharCode(0)}b`, "x"), "ab.gif");
  assert.ok(!gifFileName("a/b\\c", "x").includes("/"));
  assert.ok(!gifFileName("a/b\\c", "x").includes("\\"));
});

test("an untitled gif falls back to its id, not a shared constant", () => {
  assert.equal(gifFileName("", "abc"), "gif-abc.gif");
  assert.equal(gifFileName("!!!", "def"), "gif-def.gif");
  assert.notEqual(gifFileName("", "abc"), gifFileName("", "def"));
});

test("a very long title is capped", () => {
  const name = gifFileName("x".repeat(500), "id");
  assert.ok(name.length <= 64, `${name.length}`);
});
