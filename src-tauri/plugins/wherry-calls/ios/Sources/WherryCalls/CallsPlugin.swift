// The iOS half of wherry-calls (docs/prompts/phone-calls-plan.md §5.2, §7).
// The page's PhoneCalls interface (client/src/voice/phone-calls.ts) reaches
// these commands through the plugin's Rust passthrough.
//
// PC1 is the skeleton: every command exists with the argument and answer
// shapes the page expects, and every body is a stub. `capabilities` answers
// "page" and false, so the page keeps ringing on its own sheet until I1 has
// built PKPushRegistry and the CXProvider (includesCallsInRecents = false,
// decision M-2) and flips ringUi to "callkit" and voip to true.
//
// Events the page listens for, with their payloads (trigger(_:data:)):
//   "action"      { kind: "answer"|"decline"|"hangup", callId, conversationId?, at? }
//   "push-token"  { token, environment, p256dh, auth }   as pushToken answers
//   "mute"        { callId, muted }   CallKit's own mute button
//
// Ownership (coordination §4): this plugin owns PKPushRegistry and
// CXProvider; the push plugin owns the UNUserNotificationCenter delegate and
// the AppDelegate token methods, and this file never touches either.

import Foundation
import Tauri
import UIKit
import WebKit

class CallsPlugin: Plugin {
  private func stub(_ invoke: Invoke, _ command: String) {
    NSLog("[wherry] calls: %@ (stub)", command)
    invoke.resolve()
  }

  @objc public override func load(webview: WKWebView) {
    NSLog("[wherry] calls: plugin loaded (stub, ringUi=page)")
  }

  @objc public func capabilities(_ invoke: Invoke) {
    invoke.resolve(["ringUi": "page", "callService": false, "voip": false] as JsonObject)
  }

  /// { apiBase, deviceId }: I1 persists them (UserDefaults) for the
  /// lock-screen decline.
  @objc public func configure(_ invoke: Invoke) {
    stub(invoke, "configure")
  }

  /// { labels: { conversationId: name } }: I1 persists the label cache.
  @objc public func setLabels(_ invoke: Invoke) {
    stub(invoke, "setLabels")
  }

  /// { token: hex | null, environment, p256dh, auth }: I1 answers PushKit's
  /// current token; environment is "sandbox" or "production" (read the way
  /// wherry-push's ApsEnvironment reads it), and p256dh and auth are the
  /// public half of the ring key pair (M-1 = E), unpadded base64url. The
  /// page registers all four through registerNativeToken("apns_voip", ...),
  /// which refuses a token without the environment or the keys (hunk H4).
  @objc public func pushToken(_ invoke: Invoke) {
    invoke.resolve(["token": nil] as JsonObject)
  }

  /// { callId, conversationId, label, group, exp } -> { shown }: I1 reports
  /// it to CallKit under UUID(callId) and resolves in the report's
  /// completion. shown is true when CallKit took the ring: reported, or
  /// callUUIDAlreadyExists (a VoIP push got there first), or filtered on
  /// purpose (filteredByDoNotDisturb, filteredByBlockList -- the page must
  /// not ring over the system). Any other error, or not knowing, is false,
  /// and the page's sheet rings instead (phone-calls.ts's IncomingAnswer).
  @objc public func reportIncoming(_ invoke: Invoke) {
    NSLog("[wherry] calls: reportIncoming (stub)")
    invoke.resolve(["shown": false] as JsonObject)
  }

  /// { active, callId, label, audioOnly }: proximity monitoring (I1), and
  /// CallKit's connected state (N1).
  @objc public func setActive(_ invoke: Invoke) {
    stub(invoke, "setActive")
  }

  /// { callId, reason }: phone-calls.ts's PhoneEndReason table says what
  /// each reason does, and not every reason ends a call. "answered" follows
  /// every Answer on this device, CallKit's own included: stop a ring that
  /// is still ringing and end nothing, or the call just answered is hung up.
  /// "declined" is a local end (CXEndCallAction) for a call CallKit still
  /// holds. The rest are reportCall(with:endedAt:reason:) with
  /// .answeredElsewhere, .declinedElsewhere, .remoteEnded (cancelled,
  /// ended), .unanswered or .failed.
  @objc public func reportEnded(_ invoke: Invoke) {
    stub(invoke, "reportEnded")
  }

  /// { callId, label }: N1's CXStartCallAction.
  @objc public func startOutgoing(_ invoke: Invoke) {
    stub(invoke, "startOutgoing")
  }

  @objc public func takePendingActions(_ invoke: Invoke) {
    invoke.resolve(["actions": [Any]()] as JsonObject)
  }

  /// The account signed out of the page, which stays loaded: I1 forgets
  /// the label cache and the queued actions, and ends any call CallKit
  /// still rings for it. The configure values stay (they are the device's).
  @objc public func resetAccount(_ invoke: Invoke) {
    stub(invoke, "resetAccount")
  }

  /// { payload }: runs the PushKit handler on a payload without APNs (the
  /// simulator's only way in, row I-51). Debug builds only.
  @objc public func debugIncoming(_ invoke: Invoke) {
    #if DEBUG
      stub(invoke, "debugIncoming")
    #else
      invoke.reject("debugIncoming is available in debug builds only")
    #endif
  }
}

@_cdecl("init_plugin_wherry_calls")
func initPlugin() -> Plugin {
  return CallsPlugin()
}
