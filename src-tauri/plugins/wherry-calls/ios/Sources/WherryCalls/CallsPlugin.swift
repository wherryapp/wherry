// The iOS half of wherry-calls (docs/prompts/phone-calls-plan.md §5.2, §7):
// PushKit and CallKit. The page's PhoneCalls interface
// (client/src/voice/phone-calls.ts) reaches these commands through the
// plugin's Rust passthrough; every decision about what a press or a ring
// means to the call is the page's (phone-rules.ts, phone-bridge.ts). This
// file carries rings to CallKit and presses back to the page.
//
// What I1 built:
// - One CXProvider (no video, one call, generic handles,
//   includesCallsInRecents = false -- decision M-2) and a PKPushRegistry for
//   VoIP, both created in `init`, never in `load(webview:)`. Under the UIScene
//   life cycle (hand edit 14) `load` waits for the first scene, and a
//   PushKit background launch is believed to connect none, so a registry made
//   in `load` would leave a push to a killed app unreported -- which iOS
//   punishes by ending the app and, repeated, by no longer delivering VoIP
//   pushes to it.
// - The push handler (`handlePush`): opens the RFC 8291 envelope with the
//   ring key (M-1 = E; RingEnvelope, RingKeys), then reports to CallKit.
//   **Every push reports a call** before its completion runs, including one
//   that does not open, as Apple requires (plan §7's table). A ring for a
//   call already ended on this device (EndedCalls, in RingMessage.swift) is
//   reported and ended at once, never rung again.
// - The provider delegate: Answer, End (a signed decline while ringing, a
//   hang-up once answered), Mute, reset. Mute goes both ways: CallKit's
//   button reaches the page as `mute`, and the page's mute reaches CallKit
//   through `setActive`'s `micMuted` (`matchMute`).
// - The commands the page drives, `debugIncoming` (debug builds) and a
//   debug-only launch ring (`WHERRY_DEBUG_RING`), which run the same handler
//   without APNs: the simulator's only way in (rows I-51, I-52).
//
// Not built here (and why):
// - Media. Answering hands the call to the page, whose webview engine
//   carries audio only in the foreground (WebKit's limit); N1 is the fix, and
//   decisions M-3 and M-4 are open. This file configures no AVAudioSession
//   (it reads the route, for proximity).
// - Outgoing calls in CallKit (`startOutgoing`): N1's.
//
// Events the page listens for, with their payloads (trigger(_:data:)):
//   "action"      { kind: "answer"|"decline"|"hangup", callId, conversationId?, at }
//   "push-token"  { token, environment, p256dh, auth }   as pushToken answers
//   "mute"        { callId, muted }   CallKit's own mute button
//
// Ownership (coordination §4): this plugin owns PKPushRegistry and
// CXProvider; the push plugin owns the UNUserNotificationCenter delegate and
// the AppDelegate token methods, and this file never touches either.
//
// Threading: every piece of state below is touched on the main queue only.
// The provider's delegate queue and the registry's queue are the main queue,
// and every command hops there first.

import AVFAudio
import CallKit
import Foundation
import PushKit
import Tauri
import UIKit
import WebKit

struct ConfigureArgs: Decodable {
  let apiBase: String
  let deviceId: String
}

struct LabelsArgs: Decodable {
  let labels: [String: String]
}

struct IncomingArgs: Decodable {
  let callId: String
  let conversationId: String
  let label: String
  let group: Bool
  let exp: Int64
}

struct ActiveArgs: Decodable {
  let active: Bool
  let callId: String?
  let label: String?
  let audioOnly: Bool
  /// Absent from an older page: false.
  let pageOwnsAudio: Bool?
  /// The page's microphone mute (client-voice-7); null or absent: leave
  /// CallKit's mute as it is.
  let micMuted: Bool?
}

struct EndedArgs: Decodable {
  let callId: String
  let reason: String
}

/// One call CallKit holds for this plugin, keyed by the call's UUID (the
/// server's call id is a UUIDv7 and is used directly, plan §2.7).
final class TrackedCall {
  let uuid: UUID
  let callId: String
  var conversationId: String?
  /// When the ring window closes here, seconds since the epoch: the expiry
  /// timer's value and EndedCalls' only. Never sent with the decline -- the
  /// page's `reportIncoming` sets it from the phone's own clock.
  var exp: Int64
  /// The push's signed decline token, whole (DeclineToken); nil until a
  /// VoIP push with one arrives, and never taken from the page.
  var token: DeclineToken?
  /// Answered in CallKit: its End is a hang-up, not a decline.
  var answered = false
  /// The page named it in `setActive(true)`: its web call is running, so the
  /// page's `setActive(false)` ends it.
  var claimed = false
  /// An Answer or End this plugin asked CallKit for itself, on the page's
  /// word: the provider delegate must not send it back as an action.
  var answerRequested = false
  var endRequested = false
  /// What CallKit's mute button shows for this call, as its last
  /// CXSetMutedCallAction said (false until one has).
  var muted = false
  /// A mute this plugin asked CallKit for on the page's word: the delegate
  /// does not send its echo back to the page as a `mute` event.
  var muteRequested: Bool?
  var expiry: DispatchWorkItem?
  var watchdog: DispatchWorkItem?

