// Round-trip tests for attachment encryption, same policy as keys.test.ts:
// this is a path where silent breakage loses content, so the pairs are
// pinned under Node's built-in runner.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BlobCryptoError,
  decryptBlob,
  encryptBlob,
  openAttachmentBytes,
} from "./blob.ts";

test("encryptBlob round-trips through decryptBlob", async () => {
  const original = crypto.getRandomValues(new Uint8Array(4096));
  const { ciphertext, ref } = await encryptBlob(original);

  assert.notDeepEqual(ciphertext.subarray(0, 64), original.subarray(0, 64));
  const opened = await decryptBlob(ciphertext, ref);
  assert.deepEqual(opened, original);
});

test("a flipped ciphertext byte is a DIGEST_MISMATCH, not a decrypt error", async () => {
  const { ciphertext, ref } = await encryptBlob(new TextEncoder().encode("photo"));
  ciphertext[0]! ^= 0xff;

  await assert.rejects(
    decryptBlob(ciphertext, ref),
    (error: unknown) =>
      error instanceof BlobCryptoError && error.code === "DIGEST_MISMATCH",
  );
});

test("the wrong key fails cleanly after the digest passes", async () => {
  const a = await encryptBlob(new TextEncoder().encode("photo a"));
  const b = await encryptBlob(new TextEncoder().encode("photo b"));

  // b's ciphertext with b's digest but a's key: the digest check passes,
  // the decrypt must not.
  await assert.rejects(
    decryptBlob(b.ciphertext, { ...b.ref, key: a.ref.key }),
    (error: unknown) =>
      error instanceof BlobCryptoError && error.code === "DECRYPT_FAILED",
  );
});

test("two encryptions of the same bytes share nothing visible", async () => {
  const bytes = new TextEncoder().encode("the same photo twice");
  const first = await encryptBlob(bytes);
  const second = await encryptBlob(bytes);

  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.ref.key, second.ref.key);
  assert.notEqual(first.ref.digest, second.ref.digest);
});

test("openAttachmentBytes passes a plaintext-era reference through untouched", async () => {
  const bytes = new TextEncoder().encode("uploaded before encryption");
  const opened = await openAttachmentBytes({}, bytes);
  assert.deepEqual(opened, bytes);
});

test("openAttachmentBytes decrypts a keyed reference", async () => {
  const original = new TextEncoder().encode("uploaded after");
  const { ciphertext, ref } = await encryptBlob(original);
  const opened = await openAttachmentBytes(ref, ciphertext);
  assert.deepEqual(opened, original);
});
