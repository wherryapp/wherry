// Pins local search's answer (store/search.ts): the matching rules, and the
// two things a search of stored bytes gets wrong without the ops -- an edited
// message must be found by its new text and not its old, and a retracted one
// must not be found at all. Every MessageStore implementation owes this answer.
//
// Run with `pnpm test` from client/. No database, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeContent, encodeOp, type MessageOp } from "../api/payload.ts";
import {
  containsAnyTerm,
  parseQuery,
  SearchFold,
  snippet,
  type SearchHit,
} from "./search.ts";
import type { StoredMessage } from "./types.ts";

const ME = "user-me";
const ALICE = "user-alice";
const BOB = "user-bob";

function stored(
  messageId: string,
  senderUserId: string,
  payload: Uint8Array,
  extra: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    messageId,
    conversationId: "c1",
    senderUserId,
    senderDeviceId: `${senderUserId}-device`,
    protocolVersion: 2,
    payload,
    sentAt: "2026-09-15T12:00:00.000Z",
    ...extra,
  };
}

const text = (value: string) => encodeContent({ text: value, attachments: [] });
const op = (value: MessageOp) => encodeOp(value);

/** Offers messages newest first, as every scan must, and returns the hits. */
function search(
  query: string,
  messages: StoredMessage[],
  pending: Uint8Array[] = [],
): SearchHit[] {
  const fold = new SearchFold(parseQuery(query), ME);
  fold.applyPending(pending);
  return [...messages]
    .sort((a, b) => b.messageId.localeCompare(a.messageId))
    .flatMap((message) => {
      const hit = fold.offer(message);
      return hit ? [hit] : [];
    });
}

const ids = (hits: SearchHit[]) => hits.map((hit) => hit.messageId);

test("a query splits on whitespace, drops duplicates without regard to case, and caps", () => {
  assert.deepEqual(parseQuery("  quokka   Picnic\tquokka PICNIC "), ["quokka", "Picnic"]);
  assert.deepEqual(parseQuery("   "), []);
  assert.equal(parseQuery("a b c d e f g h i j").length, 8);
});

test("matching ignores case and needs every term", () => {
  const messages = [
    stored("m1", ALICE, text("Quokka picnic on Sunday")),
    stored("m2", ALICE, text("a quokka alone")),
    stored("m3", BOB, text("a picnic alone")),
  ];
  assert.deepEqual(ids(search("QUOKKA picnic", messages)), ["m1"]);
  assert.deepEqual(ids(search("alone", messages)), ["m3", "m2"]);
});

test("an edited message is found by its new text and not the text it replaced", () => {
  const messages = [
    stored("m1", ALICE, text("meet at the harbour")),
    stored("m2", ALICE, op({ kind: "edit", target: "m1", text: "meet at the station" })),
  ];
  assert.deepEqual(ids(search("harbour", messages)), []);
  const [hit] = search("station", messages);
  assert.equal(hit?.messageId, "m1");
  assert.equal(hit?.text, "meet at the station");
  assert.equal(hit?.edited, true);
});

test("the sender's newest edit is the one searched", () => {
  const messages = [
    stored("m1", ALICE, text("original")),
    stored("m2", ALICE, op({ kind: "edit", target: "m1", text: "first edit" })),
    stored("m3", ALICE, op({ kind: "edit", target: "m1", text: "second edit" })),
  ];
  assert.deepEqual(ids(search("first", messages)), []);
  assert.deepEqual(ids(search("second", messages)), ["m1"]);
});

test("an edit from anybody but the sender is ignored, and cannot hide the real one", () => {
  const messages = [
    stored("m1", ALICE, text("original")),
    stored("m2", ALICE, op({ kind: "edit", target: "m1", text: "the real edit" })),
    stored("m3", BOB, op({ kind: "edit", target: "m1", text: "forged" })),
  ];
  assert.deepEqual(ids(search("forged", messages)), []);
  assert.deepEqual(ids(search("real", messages)), ["m1"]);
});

