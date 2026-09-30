// decodeWire must be total: whatever bytes another member sends, the only
// thing it throws is the E2EError the engine turns into one failed message.
// The truncated inputs are the ones sweep 1001 reproduced (client-core-1);
// before the fix each threw ts-mls's CodecError, which escaped the inbox
// drain and stopped every recipient's inbox.
//
// Run with `pnpm test` from client/. No database, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApplicationMessage,
  createGroup,
  defaultCapabilities,
  defaultLifetime,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from "ts-mls";
import { E2EError } from "./provider.ts";
import { decodeWire } from "./wire.ts";

const encoder = new TextEncoder();

function assertE2E(fn: () => unknown, label: string): void {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof E2EError && error.code === "EPOCH_UNAVAILABLE",
    label,
  );
}

test("truncated MLS bodies throw E2EError, not a codec error", () => {
  const inputs: number[][] = [
    [],
    [0],
    [0, 1],
    [0, 1, 0, 2],
    [0, 1, 0, 2, 0x40],
    [0, 1, 0, 2, 5, 1, 2, 3],
    [0, 1, 0, 3, 0xff, 0xff, 0xff, 0xff],
    [0, 1, 0, 5, 0x80],
    [0xff, 0xff, 0xff, 0xff],
  ];
  for (const bytes of inputs) {
    assertE2E(
      () => decodeWire(new Uint8Array(bytes), "mls_private_message"),
      `[${bytes.join(",")}]`,
    );
  }
});

test("random garbage never throws anything but E2EError", () => {
  for (let i = 0; i < 500; i++) {
    const length = Math.floor(Math.random() * 64);
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    // A leading version word of mls10 gets the decoder past its first check,
    // which is where the codec throws live.
    if (i % 2 === 0 && length >= 4) bytes.set([0, 1, 0, 1 + (i % 5)], 0);
    try {
      decodeWire(bytes, "mls_private_message");
    } catch (error) {
      assert.ok(
        error instanceof E2EError,
        `[${Array.from(bytes).join(",")}] threw ${String(error)}`,
      );
    }
  }
});

test("a well-formed message of the wrong format is refused", async () => {
  const suite = await getCiphersuiteImpl(
    getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
  );
  const pkg = await generateKeyPackage(
    { credentialType: "basic", identity: encoder.encode("a") },
    defaultCapabilities(),
    defaultLifetime,
    [],
    suite,
  );
  const wire = encodeMlsMessage({
    version: "mls10",
    wireformat: "mls_key_package",
    keyPackage: pkg.publicPackage,
  });

  assert.equal(decodeWire(wire, "mls_key_package").wireformat, "mls_key_package");
  assertE2E(() => decodeWire(wire, "mls_private_message"), "key package as message");

  const state = await createGroup(
    encoder.encode("g"),
    pkg.publicPackage,
    pkg.privatePackage,
    [],
    suite,
  );
  const sent = await createApplicationMessage(state, encoder.encode("hi"), suite);
  const message = encodeMlsMessage({
    version: "mls10",
    wireformat: "mls_private_message",
    privateMessage: sent.privateMessage,
  });
  const decoded = decodeWire(message, "mls_private_message", "mls_public_message");
  assert.equal(decoded.wireformat, "mls_private_message");
  assertE2E(() => decodeWire(message, "mls_welcome"), "message as welcome");
});
