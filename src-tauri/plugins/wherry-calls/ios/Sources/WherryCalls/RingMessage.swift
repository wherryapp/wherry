// What a VoIP push (or `debugIncoming`) says, read with no CallKit and no
// Tauri, so ios/Tests/run-tests.sh runs it on the Mac.
//
// The payloads are the phone-calls plan's §4.2 closed set:
//   { w: 1, k: "call_ring", call, conv, dev, group, exp, dsig? }
//   { w: 1, k: "ring_ended", call, why }
// On APNs they travel as `{k, e}`, `e` the RFC 8291 body (RingEnvelope), so
// Apple reads the kind and nothing else. Values may be JSON numbers and
// booleans (the decrypted JSON, and `?devring`) or strings (FCM's data map,
// kept readable here so one fixture serves both platforms).
//
// A call kind with no `e` is never genuine in a release build: the server
// encrypts every ring (M-1 = E). Only the debug-only paths ask for plaintext,
// the way the push plugin's Android RingGate.kt refuses `unencrypted`.

import Foundation

/// One ring, as the push carried it.
struct RingPush: Equatable {
  /// The call's id, a UUID string as the server spells it (lowercase).
  let callId: String
  let conversationId: String?
  /// The recipient device the signature names.
  let deviceId: String?
  let group: Bool
  /// When the ring window closes, seconds since the epoch.
  let exp: Int64
  /// The signed-decline token (plan §2.5); absent when the server has no
  /// CALL_ACTION_SECRET.
  let dsig: String?
}

enum RingMessage: Equatable {
  case ring(RingPush)
  /// `why` is the server's reason: answered, answered_elsewhere,
  /// declined_elsewhere, cancelled or unanswered.
  case ended(callId: String, why: String)

  var callId: String {
    switch self {
    case .ring(let push): return push.callId
    case .ended(let callId, _): return callId
    }
  }
}

enum RingDecision: Equatable {
  case message(RingMessage)
  /// Not acted on. `unopened` (an `e` that did not open), `unencrypted` (no
  /// `e`, plaintext not allowed), `mismatched` (the inner kind is not the
  /// outer), or `malformed`. Apple still requires a call to be reported for
  /// the push (plan §7), which the caller does.
  case refused(String)
}

enum RingGate {
  /// - Parameters:
  ///   - outer: the push's top-level dictionary.
  ///   - allowPlaintext: true only on the debug-only paths.
  ///   - open: decrypts an RFC 8291 body, or nil.
  static func decide(
    _ outer: [String: Any], allowPlaintext: Bool, open: (Data) -> Data?
  ) -> RingDecision {
    if let encoded = outer["e"] {
      guard let text = encoded as? String, let body = Base64URL.decode(text),
        let plaintext = open(body)
      else {
        return .refused("unopened")
      }
      guard
        let inner = (try? JSONSerialization.jsonObject(with: plaintext, options: []))
          as? [String: Any]
      else {
        return .refused("malformed")
      }
      if let outerKind = outer["k"], string(outerKind) != string(inner["k"]) {
        return .refused("mismatched")
      }
      return parse(inner)
    }
    return allowPlaintext ? parse(outer) : .refused("unencrypted")
  }

  static func parse(_ fields: [String: Any]) -> RingDecision {
    if let version = fields["w"], int(version) != 1 { return .refused("malformed") }
    guard let callId = uuid(fields["call"]) else { return .refused("malformed") }
    switch string(fields["k"]) {
    case "call_ring":
      guard let exp = int(fields["exp"]) else { return .refused("malformed") }
      // A signature of the wrong shape is dropped, not the ring: the ring
      // still rings, and its Decline goes through the page instead.
      let dsig = string(fields["dsig"]).flatMap { isSignature($0) ? $0 : nil }
      return .message(
        .ring(
          RingPush(
            callId: callId,
            conversationId: uuid(fields["conv"]),
            deviceId: uuid(fields["dev"]),
            group: bool(fields["group"]) ?? false,
            exp: exp,
            dsig: dsig)))
    case "ring_ended":
      guard let why = string(fields["why"]), !why.isEmpty else { return .refused("malformed") }
      return .message(.ended(callId: callId, why: why))
    default:
      return .refused("malformed")
    }
  }

  // MARK: - Values, each either JSON-typed or a string

  static func string(_ value: Any?) -> String? {
    return value as? String
  }

  static func int(_ value: Any?) -> Int64? {
    if let text = value as? String { return Int64(text) }
    if let number = value as? NSNumber {
      // A JSON `true` is an NSNumber too; it is not a number here.
      if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
      let double = number.doubleValue
      guard double.isFinite, double == double.rounded() else { return nil }
      return number.int64Value
    }
    return nil
  }

  static func bool(_ value: Any?) -> Bool? {
    if let text = value as? String {
      if text == "true" { return true }
      if text == "false" { return false }
      return nil
    }
    if let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() {
      return number.boolValue
    }
    return nil
  }

