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
  MENTIONS_MAX,
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

test("mentions ride the structured text shape and round-trip", () => {
  const content = { text: "hey @Dave", attachments: [], mentions: ["u2"] };
  const encoded = encodeContent(content);
  // Mentions force the structured format even with no attachments.
  assert.equal(encoded[0], 0x01);
  assert.deepEqual(decodeContent(encoded), content);
});

test("mentions are deduplicated, filtered and capped, never trusted", () => {
  const encoded = encodeContent({
    text: "x",
    attachments: [],
    mentions: ["a", "a", "b"],
  });
  const decoded = decodeContent(encoded);
  assert.notEqual(decoded, "unsupported");
  if (decoded !== "unsupported" && !isMessageOp(decoded)) {
    assert.deepEqual(decoded.mentions, ["a", "b"]);
  }

  // Off the wire, non-strings are dropped and an empty list is absence.
  const dirty = decodeContent(
    structured({ text: "x", attachments: [], mentions: [5, null, "c"] }),
  );
  if (dirty !== "unsupported" && !isMessageOp(dirty)) {
    assert.deepEqual(dirty.mentions, ["c"]);
  }
  const none = decodeContent(
    structured({ text: "x", attachments: [], mentions: [] }),
  );
  if (none !== "unsupported" && !isMessageOp(none)) {
    assert.equal(none.mentions, undefined);
  }

  const many = Array.from({ length: MENTIONS_MAX + 5 }, (_, i) => `u${i}`);
  const capped = decodeContent(
    structured({ text: "x", attachments: [], mentions: many }),
  );
  if (capped !== "unsupported" && !isMessageOp(capped)) {
    assert.equal(capped.mentions?.length, MENTIONS_MAX);
  }
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

test("an unsupported kind counts as unread — the constraint on any future kind", () => {
  // store.countUnread skips a message only when isMessageOp says so, and
  // ui/unread.ts mirrors countUnread exactly so the divider and the badge
  // cannot name different numbers. Composing the two calls the way the store
  // does is the point of this test: "unsupported" is not an op, so a client
  // that predates a new kind COUNTS it, badges it, and can open the
  // conversation onto a bubble reading "this message needs a newer version".
  //
  // That is correct for a kind meant to be read, and wrong for one that is
  // not -- so an invisible new kind must be an OPERATION, added to decodeOp's
  // switch, never merely a new kind name. Like the discriminator itself, that
  // only protects clients shipped before the first such message is sent,
  // which is why the rule is pinned here rather than remembered.
  const unknown = structured({ kind: "voice", target: "t1", duration: 3 });
  assert.equal(decodeContent(unknown), "unsupported");
  assert.equal(isMessageOp(decodeContent(unknown)), false);

  // The behaviour an invisible kind has to join: every op is skipped.
  for (const op of [
    { kind: "reaction", target: "t1", emoji: "👍" },
    { kind: "edit", target: "t1", text: "fixed" },
    { kind: "retract", target: "t1" },
  ] as const) {
    assert.equal(isMessageOp(decodeContent(encodeOp(op))), true);
  }
});

// Attachment refs are another client's data. Every field the type admits is
// checked, because a consumer that trusts the type will call string methods
// on it during render (sweep 1001, client-core-2: `name: 5` blanked the app).
function refsOf(attachments: unknown[]): unknown {
  const decoded = decodeContent(structured({ text: "x", attachments }));
  assert.ok(typeof decoded === "object" && !isMessageOp(decoded));
  return decoded.attachments;
}

const base = { id: "a1", mediaType: "application/pdf", byteSize: 1 };
const sealed = {
  key: "q83vEjRWeJA=",
  nonce: "AAAAAAAAAAAAAAAA",
  digest: "3q2+7w==",
};

test("a non-string attachment name is dropped, and the attachment kept", () => {
  for (const name of [5, null, {}, ["a"], true]) {
    assert.deepEqual(refsOf([{ ...base, name }]), [base]);
  }
  assert.deepEqual(refsOf([{ ...base, name: "report.pdf" }]), [
    { ...base, name: "report.pdf" },
  ]);
});

test("width and height survive only as finite positive numbers", () => {
  for (const bad of ["100", -1, 0, Number.NaN, null, {}]) {
    assert.deepEqual(refsOf([{ ...base, width: bad, height: bad }]), [base]);
  }
  // JSON cannot carry Infinity or NaN, but a hand-built payload can say 1e999,
  // which parses to Infinity.
  const huge = new TextEncoder().encode(
    '\u0001{"text":"x","attachments":[{"id":"a1","mediaType":"image/png","byteSize":1,"width":1e999}]}',
  );
  const decoded = decodeContent(huge);
  assert.ok(typeof decoded === "object" && !isMessageOp(decoded));
  assert.deepEqual(decoded.attachments, [
    { id: "a1", mediaType: "image/png", byteSize: 1 },
  ]);
  assert.deepEqual(refsOf([{ ...base, width: 640, height: 480 }]), [
    { ...base, width: 640, height: 480 },
  ]);
});

test("a malformed required field rejects the ref", () => {
  assert.deepEqual(
    refsOf([
      { ...base, id: 5 },
      { ...base, id: "" },
      { ...base, mediaType: 7 },
      { ...base, byteSize: "1" },
      { ...base, byteSize: -1 },
      null,
      "a1",
    ]),
    [],
  );
});

test("the crypto fields come as a base64 set of three or not at all", () => {
  assert.deepEqual(refsOf([{ ...base, ...sealed }]), [{ ...base, ...sealed }]);
  assert.deepEqual(
    refsOf([
      { ...base, key: sealed.key },
      { ...base, ...sealed, nonce: undefined },
      // Present but not a string: before, a non-string did not count toward
      // the set, so `key: 5` alone passed as a plaintext-era ref.
      { ...base, key: 5 },
      { ...base, ...sealed, key: 5 },
      // Not base64: `atob` would throw a DOMException in the download path.
      { ...base, ...sealed, key: "not base64!" },
      { ...base, ...sealed, digest: "abc" },
    ]),
    [],
  );
});

test("a ref is rebuilt, so nothing the sender added rides along", () => {
  assert.deepEqual(refsOf([{ ...base, extra: "x", __proto__: { y: 1 } }]), [
    base,
  ]);
});
