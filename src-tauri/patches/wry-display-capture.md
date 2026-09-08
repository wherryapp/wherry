# wry — the display-capture permission delegate (written 2026-09-08)

**Status: written, not applied and not verified — and its fate now hangs
on stage 3N's render path** (2026-09-08). The `[patch]` section in
`Cargo.toml` still points wry at crates.io. Read the "Why this is not
applied yet" section before wiring it; it is the honest half of this file.

The argument for leaving it alone was that native screen share on the
desktop shell's own engine would make it a nicety for a minority. That
argument depends on stage 3N shipping, and 3N's spike (2026-09-08,
`docs/prompts/video-next-stages-handoff.md` §2.4) found its render path
(a) **too expensive** — 2.4× the webview transport's CPU where the bar
was 1.5×. Path (b), a native view per tile, is unbuilt. **If (b) is not
built, the webview transport is the only thing that shows video on macOS
and this patch becomes the macOS screen-share route**, not a nicety —
and its spike goes to the front of the keyboard session's queue. Whoever
settles (b) settles this.

## What is wrong

`navigator.mediaDevices.getDisplayMedia()` fails in the macOS shell — so
the call bar's screen-share button is dead there while it works in every
browser and, per the video plan's §5.5, in WebView2 on Windows.

The cause is not a missing entitlement and not the app. WKWebView asks its
UI delegate for permission before it will capture a screen, and it asks
through a **different** selector from the one it uses for a camera or a
microphone. wry implements the camera/microphone one and nothing else
(`src/wkwebview/class/wry_web_view_ui_delegate.rs`, wry 0.55.1):

```rust
#[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
fn request_media_capture_permission(
  &self,
  _webview: &WryWebView,
  _origin: &WKSecurityOrigin,
  _frame: &WKFrameInfo,
  _capture_type: WKMediaCaptureType,
  decision_handler: &Block<dyn Fn(WKPermissionDecision)>,
) {
  (*decision_handler).call((WKPermissionDecision::Grant,));
}
```

`WKMediaCaptureType` has `Camera`, `Microphone` and `CameraAndMicrophone`
and no screen member. A delegate that does not answer the display-capture
selector is treated as a denial, and WebKit rejects the `getDisplayMedia`
promise without ever showing the system picker. That is exactly the
symptom, and it is why the fix is one method rather than anything in this
application.

## The change

One more method on the same `define_class!` block, beside the one above:

```rust
// WebKit asks for a SCREEN through a different selector from the one it
// uses for a camera. Answering it with ScreenPrompt is what makes
// getDisplayMedia reach the system picker at all; Deny -- which is the
// behaviour of a delegate that does not implement this -- rejects the
// promise with nothing shown, which reads to a person as "screen sharing
// is broken in this app".
//
// This grants the *prompt*, never the capture: macOS still shows its own
// picker and still enforces the Screen Recording TCC grant against the
// bundle. There is nothing here that could share a screen without the
// person choosing one.
#[unsafe(method(_webView:requestDisplayCapturePermissionForOrigin:initiatedByFrame:withSystemAudio:decisionHandler:))]
fn request_display_capture_permission(
  &self,
  _webview: &WryWebView,
  _origin: &WKSecurityOrigin,
  _frame: &WKFrameInfo,
  _with_system_audio: bool,
  decision_handler: &Block<dyn Fn(isize)>,
) {
  // _WKDisplayCapturePermissionDecision, from WKUIDelegatePrivate.h:
  // 0 Deny, 1 ScreenPrompt, 2 WindowPrompt. Not in objc2-web-kit, which
  // binds the public headers only -- hence the raw isize.
  const SCREEN_PROMPT: isize = 1;
  (*decision_handler).call((SCREEN_PROMPT,));
}
```

`ScreenPrompt` rather than `WindowPrompt` on purpose: the picker it opens
offers windows as well as whole screens, so it is the superset, and
`getDisplayMedia`'s `displaySurface` hint decides what the picker
preselects.

## The thing to say out loud: this is a private selector

`_webView:requestDisplayCapturePermissionForOrigin:…` is
`WKUIDelegatePrivate`, not public API. Three consequences, and they are
the reason this file exists rather than a quiet commit:

- **It can change under a macOS update.** A renamed or re-signatured
  selector is not a compile error — it is a delegate method nobody calls,
  and the symptom is the same silent failure this is fixing. Whatever
  ships it needs a regression row that actually shares a screen.
- **It is a leading underscore in an App Store submission.** Nothing here
  is submitted today (desktop signing and notarisation are on the not-built
  list), but a private selector is the kind of thing that is cheap now and
  expensive at review time, and the decision should be made deliberately
  rather than discovered.
- **Upstream is the right home.** The same one method serves every wry
  application that wants a screen share, and it is the shape of change
  wry already accepts (it implements the sibling selector for exactly this
  reason). It goes as a pull request in the same stage it is written,
  which is what `patches/` in this directory has meant every time.

## Why this is not applied yet

The video plan's §12 authorises a cargo patch to wry **"if stage 5's spike
shows it is the whole fix"**, and that spike cannot be run from a session:
the first hour on macOS needs a **bundled** build and somebody at the
keyboard to answer the Screen Recording prompt, which is a TCC grant
against the bundle and cannot be scripted. Wiring the `[patch]` before that
would ship a fork of the window layer on the strength of reading a header.

So the sequence is: fork `tauri-apps/wry` at the pinned 0.55.1 tag, apply
the method above, point `[patch.crates-io] wry` at the fork behind a
`WRY_REV`, run a bundled build with a hand on the keyboard, and read the
row. If the picker opens and a frame reaches a peer, the patch is the whole
fix and goes upstream. If it does not, nothing has been shipped on a guess.

Until then the macOS shell's screen button is hidden on the same rule that
hides it on the phones (`showsVideoButton` in `ui/voice/CallBar.tsx`): a
transport that cannot do it, with no fix reachable from here.
