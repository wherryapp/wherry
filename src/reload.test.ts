// stripReloadMarker keeps every other parameter, on engines where
// URLSearchParams has no `size` (Safari and WKWebView below 17 -- the iOS
// minimum is 15.4). Sweep 1001, client-core-17.
//
// Run with `pnpm test` from client/.

import assert from "node:assert/strict";
import { test } from "node:test";

function install(search: string, hash = ""): { url: () => string } {
  let replaced = "";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { search, pathname: "/verify", hash },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          replaced = url;
        },
      },
    },
  });
  return { url: () => replaced };
}

const { stripReloadMarker } = await import("./reload.ts");

test("the marker goes and every other parameter and the hash stay, without `size`", () => {
  const descriptor = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size");
  // What Safari 16 looks like: no `size` at all.
  Object.defineProperty(URLSearchParams.prototype, "size", {
    configurable: true,
    get: () => undefined,
  });
  try {
    const page = install("?token=abc&r=123", "#x");
    stripReloadMarker();
    assert.equal(page.url(), "/verify?token=abc#x");

    const bare = install("?r=123");
    stripReloadMarker();
    assert.equal(bare.url(), "/verify");

    const untouched = install("?token=abc");
    stripReloadMarker();
    assert.equal(untouched.url(), "", "no marker, no rewrite");
  } finally {
    if (descriptor) Object.defineProperty(URLSearchParams.prototype, "size", descriptor);
    delete (globalThis as Record<string, unknown>)["window"];
  }
});
