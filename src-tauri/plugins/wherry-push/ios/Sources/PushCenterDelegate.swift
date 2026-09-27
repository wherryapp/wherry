// The notification delegate (plan §5.2, mechanism 2).
//
// iOS has one `UNUserNotificationCenter.delegate`, and
// tauri-plugin-notification takes it when it loads: its NotificationManager
// sets itself as the delegate, returns no presentation for any push-triggered
// notification and drops the tap on one (2.4.0, NotificationManager.swift).
// So a tap on a remote notification reaches nothing today.
//
// This wraps it rather than replacing it. It remembers the delegate it found
// (`previous`, held strongly: the centre's own reference is weak), installs
// itself, and then:
// - a LOCAL notification (the engine's desktop-notify path) goes to
//   `previous` unchanged, both callbacks, so it behaves exactly as before;
// - a PUSH notification is ours: `willPresent` reports it (`received`) and
//   shows a banner only for a call, and `didReceive` stores the tap for
//   `take_open`.
//
// It has to be installed after plugin-notification's manager exists, which
// is why lib.rs registers wherry-push after tauri_plugin_notification (Tauri
// initialises plugins in order). Both plugins initialise while the app is
// being built, before UIApplicationMain runs, so the delegate is in place
// before launch finishes -- the condition for the tap that LAUNCHED the app
// to be delivered at all (row I-41).

import UserNotifications

final class PushCenterDelegate: NSObject, UNUserNotificationCenterDelegate {
  /// Plugin-notification's manager, or whatever held the delegate before us.
  private(set) var previous: UNUserNotificationCenterDelegate?

  /// `received` for a push that arrives while the app is in front.
  var onReceived: ((_ kind: String) -> Void)?
  /// A tap on a push: its kind and opaque reference (plan §2).
  var onOpened: ((_ kind: String, _ ref: String?) -> Void)?

  func install() {
    let center = UNUserNotificationCenter.current()
    if center.delegate === self { return }
    previous = center.delegate
    center.delegate = self
    let name = previous.map { String(describing: type(of: $0)) } ?? "none"
    NSLog("[wherry-push] delegate wrapped (previous=%@)", name)
  }

  /// The `w` object every Wherry alert carries: `{"k": kind, "r": ref}`
  /// (plan §4.4). A push without it (someone else's test payload) reads as a
  /// plain message with no reference.
  static func wherryFields(_ userInfo: [AnyHashable: Any]) -> (kind: String, ref: String?) {
    let w = userInfo["w"] as? [String: Any]
    let kind = (w?["k"] as? String) ?? "message"
    let ref = w?["r"] as? String
    return (kind, ref)
  }

  private static func isPush(_ notification: UNNotification) -> Bool {
    return notification.request.trigger is UNPushNotificationTrigger
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    guard Self.isPush(notification) else {
      if previous?.userNotificationCenter?(
        center, willPresent: notification, withCompletionHandler: completionHandler) == nil
      {
        completionHandler([])
      }
      return
    }
    let fields = Self.wherryFields(notification.request.content.userInfo)
    NSLog("[wherry-push] received %@ in foreground", fields.kind)
    onReceived?(fields.kind)
    // The app is in front: the socket and the timeline already carry a
    // message, a mention or a contact event, so no banner (sw.js's focused
    // rule). A ring is worth one duplicate, as on the web.
    if fields.kind == "call" {
      completionHandler([.banner, .sound, .list])
    } else {
      completionHandler([])
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    guard Self.isPush(response.notification) else {
      if previous?.userNotificationCenter?(
        center, didReceive: response, withCompletionHandler: completionHandler) == nil
      {
        completionHandler()
      }
      return
    }
    let fields = Self.wherryFields(response.notification.request.content.userInfo)
    // Only a tap opens; a dismiss (with a dismiss action registered) does not.
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
      NSLog("[wherry-push] open %@ %@", fields.kind, fields.ref ?? "-")
      onOpened?(fields.kind, fields.ref)
    }
    completionHandler()
  }

}