  init(uuid: UUID, callId: String, exp: Int64) {
    self.uuid = uuid
    self.callId = callId
    self.exp = exp
  }

  func cancelTimers() {
    expiry?.cancel()
    expiry = nil
    watchdog?.cancel()
    watchdog = nil
  }
}

class CallsPlugin: Plugin, CXProviderDelegate, PKPushRegistryDelegate {
  /// The name a ring carries when the label cache has none for it (plan
  /// §2.4; D1 keeps names out of every push).
  private static let fallbackLabel = "Wherry call"
  /// The label cache's bound (phone-rules.ts's MAX_LABELS).
  private static let maxLabels = 500
  /// Presses kept for the page; a flood keeps the newest (as Android's).
  private static let queueMax = 16
  /// How long a call answered in CallKit waits for the page to join it
  /// before it is ended: the page drops a queued Answer after
  /// phone-rules.ts's ACTION_TTL_MS (60 s), and a CallKit call nobody joins
  /// would hold the audio session and the green call indicator for good.
  private static let unclaimedAnswerSeconds: TimeInterval = 75

  private static let defaultsApiBase = "wherry.calls.apiBase"
  private static let defaultsDeviceId = "wherry.calls.deviceId"
  private static let defaultsLabels = "wherry.calls.labels"

  private var provider: CXProvider?
  private var registry: PKPushRegistry?
  private let controller = CXCallController()
  private var calls: [UUID: TrackedCall] = [:]
  /// Calls ended here, so a late ring for one is not a new ring (EndedCalls).
  private var ended = EndedCalls()
  private var pending: [JSObject] = []
  private var voipToken: String?
  private var proximityWanted = false

  // MARK: - Set-up, before any scene

  // Runs while the app is being built, before UIApplicationMain, on a
  // foreground launch and on a PushKit background launch alike (the push
  // plugin's `loaded` line is read there, hand edit 14). The main queue is
  // not draining yet; PushKit and CallKit deliver on it once UIKit runs it.
  override init() {
    super.init()
    if Thread.isMainThread {
      setUp()
    } else {
      DispatchQueue.main.async { self.setUp() }
    }
  }

  private func setUp() {
    let provider = CXProvider(configuration: Self.providerConfiguration(icon: nil))
    provider.setDelegate(self, queue: nil)
    self.provider = provider
    NSLog(
      "[wherry] calls: provider ready (recents=%@)",
      provider.configuration.includesCallsInRecents ? "true" : "false")

    let registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    self.registry = registry
    NSLog("[wherry] calls: pushkit registry created")

    NotificationCenter.default.addObserver(
      self, selector: #selector(didFinishLaunching),
      name: UIApplication.didFinishLaunchingNotification, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(routeChanged),
      name: AVAudioSession.routeChangeNotification, object: nil)
  }

  private static func providerConfiguration(icon: Data?) -> CXProviderConfiguration {
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = false
    configuration.maximumCallGroups = 1
    configuration.maximumCallsPerCallGroup = 1
    configuration.supportedHandleTypes = [.generic]
    // Decision M-2 (plan §2.6): on, every call would land in the Phone app's
    // Recents, which iOS syncs to iCloud -- a copy of who called whom at a
    // third party. Row I-57 reads it on a phone.
    configuration.includesCallsInRecents = false
    configuration.iconTemplateImageData = icon
    return configuration
  }

  @objc private func didFinishLaunching() {
    // The icon is drawn with UIKit, so after UIApplicationMain has started.
    provider?.configuration = Self.providerConfiguration(icon: Self.iconTemplate())
    #if DEBUG
      debugLaunchRing()
    #endif
  }

  /// The monochrome glyph CallKit shows on its call screen's app button: a
  /// placeholder SF Symbol, like the push plan's placeholder Android icon
  /// (its decision D5). A template image is read by its alpha only.
  private static func iconTemplate() -> Data? {
    let size = CGSize(width: 40, height: 40)
    guard
      let symbol = UIImage(
        systemName: "bubble.left.fill",
        withConfiguration: UIImage.SymbolConfiguration(pointSize: 30, weight: .regular))
    else {
      return nil
    }
    let image = UIGraphicsImageRenderer(size: size).image { _ in
      let origin = CGPoint(
        x: (size.width - symbol.size.width) / 2, y: (size.height - symbol.size.height) / 2)
      symbol.withTintColor(.black).draw(at: origin)
    }
    return image.pngData()
  }

