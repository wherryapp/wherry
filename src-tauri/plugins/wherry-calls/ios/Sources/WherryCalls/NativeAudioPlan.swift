// What the plugin does to the audio session so the shell's own media engine
// can carry a call (phone-calls-plan.md §8.2, stage N1) -- the decisions only,
// read with no UIKit, no CallKit and no Tauri, so ios/Tests/run-tests.sh runs
// them on the Mac. `NativeAudio.swift` is the mechanism that carries each step
// out, and CallsPlugin.swift feeds this the events.
//
// The shape of the problem. libwebrtc's iOS audio module is told, in "manual
// audio" mode, that something other than itself owns the session: it neither
// activates it nor starts its audio unit until it is told the session is
// active and audio is enabled. That is what lets CallKit own a call's audio
// (its `didActivate` is the cue, a lock-screen answer included), and it is
// also why a call that CallKit does not hold needs the plugin to do what
// CallKit would have: a hub's voice channel, an outgoing call (N1 reports no
// CXStartCallAction -- `startOutgoing` stays a no-op, because CallKit's
// outgoing path cannot be read without a phone), and the simulator, whose
// CallKit ends every call it is given (row I-51).
//
// So one of two owners holds the session for a native-engine call:
// - CallKit, when the page's call is a call CallKit holds: `didActivate` and
//   `didDeactivate` are the whole story, and this plan only prepares the
//   category and relays them.
// - The plugin itself ("direct"), for every other call: it activates the
//   session when the page reports the call active and deactivates it when the
//   page reports it over. Background audio (`UIBackgroundModes: audio`, hand
//   edit 10's neighbour) is what keeps a direct call alive when the phone
//   locks.
//
// Nothing here runs unless the engine is linked (`NativeAudio.engineLinked`),
// which is the dark half of "ship dark" on this side: a build without the
// `phone-media` feature behaves exactly as before.

import Foundation

/// One thing to do to the audio session or the engine's view of it.
enum AudioStep: Equatable {
  /// `.playAndRecord`, mode `.voiceChat`, `.allowBluetooth`; and the engine's
  /// session told that something else owns activation (`useManualAudio`).
  case prepareSession
  /// `AVAudioSession.setActive(true)`, because no CallKit call will.
  case activateDirect
  case deactivateDirect
  /// `audioSessionDidActivate(_:)`: the engine's own bookkeeping, which CallKit
  /// callers owe it after activating (and so does the plugin, direct).
  case engineSessionActivated
  case engineSessionDeactivated
  /// `isAudioEnabled`: the engine may start (or must stop) its audio unit.
  case enableEngine
  case disableEngine
}

struct NativeAudioPlan {
  /// The plugin activated the session itself for the call it is reporting.
  private(set) var directActive = false
  /// The category was prepared for the call now in progress.
  private(set) var prepared = false

  /// The page's `setActive` report. `native` is the page's engine choice for
  /// this call (`ActiveReport.nativeAudio`), `callKitHoldsCall` whether the
  /// plugin tracks a CallKit call for the page's call id (a ring or an
  /// answered call; never on the simulator).
  mutating func pageReport(active: Bool, native: Bool, callKitHoldsCall: Bool) -> [AudioStep] {
    // The call is over, or has moved to the webview engine (a camera press
    // takes the per-call switch, rules.ts's `videoNeedsSwitch`): either way
    // the plugin's own hold on the session goes, because WebKit manages the
    // session for the engine that is left.
    if !active || !native {
      if !active { prepared = false }
      guard directActive else { return [] }
      directActive = false
      prepared = false
      // Stop the unit before the session goes, and tell the engine last.
      return [.disableEngine, .deactivateDirect, .engineSessionDeactivated]
    }
    var steps: [AudioStep] = []
    if !prepared {
      prepared = true
      steps.append(.prepareSession)
    }
    if !callKitHoldsCall && !directActive {
      directActive = true
      steps += [.activateDirect, .engineSessionActivated, .enableEngine]
    }
    return steps
  }

  /// CallKit is answering a call and the persisted engine choice (the last
  /// `setActive`'s) is native: the category is wanted before it activates.
  mutating func callKitAnswering(native: Bool) -> [AudioStep] {
    guard native, !prepared else { return [] }
    prepared = true
    return [.prepareSession]
  }

  /// `provider(_:didActivate:)`: the system activated the session for a call
  /// CallKit holds. Always relayed (it is harmless to an engine that is not
  /// in use, and the lock-screen answer arrives before any page report).
  mutating func callKitActivated() -> [AudioStep] {
    return [.engineSessionActivated, .enableEngine]
  }

  /// `provider(_:didDeactivate:)`, and `providerDidReset`.
  mutating func callKitDeactivated() -> [AudioStep] {
    prepared = false
    return [.disableEngine, .engineSessionDeactivated]
  }
}
