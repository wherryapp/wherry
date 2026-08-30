// Attachment encryption: a fresh key per blob, carried inside the message.
//
// The server's attachment store was built for this day -- it takes and
// returns opaque bytes, records no filename and no content type -- so the
// entire change is the client encrypting before upload and the reference
// inside the message payload growing three fields: the key, the nonce, and
// a digest of the ciphertext. The reference travels inside the message
// content, which MLS already seals, so the key reaches exactly the people
// the message does and nobody else. This is the standard shape (it is how
// Signal ships attachments) and there is nothing clever in it.
//
// The digest is of the *ciphertext*, checked before decryption: the
// reference, sealed inside the message, commits to the exact bytes the
// sender uploaded, so the blob store (or anything between) swapping bytes
// is detected as a mismatch rather than surfacing as a GCM error -- or
// worse, as a decrypt of something else that happened to be sealed under a
// key the attacker learned. Belt and braces over AES-GCM's own
// authentication, at the cost of one hash.

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export type BlobCrypto = {
  /** base64, all three -- they live inside the payload JSON. */
  key: string;
  nonce: string;
  digest: string;
};

export class BlobCryptoError extends Error {
  readonly code: "DIGEST_MISMATCH" | "DECRYPT_FAILED";

  constructor(code: "DIGEST_MISMATCH" | "DECRYPT_FAILED", message: string) {
    super(message);
    this.name = "BlobCryptoError";
    this.code = code;
  }
}

// Standalone base64 helpers rather than importing api/base64: crypto modules
// depending on the api layer is the wrong direction, and these are four
// lines each.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

/** Encrypts a blob under a fresh single-use key. Single-shot AES-256-GCM --
 * fine at the attachment size cap, and one fewer thing to get wrong than a
 * streaming construction. */
export async function encryptBlob(
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; ref: BlobCrypto }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      key,
      toArrayBuffer(plaintext),
    ),
  );

  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(ciphertext)),
  );

  return {
    ciphertext,
    ref: {
      key: toBase64(keyBytes),
      nonce: toBase64(nonce),
      digest: toBase64(digest),
    },
  };
}

/**
 * What both download paths call: bytes come back as-is for a
 * plaintext-era reference, decrypted (and digest-verified) for one that
 * carries a key. Throws BlobCryptoError on tampered or undecryptable bytes.
 */
export async function openAttachmentBytes(
  ref: { key?: string; nonce?: string; digest?: string },
  fetched: Uint8Array,
): Promise<Uint8Array> {
  if (!ref.key || !ref.nonce || !ref.digest) return fetched;
  return await decryptBlob(fetched, {
    key: ref.key,
    nonce: ref.nonce,
    digest: ref.digest,
  });
}

/** Verifies the digest, then decrypts. Throws BlobCryptoError on either. */
export async function decryptBlob(
  ciphertext: Uint8Array,
  ref: BlobCrypto,
): Promise<Uint8Array> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(ciphertext)),
  );
  if (toBase64(digest) !== ref.digest) {
    throw new BlobCryptoError(
      "DIGEST_MISMATCH",
      "The stored bytes are not what the sender uploaded",
    );
  }

  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(ref.key) as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"],
  );

  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(ref.nonce) as BufferSource },
        key,
        toArrayBuffer(ciphertext),
      ),
    );
  } catch {
    throw new BlobCryptoError(
      "DECRYPT_FAILED",
      "The attachment could not be decrypted with the key in the message",
    );
  }
}
