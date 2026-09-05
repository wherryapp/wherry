// Pins how channels fall under categories: uncategorised first and
// unheaded, server order kept, orphans kept visible, empties dropped
// unless asked for.
//
// Run with `pnpm test` from client/. No database, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { groupChannels } from "./channels.ts";

const cat = (id: string) => ({ id, name: id });
const ch = (id: string, categoryId: string | null) => ({ id, categoryId });

test("a hub with no categories is one unheaded group, order kept", () => {
  const groups = groupChannels([ch("a", null), ch("b", null)], []);
  assert.deepEqual(groups, [
    { category: null, channels: [ch("a", null), ch("b", null)] },
  ]);
});

test("uncategorised channels come first, then categories in the given order", () => {
  const groups = groupChannels(
    [ch("x", "two"), ch("loose", null), ch("y", "one"), ch("z", "two")],
    [cat("one"), cat("two")],
  );
  assert.deepEqual(
    groups.map((g) => [g.category?.id ?? null, g.channels.map((c) => c.id)]),
    [
      [null, ["loose"]],
      ["one", ["y"]],
      ["two", ["x", "z"]],
    ],
  );
});

test("no empty uncategorised group above real headings", () => {
  const groups = groupChannels([ch("a", "one")], [cat("one")]);
  assert.deepEqual(
    groups.map((g) => g.category?.id ?? null),
    ["one"],
  );
});

test("an empty category is dropped unless includeEmpty", () => {
  const channels = [ch("a", "one")];
  const categories = [cat("one"), cat("empty")];
  assert.deepEqual(
    groupChannels(channels, categories).map((g) => g.category?.id),
    ["one"],
  );
  assert.deepEqual(
    groupChannels(channels, categories, { includeEmpty: true }).map(
      (g) => g.category?.id,
    ),
    ["one", "empty"],
  );
});

test("a channel under a category this build does not know is shown as loose", () => {
  const groups = groupChannels([ch("a", "gone"), ch("b", "one")], [cat("one")]);
  assert.deepEqual(
    groups.map((g) => [g.category?.id ?? null, g.channels.map((c) => c.id)]),
    [
      [null, ["a"]],
      ["one", ["b"]],
    ],
  );
});
