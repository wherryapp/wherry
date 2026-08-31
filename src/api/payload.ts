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

/**
 * Quote context on a reply, copied into the payload at send time.
 *
 * The excerpt is a *copy*, not a lookup: the target message may simply not be
 * on the receiving device (a member added later, a cleared browser), and a
 * reply that renders only when its target happens to be local is a reply that
 * usually renders as nothing. Denormalising the excerpt is the boring fix.
 *
 * Reply is deliberately an additive field on the text shape rather than a new
 * `kind`: a client without this code renders the reply's text and merely
 * misses the quote, which degrades strictly better than the "needs a newer
 * version" placeholder a new kind would force. New kinds are reserved for
 * payloads an old rendering would get *wrong*, not merely poorer.
 */
export type ReplyContext = {
  messageId: string;
  excerpt: string;
  senderUserId: string;
};

// Matches the server's MENTIONS_MAX; more than this is a broadcast wearing
// a mention's clothes, and the server ignores the overflow anyway.
export const MENTIONS_MAX = 20;

export type MessageContent = {
  text: string;
  attachments: AttachmentRef[];
  replyTo?: ReplyContext;
  /**
   * User ids named in the text. Additive like replyTo -- an old client
   * renders the text and merely misses the highlight. In PUBLIC channels
   * the server reads this from the (readable) payload and pushes only the
   * people it names; in sealed conversations it is client-side decoration
   * only, because the server cannot read it there. Disclosed in docs/api.md.
   */
  mentions?: string[];
};

// ---------------------------------------------------------------------------
// Operation payloads -- messages about other messages
// ---------------------------------------------------------------------------
//
// A reaction, an edit and a retraction are ordinary messages whose content
// *targets* another message by id. They are stored, synced, archived and
// encrypted exactly like text -- the server cannot tell a reaction from a
// novel -- and the timeline aggregates them onto their targets at render
// time. Per (target, reactor) the latest reaction wins; per target the
// latest edit wins; a retraction beats everything. "Latest" is uuidv7 order,
// the same order the timeline already sorts by.

export type ReactionOp = {
  kind: "reaction";
  target: string;
  /** The emoji to show, or null to remove this sender's reaction. */
  emoji: string | null;
};

export type EditOp = {
  kind: "edit";
  target: string;
  /** Replacement text. Attachments are not editable; the target's remain. */
  text: string;
};

export type RetractOp = {
  kind: "retract";
  target: string;
};

export type MessageOp = ReactionOp | EditOp | RetractOp;

/**
 * What decoding produces: content, or the fact that this build cannot
 * represent it.
 *
 * A structured payload may carry a `kind` field naming what it is. Absent
 * means `"text"` -- the shape that existed before the field did. This build
 * also knows the operation kinds (`reaction`, `edit`, `retract`), which are
 * not rendered as messages but aggregated onto their targets. Anything else
 * (a voice note -- kinds that do not exist yet) decodes to `"unsupported"`,
 * which the UI renders as "needs a newer version" rather than as an empty
 * message.
 *
 * The distinction is the whole point: a client without this code shows an
 * unknown kind as a blank bubble and nobody can tell why. This ships before
 * any new kind does, precisely because it only protects clients that already
 * have it.
 */
/** What the timeline can put in a bubble: everything decode produces except
 * an operation, which is aggregated onto its target instead of rendered. */
export type RenderableContent = MessageContent | "unsupported";

export type DecodedContent = RenderableContent | MessageOp;

/**
 * Discriminates an operation from renderable content. `MessageContent` never
 * carries a `kind` property -- the decoder strips it -- so the check is exact.
 */
export function isMessageOp(decoded: DecodedContent): decoded is MessageOp {
  return typeof decoded === "object" && "kind" in decoded;
}

/** Encodes content, choosing the smallest representation that carries it. */
export function encodeContent(content: MessageContent): Uint8Array {
  // Text with no attachments, no reply context and no mentions stays in the
  // old format. Not for compatibility with old *clients* -- there are none
  // in the wild that would choke -- but because the overwhelming majority of
  // messages are plain text, and wrapping every one of them in JSON costs
  // bytes in two tables and a parse on every render, forever, to express
  // nothing.
  const mentions =
    content.mentions !== undefined && content.mentions.length > 0
      ? [...new Set(content.mentions)].slice(0, MENTIONS_MAX)
      : undefined;

  if (
    content.attachments.length === 0 &&
    content.replyTo === undefined &&
    mentions === undefined
  ) {
    return new TextEncoder().encode(content.text);
  }

  const json = JSON.stringify({
    text: content.text,
    attachments: content.attachments,
    ...(content.replyTo !== undefined && { replyTo: content.replyTo }),
    ...(mentions !== undefined && { mentions }),
  });

  const body = new TextEncoder().encode(json);
  const out = new Uint8Array(body.length + 1);
  out[0] = STRUCTURED;
  out.set(body, 1);
  return out;
}

/** Encodes an operation. Always structured -- an op has no legacy form. */
export function encodeOp(op: MessageOp): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(op));
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
      replyTo?: unknown;
      mentions?: unknown;
      target?: unknown;
      emoji?: unknown;
    };

    // Absent means "text". A recognised kind whose required fields do not
    // check out is also "unsupported" -- a newer client wanting different
    // semantics for an op must pick a new kind name, so a known name with an
    // unknown shape is by definition something this build cannot represent.
    // Present-but-unrecognised -- including a kind that is not even a string
    // -- is a payload from a newer client, not garbage.
    if (shape.kind !== undefined && shape.kind !== "text") {
      return decodeOp(shape) ?? "unsupported";
    }

    const content: MessageContent = {
      text: typeof shape.text === "string" ? shape.text : "",
      attachments: Array.isArray(shape.attachments)
        ? shape.attachments.filter(isAttachmentRef)
        : [],
    };
    // A malformed replyTo is dropped rather than failing the message: the
    // text still renders, which is exactly how a client predating the field
    // degrades. Mentions get the same treatment, entry by entry.
    if (isReplyContext(shape.replyTo)) content.replyTo = shape.replyTo;
    if (Array.isArray(shape.mentions)) {
      const mentions = [
        ...new Set(
          shape.mentions.filter((m): m is string => typeof m === "string"),
        ),
      ].slice(0, MENTIONS_MAX);
      if (mentions.length > 0) content.mentions = mentions;
    }
    return content;
  } catch {
    return { text: "", attachments: [] };
  }
}

/** The op kinds this build knows. Anything else is the caller's "unsupported". */
function decodeOp(shape: {
  kind?: unknown;
  target?: unknown;
  text?: unknown;
  emoji?: unknown;
}): MessageOp | null {
  if (typeof shape.target !== "string") return null;

  switch (shape.kind) {
    case "reaction":
      // The length cap is defensive: a chip renders whatever this string is,
      // and 32 UTF-16 units is room for any real emoji sequence (the longest
      // ZWJ families are ~11) without letting a paragraph through.
      if (shape.emoji === null) {
        return { kind: "reaction", target: shape.target, emoji: null };
      }
      if (typeof shape.emoji === "string" && shape.emoji.length <= 32) {
        return { kind: "reaction", target: shape.target, emoji: shape.emoji };
      }
      return null;
    case "edit":
      if (typeof shape.text !== "string") return null;
      return { kind: "edit", target: shape.target, text: shape.text };
    case "retract":
      return { kind: "retract", target: shape.target };
    default:
      return null;
  }
}

function isReplyContext(value: unknown): value is ReplyContext {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref["messageId"] === "string" &&
    typeof ref["excerpt"] === "string" &&
    typeof ref["senderUserId"] === "string"
  );
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
