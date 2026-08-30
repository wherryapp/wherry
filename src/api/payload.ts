// What is inside a message payload.
//
// ---------------------------------------------------------------------------
// Two formats, and how a client tells them apart
// ---------------------------------------------------------------------------
//
// Every message sent before attachments existed is a payload of raw UTF-8
// text, and those messages are immutable and permanent -- they live in
// `message_archive` and cannot be rewritten, by design. So a client has to
// read both forever.
//
// A structured payload therefore begins with a single sentinel byte, 0x01,
// followed by UTF-8 JSON. Anything not starting with that byte is the old
// format and is the message text in its entirety.
//
// The obvious alternative -- try `JSON.parse` and fall back on failure -- is
// wrong in a way that would take a long time to notice: "{}" is a message
// somebody can type, and so is `{"text": "hi"}`. A control byte cannot appear
// at the start of a plain-text message, so the test is exact rather than a
// guess about intent.
//
// This is deliberately *not* `protocol_version` on the envelope. That field
// says how the bytes were encrypted; this says what the bytes mean once
// decrypted. Conflating them would mean a payload format change forced a
// crypto version change, and every client that could not read the new shape
// would decide it could not decrypt the message either.

const STRUCTURED = 0x01;

export type AttachmentRef = {
  id: string;
  /**
   * The real type of the file, which the *server* never learns.
   *
   * It lives here, inside the payload, because it is content: knowing an
   * attachment is a photo rather than a PDF says something about the message.
   * The upload endpoint takes and returns opaque bytes and stores no type.
   */
  mediaType: string;
  byteSize: number;
  /** Pixel dimensions, so a placeholder can hold the right shape while loading. */
  width?: number;
  height?: number;
  /**
   * Present together on an encrypted attachment: the single-use AES-256-GCM
   * key and nonce the blob was sealed with, and a SHA-256 digest of the
   * ciphertext, all base64. They live here because the payload is the one
   * place already sealed to exactly the message's audience -- the key
   * reaches whoever the message does and nobody else, the server included.
   * A reference without them is a plaintext-era blob and is read as-is.
   */
  key?: string;
  nonce?: string;
  digest?: string;
};

export type MessageContent = {
  text: string;
  attachments: AttachmentRef[];
};

/**
 * What decoding produces: content, or the fact that this build cannot
 * represent it.
 *
 * A structured payload may carry a `kind` field naming what it is. Absent
 * means `"text"` -- the shape that existed before the field did, and the only
 * kind this build knows. Anything else (a reaction, a reply, a voice note --
 * kinds that do not exist yet) decodes to `"unsupported"`, which the UI
 * renders as "needs a newer version" rather than as an empty message.
 *
 * The distinction is the whole point: a client without this code shows an
 * unknown kind as a blank bubble and nobody can tell why. This ships before
 * any new kind does, precisely because it only protects clients that already
 * have it.
 */
export type DecodedContent = MessageContent | "unsupported";

/** Encodes content, choosing the smallest representation that carries it. */
export function encodeContent(content: MessageContent): Uint8Array {
  // Text with no attachments stays in the old format. Not for compatibility
  // with old *clients* -- there are none in the wild that would choke -- but
  // because the overwhelming majority of messages are plain text, and wrapping
  // every one of them in JSON costs bytes in two tables and a parse on every
  // render, forever, to express nothing.
  if (content.attachments.length === 0) {
    return new TextEncoder().encode(content.text);
  }

  const json = JSON.stringify({
    text: content.text,
    attachments: content.attachments,
  });

  const body = new TextEncoder().encode(json);
  const out = new Uint8Array(body.length + 1);
  out[0] = STRUCTURED;
  out.set(body, 1);
  return out;
}

/**
 * Decodes a payload of either format.
 *
 * Never throws. Corrupt bytes come back as empty content rather than an
 * exception, because the alternative is one bad message taking down the
 * timeline it appears in. A well-formed payload of a kind this build does
 * not know comes back as `"unsupported"` -- corruption and the future are
 * different things, and only the latter is fixed by updating.
 */
export function decodeContent(payload: Uint8Array): DecodedContent {
  if (payload.length === 0) return { text: "", attachments: [] };

  if (payload[0] !== STRUCTURED) {
    return { text: new TextDecoder().decode(payload), attachments: [] };
  }

  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(payload.subarray(1)),
    );

    if (typeof parsed !== "object" || parsed === null) {
      return { text: "", attachments: [] };
    }

    const shape = parsed as {
      kind?: unknown;
      text?: unknown;
      attachments?: unknown;
    };

    // Absent means "text". Present-but-unrecognised -- including a kind that
    // is not even a string -- is a payload from a newer client, not garbage.
    if (shape.kind !== undefined && shape.kind !== "text") {
      return "unsupported";
    }

    return {
      text: typeof shape.text === "string" ? shape.text : "",
      attachments: Array.isArray(shape.attachments)
        ? shape.attachments.filter(isAttachmentRef)
        : [],
    };
  } catch {
    return { text: "", attachments: [] };
  }
}

/**
 * Checked rather than asserted.
 *
 * This is data off the wire that another client wrote, and a malformed
 * reference that reached the render layer would be a crash in a component
 * rather than a message that quietly shows less than it should.
 */
function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;

  // The crypto fields come as a set or not at all. A reference with a key
  // but no nonce is not "partially encrypted", it is malformed, and letting
  // it through would surface as a baffling decrypt error later.
  const cryptoFields = [ref["key"], ref["nonce"], ref["digest"]];
  const cryptoCount = cryptoFields.filter(
    (field) => typeof field === "string",
  ).length;
  if (cryptoCount !== 0 && cryptoCount !== 3) return false;

  return (
    typeof ref["id"] === "string" &&
    typeof ref["mediaType"] === "string" &&
    typeof ref["byteSize"] === "number"
  );
}
