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
};

export type MessageContent = {
  text: string;
  attachments: AttachmentRef[];
};

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
 * Never throws. A payload this build cannot make sense of -- a future format,
 * or something corrupt -- comes back as empty content rather than an
 * exception, because the alternative is one bad message taking down the
 * timeline it appears in.
 */
export function decodeContent(payload: Uint8Array): MessageContent {
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

    const shape = parsed as { text?: unknown; attachments?: unknown };

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
  return (
    typeof ref["id"] === "string" &&
    typeof ref["mediaType"] === "string" &&
    typeof ref["byteSize"] === "number"
  );
}
