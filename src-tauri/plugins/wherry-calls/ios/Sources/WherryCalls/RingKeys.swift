// The key pair rings are encrypted to on iOS (decision M-1 = E). The public
// half and the auth secret are what `pushToken` and the `push-token` event
// report as `p256dh` and `auth` (unpadded base64url), and what the page
// registers with the PushKit token; the private half never leaves this
// process.
//
// Where it lives: one Keychain item (generic password), holding the 16-byte
// auth secret and the 32-byte private scalar, with
// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly:
// - after first unlock, because a VoIP push reaches a locked phone and the
//   ring has to open then;
// - this device only, so the item is left out of backups and device
//   transfers, which is the Android half's reasoning (RingKeys.kt keeps the
//   key behind a Keystore key for the same end). A restored phone mints a new
//   pair, and the page's next registration sends the new public half.
//
// Not the Secure Enclave: it holds only keys it generated itself, and a key
// there can be used on a locked phone only with the same accessibility class,
// so it would buy nothing here while adding a second code path.

import CryptoKit
import Foundation
import Security

enum RingKeys {
  private static let service = "app.wherry.calls.ring"
  private static let account = "ring-key"
  private static let authLength = 16

  struct Material {
    let privateKey: P256.KeyAgreement.PrivateKey
    let auth: Data

    /// The uncompressed point, as the server's register schema wants it.
    var p256dh: String { Base64URL.encode(privateKey.publicKey.x963Representation) }
    var authText: String { Base64URL.encode(auth) }
  }

  private static var cached: Material?
  private static let lock = NSLock()

  /// The current pair, minting one when there is none or the stored one is
  /// unreadable. Nil only when the Keychain refuses both the read and the
  /// write (a locked phone before its first unlock since boot).
  static func load() -> Material? {
    lock.lock()
    defer { lock.unlock() }
    if let cached = cached { return cached }
    #if DEBUG
      if let fixture = debugFixture() {
        cached = fixture
        return fixture
      }
    #endif
    switch read() {
    case .found(let material):
      cached = material
      return material
    case .locked:
      // Before the first unlock: minting now would replace the registered
      // pair with one the server has never seen. Try again later.
      NSLog("[wherry] calls: ring key unavailable (keychain locked)")
      return nil
    case .absent, .unreadable:
      return mint()
    }
  }

  private enum ReadResult {
    case found(Material)
    case absent
    case locked
    case unreadable
  }

  private static func read() -> ReadResult {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    switch status {
    case errSecSuccess:
      guard let data = result as? Data, data.count == authLength + 32,
        let key = try? P256.KeyAgreement.PrivateKey(
          rawRepresentation: data.subdata(in: authLength..<data.count))
      else {
        NSLog("[wherry] calls: ring key unreadable; minting a new one")
        return .unreadable
      }
      return .found(Material(privateKey: key, auth: data.subdata(in: 0..<authLength)))
    case errSecItemNotFound:
      return .absent
    case errSecInteractionNotAllowed:
      return .locked
    default:
      NSLog("[wherry] calls: ring key read failed (%d); minting a new one", status)
      return .unreadable
    }
  }

  private static func mint() -> Material? {
    let key = P256.KeyAgreement.PrivateKey()
    var auth = Data(count: authLength)
    let random = auth.withUnsafeMutableBytes {
      SecRandomCopyBytes(kSecRandomDefault, authLength, $0.baseAddress!)
    }
    guard random == errSecSuccess else {
      NSLog("[wherry] calls: no randomness for the ring key (%d)", random)
      return nil
    }
    SecItemDelete(baseQuery() as CFDictionary)
    var item = baseQuery()
    item[kSecValueData as String] = auth + key.rawRepresentation
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      NSLog("[wherry] calls: ring key could not be stored (%d)", status)
      return nil
    }
    NSLog("[wherry] calls: ring key minted")
    let material = Material(privateKey: key, auth: auth)
    cached = material
    return material
  }

  private static func baseQuery() -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  #if DEBUG
    /// Debug builds only: `WHERRY_DEBUG_RING_KEY` (base64url of the 16-byte
    /// auth secret followed by the 32-byte private scalar) replaces the
    /// Keychain pair for this process, and nothing is stored. It lets a
    /// simulator row decrypt a ring the server's own `encryptFor` wrote to a
    /// test key (`xcrun simctl launch` passes it as
    /// `SIMCTL_CHILD_WHERRY_DEBUG_RING_KEY`); an installed build has no way
    /// to set it.
    private static func debugFixture() -> Material? {
      guard let text = ProcessInfo.processInfo.environment["WHERRY_DEBUG_RING_KEY"] else {
        return nil
      }
      guard let data = Base64URL.decode(text), data.count == authLength + 32,
        let key = try? P256.KeyAgreement.PrivateKey(
          rawRepresentation: data.subdata(in: authLength..<data.count))
      else {
        NSLog("[wherry] calls: WHERRY_DEBUG_RING_KEY ignored (not 48 bytes of base64url)")
        return nil
      }
      NSLog("[wherry] calls: ring key from WHERRY_DEBUG_RING_KEY (debug)")
      return Material(privateKey: key, auth: data.subdata(in: 0..<authLength))
    }
  #endif
}