  @objc public override func load(webview: WKWebView) {
    NSLog(
      "[wherry] calls: plugin loaded (ringUi=%@)", Self.callKitShowsRings ? "callkit" : "page")
  }

  // MARK: - Commands

  /// Whether CallKit can show a ring on this device. Not on the simulator:
  /// its runtime has no in-call application (callservicesd's
  /// `facetime://?launchForIncomingCall=1` finds no handler), so a reported
  /// call is accepted and then ended by the system about 80 ms later, which
  /// reaches the delegate as an End -- a decline (row I-51, read
  /// 2026-09-27). Answering "page" there keeps a signed-in simulator's calls
  /// on the page's own sheet (TURN's I-70 rings one) instead of declining
  /// every one of them. The push handler still reports on the simulator, for
  /// the debug rows.
  private static let callKitShowsRings: Bool = {
    #if targetEnvironment(simulator)
      return false
    #else
      return true
    #endif
  }()

  @objc public func capabilities(_ invoke: Invoke) {
    let callKit = Self.callKitShowsRings
    invoke.resolve(
      [
        "ringUi": callKit ? "callkit" : "page", "callService": false, "voip": callKit,
        // CallKit's incoming-call screen takes a locked phone's whole screen,
        // and needs no permission for it.
        "fullScreen": callKit,
      ] as JsonObject)
  }

