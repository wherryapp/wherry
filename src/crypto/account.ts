// The account-key flows: what actually happens at registration, login,
// password change and recovery.
//
// This is orchestration -- it strings together crypto/keys.ts, crypto/db.ts
// and the API client -- so the UI stays thin and the crypto primitives stay
// pure. The flows and their tiers are described on each function; the design
// they implement is docs/architecture.md's "wrap, don't derive" section.

import {
  ApiError,
  fetchAccountKeys,
  putAccountKeys,
  changePassword as changePasswordApi,
} from "../api/client";
import { decodeBase64, encodeBase64 } from "../api/base64";
import type { AccountKeysWire, KdfParamsWire } from "../api/types";
import {
  clearAccountKeypair,
  loadAccountKeypair,
  saveAccountKeypair,
} from "./db";
import {
  KeysError,
  generateAccountKeypair,
  generateRecoveryCode,
  normalizeRecoveryCode,
  unwrapKey,
  wrapKey,
  type AccountKeypair,
  type KdfParams,
} from "./keys";

export { clearAccountKeypair, loadAccountKeypair };

// The server's KdfParamsWire says `alg: string` because it does not
// interpret it; this build only produces and consumes argon2id.
function asKdfParams(wire: KdfParamsWire): KdfParams {
  return { alg: "argon2id", m: wire.m, t: wire.t, p: wire.p };
}

