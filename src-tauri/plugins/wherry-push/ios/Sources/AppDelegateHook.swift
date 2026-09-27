// The APNs token callbacks (plan §5.2, mechanism 1).
//
// UIKit hands the device token to the *application delegate*, and the
// delegate is tao's `AppDelegate`, a class tao declares at runtime with
// didFinishLaunching, openURL, continueUserActivity and the lifecycle methods
// and nothing else (tao 0.35.3, platform_impl/ios/view.rs). So this ADDS
// `application:didRegisterForRemoteNotificationsWithDeviceToken:` and
// `application:didFailToRegisterForRemoteNotificationsWithError:` to that
// class with `class_addMethod`. If a future tao declares either, adding fails
// and the hook exchanges the implementation instead and calls through, so
// tao's own handling keeps working. Either way it logs `[wherry-push]`, the
// same fail-soft style as main.mm.
//
// Why the delegate is re-assigned afterwards: UIApplication caches which
// optional methods its delegate answers when the delegate is set, so a
// method added after that is not seen until the delegate is set again.
// Setting it to nil and back refreshes the cache; the hook keeps a strong
// reference first, so the object cannot be released in between.

import ObjectiveC
import UIKit

enum AppDelegateHook {
  static var onToken: ((Data) -> Void)?
  static var onError: ((Error) -> Void)?

  private static var installed = false
  private static var retainedDelegate: UIApplicationDelegate?

  private typealias TokenImp = @convention(c) (AnyObject, Selector, UIApplication, NSData) -> Void
  private typealias ErrorImp = @convention(c) (AnyObject, Selector, UIApplication, NSError) -> Void

  /// Main thread only. Idempotent. Returns false while there is no
  /// application delegate yet (before UIApplicationMain has set one).
  @discardableResult
  static func install() -> Bool {
    if installed { return true }
    guard let delegate = UIApplication.shared.delegate else {
      NSLog("[wherry-push] appdelegate hook deferred: no delegate yet")
      return false
    }
    let cls: AnyClass = type(of: delegate)

    let tokenOutcome = hookToken(cls)
    let errorOutcome = hookError(cls)

    retainedDelegate = delegate
    UIApplication.shared.delegate = nil
    UIApplication.shared.delegate = delegate

    installed = true
    if tokenOutcome == "added" && errorOutcome == "added" {
      NSLog("[wherry-push] appdelegate hook added (class=%@)", NSStringFromClass(cls))
    } else {
      NSLog(
        "[wherry-push] appdelegate hook token=%@ error=%@ (class=%@)",
        tokenOutcome, errorOutcome, NSStringFromClass(cls))
    }
    return true
  }

  private static func hookToken(_ cls: AnyClass) -> String {
    let sel = NSSelectorFromString("application:didRegisterForRemoteNotificationsWithDeviceToken:")
    var original: IMP?
    let block: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { this, app, token in
      AppDelegateHook.onToken?(token as Data)
      if let original = original {
        unsafeBitCast(original, to: TokenImp.self)(this, sel, app, token)
      }
    }
    let imp = imp_implementationWithBlock(block)
    if class_addMethod(cls, sel, imp, "v@:@@") {
      return "added"
    }
    guard let method = class_getInstanceMethod(cls, sel) else {
      return "failed"
    }
    original = method_setImplementation(method, imp)
    return "exchanged"
  }

  private static func hookError(_ cls: AnyClass) -> String {
    let sel = NSSelectorFromString("application:didFailToRegisterForRemoteNotificationsWithError:")
    var original: IMP?
    let block: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { this, app, error in
      AppDelegateHook.onError?(error)
      if let original = original {
        unsafeBitCast(original, to: ErrorImp.self)(this, sel, app, error)
      }
    }
    let imp = imp_implementationWithBlock(block)
    if class_addMethod(cls, sel, imp, "v@:@@") {
      return "added"
    }
    guard let method = class_getInstanceMethod(cls, sel) else {
      return "failed"
    }
    original = method_setImplementation(method, imp)
    return "exchanged"
  }
}
