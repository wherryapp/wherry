// The account key: an HPKE keypair, and the machinery that wraps it.
//
// ---------------------------------------------------------------------------
// Why a keypair and not a symmetric key
// ---------------------------------------------------------------------------
//
// Archive rows are per recipient *user*, and the sender writes them for
// everybody in the conversation -- so sealing one needs something public per
// recipient. A symmetric account key could only ever seal your own rows.
// With a keypair, the public half lives on the server in the clear and any
// sender can seal to it; the private half is what a device needs to *read*
// history, and that is the thing that gets wrapped and stored.
//
// ---------------------------------------------------------------------------
// Wrapped, never derived (docs/architecture.md)
// ---------------------------------------------------------------------------
//
// The private key is random. The password only derives a key-encryption-key
// (KEK) that wraps it, so changing the password re-wraps the same key and
// history survives. It is wrapped twice -- password KEK and recovery-code
// KEK -- because the recovery wrap is what survives a password reset when no
// signed-in device is left. Both wraps exist from registration or neither
// can be added later.
//
// The KDF is Argon2id at the same cost the server uses for password hashes
// (64 MiB, t=3, p=1) -- measured at ~110 ms here, and this derivation is the
// only thing between a database leak and every user's history, so the cost
// is the point. `hash-wasm` rather than a pure-JS Argon2 because 64 MiB of
// pure JS takes seconds, and rather than WebCrypto PBKDF2 because PBKDF2 is
// far cheaper for a GPU to grind.

import { Aes128Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { argon2id } from "hash-wasm";

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * Recorded on the server per wrap and sent back at unwrap time, so these
 * numbers can be raised later without breaking wraps made under the old
 * ones. `m` is KiB, matching the server's own Argon2 tuning.
 */
export type KdfParams = { alg: "argon2id"; m: number; t: number; p: number };

export const KDF_DEFAULTS: KdfParams = { alg: "argon2id", m: 65536, t: 3, p: 1 };

const KDF_SALT_BYTES = 16;
const WRAP_NONCE_BYTES = 12;

// The HPKE suite archive payloads are sealed with. X25519 because it is the
// same KEM the MLS ciphersuite uses, so there is exactly one curve in the
// system. AES-128-GCM matches that ciphersuite for the same reason.
const hpke = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

// A format byte leads every sealed archive payload, so the KEM can change
// someday without touching `protocol_version` -- that says how the *message*
// was encrypted, this says how the *archive copy* was sealed. The same idea
// as the 0x01 content-format byte in api/payload.ts.
const ARCHIVE_FORMAT_X25519 = 0x01;

// X25519 KEM: the encapsulated key is always 32 bytes, so length-prefixing
// it would encode a constant. A future format byte can choose differently.
const X25519_ENC_BYTES = 32;

// The symmetric sibling: a v3 archive payload is AEAD under the
// conversation's history key rather than HPKE to one user. Distinct format
// byte for the distinct seal; 0x01 stays HPKE forever, because v2 rows do.
const ARCHIVE_FORMAT_HISTORY_AES256GCM = 0x02;

const HISTORY_KEY_BYTES = 32;
const HISTORY_NONCE_BYTES = 12;

export class KeysError extends Error {
  readonly code: "WRONG_SECRET" | "UNSUPPORTED_FORMAT";

  constructor(code: "WRONG_SECRET" | "UNSUPPORTED_FORMAT", message: string) {
    super(message);
    this.name = "KeysError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// KEK derivation and wrapping
// ---------------------------------------------------------------------------

export type Wrapped = {
  wrapped: Uint8Array;
  salt: Uint8Array;
  params: KdfParams;
};

/** Derives the 32-byte key-encryption-key from a password or recovery code. */
export async function deriveKek(
  secret: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<Uint8Array> {
  return await argon2id({
    password: secret,
    salt,
    memorySize: params.m,
    iterations: params.t,
    parallelism: params.p,
    hashLength: 32,
    outputType: "binary",
  });
}

/**
 * Wraps key material under a fresh salt: nonce ‖ AES-256-GCM ciphertext.
 *
 * A new salt per wrap, deliberately -- re-wrapping under the same password
 * after a scare should still produce an unrelated KEK.
 */
export async function wrapKey(
  secret: string,
  keyMaterial: Uint8Array,
): Promise<Wrapped> {
  const salt = crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES));
  const params = KDF_DEFAULTS;
  const kek = await deriveKek(secret, salt, params);

  const nonce = crypto.getRandomValues(new Uint8Array(WRAP_NONCE_BYTES));
  const aesKey = await crypto.subtle.importKey("raw", kek as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aesKey,
      keyMaterial as BufferSource,
    ),
  );

  const wrapped = new Uint8Array(nonce.length + ciphertext.length);
  wrapped.set(nonce, 0);
  wrapped.set(ciphertext, nonce.length);

  return { wrapped, salt, params };
}

/**
 * Unwraps, or throws WRONG_SECRET.
 *
 * A GCM auth failure *is* the wrong-password signal -- after a password
 * reset the stored wrap no longer matches what the user types, and this
 * clean failure is what routes the client into the recovery flow. No
 * server-side staleness flag exists because none is needed.
 */
export async function unwrapKey(
  secret: string,
  wrap: Wrapped,
): Promise<Uint8Array> {
  const kek = await deriveKek(secret, wrap.salt, wrap.params);
  const nonce = wrap.wrapped.subarray(0, WRAP_NONCE_BYTES);
  const ciphertext = wrap.wrapped.subarray(WRAP_NONCE_BYTES);

  const aesKey = await crypto.subtle.importKey("raw", kek as BufferSource, "AES-GCM", false, [
    "decrypt",
  ]);

  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource },
        aesKey,
        ciphertext as BufferSource,
      ),
    );
  } catch {
    throw new KeysError(
      "WRONG_SECRET",
      "The key could not be unwrapped with that secret",
    );
  }
}

