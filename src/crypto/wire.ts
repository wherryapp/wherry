// MLSMessage wire bytes -> a decoded message, total over its input.
//
// Kept apart from crypto/mls.ts because that file needs IndexedDB and Web
// Locks and so cannot load under Node; this one is pure, and the property it
// holds is the kind only a pinned test keeps. The bytes it decodes come off
// the wire from another member -- an envelope, a commit, a published key
// package or GroupInfo, a welcome -- and ts-mls's decoder does not only
// answer `undefined` for bad input: on a truncated body it *throws* its own
// CodecError ("Offset beyond buffer", "Incomplete 2-byte length"). The
// engine turns an E2EError into one failed message, but anything else
// escapes the inbox page's Promise.all, so one member sending four bytes
// stopped every recipient device's inbox, in every conversation, until the
// envelope was deleted server-side (sweep 1001, client-core-1). So every
// failure here is the same E2EError a well-formed but unopenable message
// gets.

import { decodeMlsMessage, type MLSMessage } from "ts-mls";
import { E2EError } from "./provider";

type WireFormat = MLSMessage["wireformat"];

/**
 * Decodes an MLSMessage and checks it is one of the wire formats expected.
 * Throws only `E2EError("EPOCH_UNAVAILABLE")`, whatever the bytes.
 */
export function decodeWire<F extends WireFormat>(
  bytes: Uint8Array,
  ...expect: F[]
): Extract<MLSMessage, { wireformat: F }> {
  let decoded: ReturnType<typeof decodeMlsMessage>;
  try {
    decoded = decodeMlsMessage(bytes, 0);
  } catch (error) {
    throw new E2EError(
      "EPOCH_UNAVAILABLE",
      `Payload is not an MLS message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!decoded) {
    throw new E2EError("EPOCH_UNAVAILABLE", "Payload is not an MLS message");
  }
  const [message] = decoded;
  if (!(expect as WireFormat[]).includes(message.wireformat)) {
    throw new E2EError(
      "EPOCH_UNAVAILABLE",
      `Expected ${expect.join(" or ")}, got ${message.wireformat}`,
    );
  }
  return message as Extract<MLSMessage, { wireformat: F }>;
}
