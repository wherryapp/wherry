// The Android half of wherry-push: the commands and events of
// docs/prompts/native-push-plan.md §5.1, over Firebase Cloud Messaging.
// Mechanism only; every decision (when to ask, when to register with the
// server, what a tap opens) is the page's, in client/src/sync/native-push.ts.
//
// The permission prompt is NOT here: @tauri-apps/plugin-notification's
// requestPermission() asks for POST_NOTIFICATIONS on Android 13 and later,
// and its manifest already declares it (§6.2).
//
// A build without google-services.json has no FirebaseApp. It must still
// run (row A-44): `status` then answers `configured: false`, and `register`
// and `unregister`, the two commands that need Firebase, reject with
// "unconfigured". The others are local (the pending tap, delivered
// notifications, the settings page) and work in any build, which is also
// what lets the debug receiver's rows run before Firebase exists.

package app.wherry.push

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

private const val TAG = "wherry-push"
private const val UNCONFIGURED = "unconfigured"

/** How long `register` and `unregister` wait for Firebase: without a
 *  network the task can hang, and a promise that never settles would leave
 *  the page's toggle spinning (the iOS half's `failed:timeout`, the same). */
private const val FIREBASE_TIMEOUT_MS = 30_000L

@InvokeArg
class ClearArgs {
  var ref: String? = null
}

