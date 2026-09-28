// The iOS half's pure pieces on the Mac: RingEnvelope (RFC 8291) and
// RingMessage (what a push says). Compiled with swiftc by run-tests.sh
// against macOS's CryptoKit, which is the same implementation iOS ships.
// Not a SwiftPM test target on purpose: the plugin's package depends on
// Tauri's Swift API, which exists only after a mobile build, and the
// package is built by Tauri's own build step, which this must not disturb.
//
// The two envelope vectors are the push plugin's RingEnvelopeTest.kt ones:
// RFC 8291 Appendix A, and one made by the server's own encryptFor
// (server/src/push/envelope.ts, 2026-09-27, throwaway key), so the iOS
// half, the Android half and the server are shown to agree byte for byte.

import CryptoKit
import Foundation

var failures = 0
var passes = 0

func check(_ condition: Bool, _ name: String, file: String = #file, line: Int = #line) {
  if condition {
    passes += 1
  } else {
    failures += 1
    print("FAIL \(name) (\(file):\(line))")
  }
}

func b64(_ text: String) -> Data {
  guard let data = Base64URL.decode(text) else { fatalError("bad fixture: \(text)") }
  return data
}

func key(_ d: String) -> P256.KeyAgreement.PrivateKey {
  return try! P256.KeyAgreement.PrivateKey(rawRepresentation: b64(d))
}

func opens(_ body: Data, _ privateKey: P256.KeyAgreement.PrivateKey, _ auth: Data) -> Data? {
  return try? RingEnvelope.open(body: body, privateKey: privateKey, auth: auth)
}

func flip(_ data: Data, at index: Int) -> Data {
  var copy = data
  copy[index] ^= 0x01
  return copy
}

// MARK: - Fixtures

