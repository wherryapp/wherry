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
//   "push-token"  { token }   the PushKit token, hex
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

  /// { token: hex | null }: I1 answers PushKit's current token.
  @objc public func pushToken(_ invoke: Invoke) {
    invoke.resolve(["token": nil] as JsonObject)
  }

  /// { callId, conversationId, label, group, exp }: I1 reports it to
  /// CallKit under UUID(callId), deduplicated.
  @objc public func reportIncoming(_ invoke: Invoke) {
    stub(invoke, "reportIncoming")
  }

  /// { active, callId, label, audioOnly }: proximity monitoring (I1), and
  /// CallKit's connected state (N1).
  @objc public func setActive(_ invoke: Invoke) {
    stub(invoke, "setActive")
  }

  /// { callId, reason }: I1 maps the reason to CXCallEndedReason.
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
