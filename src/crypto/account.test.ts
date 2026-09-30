// The recovery-code reissue, without the network or IndexedDB: the pure half
// of regenerateRecoveryCode. What is pinned is what would silently destroy
// history if it broke -- the new code must open the same private key, the
// old code must stop opening anything, and the password wrap must still
// open under the password.
//
// Production KDF parameters (wrapKey always uses them), so each case costs a
// few Argon2id derivations; a handful of cases keeps the suite quick.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase64, encodeBase64 } from "../api/base64.ts";
import type { AccountKeysWire } from "../api/types.ts";
import { prepareRegistrationKeys, reissueRecoveryWrap } from "./account.ts";
import {
  KeysError,
  generateAccountKeypair,
  normalizeRecoveryCode,
  unwrapKey,
  type KdfParams,
} from "./keys.ts";

const PASSWORD = "correct horse battery staple";

function recoveryWrapOf(wire: AccountKeysWire) {
  return {
    wrapped: decodeBase64(wire.recoveryWrappedKey),
    salt: decodeBase64(wire.recoveryKdfSalt),
    params: wire.recoveryKdfParams as KdfParams,
  };
}

function passwordWrapOf(wire: AccountKeysWire) {
  return {
    wrapped: decodeBase64(wire.passwordWrappedKey),
    salt: decodeBase64(wire.passwordKdfSalt),
    params: wire.passwordKdfParams as KdfParams,
  };
}

async function assertWrongSecret(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    (error) => error instanceof KeysError && error.code === "WRONG_SECRET",
  );
}

test("a reissued code opens the same key, and the old code no longer does", async () => {
  const registered = await prepareRegistrationKeys(PASSWORD);
  // What GET /account/keys returns carries updatedAt too.
  const stored = { ...registered.wire, updatedAt: new Date().toISOString() };

  const { wire, recoveryCode, keypair } = await reissueRecoveryWrap(
    stored,
    PASSWORD,
    null,
  );

  assert.notEqual(recoveryCode, registered.recoveryCode);
  // Same keypair: everything already sealed to the account stays readable.
  assert.equal(wire.publicKey, registered.wire.publicKey);
  assert.deepEqual(keypair.privateKey, registered.keypair.privateKey);

  assert.deepEqual(
    await unwrapKey(normalizeRecoveryCode(recoveryCode), recoveryWrapOf(wire)),
    registered.keypair.privateKey,
  );
  await assertWrongSecret(
    unwrapKey(
      normalizeRecoveryCode(registered.recoveryCode),
      recoveryWrapOf(wire),
    ),
  );
  // The password wrap is re-made, and still opens under the password.
  assert.deepEqual(
    await unwrapKey(PASSWORD, passwordWrapOf(wire)),
    registered.keypair.privateKey,
  );

  // Exactly the seven fields PUT /account/keys accepts
  // (additionalProperties: false): the response's updatedAt must not ride
  // along into the request.
  assert.deepEqual(Object.keys(wire).sort(), [
    "passwordKdfParams",
    "passwordKdfSalt",
    "passwordWrappedKey",
    "publicKey",
    "recoveryKdfParams",
    "recoveryKdfSalt",
    "recoveryWrappedKey",
  ]);
});

test("a local key for the stored public key is used without opening the password wrap", async () => {
  const registered = await prepareRegistrationKeys(PASSWORD);

  // A password that does not open the wrap still gets a row back: the local
  // key made the unwrap unnecessary, and the server is what verifies the
  // password on the PUT.
  const { keypair } = await reissueRecoveryWrap(
    registered.wire,
    "not the password at all",
    registered.keypair,
  );
  assert.deepEqual(keypair.privateKey, registered.keypair.privateKey);
});

test("a local key for another public key is ignored, and a wrong password fails before anything is built", async () => {
  const registered = await prepareRegistrationKeys(PASSWORD);
  const retired = await generateAccountKeypair();
  assert.notEqual(encodeBase64(retired.publicKey), registered.wire.publicKey);

  await assertWrongSecret(
    reissueRecoveryWrap(registered.wire, "not the password at all", retired),
  );

  // With the right password the stored key is recovered, not the stray one.
  const { keypair } = await reissueRecoveryWrap(
    registered.wire,
    PASSWORD,
    retired,
  );
  assert.deepEqual(keypair.privateKey, registered.keypair.privateKey);
});
