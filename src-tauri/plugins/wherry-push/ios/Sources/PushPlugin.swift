// The iOS half of wherry-push: the commands and events of
// docs/prompts/native-push-plan.md §5.1. Mechanism only; every decision
// (when to ask, when to register with the server, what a tap opens) is the
// page's, in client/src/sync/native-push.ts.
//
// The permission prompt is NOT here: @tauri-apps/plugin-notification's
// requestPermission() already asks for [.badge, .alert, .sound], and the
// page calls it before `register`.

import Tauri
import UIKit
import UserNotifications
import WebKit

struct ClearArgs: Decodable {
  let ref: String
}

struct SetBadgeArgs: Decodable {
  let count: Int
}

class PushPlugin: Plugin {
  private let centerDelegate = PushCenterDelegate()

  // All state below is touched on the main queue only.
  private var token: String?
  private var pendingRegisters: [Invoke] = []
  private var pendingOpen: (kind: String, ref: String?)?

  /// How long `register` waits for APNs before giving up. Without a network,
  /// or on a simulator that issues no token, the callback never comes, and a
  /// promise that never settles would leave the page's toggle spinning.
  private static let registerTimeout: TimeInterval = 30

  // Runs while the app is being built, before UIApplicationMain: early
  // enough to own the notification delegate before launch finishes (see
  // PushCenterDelegate). UIApplication.shared does not exist yet, so the
  // AppDelegate hook waits for `load(webview:)` or the launch notification.
  override init() {
    super.init()
    NSLog("[wherry-push] loaded")

    centerDelegate.onReceived = { [weak self] kind in
      self?.onMain { self?.emit("received", ["kind": kind]) }
    }
    centerDelegate.onOpened = { [weak self] kind, ref in
      self?.onMain {
        self?.pendingOpen = (kind, ref)
        self?.emit("opened", [:])
      }
    }
    centerDelegate.install()

    AppDelegateHook.onToken = { [weak self] data in
      self?.onMain { self?.tokenArrived(data) }
    }
    AppDelegateHook.onError = { [weak self] error in
      self?.onMain { self?.tokenFailed(error) }
    }

    NotificationCenter.default.addObserver(
      self, selector: #selector(didFinishLaunching),
      name: UIApplication.didFinishLaunchingNotification, object: nil)
  }

  override func load(webview: WKWebView) {
    installHookAndRefresh()
  }

  @objc private func didFinishLaunching() {
    installHookAndRefresh()
  }

