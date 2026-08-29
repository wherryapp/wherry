// Bytes to base64 and back.
//
// The mirror of server/src/routes/shared.ts. Message content is bytes
// everywhere it matters and base64 only on the wire, because JSON cannot carry
// bytes and `envelopes.payload` is bytea.
//
// Under version 1 those bytes happen to be UTF-8 text. Nothing here is allowed
// to assume that -- the moment payloads are ciphertext, a helper that returned
// a string would be a lie. Text decoding is the caller's business, and it
// happens only after the protocol version has been checked.

/**
 * Encodes bytes as base64.
 *
 * Chunked rather than `String.fromCharCode(...bytes)`. Spreading a 48 KiB
 * payload passes ~49,000 arguments in one call, which is close enough to
 * engine argument limits to fail on larger inputs -- and it would fail as a
 * RangeError at send time rather than anywhere useful.
 */
export function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decodes base64 to bytes.
 *
 * `atob` throws on characters base64 cannot contain, which is the behaviour we
 * want and is worth contrasting with Node: `Buffer.from(s, "base64")` silently
 * skips them and returns something shorter, so a corrupt payload would decode
 * to a truncated message rather than an error. That is the same hazard the
 * server's BASE64_PATTERN exists to close on the way in.
 */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 text to bytes, for composing a version 1 message. */
export function textToBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Bytes to UTF-8 text. Only valid once protocolVersion has been checked. */
export function bytesToText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
