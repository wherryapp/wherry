// The lock screen's Decline without a session (plan §2.5): POST
// `/api/calls/:id/decline-signed` with the token the ring carried. It can
// decline that one call, for the ring's device's user, until `exp`, and
// nothing else. iOS could read the vaulted session instead, but that would
// hand native code a full credential; the plan rejects it.
//
// The server answers 204 whatever happened (api.md), so a 204 says the
// request arrived, not that a call was declined; 503 means the server has no
// CALL_ACTION_SECRET. The same request as the Android half's SignedDecline.kt.

import Foundation

enum SignedDecline {
  /// Well inside the few seconds iOS gives a background app after CallKit's
  /// end action.
  private static let timeout: TimeInterval = 4

  /// Sends the decline; `done` gets the status code, or nil when the request
  /// never completed or was refused before sending.
  static func post(
    apiBase: String, callId: String, deviceId: String, exp: Int64, sig: String,
    done: @escaping (Int?) -> Void
  ) {
    // Every part of the URL and body is shape-checked: the ids reach a path,
    // and a stray `/` or `?` must never.
    guard RingGate.uuid(callId) != nil, RingGate.uuid(deviceId) != nil,
      RingGate.isSignature(sig),
      apiBase.hasPrefix("https://") || apiBase.hasPrefix("http://"),
      let url = URL(string: "\(apiBase)/calls/\(callId)/decline-signed")
    else {
      done(nil)
      return
    }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let body: [String: Any] = ["deviceId": deviceId, "exp": exp, "sig": sig]
    guard let data = try? JSONSerialization.data(withJSONObject: body, options: []) else {
      done(nil)
      return
    }
    request.httpBody = data

    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = timeout
    configuration.timeoutIntervalForResource = timeout
    let session = URLSession(configuration: configuration)
    session.dataTask(with: request) { _, response, error in
      session.finishTasksAndInvalidate()
      if let error = error {
        NSLog("[wherry] calls: signed decline failed: %@", (error as NSError).domain)
        done(nil)
        return
      }
      done((response as? HTTPURLResponse)?.statusCode)
    }.resume()
  }
}