@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())

  override fun load(webView: WebView) {
    super.load(webView)
    PushState.plugin = this
    // Taps and the foreground flag are PushLifecycle's, installed at process
    // start by PushInitProvider, because this plugin exists only once the
    // webview does. Should the provider not have run, install it now; the
    // resumed activity and its launch intent are then taken as they stand.
    if (!PushLifecycle.installed) {
      PushLifecycle.install(activity.application)
      PushState.resumed = activityResumed()
      PushLifecycle.capture(activity.intent, "launch (late)")
    }
    Log.i(TAG, "loaded (resumed=${PushState.resumed})")
    PushRenderer.ensureChannels(activity)
  }

  override fun onNewIntent(intent: Intent) {
    // MainActivity is singleTask: a tap while the app runs arrives here too.
    // PushLifecycle's listener normally saw it first, and a captured intent
    // is marked read, so this opens nothing twice.
    PushLifecycle.capture(intent, "new intent")
  }

  @Suppress("OVERRIDE_DEPRECATION")
  override fun onDestroy() {
    if (PushState.plugin === this) PushState.plugin = null
  }

  // MARK: - Commands

  @Command
  fun status(invoke: Invoke) {
    val configured = firebaseConfigured()
    val ret = JSObject()
    ret.put("provider", "fcm")
    ret.put("configured", configured)
    ret.put("token", (if (configured) PushState.token(activity) else null) ?: JSONObject.NULL)
    // APNs only (§5.1): FCM has one endpoint.
    ret.put("environment", JSONObject.NULL)
    putKeys(ret)
    // Not read by the page today (it infers "blocked" from its own
    // permission answer); here for a row to read.
    ret.put("notificationsEnabled", NotificationManagerCompat.from(activity).areNotificationsEnabled())
    invoke.resolve(ret)
  }

  @Command
  fun register(invoke: Invoke) {
    if (!firebaseConfigured()) {
      invoke.reject(UNCONFIGURED)
      return
    }
    val settled = AtomicBoolean(false)
    val messaging = FirebaseMessaging.getInstance()
    // Auto-init is off in the manifest, so an install that never turned
    // push on never asks Google for a token. Turning it on here also lets
    // Firebase refresh a rotated token by itself (onNewToken).
    messaging.isAutoInitEnabled = true
    // getToken() is deprecated in firebase-messaging 25 in favour of
    // register() + FirebaseMessagingService.onRegistered, an opt-in path
    // (`firebase_messaging_installation_id_enabled`) that is off by default.
    // The default path is this one, which every FCM guide and the server's
    // token handling were written against. Moving is a follow-up.
    @Suppress("DEPRECATION")
    messaging.token.addOnCompleteListener { task ->
      if (!settled.compareAndSet(false, true)) return@addOnCompleteListener
      if (!task.isSuccessful || task.result.isNullOrEmpty()) {
        val reason = task.exception?.javaClass?.simpleName ?: "no token"
        Log.w(TAG, "register failed: $reason")
        invoke.reject("failed:$reason")
        return@addOnCompleteListener
      }
      val token = task.result
      PushState.setToken(activity, token)
      Log.i(TAG, "token ${token.take(8)}... (${token.length} chars)")
      invoke.resolve(tokenAnswer(token))
    }
    main.postDelayed({
      if (settled.compareAndSet(false, true)) {
        Log.w(TAG, "register timed out")
        invoke.reject("failed:timeout")
      }
    }, FIREBASE_TIMEOUT_MS)
  }

  @Command
  fun unregister(invoke: Invoke) {
    if (!firebaseConfigured()) {
      invoke.reject(UNCONFIGURED)
      return
    }
    val settled = AtomicBoolean(false)
    val messaging = FirebaseMessaging.getInstance()
    messaging.isAutoInitEnabled = false
    PushState.setToken(activity, null)
    // A new pair at the next Turn on: nothing encrypted to this one should
    // be readable after the person turned push off.
    RingKeys.forget(activity)
    // The default path's counterpart of getToken() (see `register`).
    @Suppress("DEPRECATION")
    messaging.deleteToken().addOnCompleteListener { task ->
      if (!settled.compareAndSet(false, true)) return@addOnCompleteListener
      if (!task.isSuccessful) {
        // The server already forgot the token (the page unregisters there
        // first), so a token Google still holds wakes nothing.
        Log.w(TAG, "deleteToken failed: ${task.exception?.javaClass?.simpleName}")
      }
      invoke.resolve()
    }
    main.postDelayed({
      if (settled.compareAndSet(false, true)) {
        Log.w(TAG, "deleteToken timed out")
        invoke.resolve()
      }
    }, FIREBASE_TIMEOUT_MS)
  }

  @Command
  fun takeOpen(invoke: Invoke) {
    val open = PendingOpen.take()
    if (open == null) {
      invoke.resolve()
      return
    }
    val ret = JSObject()
    ret.put("kind", open.kind)
    ret.put("ref", open.ref ?: JSONObject.NULL)
    invoke.resolve(ret)
  }

  @Command
  fun clear(invoke: Invoke) {
    val ref = invoke.parseArgs(ClearArgs::class.java).ref
    if (ref.isNullOrEmpty()) {
      invoke.reject("ref is required")
      return
    }
    val count = PushRenderer.clear(activity, ref)
    Log.i(TAG, "cleared $count")
    invoke.resolve()
  }

  @Command
  fun setBadge(invoke: Invoke) {
    // Launchers badge from posted notifications (§5.1); nothing to set.
    invoke.resolve()
  }

  @Command
  fun openSettings(invoke: Invoke) {
    // The app's notification page where Android has one (8.0 and later),
    // else its details page: the way out of "blocked".
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
    } else {
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
        .setData(android.net.Uri.fromParts("package", activity.packageName, null))
    }
    activity.runOnUiThread {
      try {
        activity.startActivity(intent)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("failed:${e.javaClass.simpleName}")
      }
    }
  }

  // MARK: - Events (from WherryMessagingService and PushDispatch)

  internal fun emitToken(token: String) {
    trigger("token", tokenAnswer(token))
  }

  /** A tap was stored; the page calls `take_open`, which keeps it idempotent. */
  internal fun emitOpened() {
    trigger("opened", JSObject())
  }

  internal fun emitReceived(kind: String) {
    val payload = JSObject()
    payload.put("kind", kind)
    trigger("received", payload)
  }

  // MARK: - Helpers

  /** `{ token, environment, p256dh, auth }`: `register`'s answer and the
   *  `token` event. The key material is required on Android (hunk H3): the
   *  server refuses an `fcm` registration without it. */
  private fun tokenAnswer(token: String): JSObject {
    val ret = JSObject()
    ret.put("token", token)
    ret.put("environment", JSONObject.NULL)
    putKeys(ret)
    return ret
  }

  /** `p256dh` and `auth` in the server's spelling: unpadded base64url, 87
   *  and 22 characters. Omitted only if the Keystore is unusable, which the
   *  page then reports as a failed Turn on rather than sending a 400. */
  private fun putKeys(target: JSObject) {
    val keys = RingKeys.load(activity) ?: return
    target.put("p256dh", keys.p256dh)
    target.put("auth", keys.authText)
  }

  private fun firebaseConfigured(): Boolean =
    try {
      FirebaseApp.getApps(activity).isNotEmpty()
    } catch (e: Exception) {
      false
    }

  private fun activityResumed(): Boolean {
    val owner = activity as? androidx.lifecycle.LifecycleOwner ?: return false
    return owner.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)
  }
}
