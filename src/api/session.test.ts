import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceNameFrom } from "./session";

// User agents as each engine sends them. The shells' webviews name no
// browser of their own; iOS's WKWebView has no "Safari/" token at all.
const IPHONE_WKWEBVIEW =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const MAC_WKWEBVIEW =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS_WEBVIEW2 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 16; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36";
const IPAD_DESKTOP_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

const shell = (userAgent: string, maxTouchPoints = 0) =>
  deviceNameFrom({ userAgent, maxTouchPoints, inShell: true });
const browser = (userAgent: string, maxTouchPoints = 0) =>
  deviceNameFrom({ userAgent, maxTouchPoints, inShell: false });

test("inside a shell the app is named, on the platform its webview reports", () => {
  // The case that was wrong: the installed iPhone app read "Browser on iPhone".
  assert.equal(shell(IPHONE_WKWEBVIEW, 5), "Wherry on iPhone");
  assert.equal(shell(MAC_WKWEBVIEW), "Wherry on Mac");
  assert.equal(shell(WINDOWS_WEBVIEW2), "Wherry on Windows");
  assert.equal(shell(ANDROID_WEBVIEW, 5), "Wherry on Android");
});

test("a browser is still named by its own token, phones before desktops", () => {
  assert.equal(browser(IPHONE_SAFARI, 5), "Safari on iPhone");
  assert.equal(browser(WINDOWS_WEBVIEW2), "Edge on Windows");
  assert.equal(browser(ANDROID_WEBVIEW, 5), "Chrome on Android");
  // An iPad in desktop mode claims a Mac; only the touch count tells.
  assert.equal(browser(IPAD_DESKTOP_SAFARI, 5), "Safari on iPad");
  assert.equal(browser(IPAD_DESKTOP_SAFARI, 0), "Safari on Mac");
  // No token it knows is still a name.
  assert.equal(browser(IPHONE_WKWEBVIEW, 5), "Browser on iPhone");
  assert.equal(browser("curl/8.9"), "Browser");
});
