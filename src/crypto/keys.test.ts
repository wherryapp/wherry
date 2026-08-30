// Round-trip tests for the account-key primitives.
//
// This is the one code path where silent breakage permanently destroys
// history: a wrap that cannot be unwrapped, or a seal that cannot be opened,
// is not a bug somebody notices -- it is every message a user ever received,
// gone the next time they need a new device. So the wrap/unwrap and
// seal/open pairs are pinned here, run under Node's built-in test runner
// (same policy as the server: no framework). WebCrypto, hash-wasm and
// @hpke/core all run identically in Node 20+ and the browser.
//
// Run with `pnpm test` from client/. Like the server's tests, these need no
// database and no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KeysError,
  deriveKek,
  generateAccountKeypair,
  generateRecoveryCode,
  normalizeRecoveryCode,
  openArchive,
  sealForUser,
  unwrapKey,
  wrapKey,
} from "./keys.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Small parameters for speed: the *correctness* of derive-wrap-unwrap does
// not depend on the cost, and 64 MiB per test would make the suite crawl.
// The production parameters live in KDF_DEFAULTS and are exercised by the
// real login flow.
const FAST = { alg: "argon2id" as const, m: 1024, t: 1, p: 1 };

test("deriveKek is deterministic for the same inputs and differs on salt", async () => {
  const salt = new Uint8Array(16).fill(7);
  const a = await deriveKek("hunter2hunter2", salt, FAST);
  const b = await deriveKek("hunter2hunter2", salt, FAST);
  assert.deepEqual(a, b);
  assert.equal(a.length, 32);

  const other = await deriveKek("hunter2hunter2", new Uint8Array(16), FAST);
  assert.notDeepEqual(a, other);
});

test("wrapKey round-trips through unwrapKey", async () => {
  const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
  const wrap = await wrapKey("correct horse battery staple", keyMaterial);
  // The defaults are the production cost; use them once here so the real
  // parameters are proven to round-trip too.
  const unwrapped = await unwrapKey("correct horse battery staple", wrap);
  assert.deepEqual(unwrapped, keyMaterial);
});

test("unwrapKey with the wrong secret throws WRONG_SECRET, not garbage", async () => {
  const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
  const wrap = await wrapKey("the right password", keyMaterial);

  await assert.rejects(
    unwrapKey("the wrong password", wrap),
    (error: unknown) =>
      error instanceof KeysError && error.code === "WRONG_SECRET",
  );
});

test("two wraps of the same key under the same secret share nothing visible", async () => {
  const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
  const first = await wrapKey("same password twice", keyMaterial);
  const second = await wrapKey("same password twice", keyMaterial);

  // Fresh salt and nonce per wrap: identical inputs must not produce
  // recognisably related ciphertext.
  assert.notDeepEqual(first.salt, second.salt);
  assert.notDeepEqual(first.wrapped, second.wrapped);
});

test("sealForUser round-trips through openArchive", async () => {
  const keypair = await generateAccountKeypair();
  const sealed = await sealForUser(
    keypair.publicKey,
    encoder.encode("history worth keeping"),
  );

  const opened = await openArchive(keypair.privateKey, sealed);
  assert.equal(decoder.decode(opened), "history worth keeping");
});

test("openArchive with the wrong private key fails cleanly", async () => {
  const alice = await generateAccountKeypair();
  const mallory = await generateAccountKeypair();

  const sealed = await sealForUser(alice.publicKey, encoder.encode("secret"));

  await assert.rejects(
    openArchive(mallory.privateKey, sealed),
    (error: unknown) =>
      error instanceof KeysError && error.code === "WRONG_SECRET",
  );
});

test("openArchive refuses an unknown format byte", async () => {
  const keypair = await generateAccountKeypair();
  const sealed = await sealForUser(keypair.publicKey, encoder.encode("x"));
  sealed[0] = 0x7f;

  await assert.rejects(
    openArchive(keypair.privateKey, sealed),
    (error: unknown) =>
      error instanceof KeysError && error.code === "UNSUPPORTED_FORMAT",
  );
});

test("recovery codes have the documented shape and survive sloppy re-entry", () => {
  const code = generateRecoveryCode();
  assert.match(code, /^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{6}$/);

  // Lowercase, stray spaces, and the confusable letters Crockford base32
  // maps back: all normalise to the same string the wrap was made from.
  const sloppy = code.toLowerCase().replace(/-/g, " ");
  assert.equal(normalizeRecoveryCode(sloppy), normalizeRecoveryCode(code));
  assert.equal(
    normalizeRecoveryCode("o1i-l"),
    "0111".replace(/-/g, ""),
  );
});

test("a recovery code wrap unwraps from the normalised re-typed form", async () => {
  const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
  const code = generateRecoveryCode();

  const wrap = await wrapKey(normalizeRecoveryCode(code), keyMaterial);
  const retyped = code.toLowerCase().replace(/O/g, "o");
  const unwrapped = await unwrapKey(normalizeRecoveryCode(retyped), wrap);
  assert.deepEqual(unwrapped, keyMaterial);
});
