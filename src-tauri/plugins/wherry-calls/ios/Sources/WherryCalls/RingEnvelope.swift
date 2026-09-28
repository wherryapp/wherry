// The device's half of decision M-1 = E on iOS (phone-calls-plan.md §2.4): a
// ring (`call_ring` / `ring_ended`) reaches this install as a VoIP push whose
// body is `{k, e}`, `e` being RFC 8291 ciphertext the server's `encryptFor`
// (server/src/push/envelope.ts) wrote to the P-256 public key and auth secret
// this plugin registered with its PushKit token (RingKeys.swift). Apple
// relays bytes it cannot read.
//
// Foundation and CryptoKit only, no UIKit and no Tauri, so the Mac can
// compile and test it on its own (ios/Tests/run-tests.sh runs it against RFC
// 8291 Appendix A and against the server's own output). The steps are the
// push plugin's Android RingEnvelope.kt and envelope.test.ts's reference
// `decrypt`, one for one:
//
//   body = salt (16) | rs (4, big-endian) | idlen (1) = 65 | keyid (65) = the
//          server's ephemeral public key | one record (AES-128-GCM, 16-byte tag)
//   ecdh = ECDH(our private key, keyid)
//   ikm  = HKDF(salt = auth, ikm = ecdh, info = "WebPush: info\0" | ours | keyid, 32)
//   cek  = HKDF(salt = salt, ikm, "Content-Encoding: aes128gcm\0", 16)
//   iv   = HKDF(salt = salt, ikm, "Content-Encoding: nonce\0", 12)
//   plaintext || 0x02 || 0x00* = AES-GCM-open(cek, iv, record)

import CryptoKit
import Foundation

/// Why a body could not be opened. The message never quotes key material.
struct RingEnvelopeError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

enum RingEnvelope {
  private static let saltLength = 16
  private static let headerLength = saltLength + 4 + 1
  private static let pointLength = 65
  private static let tagLength = 16
  private static let authLength = 16

  /// Opens one `aes128gcm` body addressed to this device.
  ///
  /// - Parameters:
  ///   - body: the whole RFC 8188 body (the server sends it base64url; the
  ///     caller decodes).
  ///   - privateKey: our P-256 key-agreement key.
  ///   - auth: the 16-byte auth secret registered as `auth`.
  static func open(
    body rawBody: Data, privateKey: P256.KeyAgreement.PrivateKey, auth rawAuth: Data
  ) throws -> Data {
    // Re-based copies: a `Data` slice keeps its parent's indices.
    let body = Data(rawBody)
    let auth = Data(rawAuth)
    guard auth.count == authLength else { throw RingEnvelopeError("auth secret is not 16 bytes") }
    guard body.count >= headerLength else { throw RingEnvelopeError("body shorter than its header") }

    let salt = body.subdata(in: 0..<saltLength)
    let rs = body.subdata(in: 16..<20).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    let idlen = Int(body[20])
    guard idlen == pointLength else { throw RingEnvelopeError("keyid is not a P-256 point") }
    guard body.count >= headerLength + idlen + tagLength + 1 else {
      throw RingEnvelopeError("body has no record")
    }
    let senderPoint = body.subdata(in: headerLength..<(headerLength + idlen))
    let record = body.subdata(in: (headerLength + idlen)..<body.count)
    // One record only: a ring is a few hundred bytes, and the server writes
    // one (RFC 8291 §4 allows no more for push).
    guard rs >= UInt64(tagLength + 2), UInt64(record.count) <= rs else {
      throw RingEnvelopeError("more than one record")
    }

    let sender: P256.KeyAgreement.PublicKey
    do {
      sender = try P256.KeyAgreement.PublicKey(x963Representation: senderPoint)
    } catch {
      throw RingEnvelopeError("keyid is not on P-256")
    }
    let shared: SharedSecret
    do {
      shared = try privateKey.sharedSecretFromKeyAgreement(with: sender)
    } catch {
      throw RingEnvelopeError("key agreement failed")
    }
    let ecdhSecret = shared.withUnsafeBytes { Data($0) }
    let ours = privateKey.publicKey.x963Representation

    // RFC 8291 §3.4.
    let keyInfo = ascii("WebPush: info\u{0}") + ours + senderPoint
    let ikm = hkdf(salt: auth, ikm: ecdhSecret, info: keyInfo, length: 32)
    // RFC 8188 §2.2 and §2.3.
    let cek = hkdf(salt: salt, ikm: ikm, info: ascii("Content-Encoding: aes128gcm\u{0}"), length: 16)
    let nonce = hkdf(salt: salt, ikm: ikm, info: ascii("Content-Encoding: nonce\u{0}"), length: 12)

    let padded: Data
    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonce),
        ciphertext: record.subdata(in: 0..<(record.count - tagLength)),
        tag: record.subdata(in: (record.count - tagLength)..<record.count))
      padded = try AES.GCM.open(box, using: SymmetricKey(data: cek))
    } catch {
      // The wrong key, or a tampered body.
      throw RingEnvelopeError("record did not authenticate")
    }

    // The last non-zero octet is the delimiter, 0x02 for the last record.
    var end = padded.count - 1
    while end >= 0 && padded[padded.startIndex + end] == 0 { end -= 1 }
    guard end >= 0, padded[padded.startIndex + end] == 0x02 else {
      throw RingEnvelopeError("no last-record delimiter")
    }
    return padded.subdata(in: padded.startIndex..<(padded.startIndex + end))
  }

  /// HKDF-SHA-256 (RFC 5869), for outputs of at most one hash length.
  static func hkdf(salt: Data, ikm: Data, info: Data, length: Int) -> Data {
    precondition(length >= 1 && length <= 32)
    let prk = Data(HMAC<SHA256>.authenticationCode(for: ikm, using: SymmetricKey(data: salt)))
    var input = info
    input.append(0x01)
    let okm = Data(HMAC<SHA256>.authenticationCode(for: input, using: SymmetricKey(data: prk)))
    return okm.prefix(length)
  }

  private static func ascii(_ text: String) -> Data {
    return text.data(using: .ascii)!
  }
}

/// Unpadded base64url, the wire spelling of `e`, `p256dh` and `auth`.
enum Base64URL {
  static func encode(_ data: Data) -> String {
    return data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// Nil for anything outside the base64url alphabet, padded or not.
  static func decode(_ text: String) -> Data? {
    var trimmed = text
    while trimmed.hasSuffix("=") { trimmed.removeLast() }
    let alphabet = CharacterSet(
      charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    guard trimmed.unicodeScalars.allSatisfy({ alphabet.contains($0) }) else { return nil }
    var standard = trimmed
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let remainder = standard.count % 4
    if remainder == 1 { return nil }
    if remainder > 0 { standard += String(repeating: "=", count: 4 - remainder) }
    return Data(base64Encoded: standard)
  }
}
