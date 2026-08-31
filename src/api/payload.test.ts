// The payload format's forward-compatibility contract, pinned.
//
// The `kind` discriminator only protects clients that already have it -- it
// shipped before any new kind existed precisely so that when one does, every
// deployed client says "needs a newer version" instead of rendering a blank
// bubble. These tests are what stop a refactor from quietly turning that
// back into empty content.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeContent,
  encodeContent,
  encodeOp,
  isMessageOp,
} from "./payload.ts";

function structured(json: object): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(body.length + 1);
  out[0] = 0x01;
  out.set(body, 1);
  return out;
}

test("a legacy raw-text payload is the message text in its entirety", () => {
  const decoded = decodeContent(new TextEncoder().encode('{"text":"hi"}'));
  // A person can type JSON; without the sentinel byte it is just text.
  assert.deepEqual(decoded, { text: '{"text":"hi"}', attachments: [] });
});

test("encodeContent round-trips text with attachments", () => {
  const content = {
    text: "look",
    attachments: [{ id: "a1", mediaType: "image/jpeg", byteSize: 123 }],
  };
  assert.deepEqual(decodeContent(encodeContent(content)), content);
});

test("an absent kind means text, and an explicit kind of \"text\" does too", () => {
  assert.deepEqual(decodeContent(structured({ text: "hi", attachments: [] })), {
    text: "hi",
    attachments: [],
  });
  assert.deepEqual(
    decodeContent(structured({ kind: "text", text: "hi", attachments: [] })),
    { text: "hi", attachments: [] },
  );
});

test("an unknown kind decodes to \"unsupported\", not empty content", () => {
  assert.equal(
    decodeContent(structured({ kind: "voice", duration: 3 })),
    "unsupported",
  );
  // A kind that is not even a string is still a newer client's payload,
  // not corruption.
  assert.equal(decodeContent(structured({ kind: 3 })), "unsupported");
});

test("the op kinds round-trip through encodeOp, and isMessageOp knows them", () => {
  const ops = [
    { kind: "reaction", target: "t1", emoji: "👍" },
    { kind: "reaction", target: "t1", emoji: null },
    { kind: "edit", target: "t1", text: "fixed" },
    { kind: "retract", target: "t1" },
  ] as const;
  for (const op of ops) {
    const decoded = decodeContent(encodeOp(op));
    assert.deepEqual(decoded, op);
    assert.equal(isMessageOp(decoded), true);
  }
  assert.equal(isMessageOp({ text: "hi", attachments: [] }), false);
  assert.equal(isMessageOp("unsupported"), false);
});

test("a known op kind with a bad shape is \"unsupported\", not a broken op", () => {
  // Missing target, wrong-typed fields, or an emoji long enough to be a
  // paragraph: a newer client wanting new op semantics must pick a new kind
  // name, so these are all "cannot represent", never a partial apply.
  assert.equal(decodeContent(structured({ kind: "reaction" })), "unsupported");
  assert.equal(
    decodeContent(structured({ kind: "reaction", target: "t1", emoji: 7 })),
    "unsupported",
  );
  assert.equal(
    decodeContent(
      structured({ kind: "reaction", target: "t1", emoji: "x".repeat(33) }),
    ),
    "unsupported",
  );
  assert.equal(
    decodeContent(structured({ kind: "edit", target: "t1" })),
    "unsupported",
  );
  assert.equal(decodeContent(structured({ kind: "retract" })), "unsupported");
});

test("replyTo rides the structured text shape and round-trips", () => {
  const content = {
    text: "agreed",
    attachments: [],
    replyTo: { messageId: "m1", excerpt: "shall we?", senderUserId: "u1" },
  };
  const encoded = encodeContent(content);
  // A reply forces the structured format even with no attachments.
  assert.equal(encoded[0], 0x01);
  assert.deepEqual(decodeContent(encoded), content);
});

test("a malformed replyTo is dropped, leaving the text intact", () => {
  const decoded = decodeContent(
    structured({ text: "hi", attachments: [], replyTo: { messageId: 3 } }),
  );
  assert.deepEqual(decoded, { text: "hi", attachments: [] });
});

test("corrupt bytes after the sentinel are empty content, never a throw", () => {
  const corrupt = new Uint8Array([0x01, 0x7b, 0x22]); // 0x01 then truncated JSON
  assert.deepEqual(decodeContent(corrupt), { text: "", attachments: [] });
});

test("an empty payload is empty content", () => {
  assert.deepEqual(decodeContent(new Uint8Array(0)), {
    text: "",
    attachments: [],
  });
});