let rfcBody = b64(
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
)
let rfcPrivate = key("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")
let rfcPublic = b64(
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
let rfcAuth = b64("BTBZMqHH6r4Tts7J_aSIgg")

let serverText =
  "OYQK1QPerGBfFF2Bkdb_oAAAEABBBFi-xIrMBu0pr1xrCKrLn1uCB2GJHkqBmov3T1nYENQljSVlyTJpUAIQ6cHHDC4flfSNDtS7gSoVwPPUZwS6-cgU3WQlK0AlPHbtmuep46t2QnR_an41i4ceHKp-e9Mn9yb8m28HNI_G2yJV8R25KM6gnH6ltx8kOqC04Unib0OG2TPK-F-OxXs4PAOlrSoDPpV_cDqSh_3hKdeRnDg_hbDTqRRdQpqFPAPxlnuKM2OhSBRM2r3hMo1mUUGF6AoQ9Hf9W1R0m6g4cOlpIm09Bh07YiGaJHl35duZMph1wyuMvu87Smcws_ya-muiUwEYHmwC32jH-4GErgN2sXHqgCEZNmo8hS0puHumesN_P1yycVKgECl0sgqjBxQcKSVXkbmRB7T1_GUnp0wmS_ROKVeweA"
let serverBody = b64(serverText)
let serverPrivate = key("rm3mcLkL1LlSte950sAvtUXidp6vncXU4k0-29JXB7A")
let serverPublic = b64(
  "BEchEPHpCkdA-7jrh0f2MjeW3vb4HuKVmIVy8bp4qz68zsljEFPi7Pn670pN-SkRYiqhud4xsN8R_QUv_vXWuSc")
let serverAuth = b64("_JIwGgBFApEFiLM6Qzx6PA")
let serverPlaintext =
  "{\"w\":1,\"k\":\"call_ring\",\"call\":\"0192f3a0-0000-7000-8000-00000000000c\","
  + "\"conv\":\"0192f3a0-0000-7000-8000-000000000001\",\"dev\":\"0192f3a0-0000-7000-8000-0000000000d1\","
  + "\"group\":false,\"exp\":1790000045,\"dsig\":\"c2lnbmF0dXJlLW5vdC1yZWFs\"}"

// MARK: - RingEnvelope

check(
  opens(rfcBody, rfcPrivate, rfcAuth).flatMap { String(data: $0, encoding: .utf8) }
    == "When I grow up, I want to be a watermelon",
  "opens RFC 8291 Appendix A")
check(rfcPrivate.publicKey.x963Representation == rfcPublic, "RFC key's public half is the point")
check(
  opens(serverBody, serverPrivate, serverAuth).flatMap { String(data: $0, encoding: .utf8) }
    == serverPlaintext,
  "opens what the server's encryptFor wrote")
check(serverPrivate.publicKey.x963Representation == serverPublic, "server key's public half")
check(
  Base64URL.encode(serverPrivate.publicKey.x963Representation).count == 87,
  "p256dh is 87 characters, as the register schema wants")
check(opens(serverBody, serverPrivate, flip(serverAuth, at: 0)) == nil, "refuses the wrong auth secret")
check(opens(serverBody, rfcPrivate, serverAuth) == nil, "refuses another device's key")
check(
  opens(flip(serverBody, at: serverBody.count - 20), serverPrivate, serverAuth) == nil,
  "refuses a tampered record")
check(opens(serverBody.prefix(90), serverPrivate, serverAuth) == nil, "refuses a truncated body")
var badIdlen = serverBody
badIdlen[20] = 64
check(opens(badIdlen, serverPrivate, serverAuth) == nil, "refuses a keyid that is not a point")
check(opens(Data(), serverPrivate, serverAuth) == nil, "refuses an empty body")
check(
  opens(serverBody.subdata(in: 1..<serverBody.count), serverPrivate, serverAuth) == nil,
  "refuses a shifted body")
// A slice with a non-zero start index must read like a copy.
let sliced = (Data([0xAA]) + serverBody).dropFirst()
check(
  opens(Data(sliced), serverPrivate, serverAuth) != nil && opens(sliced, serverPrivate, serverAuth) != nil,
  "opens a Data slice")

// RFC 5869 A.1, truncated to the one-block outputs this code uses.
let okm = RingEnvelope.hkdf(
  salt: Data((0..<13).map { UInt8($0) }), ikm: Data(repeating: 0x0b, count: 22),
  info: Data((0..<10).map { UInt8(0xf0 + $0) }), length: 32)
check(
  okm.map { String(format: "%02x", $0) }.joined()
    == "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf",
  "HKDF matches RFC 5869 test case 1")

check(Base64URL.decode("a+b") == nil, "base64url refuses standard-alphabet characters")
check(Base64URL.decode("a") == nil, "base64url refuses an impossible length")
check(Base64URL.encode(Data([0xfb, 0xff])) == "-_8", "base64url encodes unpadded")

// MARK: - RingGate

let serverOpen: (Data) -> Data? = { opens($0, serverPrivate, serverAuth) }
let neverOpen: (Data) -> Data? = { _ in nil }

let ringOuter: [String: Any] = ["k": "call_ring", "e": serverText]
if case .message(.ring(let push)) = RingGate.decide(ringOuter, allowPlaintext: false, open: serverOpen) {
  check(push.callId == "0192f3a0-0000-7000-8000-00000000000c", "envelope ring: call id")
  check(push.conversationId == "0192f3a0-0000-7000-8000-000000000001", "envelope ring: conversation")
  check(push.deviceId == "0192f3a0-0000-7000-8000-0000000000d1", "envelope ring: device")
  check(push.group == false, "envelope ring: group")
  check(push.exp == 1_790_000_045, "envelope ring: exp")
  check(push.dsig == nil, "a signature of the wrong shape is dropped, the ring kept")
} else {
  check(false, "the server's envelope decides to a ring")
}
check(
  RingGate.decide(["k": "ring_ended", "e": serverText], allowPlaintext: false, open: serverOpen)
    == .refused("mismatched"),
  "an inner kind that is not the outer is refused")
check(
  RingGate.decide(ringOuter, allowPlaintext: false, open: neverOpen) == .refused("unopened"),
  "an envelope that does not open is refused")
check(
  RingGate.decide(["k": "call_ring", "e": 42], allowPlaintext: true, open: serverOpen)
    == .refused("unopened"),
  "an `e` that is not a string is refused")

let signature = String(repeating: "A", count: 43)
let plainRing: [String: Any] = [
  "w": 1, "k": "call_ring", "call": "0192f3a0-0000-7000-8000-00000000000c",
  "conv": "0192f3a0-0000-7000-8000-000000000001", "dev": "0192f3a0-0000-7000-8000-0000000000d1",
  "group": true, "exp": 1_790_000_045, "dsig": signature,
]
check(
  RingGate.decide(plainRing, allowPlaintext: false, open: serverOpen) == .refused("unencrypted"),
  "plaintext is refused outside the debug paths")
check(
  RingGate.decide(plainRing, allowPlaintext: true, open: serverOpen)
    == .message(
      .ring(
        RingPush(
          callId: "0192f3a0-0000-7000-8000-00000000000c",
          conversationId: "0192f3a0-0000-7000-8000-000000000001",
          deviceId: "0192f3a0-0000-7000-8000-0000000000d1", group: true, exp: 1_790_000_045,
          dsig: signature))),
  "plaintext parses on the debug paths")

// FCM's data map spells every value as a string.
let stringRing: [String: Any] = [
  "w": "1", "k": "call_ring", "call": "0192f3a0-0000-7000-8000-00000000000c", "group": "false",
  "exp": "1790000045",
]
if case .message(.ring(let push)) = RingGate.parse(stringRing) {
  check(push.exp == 1_790_000_045 && push.group == false, "string values parse")
  check(push.conversationId == nil && push.dsig == nil, "absent optional fields read as nil")
} else {
  check(false, "a ring spelled in strings parses")
}

// Round-trip through JSON, as a decrypted body arrives: numbers are
// NSNumbers there, and `false` must not read as a number nor 0 as a bool.
let jsonRing = try! JSONSerialization.jsonObject(
  with: serverPlaintext.data(using: .utf8)!, options: []) as! [String: Any]
if case .message(.ring(let push)) = RingGate.parse(jsonRing) {
  check(push.exp == 1_790_000_045 && push.group == false, "JSON values parse")
} else {
  check(false, "a JSON ring parses")
}
check(RingGate.parse(["w": 1, "k": "call_ring", "call": "x", "exp": 1]) == .refused("malformed"), "a call id that is not a UUID")
check(
  RingGate.parse(["w": 1, "k": "call_ring", "call": "0192f3a0-0000-7000-8000-00000000000c/../x", "exp": 1])
    == .refused("malformed"), "a call id with a path in it")
check(
  RingGate.parse(["w": 2, "k": "call_ring", "call": "0192f3a0-0000-7000-8000-00000000000c", "exp": 1])
    == .refused("malformed"), "a newer payload version")
check(
  RingGate.parse(["w": 1, "k": "call_ring", "call": "0192f3a0-0000-7000-8000-00000000000c"])
    == .refused("malformed"), "a ring without exp")
check(
  RingGate.parse(["w": 1, "k": "call_ring", "call": "0192f3a0-0000-7000-8000-00000000000c", "exp": true])
    == .refused("malformed"), "a boolean is not an exp")
check(
  RingGate.parse(["w": 1, "k": "call_ring", "call": "0192f3a0-0000-7000-8000-00000000000c", "exp": 1.5])
    == .refused("malformed"), "a fraction is not an exp")
check(
  RingGate.parse(["w": 1, "k": "message", "call": "0192f3a0-0000-7000-8000-00000000000c"])
    == .refused("malformed"), "an unknown kind")
check(
  RingGate.parse(["w": 1, "k": "ring_ended", "call": "0192f3a0-0000-7000-8000-00000000000c", "why": "cancelled"])
    == .message(.ended(callId: "0192f3a0-0000-7000-8000-00000000000c", why: "cancelled")),
  "a dismissal parses")
check(
  RingGate.parse(["w": 1, "k": "ring_ended", "call": "0192f3a0-0000-7000-8000-00000000000c"])
    == .refused("malformed"), "a dismissal without why")
check(RingGate.isSignature(signature), "43 base64url characters are a signature")
check(!RingGate.isSignature("c2lnbmF0dXJlLW5vdC1yZWFs"), "24 characters are not")
check(!RingGate.isSignature(String(repeating: "A", count: 42) + "/"), "nor a standard-alphabet one")

// MARK: - Ends

check(RingEnd.forServerWhy("answered_elsewhere") == .answeredElsewhere, "answered_elsewhere")
check(RingEnd.forServerWhy("declined_elsewhere") == .declinedElsewhere, "declined_elsewhere")
check(RingEnd.forServerWhy("unanswered") == .unanswered, "unanswered")
check(RingEnd.forServerWhy("cancelled") == .remoteEnded, "cancelled is the caller's end")
check(RingEnd.forServerWhy("answered") == .remoteEnded, "another member's answer ends the ring")
check(RingEnd.forServerWhy("something-newer") == .remoteEnded, "an unknown reason")

check(PageEnd.forPageReason("answered") == .answeredHere, "the page's answered ends nothing")
check(PageEnd.forPageReason("declined") == .declinedHere, "the page's declined is a local end")
check(PageEnd.forPageReason("ended") == .report(.remoteEnded), "ended")
check(PageEnd.forPageReason("cancelled") == .report(.remoteEnded), "cancelled")
check(PageEnd.forPageReason("failed") == .report(.failed), "failed")
check(PageEnd.forPageReason("unanswered") == .report(.unanswered), "unanswered")
check(PageEnd.forPageReason("answered_elsewhere") == .report(.answeredElsewhere), "answered elsewhere")
check(PageEnd.forPageReason("declined_elsewhere") == .report(.declinedElsewhere), "declined elsewhere")

// MARK: - EndedCalls (a late ring for a call ended here)

do {
  let x = UUID()
  let y = UUID()
  let now: Int64 = 1_000_000
  var ended = EndedCalls()
  check(ended.ended(x, now: now) == nil, "an unknown call is not ended")
  ended.add(x, exp: now + 45, end: .remoteEnded, now: now)
  check(ended.ended(x, now: now) == .remoteEnded, "a declined call reads as ended at once")
  check(ended.ended(x, now: now + 44) == .remoteEnded, "still ended inside the ring window")
  check(
    ended.ended(x, now: now + 45 + EndedCalls.margin - 1) == .remoteEnded,
    "still ended inside the margin after exp")
  check(ended.ended(x, now: now + 45 + EndedCalls.margin) == nil, "lapses at exp plus the margin")
  check(ended.ended(y, now: now) == nil, "another call is not ended")

  ended.add(y, exp: now + 1_000_000, end: .unanswered, now: now)
  check(
    ended.ended(y, now: now + EndedCalls.maxWindow + EndedCalls.margin) == nil,
    "a far-future exp is capped")
  ended.add(y, exp: now - 10, end: .unanswered, now: now)
  check(ended.ended(y, now: now) == .unanswered, "an expired call is still kept for the margin")
  ended.add(y, exp: now + 45, end: .answeredElsewhere, now: now)
  check(ended.ended(y, now: now) == .answeredElsewhere, "a later end replaces the reason")

  var full = EndedCalls()
  let first = UUID()
  full.add(first, exp: now + 1, end: .failed, now: now)
  for index in 0..<EndedCalls.capacity {
    full.add(UUID(), exp: now + 100 + Int64(index), end: .failed, now: now)
  }
  check(full.count == EndedCalls.capacity, "bounded at capacity")
  check(full.ended(first, now: now) == nil, "the soonest to lapse is dropped first")

  let later = now + 100 + Int64(EndedCalls.capacity) + EndedCalls.margin
  full.add(UUID(), exp: later + 45, end: .failed, now: later)
  check(full.count == 1, "lapsed entries are pruned on add")
  full.removeAll()
  check(full.count == 0, "removeAll empties it")
}

print("\(passes) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