/** Builds the full wire object: both wraps, made fresh. */
async function buildWireKeys(
  keypair: AccountKeypair,
  password: string,
  recoveryCode: string,
): Promise<AccountKeysWire> {
  const passwordWrap = await wrapKey(password, keypair.privateKey);
  const recoveryWrap = await wrapKey(
    normalizeRecoveryCode(recoveryCode),
    keypair.privateKey,
  );

  return {
    publicKey: encodeBase64(keypair.publicKey),
    passwordWrappedKey: encodeBase64(passwordWrap.wrapped),
    passwordKdfSalt: encodeBase64(passwordWrap.salt),
    passwordKdfParams: passwordWrap.params,
    recoveryWrappedKey: encodeBase64(recoveryWrap.wrapped),
    recoveryKdfSalt: encodeBase64(recoveryWrap.salt),
    recoveryKdfParams: recoveryWrap.params,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export type RegistrationKeys = {
  /** Goes into the register request body. */
  wire: AccountKeysWire;
  /** Shown to the user exactly once, then never stored anywhere. */
  recoveryCode: string;
  /** Persisted locally once registration succeeds. */
  keypair: AccountKeypair;
};

/**
 * Everything registration needs, computed before the request: the keypair,
 * the recovery code, and both wraps. Two Argon2id derivations at ~110 ms
 * each, so this belongs behind the button press, not behind a keystroke.
 */
export async function prepareRegistrationKeys(
  password: string,
): Promise<RegistrationKeys> {
  const keypair = await generateAccountKeypair();
  const recoveryCode = generateRecoveryCode();
  const wire = await buildWireKeys(keypair, password, recoveryCode);
  return { wire, recoveryCode, keypair };
}

/** After a successful register: keep the keypair for this browser. */
export async function persistKeypair(keypair: AccountKeypair): Promise<void> {
  await saveAccountKeypair(keypair.publicKey, keypair.privateKey);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export type UnlockResult =
  /** The key is unwrapped and stored locally; nothing more to do. */
  | { status: "unlocked" }
  /** Account predates v2 -- no keys exist, and that is fine until cutover. */
  | { status: "no-keys" }
  /**
   * The password wrap did not open with this password -- the signature of a
   * password reset -- and no surviving local key could repair it silently.
   * The UI must ask for the recovery code (or offer starting fresh).
   */
  | { status: "recovery-needed" };

/**
 * The login-time unlock, tiered exactly as the architecture doc lays out:
 *
 * 1. The stored password wrap opens with the password just typed -- the
 *    common case -- and the key lands in local storage.
 * 2. It does not open (stale after a reset), but this browser still holds
 *    the private key from an earlier session: re-wrap under the current
 *    password and push it, silently. This is the "signed-in device
 *    re-wraps" promise, and it is why an involuntary sign-out keeps the
 *    local key (see crypto/db.ts).
 * 3. Neither works: hand the decision to the UI -- recovery code, or start
 *    fresh and lose old history.
 *
 * Called after login succeeds, while the password is still in hand. The
 * password is never kept beyond this call.
 */
export async function unlockAccountKey(password: string): Promise<UnlockResult> {
  let stored;
  try {
    stored = await fetchAccountKeys();
  } catch (error) {
    if (error instanceof ApiError && error.code === "KEYS_NOT_FOUND") {
      return { status: "no-keys" };
    }
    throw error;
  }

  const publicKey = decodeBase64(stored.publicKey);

  try {
    const privateKey = await unwrapKey(password, {
      wrapped: decodeBase64(stored.passwordWrappedKey),
      salt: decodeBase64(stored.passwordKdfSalt),
      params: asKdfParams(stored.passwordKdfParams),
    });
    await saveAccountKeypair(publicKey, privateKey);
    return { status: "unlocked" };
  } catch (error) {
    if (!(error instanceof KeysError) || error.code !== "WRONG_SECRET") {
      throw error;
    }
  }

  // Tier 2: a surviving local key. Only if it is the *same* keypair -- a
  // local key from before a "start fresh" rotation must not resurrect the
  // retired one.
  const local = await loadAccountKeypair();
  if (local && encodeBase64(local.publicKey) === stored.publicKey) {
    await rewrapPasswordWrap(password, local);
    return { status: "unlocked" };
  }

  return { status: "recovery-needed" };
}

/**
 * Tier 3a: the user typed their recovery code. Unwrap with it, re-wrap under
 * the current password, push both wraps fresh, and keep the key locally.
 *
 * A *new* recovery code is issued and returned, because the old one has now
 * been typed into a browser -- and a code that may have been seen is a code
 * that has done its job. The UI shows it once, same as registration.
 */
export async function recoverWithCode(
  password: string,
  typedCode: string,
): Promise<{ newRecoveryCode: string }> {
  const stored = await fetchAccountKeys();

  const privateKey = await unwrapKey(normalizeRecoveryCode(typedCode), {
    wrapped: decodeBase64(stored.recoveryWrappedKey),
    salt: decodeBase64(stored.recoveryKdfSalt),
    params: asKdfParams(stored.recoveryKdfParams),
  });

  const keypair: AccountKeypair = {
    publicKey: decodeBase64(stored.publicKey),
    privateKey,
  };

  const newRecoveryCode = generateRecoveryCode();
  await putAccountKeys(
    password,
    await buildWireKeys(keypair, password, newRecoveryCode),
  );
  await persistKeypair(keypair);

  return { newRecoveryCode };
}

/**
 * Tier 3b, and the honest end of the line: no password wrap, no local key,
 * no recovery code. Generates a brand-new keypair and replaces the row.
 * Everything sealed to the old public key is permanently unreadable from
 * now on -- the caller's UI says so before calling this, plainly.
 */
export async function startFresh(
  password: string,
): Promise<{ recoveryCode: string }> {
  const keypair = await generateAccountKeypair();
  const recoveryCode = generateRecoveryCode();
  await putAccountKeys(
    password,
    await buildWireKeys(keypair, password, recoveryCode),
  );
  await persistKeypair(keypair);
  return { recoveryCode };
}

/**
 * Tier 2's write: same keypair, a fresh password wrap, and the recovery wrap
 * re-sent byte-for-byte. Preserving it matters: this repair runs silently,
 * and a silent repair must not invalidate the code the user wrote down at
 * registration. Only recoverWithCode replaces the recovery wrap, because
 * only there has the old code demonstrably been spent.
 */
async function rewrapPasswordWrap(
  password: string,
  keypair: AccountKeypair,
): Promise<void> {
  const stored = await fetchAccountKeys();
  const passwordWrap = await wrapKey(password, keypair.privateKey);

  await putAccountKeys(password, {
    publicKey: encodeBase64(keypair.publicKey),
    passwordWrappedKey: encodeBase64(passwordWrap.wrapped),
    passwordKdfSalt: encodeBase64(passwordWrap.salt),
    passwordKdfParams: passwordWrap.params,
    // Unchanged: the recovery code in the user's drawer still opens these.
    recoveryWrappedKey: stored.recoveryWrappedKey,
    recoveryKdfSalt: stored.recoveryKdfSalt,
    recoveryKdfParams: stored.recoveryKdfParams,
  });
}

// ---------------------------------------------------------------------------
// Password change
// ---------------------------------------------------------------------------

/**
 * A password change that keeps the wrap in step with the hash.
 *
 * The private key comes from the local store when this browser holds it, and
 * failing that from unwrapping with the current password (which the form has
 * anyway). Only if *both* fail does the change go through without a re-wrap
 * -- the wrap was already stale, and leaving it stale loses nothing.
 */
export async function changePasswordWithRewrap(
  currentPassword: string,
  newPassword: string,
): Promise<{ otherSessionsRevoked: number }> {
  let privateKey: Uint8Array | null = null;

  const local = await loadAccountKeypair();
  let storedPublicKey: string | null = null;

  try {
    const stored = await fetchAccountKeys();
    storedPublicKey = stored.publicKey;

    if (local && encodeBase64(local.publicKey) === stored.publicKey) {
      privateKey = local.privateKey;
    } else {
      privateKey = await unwrapKey(currentPassword, {
        wrapped: decodeBase64(stored.passwordWrappedKey),
        salt: decodeBase64(stored.passwordKdfSalt),
        params: asKdfParams(stored.passwordKdfParams),
      });
    }
  } catch (error) {
    const noKeys = error instanceof ApiError && error.code === "KEYS_NOT_FOUND";
    const staleWrap =
      error instanceof KeysError && error.code === "WRONG_SECRET";
    if (!noKeys && !staleWrap) throw error;
  }

  if (privateKey === null || storedPublicKey === null) {
    return await changePasswordApi(currentPassword, newPassword);
  }

  const wrap = await wrapKey(newPassword, privateKey);
  const result = await changePasswordApi(currentPassword, newPassword, {
    passwordWrappedKey: encodeBase64(wrap.wrapped),
    passwordKdfSalt: encodeBase64(wrap.salt),
    passwordKdfParams: wrap.params,
  });

  // The unwrap above may have been this browser's first sight of the key.
  await saveAccountKeypair(decodeBase64(storedPublicKey), privateKey);

  return result;
}
