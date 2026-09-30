// Taps and the foreground flag, observed from process start rather than from
// the plugin.
//
// Why not from PushPlugin alone: Tauri creates plugins only once the webview
// exists, well after the activity. When Android has killed the process in the
// background but kept the task (the ordinary case for an app left alone), a
// tap re-creates MainActivity from its saved record and hands the tap to
// `onNewIntent` before any plugin exists, so PluginManager has nobody to give
// it to and the tap is lost. Seen on the emulator 2026-09-27: START result 2,
// the app opened, and no `open` line. A ContentProvider's onCreate runs when
// the process starts, before any activity, so the callbacks installed here see
// every creation and every new intent.
//
// The same callbacks keep `PushState.resumed`: they are per activity and
// immediate, where Tauri's plugin onResume/onPause come from
// ProcessLifecycleOwner (delayed, and only once a plugin exists). And each
// resumed activity's window focus (`PushState.focused`), because resumed is
// not visible: a ring's full-screen intent resumes MainActivity behind a
// secure keyguard without showing it (the calls plugin's CallLifecycle.inFront
// reads the same on API 36), and a message push must still post then. The two
// plugins share no code (native-gaps-coordination.md §4), so this is a copy
// of the calls plugin's focus watch, not a use of it.

package app.wherry.push

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import java.util.WeakHashMap

internal object PushLifecycle : Application.ActivityLifecycleCallbacks {
  private const val TAG = "wherry-push"
  private const val ACTION_READ = "app.wherry.push.OPENED"

  @Volatile
  var installed = false
    private set
  private var resumedCount = 0

  /** Activities whose window focus is already observed. Main thread. */
  private val watched = WeakHashMap<Activity, Boolean>()

  @Synchronized
  fun install(app: Application) {
    if (installed) return
    installed = true
    app.registerActivityLifecycleCallbacks(this)
  }

  /**
   * Stores a tap on one of our notifications for `take_open`, and tells a
   * loaded plugin. The intent's action is then rewritten, so the same Intent
   * object seen twice (the listener here and the plugin's onNewIntent) opens
   * once; an intent relaunched from recents still carries old extras and is
   * ignored.
   */
  @Synchronized
  fun capture(intent: Intent?, source: String) {
    if (intent == null || intent.action != PushRenderer.ACTION_OPEN) return
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) {
      intent.action = ACTION_READ
      Log.i(TAG, "tap ignored: relaunched from recents")
      return
    }
    val kind = intent.getStringExtra(PushRenderer.EXTRA_KIND) ?: "message"
    val ref = intent.getStringExtra(PushRenderer.EXTRA_REF)
    intent.action = ACTION_READ
    Log.i(TAG, "tap via $source")
    PendingOpen.store(kind, ref)
    PushState.plugin?.emitOpened()
  }

  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
    (activity as? ComponentActivity)?.addOnNewIntentListener { intent -> capture(intent, "new intent") }
    // A re-created activity's intent is the one it was first launched with,
    // possibly a tap already opened in an earlier process; only a fresh
    // creation's intent is new.
    if (savedInstanceState == null) capture(activity.intent, "launch")
  }

  /**
   * Main thread. Focus comes after the resume, and comes back with no new
   * resume when the keyguard or the shade goes away over an activity that
   * stayed resumed, so it is watched rather than read once. Also PushPlugin's
   * late-install fallback, for the activity already resumed then.
   */
  fun watchFocus(activity: Activity) {
    if (watched.containsKey(activity)) return
    val observer = activity.window?.decorView?.viewTreeObserver ?: return
    if (!observer.isAlive) return
    watched[activity] = true
    observer.addOnWindowFocusChangeListener { hasFocus -> PushState.focused = hasFocus }
  }

  @Synchronized
  override fun onActivityResumed(activity: Activity) {
    resumedCount += 1
    PushState.resumed = true
    watchFocus(activity)
    PushState.focused = activity.hasWindowFocus()
  }

  @Synchronized
  override fun onActivityPaused(activity: Activity) {
    resumedCount = maxOf(0, resumedCount - 1)
    PushState.resumed = resumedCount > 0
    if (!PushState.resumed) PushState.focused = false
  }

  override fun onActivityStarted(activity: Activity) {}
  override fun onActivityStopped(activity: Activity) {}
  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
  override fun onActivityDestroyed(activity: Activity) {
    watched.remove(activity)
  }
}

/**
 * Installs PushLifecycle when the process starts (declared in this plugin's
 * manifest, not exported). It serves no data.
 */
class PushInitProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    val app = context?.applicationContext as? Application ?: return false
    PushLifecycle.install(app)
    return true
  }

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
