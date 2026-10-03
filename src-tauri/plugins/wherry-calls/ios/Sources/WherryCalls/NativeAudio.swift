// The mechanism behind NativeAudioPlan.swift: the AVAudioSession calls, and
// libwebrtc's own audio-session object reached through the Objective-C
// runtime (phone-calls-plan.md §8.2, stage N1).
//
// Why the runtime and not a header: libwebrtc is not this package's
// dependency (the shell's Rust crate links it, only in a build with the
// `phone-media` feature), so there is nothing to import. `RTCAudioSession`
// is looked up by name when it is wanted; where the class is absent -- every
// build without the feature -- `engineLinked` is false and every function
// here does nothing, which is what keeps that build exactly as it was.
//
// The class carries no prefix in LiveKit's prebuilt (N0, `nm -gU` of both iOS
// prebuilts), and is already in the image without `-ObjC` because the audio
// device module references it. Hand edit 11 adds `-ObjC` to the app's link
// anyway (regen-hand-edits.md): the static library's other Objective-C
// classes are only loaded by it, and what the page's calls need from this
// file is the one object the engine itself pulls in.
//
// The properties and methods used, from libwebrtc's `RTCAudioSession.h`:
// `+sharedInstance`, `useManualAudio`, `isAudioEnabled`,
// `-audioSessionDidActivate:` and `-audioSessionDidDeactivate:`.

import AVFAudio
import Foundation

enum NativeAudio {
  /// The engine's audio-session object, or nil where the engine is not linked.
  private static var rtcSession: NSObject? {
    guard let cls = NSClassFromString("RTCAudioSession") else { return nil }
    let sharedInstance = NSSelectorFromString("sharedInstance")
    guard let unmanaged = (cls as AnyObject).perform(sharedInstance) else { return nil }
    return unmanaged.takeUnretainedValue() as? NSObject
  }

  /// Whether this build carries the native engine at all.
  static var engineLinked: Bool { rtcSession != nil }

  /// Carries out one step, logging it (row I-61 reads these lines). A no-op
  /// without the engine. `session` is the one CallKit handed over, when the
  /// step answers its callback; otherwise the app's shared session.
  static func perform(_ step: AudioStep, session: AVAudioSession = .sharedInstance()) {
    guard let engine = rtcSession else { return }
    switch step {
    case .prepareSession:
      prepare(engine, session)
    case .activateDirect:
      do {
        try session.setActive(true, options: [])
        NSLog("[wherry] calls: audio session activated directly (no CallKit call holds this one)")
      } catch {
        NSLog("[wherry] calls: audio session activation failed (%@)", describe(error))
      }
    case .deactivateDirect:
      do {
        try session.setActive(false, options: [.notifyOthersOnDeactivation])
        NSLog("[wherry] calls: audio session deactivated directly")
      } catch {
        NSLog("[wherry] calls: audio session deactivation failed (%@)", describe(error))
      }
    case .engineSessionActivated:
      _ = engine.perform(NSSelectorFromString("audioSessionDidActivate:"), with: session)
    case .engineSessionDeactivated:
      _ = engine.perform(NSSelectorFromString("audioSessionDidDeactivate:"), with: session)
    case .enableEngine:
      engine.setValue(true, forKey: "isAudioEnabled")
      NSLog("[wherry] calls: engine audio enabled (reads %@)", flag(engine, "isAudioEnabled"))
    case .disableEngine:
      engine.setValue(false, forKey: "isAudioEnabled")
      NSLog("[wherry] calls: engine audio disabled (reads %@)", flag(engine, "isAudioEnabled"))
    }
  }

  /// The category and mode a call needs, and the engine told it is not the
  /// one activating the session. Before the first call, never at launch:
  /// `.playAndRecord` with `.voiceChat` changes where every other sound the
  /// app makes goes (the earpiece, not the speaker), so it is set for a call
  /// that will use it and not before.
  private static func prepare(_ engine: NSObject, _ session: AVAudioSession) {
    do {
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
      NSLog(
        "[wherry] calls: audio session category %@ mode %@", session.category.rawValue,
        session.mode.rawValue)
    } catch {
      NSLog("[wherry] calls: audio session category refused (%@)", describe(error))
    }
    engine.setValue(true, forKey: "useManualAudio")
    NSLog("[wherry] calls: engine manual audio on (reads %@)", flag(engine, "useManualAudio"))
  }

  private static func flag(_ engine: NSObject, _ key: String) -> String {
    return (engine.value(forKey: key) as? Bool).map { $0 ? "true" : "false" } ?? "unreadable"
  }

  private static func describe(_ error: Error) -> String {
    let ns = error as NSError
    return "\(ns.domain) \(ns.code)"
  }
}