  /// { apiBase, deviceId }: where the lock screen's decline goes. Kept in
  /// UserDefaults so a PushKit launch with no page still has it. The device
  /// id is stored and read by nothing: a signed decline names the device its
  /// token was signed for (DeclineToken). It stays in the command because
  /// PC1 fixed `configure`'s shape on both phones (phone-calls.ts).
  @objc public func configure(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ConfigureArgs.self)
    onMain {
      let defaults = UserDefaults.standard
      defaults.set(args.apiBase, forKey: Self.defaultsApiBase)
      defaults.set(args.deviceId, forKey: Self.defaultsDeviceId)
      invoke.resolve()
    }
  }

  /// { labels: { conversationId: name } }: names only, never content (the
  /// push plan's D1). A VoIP push carries no name, so this is what names a
  /// ring the page never saw. Cleared by `resetAccount`.
  @objc public func setLabels(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(LabelsArgs.self)
    onMain {
      var kept: [String: String] = [:]
      for (conversationId, label) in args.labels where kept.count < Self.maxLabels {
        kept[conversationId] = label
      }
      UserDefaults.standard.set(kept, forKey: Self.defaultsLabels)
      invoke.resolve()
    }
  }

  /// { token: hex | null, environment, p256dh, auth }. The page registers
  /// all four through registerNativeToken("apns_voip", ...), which refuses a
  /// token without the environment or the keys (hunk H4).
  @objc public func pushToken(_ invoke: Invoke) {
    onMain { invoke.resolve(self.tokenAnswer()) }
  }

  /// { callId, conversationId, label, group, exp } -> { shown }: a ring the
  /// page heard over the socket. shown is true when CallKit took it:
  /// reported, or already reported (a VoIP push got there first), or
  /// already ended here (declined in CallKit before the socket's ring came:
  /// not reported again), or filtered on purpose (Do Not Disturb, the block
  /// list -- the page must not ring over the system). Anything else is
  /// false, and the page's sheet rings instead (phone-calls.ts's
  /// IncomingAnswer).
  @objc public func reportIncoming(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(IncomingArgs.self)
    onMain {
      guard Self.callKitShowsRings else {
        invoke.resolve(["shown": false] as JsonObject)
        return
      }
      guard RingGate.uuid(args.callId) != nil, let uuid = UUID(uuidString: args.callId) else {
        invoke.resolve(["shown": false] as JsonObject)
        return
      }
      if let known = self.calls[uuid] {
        if known.conversationId == nil { known.conversationId = args.conversationId }
        invoke.resolve(["shown": true] as JsonObject)
        return
      }
      if self.ended.ended(uuid, now: Self.nowSeconds()) != nil {
        NSLog("[wherry] calls: reportIncoming %@ already ended here; not reported", args.callId)
        invoke.resolve(["shown": true] as JsonObject)
        return
      }
      if args.exp <= Self.nowSeconds() {
        invoke.resolve(["shown": false] as JsonObject)
        return
      }
      let call = TrackedCall(uuid: uuid, callId: args.callId, exp: args.exp)
      call.conversationId = args.conversationId
      self.calls[uuid] = call
      let label = args.label.isEmpty ? Self.fallbackLabel : args.label
      self.report(uuid, label: label) { error in
        let shown = Self.callKitTook(error)
        if error != nil { self.forget(uuid) } else { self.scheduleExpiry(call) }
        invoke.resolve(["shown": shown] as JsonObject)
      }
    }
  }

  /// { active, callId, label, audioOnly }: the web call's lifetime. Proximity
  /// monitoring for an audio-only call off the loudspeaker, and the end of a
  /// CallKit call the page's own call has ended.
  @objc public func setActive(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ActiveArgs.self)
    onMain {
      if args.active, let callId = args.callId, let uuid = UUID(uuidString: callId),
        let call = self.calls[uuid]
      {
        call.claimed = true
        call.watchdog?.cancel()
        call.watchdog = nil
        // Branch B of row I-58 (2026-09-28, iPhone, iOS 26.6.2): with a
        // CallKit call live and the app in front, WebKit re-activates the
        // audio session and interrupts its own microphone, so the call is
        // silent while Wherry is on screen. Once the page's call is up in
        // front, CallKit has carried the ring: end its call as a local end,
        // which is never sent back to the page as a hangup.
        if args.pageOwnsAudio == true, call.answered, !call.endRequested {
          NSLog("[wherry] calls: page owns audio; ending CallKit's call uuid=%@", call.callId)
          self.endLocally(call)
        } else if let muted = args.micMuted {
          self.matchMute(call, muted)
        }
      }
      if !args.active {
        // Only calls the page had claimed: a run starting after a
        // lock-screen Answer reports `active: false` before it drains that
        // Answer, and must not end the call it is about to join.
        for call in self.calls.values where call.answered && call.claimed {
          self.endLocally(call)
        }
      }
      self.proximityWanted = args.active && args.audioOnly
      self.applyProximity()
      invoke.resolve()
    }
  }

  /// { callId, reason }: phone-calls.ts's PhoneEndReason table, iOS column.
  /// Not every reason ends a call: `answered` follows every Answer on this
  /// device, CallKit's own included.
  @objc public func reportEnded(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(EndedArgs.self)
    onMain {
      guard let uuid = UUID(uuidString: args.callId), let call = self.calls[uuid] else {
        invoke.resolve()
        return
      }
      switch PageEnd.forPageReason(args.reason) {
      case .answeredHere:
        // Still ringing in CallKit (a race with the sheet): answer it there
        // too, so the ring stops and CallKit's call spans the web call
        // (branch A of §7; row I-58 decides whether that holds).
        if !call.answered { self.answerLocally(call) }
      case .declinedHere:
        self.endLocally(call)
      case .report(let end):
        self.endReported(call.uuid, end)
      }
      invoke.resolve()
    }
  }

  /// { callId, label }: CXStartCallAction is N1's (an outgoing call in
  /// CallKit only makes sense once CallKit owns its audio).
  @objc public func startOutgoing(_ invoke: Invoke) {
    invoke.resolve()
  }

  /// Presses made while the page was not listening. Every press is queued
  /// as well as sent: the Tauri iOS plugin cannot tell whether a listener
  /// is registered, and a press lost to a page that was reloading is worse
  /// than one repeated, which phone-rules.ts's `pendingActionVerdict` drops.
  @objc public func takePendingActions(_ invoke: Invoke) {
    onMain {
      let actions = self.pending
      self.pending.removeAll()
      invoke.resolve(["actions": actions] as JsonObject)
    }
  }

  /// The account signed out of the page, which stays loaded: forget the
  /// label cache and the queued presses, and end every call CallKit holds
  /// for it. The configure values stay (they are the device's).
  @objc public func resetAccount(_ invoke: Invoke) {
    onMain {
      UserDefaults.standard.removeObject(forKey: Self.defaultsLabels)
      self.pending.removeAll()
      for call in Array(self.calls.values) {
        self.endReported(call.uuid, .remoteEnded)
      }
      // Ended calls are the account's too: a call the next account is also
      // rung for must not be taken for one already ended.
      self.ended.removeAll()
      NSLog("[wherry] calls: account reset")
      invoke.resolve()
    }
  }

  /// { payload }: runs the PushKit handler on a payload without APNs (the
  /// simulator's only way in, row I-51), plaintext or `{k, e}`. Debug builds
  /// only.
  @objc public func debugIncoming(_ invoke: Invoke) {
    #if DEBUG
      let raw = invoke.getRawArgs().data(using: .utf8) ?? Data()
      guard
        let args = (try? JSONSerialization.jsonObject(with: raw, options: [])) as? [String: Any],
        let payload = args["payload"] as? [String: Any]
      else {
        invoke.reject("debugIncoming needs { payload: {...} }")
        return
      }
      onMain {
        self.handlePush(payload, allowPlaintext: true, source: "debugIncoming") {
          invoke.resolve()
        }
      }
    #else
      invoke.reject("debugIncoming is available in debug builds only")
    #endif
  }

  // MARK: - PushKit

  func pushRegistry(
    _ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType
  ) {
    guard type == .voIP else { return }
    let hex = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    voipToken = hex
    // Never the whole token in a log (the push plan's rule, kept here).
    NSLog(
      "[wherry] calls: voip token %@... (%ld hex, %@)", String(hex.prefix(8)), hex.count,
      ApsEnvironment.current)
    trigger("push-token", data: tokenEvent())
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    voipToken = nil
    NSLog("[wherry] calls: voip token invalidated")
  }

  func pushRegistry(
    _ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType, completion: @escaping () -> Void
  ) {
    guard type == .voIP else {
      completion()
      return
    }
    var outer: [String: Any] = [:]
    for (key, value) in payload.dictionaryPayload {
      if let key = key as? String { outer[key] = value }
    }
    handlePush(outer, allowPlaintext: false, source: "pushkit", completion: completion)
  }

  /// The one handler behind PushKit, `debugIncoming` and the debug launch
  /// ring. It reports a call to CallKit on every path before `completion`.
  private func handlePush(
    _ outer: [String: Any], allowPlaintext: Bool, source: String,
    completion: @escaping () -> Void
  ) {
    let decision = RingGate.decide(outer, allowPlaintext: allowPlaintext) { body in
      guard let keys = RingKeys.load() else { return nil }
      do {
        return try RingEnvelope.open(body: body, privateKey: keys.privateKey, auth: keys.auth)
      } catch {
        NSLog("[wherry] calls: ring did not open (%@)", "\(error)")
        return nil
      }
    }
    switch decision {
    case .refused(let reason):
      // Apple's rule has no exception for a push this device cannot read:
      // report something, then end it at once.
      NSLog("[wherry] calls: %@ push refused (%@); reporting and ending", source, reason)
      let uuid = UUID()
      report(uuid, label: Self.fallbackLabel) { error in
        completion()
        guard error == nil else { return }
        self.provider?.reportCall(with: uuid, endedAt: Date(), reason: .failed)
        NSLog("[wherry] calls: ended refused uuid=%@", uuid.uuidString.lowercased())
      }
    case .message(.ring(let push)):
      NSLog("[wherry] calls: %@ ring %@", source, push.callId)
      handleRing(push, completion: completion)
    case .message(.ended(let callId, let why)):
      NSLog("[wherry] calls: %@ ring_ended %@ (%@)", source, callId, why)
      handleEnded(callId: callId, why: why, completion: completion)
    }
  }

  private func handleRing(_ push: RingPush, completion: @escaping () -> Void) {
    guard let uuid = UUID(uuidString: push.callId) else {
      completion()
      return
    }
    let expired = push.exp <= Self.nowSeconds()
    if let call = calls[uuid] {
      // Known: the socket's report got here first, or the push repeated.
      // Report again (callUUIDAlreadyExists) so the push counts as
      // reported, and keep what only the push carries: the decline token,
      // its three fields together (never the push's signature beside the
      // page's `exp`, which would not verify).
      call.conversationId = call.conversationId ?? push.conversationId
      call.token = DeclineToken.merged(DeclineToken(push), over: call.token)
      report(uuid, label: label(for: call.conversationId)) { _ in
        completion()
        if expired && !call.answered { self.endReported(uuid, .unanswered) }
      }
      return
    }
    if let end = ended.ended(uuid, now: Self.nowSeconds()) {
      // Ended here already -- declined, hung up, cancelled -- and this push
      // came late. Reported, as Apple requires, and ended at once, like an
      // expired ring; never rung again (EndedCalls says why nothing else
      // would stop it after a decline here).
      report(uuid, label: label(for: push.conversationId)) { error in
        completion()
        guard error == nil else { return }
        self.provider?.reportCall(with: uuid, endedAt: Date(), reason: Self.cxReason(end))
        NSLog("[wherry] calls: late ring for ended uuid=%@ ended (%@)", uuid.uuidString.lowercased(), "\(end)")
      }
      return
    }
    let call = TrackedCall(uuid: uuid, callId: push.callId, exp: push.exp)
    call.conversationId = push.conversationId
    call.token = DeclineToken(push)
    calls[uuid] = call
    report(uuid, label: label(for: push.conversationId)) { error in
      completion()
      if error != nil {
        self.forget(uuid)
      } else if expired {
        // A ring that outlived its window in transit: reported, as Apple
        // requires, and ended at once.
        self.endReported(uuid, .unanswered)
      } else {
        self.scheduleExpiry(call)
      }
    }
  }

  private func handleEnded(callId: String, why: String, completion: @escaping () -> Void) {
    guard let uuid = UUID(uuidString: callId) else {
      completion()
      return
    }
    let end = RingEnd.forServerWhy(why)
    if let call = calls[uuid] {
      // Reported again first (callUUIDAlreadyExists), so the push counts,
      // then ended -- never the other way round, or the second report
      // would ring a new call.
      report(uuid, label: label(for: call.conversationId)) { _ in
        completion()
        // Answered here and not cancelled: the page's call is this call,
        // and the page ends it (setActive, or CallKit's own End).
        if call.answered && why != "cancelled" { return }
        self.endReported(uuid, end)
      }
      return
    }
    // Unknown here (a ring this device never got, or one already ended):
    // report, then end at once (plan §7).
    report(uuid, label: Self.fallbackLabel) { error in
      completion()
      guard error == nil else { return }
      self.provider?.reportCall(with: uuid, endedAt: Date(), reason: Self.cxReason(end))
      NSLog("[wherry] calls: ended unknown uuid=%@ (%@)", uuid.uuidString.lowercased(), "\(end)")
    }
  }

  // MARK: - CallKit, what this plugin asks of it

  private func report(_ uuid: UUID, label: String, completion: @escaping (Error?) -> Void) {
    guard let provider = provider else {
      completion(NSError(domain: "wherry-calls", code: 1))
      return
    }
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: label)
    update.localizedCallerName = label
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    provider.reportNewIncomingCall(with: uuid, update: update) { error in
      let outcome = error.map { Self.describe($0) } ?? "ok"
      NSLog("[wherry] calls: reported uuid=%@ (%@)", uuid.uuidString.lowercased(), outcome)
      if Thread.isMainThread {
        completion(error)
      } else {
        DispatchQueue.main.async { completion(error) }
      }
    }
  }

  /// A ring or call ended for a reason CallKit shows (no delegate action
  /// follows a `reportCall`).
  private func endReported(_ uuid: UUID, _ end: RingEnd) {
    guard let call = calls[uuid] else { return }
    retire(call, end)
    provider?.reportCall(with: uuid, endedAt: Date(), reason: Self.cxReason(end))
    NSLog("[wherry] calls: ended uuid=%@ (%@)", uuid.uuidString.lowercased(), "\(end)")
  }

  /// An end this device asked for (a decline on the page, or the page's call
  /// over): a CXEndCallAction, which the delegate fulfils without sending it
  /// back to the page.
  private func endLocally(_ call: TrackedCall) {
    call.endRequested = true
    let transaction = CXTransaction(action: CXEndCallAction(call: call.uuid))
    controller.request(transaction) { error in
      guard let error = error else { return }
      DispatchQueue.main.async {
        NSLog("[wherry] calls: local end refused (%@); reporting it", Self.describe(error))
        self.endReported(call.uuid, .remoteEnded)
      }
    }
  }

  private func answerLocally(_ call: TrackedCall) {
    call.answerRequested = true
    let transaction = CXTransaction(action: CXAnswerCallAction(call: call.uuid))
    controller.request(transaction) { error in
      guard let error = error else { return }
      DispatchQueue.main.async {
        call.answerRequested = false
        NSLog("[wherry] calls: local answer refused (%@)", Self.describe(error))
      }
    }
  }

  /// The page's mute, shown on CallKit's own button (client-voice-7): a mute
  /// from the page's button, a call joined muted, or an unmute that failed
  /// would otherwise leave the lock screen reading the opposite, and the next
  /// press there would ask for what the page already had. Only for a call
  /// CallKit holds answered; its echo is not sent back to the page.
  private func matchMute(_ call: TrackedCall, _ muted: Bool) {
    guard call.answered, !call.endRequested else { return }
    let target = call.muteRequested ?? call.muted
    if target == muted { return }
    call.muteRequested = muted
    let transaction = CXTransaction(action: CXSetMutedCallAction(call: call.uuid, muted: muted))
    controller.request(transaction) { error in
      guard let error = error else { return }
      DispatchQueue.main.async {
        if call.muteRequested == muted { call.muteRequested = nil }
        NSLog("[wherry] calls: mute to CallKit refused (%@)", Self.describe(error))
      }
    }
  }

  /// Drops a call CallKit never took (its report failed): a later ring for
  /// it may still be reported.
  private func forget(_ uuid: UUID) {
    calls[uuid]?.cancelTimers()
    calls[uuid] = nil
  }

  /// Drops a call that has ended here, and remembers it until its ring
  /// window closes, so a late push for it is ended rather than rung
  /// (EndedCalls). Every end goes through this; only a failed report uses
  /// `forget` alone.
  private func retire(_ call: TrackedCall, _ end: RingEnd) {
    ended.add(call.uuid, exp: call.exp, end: end, now: Self.nowSeconds())
    forget(call.uuid)
  }

  /// Ends a ring CallKit still shows once its window closes, in case the
  /// server's `ring_ended` never arrives (no network, or no push at all for
  /// a ring the page reported).
  private func scheduleExpiry(_ call: TrackedCall) {
    call.expiry?.cancel()
    let delay = max(0, TimeInterval(call.exp - Self.nowSeconds()))
    let work = DispatchWorkItem { [weak self] in
      guard let self = self, let live = self.calls[call.uuid], live === call, !call.answered else {
        return
      }
      self.endReported(call.uuid, .unanswered)
    }
    call.expiry = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  // MARK: - CXProviderDelegate, what the person does

  func providerDidReset(_ provider: CXProvider) {
    NSLog("[wherry] calls: provider reset")
    for call in Array(calls.values) {
      if call.answered && !call.endRequested {
        deliver("hangup", call)
      }
      retire(call, .failed)
    }
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard let call = calls[action.callUUID] else {
      action.fail()
      return
    }
    call.answered = true
    call.expiry?.cancel()
    call.expiry = nil
    if call.answerRequested {
      // The page answered first; it knows.
      call.answerRequested = false
      call.claimed = true
      action.fulfill()
      return
    }
    NSLog("[wherry] calls: answered uuid=%@", call.callId)
    deliver("answer", call)
    watchUnclaimed(call)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    guard let call = calls[action.callUUID] else {
      action.fulfill()
      return
    }
    // Remembered as ended, so a VoIP push for it that lands after this
    // (the server sends a declining device no ring_ended) is ended at once
    // rather than rung again; .remoteEnded is only what CallKit is told then.
    retire(call, .remoteEnded)
    if call.endRequested {
      action.fulfill()
      return
    }
    if call.answered {
      NSLog("[wherry] calls: hung up uuid=%@", call.callId)
      deliver("hangup", call)
    } else {
      NSLog("[wherry] calls: declined uuid=%@", call.callId)
      deliver("decline", call)
      declineSigned(call)
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    if let call = calls[action.callUUID] {
      call.muted = action.isMuted
      if let requested = call.muteRequested, requested == action.isMuted {
        // The page's own mute, asked for by `matchMute`: it knows.
        call.muteRequested = nil
      } else {
        call.muteRequested = nil
        trigger("mute", data: ["callId": call.callId, "muted": action.isMuted])
      }
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    // supportsHolding is false; a hold from the system (a cellular call's
    // "Hold & Accept") is refused rather than half-honoured.
    action.fail()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    // The webview engine owns its audio in I1; N1 starts native audio here.
    NSLog("[wherry] calls: audio session activated")
    applyProximity()
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    NSLog("[wherry] calls: audio session deactivated")
  }

  func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
    NSLog("[wherry] calls: action timed out (%@)", String(describing: type(of: action)))
  }

  // MARK: - Presses, on their way to the page

  private func deliver(_ kind: String, _ call: TrackedCall) {
    var action: JSObject = [
      "kind": kind,
      "callId": call.callId,
      "at": Int(Date().timeIntervalSince1970 * 1000),
    ]
    if let conversationId = call.conversationId { action["conversationId"] = conversationId }
    pending.append(action)
    if pending.count > Self.queueMax { pending.removeFirst(pending.count - Self.queueMax) }
    trigger("action", data: action)
  }

  /// A call answered in CallKit that the page never joins -- a lock-screen
  /// Answer on a phone nobody unlocks -- is ended once the page could no
  /// longer act on the Answer, rather than holding the audio session.
  private func watchUnclaimed(_ call: TrackedCall) {
    call.watchdog?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self = self, let live = self.calls[call.uuid], live === call, !call.claimed else {
        return
      }
      NSLog("[wherry] calls: answered uuid=%@ never joined; ending", call.callId)
      self.pending.removeAll { ($0["callId"] as? String) == call.callId }
      self.endReported(call.uuid, .failed)
    }
    call.watchdog = work
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.unclaimedAnswerSeconds, execute: work)
  }

  /// The lock screen's Decline, when the ring's push carried a token. The
  /// page, if it is running, declines too through its own session (the
  /// `decline` action); the second decline is a no-op on the server.
  private func declineSigned(_ call: TrackedCall) {
    let defaults = UserDefaults.standard
    guard let token = call.token, let apiBase = defaults.string(forKey: Self.defaultsApiBase)
    else {
      NSLog("[wherry] calls: no signed decline for %@ (the page declines)", call.callId)
      return
    }
    if token.expired(now: Self.nowSeconds()) {
      // The server would refuse it and answer 204 all the same; the page's
      // `decline` action, live or queued, carries the press instead.
      NSLog("[wherry] calls: decline token for %@ expired (the page declines)", call.callId)
      return
    }
    // A few seconds of background time: the End action is often the last
    // thing this process does before iOS suspends it.
    var task = UIBackgroundTaskIdentifier.invalid
    task = UIApplication.shared.beginBackgroundTask(withName: "wherry-decline") {
      UIApplication.shared.endBackgroundTask(task)
      task = .invalid
    }
    SignedDecline.post(
      apiBase: apiBase, callId: call.callId, deviceId: token.deviceId, exp: token.exp,
      sig: token.sig
    ) { status in
      DispatchQueue.main.async {
        NSLog(
          "[wherry] calls: signed decline %@ -> %@", call.callId,
          status.map { String($0) } ?? "not sent")
        if task != .invalid {
          UIApplication.shared.endBackgroundTask(task)
          task = .invalid
        }
      }
    }
  }

  // MARK: - Proximity

  @objc private func routeChanged() {
    onMain { self.applyProximity() }
  }

  /// The screen blanks at the ear for an audio-only call, and not on the
  /// loudspeaker, where the phone is held away from the face (row I-66).
  private func applyProximity() {
    let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
    let onSpeaker = outputs.contains { $0.portType == .builtInSpeaker }
    let enabled = proximityWanted && !onSpeaker
    if UIDevice.current.isProximityMonitoringEnabled != enabled {
      UIDevice.current.isProximityMonitoringEnabled = enabled
      NSLog(
        "[wherry] calls: proximity %@ (reads %@)", enabled ? "on" : "off",
        UIDevice.current.isProximityMonitoringEnabled ? "on" : "off")
    }
  }

  // MARK: - Helpers

  private func label(for conversationId: String?) -> String {
    guard let conversationId = conversationId,
      let labels = UserDefaults.standard.dictionary(forKey: Self.defaultsLabels),
      let label = labels[conversationId] as? String, !label.isEmpty
    else {
      return Self.fallbackLabel
    }
    return label
  }

  private func tokenAnswer() -> JsonObject {
    var answer: JsonObject = ["environment": ApsEnvironment.current]
    answer["token"] = voipToken.map { $0 as Any } ?? NSNull()
    if let keys = RingKeys.load() {
      answer["p256dh"] = keys.p256dh
      answer["auth"] = keys.authText
    }
    return answer
  }

  private func tokenEvent() -> JSObject {
    var event: JSObject = ["environment": ApsEnvironment.current]
    event["token"] = voipToken ?? NSNull()
    if let keys = RingKeys.load() {
      event["p256dh"] = keys.p256dh
      event["auth"] = keys.authText
    }
    return event
  }

  /// Whether CallKit has the ring, so the page must not ring over it.
  private static func callKitTook(_ error: Error?) -> Bool {
    guard let error = error else { return true }
    guard let incoming = error as? CXErrorCodeIncomingCallError else { return false }
    switch incoming.code {
    case .callUUIDAlreadyExists, .filteredByDoNotDisturb, .filteredByBlockList:
      return true
    default:
      return false
    }
  }

  private static func describe(_ error: Error) -> String {
    let ns = error as NSError
    return "\(ns.domain) \(ns.code)"
  }

  private static func cxReason(_ end: RingEnd) -> CXCallEndedReason {
    switch end {
    case .remoteEnded: return .remoteEnded
    case .unanswered: return .unanswered
    case .answeredElsewhere: return .answeredElsewhere
    case .declinedElsewhere: return .declinedElsewhere
    case .failed: return .failed
    }
  }

  private static func nowSeconds() -> Int64 {
    return Int64(Date().timeIntervalSince1970)
  }

  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread {
      work()
    } else {
      DispatchQueue.main.async(execute: work)
    }
  }

  #if DEBUG
    /// Debug builds only: `WHERRY_DEBUG_RING` runs the push handler with no
    /// page and no APNs -- how a simulator row rings a build with nobody to
    /// tap and no dev server (`SIMCTL_CHILD_WHERRY_DEBUG_RING=... xcrun
    /// simctl launch`). It is one JSON payload (plaintext or `{k, e}`) or an
    /// array of them; the first runs `WHERRY_DEBUG_RING_AFTER` seconds after
    /// launch (default 2) and each next one `WHERRY_DEBUG_RING_EVERY` seconds
    /// later (default 3), so a row can ring and then dismiss. An absent `exp`
    /// in a plaintext ring is filled in as now + 45 s, as `?devring` does.
    private func debugLaunchRing() {
      let environment = ProcessInfo.processInfo.environment
      guard let text = environment["WHERRY_DEBUG_RING"] else { return }
      let parsed = text.data(using: .utf8).flatMap {
        try? JSONSerialization.jsonObject(with: $0, options: [])
      }
      let payloads: [[String: Any]]
      if let one = parsed as? [String: Any] {
        payloads = [one]
      } else if let many = parsed as? [[String: Any]] {
        payloads = many
      } else {
        NSLog("[wherry] calls: WHERRY_DEBUG_RING ignored (not a JSON object or array)")
        return
      }
      let after = Double(environment["WHERRY_DEBUG_RING_AFTER"] ?? "") ?? 2
      let every = Double(environment["WHERRY_DEBUG_RING_EVERY"] ?? "") ?? 3
      for (index, original) in payloads.enumerated() {
        let delay = max(0, after) + max(0, every) * Double(index)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
          var payload = original
          if payload["e"] == nil, payload["k"] as? String == "call_ring", payload["exp"] == nil {
            payload["exp"] = Self.nowSeconds() + 45
          }
          self.handlePush(payload, allowPlaintext: true, source: "debug-launch") {}
        }
      }
    }
  #endif
}

@_cdecl("init_plugin_wherry_calls")
func initPlugin() -> Plugin {
  return CallsPlugin()
}