test("a retracted message is never found; a retraction by somebody else changes nothing", () => {
  const plan = stored("m1", ALICE, text("the secret plan"));
  assert.deepEqual(
    ids(search("secret", [plan, stored("m2", ALICE, op({ kind: "retract", target: "m1" }))])),
    [],
  );
  assert.deepEqual(
    ids(search("secret", [plan, stored("m2", BOB, op({ kind: "retract", target: "m1" }))])),
    ["m1"],
  );
});

test("this device's unsent ops apply, the newest pending edit winning", () => {
  const mine = [stored("m1", ME, text("a typo here"))];
  assert.deepEqual(ids(search("typo", mine, [op({ kind: "retract", target: "m1" })])), []);
  const edited = search("fixed", mine, [
    op({ kind: "edit", target: "m1", text: "fixed once" }),
    op({ kind: "edit", target: "m1", text: "fixed twice" }),
  ]);
  assert.equal(edited[0]?.text, "fixed twice");
});

test("an attachment is found by its filename", () => {
  const messages = [
    stored(
      "m1",
      ALICE,
      encodeContent({
        text: "",
        attachments: [
          { id: "a1", name: "Quarterly Report.pdf", mediaType: "application/pdf", byteSize: 10 },
        ],
      }),
    ),
  ];
  const [hit] = search("report", messages);
  assert.deepEqual(hit?.filenames, ["Quarterly Report.pdf"]);
  // A term cannot straddle the text and a filename.
  assert.deepEqual(ids(search("pdf quarterly", messages)), ["m1"]);
});

test("operations, unsupported kinds and undecrypted rows are never hits", () => {
  const unsupported = new TextEncoder().encode('{"kind":"poll","text":"hello"}');
  const messages = [
    stored("m1", ALICE, op({ kind: "reaction", target: "m0", emoji: "hello" })),
    stored("m2", ALICE, unsupported),
    stored("m3", ALICE, new TextEncoder().encode("hello"), { decryptFailed: true }),
  ];
  assert.deepEqual(ids(search("hello", messages)), []);
});

test("decomposed text matches a composed query", () => {
  const messages = [stored("m1", ALICE, text("the café on the corner"))];
  assert.deepEqual(ids(search("café", messages)), ["m1"]);
});

test("a query full of pattern characters is matched literally", () => {
  const messages = [
    stored("m1", ALICE, text("I write c++ (mostly)")),
    stored("m2", ALICE, text("I write c")),
  ];
  assert.deepEqual(ids(search("c++ (mostly)", messages)), ["m1"]);
  assert.equal(containsAnyTerm("[brackets]", ["[br"]), true);
});

test("a snippet marks every occurrence in its original case", () => {
  assert.deepEqual(snippet("The Quokka met a quokka", ["quokka"]), [
    { text: "The ", hit: false },
    { text: "Quokka", hit: true },
    { text: " met a ", hit: false },
    { text: "quokka", hit: true },
  ]);
});

test("a snippet marks every term of a several-term query, longest first", () => {
  assert.deepEqual(snippet("Kestrel and an osprey, kestrels too", ["kestrel", "osprey", "kestrels"]), [
    { text: "Kestrel", hit: true },
    { text: " and an ", hit: false },
    { text: "osprey", hit: true },
    { text: ", ", hit: false },
    { text: "kestrels", hit: true },
    { text: " too", hit: false },
  ]);
  assert.equal(snippet("a+b (c)", ["a+b", "(c)"]).filter((part) => part.hit).length, 2);
});

test("a snippet of long text starts near the match and says it was cut", () => {
  const long = `${"filler ".repeat(60)}the needle ${"more ".repeat(60)}`;
  const parts = snippet(long, ["needle"], 60);
  assert.equal(parts[0]?.text.startsWith("…"), true);
  assert.equal(parts[parts.length - 1]?.text.endsWith("…"), true);
  assert.equal(parts.some((part) => part.hit && part.text === "needle"), true);
  assert.deepEqual(snippet("   ", ["x"]), []);
});