  /// Installs the AppDelegate hook once, then re-registers if permission is
  /// already granted: Apple asks for registration at every launch because a
  /// token can rotate, and the page compares what arrives with what it last
  /// sent to the server.
  private var refreshedAtLaunch = false
  private func installHookAndRefresh() {
    guard AppDelegateHook.install(), !refreshedAtLaunch else { return }
    refreshedAtLaunch = true
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral:
        DispatchQueue.main.async {
          NSLog("[wherry-push] permission granted at launch; registering")
          UIApplication.shared.registerForRemoteNotifications()
        }
      default:
        break
      }
    }
  }

  // MARK: - Commands

  /// `environment` is reported whether or not a token has been obtained
  /// (hunk H6, native-push-plan.md §16): it is a property of the signed
  /// build, not of the token, and the calls plugin's VoIP registration can
  /// happen before, or without, any alert token.
  ///
  /// No `p256dh` / `auth` here, on purpose (hunk H3): an APNs alert token is
  /// registered without key material, and the VoIP token's keys are the
  /// calls plugin's. Android's answer carries them.
  @objc func status(_ invoke: Invoke) {
    onMain {
      var result: JsonObject = [
        "provider": "apns",
        "configured": true,
        "environment": ApsEnvironment.current,
      ]
      if let token = self.token {
        result["token"] = token
      } else {
        result["token"] = NSNull()
      }
      invoke.resolve(result)
    }
  }

  @objc func register(_ invoke: Invoke) {
    onMain {
      self.pendingRegisters.append(invoke)
      AppDelegateHook.install()
      UIApplication.shared.registerForRemoteNotifications()
      // The plugin lives as long as the app, so a strong capture is fine.
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.registerTimeout) {
        guard let index = self.pendingRegisters.firstIndex(where: { $0 === invoke }) else {
          return
        }
        self.pendingRegisters.remove(at: index)
        NSLog("[wherry-push] register timed out")
        invoke.reject("failed:timeout")
      }
    }
  }

  @objc func unregister(_ invoke: Invoke) {
    // Apple advises against unregisterForRemoteNotifications (a later
    // re-register can be refused for a while); forgetting the token here
    // and on the server is what stops the pushes.
    onMain {
      self.token = nil
      invoke.resolve()
    }
  }

  @objc func takeOpen(_ invoke: Invoke) {
    onMain {
      guard let open = self.pendingOpen else {
        invoke.resolve()
        return
      }
      self.pendingOpen = nil
      var result: JsonObject = ["kind": open.kind]
      if let ref = open.ref {
        result["ref"] = ref
      } else {
        result["ref"] = NSNull()
      }
      invoke.resolve(result)
    }
  }

  @objc func clear(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ClearArgs.self)
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { delivered in
      let ids = delivered.filter { notification in
        let content = notification.request.content
        return content.threadIdentifier == args.ref
          || PushCenterDelegate.wherryFields(content.userInfo).ref == args.ref
      }.map { $0.request.identifier }
      if !ids.isEmpty {
        center.removeDeliveredNotifications(withIdentifiers: ids)
      }
      NSLog("[wherry-push] cleared %ld", ids.count)
      invoke.resolve()
    }
  }

  @objc func setBadge(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetBadgeArgs.self)
    let count = max(0, args.count)
    if #available(iOS 16.0, *) {
      UNUserNotificationCenter.current().setBadgeCount(count) { error in
        if let error = error {
          invoke.reject("failed:\(error.localizedDescription)")
        } else {
          invoke.resolve()
        }
      }
    } else {
      onMain {
        UIApplication.shared.applicationIconBadgeNumber = count
        invoke.resolve()
      }
    }
  }

  @objc func openSettings(_ invoke: Invoke) {
    onMain {
      // The notification page where iOS has one (15.4 and later), else the
      // app's settings page; both are the way out of "blocked".
      var target = UIApplication.openSettingsURLString
      if #available(iOS 15.4, *) {
        target = UIApplicationOpenNotificationSettingsURLString
      }
      if let url = URL(string: target) {
        UIApplication.shared.open(url)
      }
      invoke.resolve()
    }
  }

  // MARK: - Token callbacks

  private func tokenArrived(_ data: Data) {
    let hex = data.map { String(format: "%02x", $0) }.joined()
    let environment = ApsEnvironment.current
    token = hex
    // Never the whole token in a log (plan §4.3's rule for the server,
    // kept here too).
    NSLog(
      "[wherry-push] token %@... (%ld hex, %@)", String(hex.prefix(8)), hex.count, environment)
    let result: JsonObject = ["token": hex, "environment": environment]
    let waiting = pendingRegisters
    pendingRegisters.removeAll()
    for invoke in waiting {
      invoke.resolve(result)
    }
    emit("token", ["token": hex, "environment": environment])
  }

  private func tokenFailed(_ error: Error) {
    NSLog("[wherry-push] token failed: %@", error.localizedDescription)
    let waiting = pendingRegisters
    pendingRegisters.removeAll()
    for invoke in waiting {
      invoke.reject("failed:\(error.localizedDescription)")
    }
  }

  // MARK: - Helpers

  private func emit(_ event: String, _ data: JSObject) {
    trigger(event, data: data)
  }

  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread {
      work()
    } else {
      DispatchQueue.main.async(execute: work)
    }
  }
}

@_cdecl("init_plugin_wherry_push")
func initPlugin() -> Plugin {
  return PushPlugin()
}
