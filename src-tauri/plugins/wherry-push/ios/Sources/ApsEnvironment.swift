// Which APNs host this install's token belongs to (plan §5.2, "The APNs
// environment"). The server records it per token and sends to the matching
// host: a sandbox token sent to production is rejected as BadDeviceToken.
//
// A development-signed build points at production too (`.env.ios` bakes
// https://wherry.app/api), so the answer cannot come from the API base. It
// comes from the signature instead:
// - the simulator is always the sandbox;
// - a build carrying `embedded.mobileprovision` (development and ad hoc)
//   reads `aps-environment` from the profile's entitlements: `development`
//   is the sandbox, anything else production;
// - no embedded profile is TestFlight or the App Store, both production
//   (believed; row I-49 settles it).

import Foundation

enum ApsEnvironment {
  static let current: String = compute()

  private static func compute() -> String {
    #if targetEnvironment(simulator)
      return "sandbox"
    #else
      guard
        let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
        let data = try? Data(contentsOf: url)
      else {
        return "production"
      }
      // `development` is the sandbox; anything else, including a profile
      // without the entitlement (which gets no token at all), is production.
      let aps = profileEntitlements(data)?["aps-environment"] as? String
      return aps == "development" ? "sandbox" : "production"
    #endif
  }

  /// The profile is a CMS envelope around an XML plist. Rather than parse
  /// the envelope, take the plist between its first `<?xml` and its last
  /// `</plist>`, which is what every implementation of this does.
  private static func profileEntitlements(_ data: Data) -> [String: Any]? {
    guard let text = String(data: data, encoding: .isoLatin1),
      let start = text.range(of: "<?xml"),
      let end = text.range(of: "</plist>", options: .backwards)
    else {
      return nil
    }
    let xml = String(text[start.lowerBound..<end.upperBound])
    guard let plistData = xml.data(using: .isoLatin1),
      let plist = try? PropertyListSerialization.propertyList(
        from: plistData, options: [], format: nil) as? [String: Any]
    else {
      return nil
    }
    return plist["Entitlements"] as? [String: Any]
  }
}