  /// A UUID as the server spells it; anything else is not an id. The shape
  /// check matters: the call id becomes a URL path segment (SignedDecline).
  static func uuid(_ value: Any?) -> String? {
    guard let text = value as? String, text.count == 36, UUID(uuidString: text) != nil else {
      return nil
    }
    return text
  }

  /// base64url of an HMAC-SHA256: 43 characters, unpadded.
  static func isSignature(_ text: String) -> Bool {
    guard text.count >= 43 && text.count <= 44 else { return false }
    let alphabet = CharacterSet(
      charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=")
    return text.unicodeScalars.allSatisfy { alphabet.contains($0) }
  }
}

/// How a ring ends in CallKit, without naming CallKit (so the Mac can test
/// the mapping): CallsPlugin.swift turns each into a `CXCallEndedReason`.
enum RingEnd: Equatable {
  case remoteEnded
  case unanswered
  case answeredElsewhere
  case declinedElsewhere
  case failed

  /// A `ring_ended` push's `why` (plan §4.2, §7). `answered` is someone
  /// else's answer -- another member of a group -- and never this device's
  /// (the server tells the answerer's own devices `answered_elsewhere`), so
  /// it reads as the ring ending rather than as "answered elsewhere".
  static func forServerWhy(_ why: String) -> RingEnd {
    switch why {
    case "answered_elsewhere": return .answeredElsewhere
    case "declined_elsewhere": return .declinedElsewhere
    case "unanswered": return .unanswered
    default: return .remoteEnded  // answered, cancelled, and anything newer
    }
  }
}

/// What the page's `reportEnded` asks of CallKit: phone-calls.ts's
/// `PhoneEndReason` table, the iOS column.
enum PageEnd: Equatable {
  /// `answered`: this device took the call. End nothing; a ring still
  /// ringing in CallKit is answered there, so it spans the web call.
  case answeredHere
  /// `declined`: a local end (CXEndCallAction) of a call CallKit holds.
  case declinedHere
  /// Every other reason: `reportCall(with:endedAt:reason:)`.
  case report(RingEnd)

  static func forPageReason(_ reason: String) -> PageEnd {
    switch reason {
    case "answered": return .answeredHere
    case "declined": return .declinedHere
    case "answered_elsewhere": return .report(.answeredElsewhere)
    case "declined_elsewhere": return .report(.declinedElsewhere)
    case "unanswered": return .report(.unanswered)
    case "failed": return .report(.failed)
    default: return .report(.remoteEnded)  // cancelled, ended, and anything newer
    }
  }
}

/// Calls this device has already ended -- declined, hung up, cancelled,
/// answered or declined elsewhere, expired -- kept until their ring window
/// has closed, so that a ring arriving late for one of them is not a new
/// ring.
///
/// Why it is needed: a ring reaches this device twice, over the page's
/// socket (`reportIncoming`) and as a VoIP push, and the push can land after
/// the call has already ended here (APNs latency is often 0.3 to 2 s). Once
/// ended, the call is gone from the plugin's `calls`, so without this the
/// late push is reported as a new call and CallKit rings again. After a
/// decline on this device nothing would stop that second ring before its
/// expiry: the server leaves the declining device out of `ring_ended`
/// (call-push-rules.ts `ringEndedTargets`, `actorDeviceId`).
///
/// Kept until `exp` plus `margin`, on this device's clock: once `exp` has
/// passed, a late ring is ended at once anyway (the expired-ring path), so
/// the margin only has to cover a phone clock running behind the server's.
/// `exp` is capped at `maxWindow` from now, so a far-future `exp` cannot hold
/// an entry for long, and the set holds at most `capacity` entries, the
/// soonest to lapse dropped first. In memory only: a push that launches a
/// fresh process after this one died is not covered (believed rare -- a
/// decline and its late push are seconds apart, and the process that
/// declined stays alive for the signed decline's background task).
///
/// Foundation only (no CallKit), so run-tests.sh tests it on the Mac.
struct EndedCalls {
  static let margin: Int64 = 120
  static let maxWindow: Int64 = 600
  static let capacity = 64

  private var entries: [UUID: (until: Int64, end: RingEnd)] = [:]

  var count: Int { return entries.count }

  /// Records `uuid` as ended here; `end` is what a late ring for it is
  /// ended with.
  mutating func add(_ uuid: UUID, exp: Int64, end: RingEnd, now: Int64) {
    prune(now: now)
    let until = min(exp, now + Self.maxWindow) + Self.margin
    entries[uuid] = (until, end)
    while entries.count > Self.capacity {
      guard let soonest = entries.min(by: { $0.value.until < $1.value.until }) else { break }
      entries[soonest.key] = nil
    }
  }

  /// How `uuid` ended here, while its entry lasts; nil otherwise.
  func ended(_ uuid: UUID, now: Int64) -> RingEnd? {
    guard let entry = entries[uuid], entry.until > now else { return nil }
    return entry.end
  }

  mutating func prune(now: Int64) {
    entries = entries.filter { $0.value.until > now }
  }

  mutating func removeAll() {
    entries.removeAll()
  }
}