// ---------------------------------------------------------------------------
// The keypair and archive sealing
// ---------------------------------------------------------------------------

export type AccountKeypair = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
};

export async function generateAccountKeypair(): Promise<AccountKeypair> {
  const pair = await hpke.kem.generateKeyPair();
  return {
    publicKey: new Uint8Array(await hpke.kem.serializePublicKey(pair.publicKey)),
    privateKey: new Uint8Array(
      await hpke.kem.serializePrivateKey(pair.privateKey),
    ),
  };
}

/** Seals an archive payload to one user's public key. */
export async function sealForUser(
  publicKey: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const sender = await hpke.createSenderContext({
    recipientPublicKey: await hpke.kem.deserializePublicKey(
      toArrayBuffer(publicKey),
    ),
  });
  const ciphertext = new Uint8Array(await sender.seal(toArrayBuffer(plaintext)));
  const enc = new Uint8Array(sender.enc);

  const sealed = new Uint8Array(1 + enc.length + ciphertext.length);
  sealed[0] = ARCHIVE_FORMAT_X25519;
  sealed.set(enc, 1);
  sealed.set(ciphertext, 1 + enc.length);
  return sealed;
}

/** Opens an archive payload sealed to this account's public key. */
export async function openArchive(
  privateKey: Uint8Array,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  if (sealed[0] !== ARCHIVE_FORMAT_X25519) {
    throw new KeysError(
      "UNSUPPORTED_FORMAT",
      `Archive payload has format byte ${sealed[0] ?? "none"}, ` +
        `and this build only reads ${ARCHIVE_FORMAT_X25519}`,
    );
  }

  const enc = sealed.subarray(1, 1 + X25519_ENC_BYTES);
  const ciphertext = sealed.subarray(1 + X25519_ENC_BYTES);

  const recipient = await hpke.createRecipientContext({
    recipientKey: await hpke.kem.deserializePrivateKey(toArrayBuffer(privateKey)),
    enc: toArrayBuffer(enc),
  });

  try {
    return new Uint8Array(await recipient.open(toArrayBuffer(ciphertext)));
  } catch {
    throw new KeysError(
      "WRONG_SECRET",
      "The archive payload could not be opened with this account key",
    );
  }
}

// ---------------------------------------------------------------------------
// History keys (protocol v3)
// ---------------------------------------------------------------------------
//
// A history key is 32 random bytes per conversation per generation. The key
// itself travels wrapped per member with sealForUser/openArchive above --
// the same stateless HPKE, nothing new -- while archive payloads are sealed
// under it symmetrically: 0x02 ‖ nonce(12) ‖ AES-256-GCM ciphertext.

/** A fresh history key. Random bytes, never derived from anything. */
export function generateHistoryKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(HISTORY_KEY_BYTES));
}

/** Seals an archive payload under a conversation's history key. */
export async function sealWithHistoryKey(
  key: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(HISTORY_NONCE_BYTES));
  const aesKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aesKey,
      plaintext as BufferSource,
    ),
  );

  const sealed = new Uint8Array(1 + nonce.length + ciphertext.length);
  sealed[0] = ARCHIVE_FORMAT_HISTORY_AES256GCM;
  sealed.set(nonce, 1);
  sealed.set(ciphertext, 1 + nonce.length);
  return sealed;
}

/** Opens a v3 archive payload with the generation's history key. */
export async function openWithHistoryKey(
  key: Uint8Array,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  if (sealed[0] !== ARCHIVE_FORMAT_HISTORY_AES256GCM) {
    throw new KeysError(
      "UNSUPPORTED_FORMAT",
      `History-key payload has format byte ${sealed[0] ?? "none"}, ` +
        `and this build only reads ${ARCHIVE_FORMAT_HISTORY_AES256GCM}`,
    );
  }

  const nonce = sealed.subarray(1, 1 + HISTORY_NONCE_BYTES);
  const ciphertext = sealed.subarray(1 + HISTORY_NONCE_BYTES);
  const aesKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "decrypt",
  ]);

  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource },
        aesKey,
        ciphertext as BufferSource,
      ),
    );
  } catch {
    throw new KeysError(
      "WRONG_SECRET",
      "The archive payload could not be opened with this history key",
    );
  }
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

// Crockford base32: no 0/O or 1/I/L confusion when somebody reads their code
// back off paper, which is the medium this is designed for.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_GROUPS = [5, 5, 5, 5, 6] as const;

/**
 * 128 bits of entropy as `XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`.
 *
 * Shown exactly once, at registration. The entropy is what makes the KDF
 * cost on it almost ceremonial -- nobody brute-forces 2^128 -- but it goes
 * through the same Argon2id path as the password so there is one code path,
 * not two.
 */
export function generateRecoveryCode(): string {
  const chars: string[] = [];
  // 26 characters × 5 bits = 130 bits drawn, 128 of them meaningful.
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  for (const byte of bytes) chars.push(CROCKFORD[byte % 32]!);

  const groups: string[] = [];
  let offset = 0;
  for (const size of RECOVERY_GROUPS) {
    groups.push(chars.slice(offset, offset + size).join(""));
    offset += size;
  }
  return groups.join("-");
}

/**
 * What typed input goes through before KDF: uppercase, drop separators, map
 * the confusable letters to what Crockford says they mean. The wrap is made
 * from the *normalized* form, so "o" for "0" on re-entry still unwraps.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

// ---------------------------------------------------------------------------

// WebCrypto and @hpke/core want ArrayBuffer, and a Uint8Array's `.buffer` may
// be a SharedArrayBuffer or carry extra bytes around a subarray's view. Copy.
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}
