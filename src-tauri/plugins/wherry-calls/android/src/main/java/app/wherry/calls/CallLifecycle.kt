// What `setActive` needs to outlive the command that said it (plan §6.1),
// on the activity's lifecycle through Application.ActivityLifecycleCallbacks:
//
//  1. The call the page last wanted, so that a service refused for want of
//     RECORD_AUDIO starts as soon as the grant arrives. The page asks for the
//     microphone last, after `connected` (session.ts), and sends no
//     setActive after that: the report does not change at `connected`. So
//     on API 34+ a first call's two setActive(true)s both come before the
//     grant, and nothing would ever start the service. The permission dialog
//     is another app's activity, so the grant always ends with this app's
//     activity resuming, which is when this retries. The same retry covers a
//     start refused because the app had already left the front.
//
//  2. Keep-resumed (built, off): measured by A-57 before it is ever on. See
//     below.
//
//  3. A2's ring (plan §6.2): whether an activity is in front (RingHandler
//     posts no ring while one is: the page's sheet rings; and it withdraws,
//     when one comes to the front, a posted ring the page holds, posting it
//     again when the person leaves), and the ring's launches into the
//     activity (RingLaunch), from every created activity's launch intent and
//     every new intent.
//
// Why not the plugin's own onPause/onResume: in tauri 2.11.5 nothing calls
// them. `TauriLifecycleObserver` (mobile/android-codegen/TauriActivity.kt) is
// defined and never registered; the only ProcessLifecycleOwner observer is
// wry's `WryLifecycleObserver`, which calls Rust, not PluginManager.
//
// One per process, installed at process start by CallsInitProvider (a ring
// pushed to a killed app runs with no plugin, and an Answer that re-creates
// the activity reaches onNewIntent before any plugin exists), and again,
// harmlessly, by the plugin. Holds the WebView weakly.
package app.wherry.calls

import android.app.Activity
import android.app.Application
import android.app.KeyguardManager
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.core.app.OnNewIntentProvider
import androidx.core.util.Consumer
import java.io.File
import java.util.WeakHashMap
import java.lang.ref.WeakReference

/** Debug builds only: a file in the app's own files directory that turns
 *  on keep-resumed (below). `adb shell run-as app.wherry.debug touch
 *  files/wherry-keep-resumed` to set it, `rm` to clear it. */
private const val KEEP_RESUMED_FLAG = "wherry-keep-resumed"

/** How long after the activity's pause keep-resumed looks. It must run after
 *  WryActivity.onPause() has paused the WebView, which happens after
 *  `onActivityPaused` returns (inside the same onPause, after its
 *  super.onPause()); any delay does that. 700 ms is ProcessLifecycleOwner's,
 *  so a rotation or a quick dialog, which resumes within it, is not
 *  treated as leaving. */
private const val KEEP_RESUMED_DELAY_MS = 700L

/** How long after the activity's pause, or its window's loss of focus, a
 *  withdrawn ring is posted again if the page has not come back:
 *  ProcessLifecycleOwner's 700 ms, for the same reason (a rotation or a
 *  quick dialog is not leaving). */
private const val LEFT_DELAY_MS = 700L

object CallLifecycle {

    /** What setActive(true) last said. */
    private data class Wanted(val callId: String?, val label: String?, val audioOnly: Boolean)

    private val lock = Any()
    private var wanted: Wanted? = null // under lock

    private val main = Handler(Looper.getMainLooper())

    // Main thread only from here down.
    private var installed = false
    private var webView: WeakReference<WebView>? = null
    private var keptResumed = false
    private var appContext: Context? = null
    private var resumedCount = 0
    /** Activities whose new intents are already observed. */
    private val adopted = WeakHashMap<Activity, Boolean>()

    /** An activity of this app is resumed: a ring then goes to the page's
     *  sheet, not to a notification (plan §2.7). False while no activity is
     *  alive, which is what a ring pushed to a killed app sees. */
    @Volatile
    var resumed: Boolean = false
        private set

    /** The resumed activity's window has input focus, from the window-focus
     *  listener each activity is given on its first resume. */
    @Volatile
    private var focused = false

    /** Activities whose window focus is already observed. */
    private val watched = WeakHashMap<Activity, Boolean>()

    /**
     * The person can see the page and hear its tone: an activity is resumed
     * **and its window has focus**. The page's own test is the same one
     * (`windowIsFocused()`, `document.hasFocus()`), and pageRingDuties plays
     * the sheet's tone only while it holds, so a ring is left to the page
     * exactly when the page will ring it. Resumed alone is not enough: a
     * full-screen intent resumes the activity behind a secure keyguard
     * without showing it (read on API 36: `ResumedActivity` MainActivity
     * with `isKeyguardShowing=true`), and there the lock screen's ring must
     * stay. Any thread.
     */
    fun inFront(): Boolean = resumed && focused

    /** CallsInitProvider, at process start (on the main thread). */
    fun install(app: Application) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { install(app) }
            return
        }
        if (installed) return
        installed = true
        appContext = app.applicationContext
        app.registerActivityLifecycleCallbacks(callbacks)
    }

    /** Main thread. Focus comes after the resume, and it comes back with no
     *  new resume when the keyguard or the shade goes away over an activity
     *  that stayed resumed, so it is watched rather than read once. */
    private fun watchFocus(activity: Activity) {
        if (watched.containsKey(activity)) return
        val observer = activity.window?.decorView?.viewTreeObserver ?: return
        if (!observer.isAlive) return
        watched[activity] = true
        observer.addOnWindowFocusChangeListener { hasFocus ->
            focused = hasFocus
            if (hasFocus) {
                cameToFront(activity.applicationContext)
            } else {
                main.removeCallbacks(leftCheck)
                main.postDelayed(leftCheck, LEFT_DELAY_MS)
            }
        }
    }

    /** A2: the page is in front now; a posted ring it holds is withdrawn. */
    private fun cameToFront(context: Context) {
        main.removeCallbacks(leftCheck)
        if (inFront()) RingHandler.pageInFront(context)
    }

    private val leftCheck = Runnable {
        val context = appContext ?: return@Runnable
        if (!inFront()) RingHandler.left(context)
    }

    /** The plugin's constructor (any thread). The provider has normally run
     *  long before; this covers a process without it. The activity already
     *  exists then, so its new intents are observed from here and its launch
     *  intent is read now (a no-op when the provider adopted it). */
    fun install(activity: Activity) {
        install(activity.application)
        main.post { adopt(activity, null) }
    }

    private fun adopt(activity: Activity, savedInstanceState: Bundle?) {
        if (adopted.containsKey(activity)) return
        adopted[activity] = true
        (activity as? OnNewIntentProvider)?.addOnNewIntentListener(
            Consumer { intent -> RingLaunch.capture(activity, intent, "new intent") },
        )
        // A re-created activity's intent is the one it was first launched
        // with, possibly a press already carried out in an earlier process.
        if (savedInstanceState == null) RingLaunch.capture(activity, activity.intent, "launch")
    }

    fun attachWebView(view: WebView) {
        main.post { webView = WeakReference(view) }
    }

    /** setActive(true): remember the call, and start or update the service. */
    fun active(context: Context, callId: String?, label: String?, audioOnly: Boolean) {
        synchronized(lock) {
            wanted = Wanted(callId, label, audioOnly)
            CallService.update(context, callId, label, audioOnly)
        }
    }

    /** The page has a call up (its last setActive was true). */
    fun hasCall(): Boolean = synchronized(lock) { wanted != null }

    /** setActive(false): forget it, stop the service, and put the WebView
     *  back where WryActivity left it if the call ended in the background. */
    fun inactive(context: Context) {
        synchronized(lock) {
            wanted = null
            CallService.stop(context)
        }
        main.post { releaseKeptResumed() }
        RingLaunch.callEnded()
    }

    // -- 1. the retry -----------------------------------------------------

    private fun retryWanted(context: Context) {
        synchronized(lock) {
            val call = wanted ?: return
            // Running, or a start already on its way (setActive a moment
            // before this resume): nothing to retry.
            if (CallService.running || CallService.starting) return
            // Quietly: without the grant, update() would log the refusal again
            // on every resume of a call that never asks for the microphone.
            if (!CallService.microphoneGranted(context)) return
            Log.i(TAG, "[wherry] calls: starting the service on resume (the grant came after setActive)")
            CallService.update(context, call.callId, call.label, call.audioOnly)
        }
    }

    // -- 2. keep-resumed (plan §6.1, measured before it is ever on) --------
    //
    // wry's WryActivity.onPause() calls WebView.onPause(), which may be what
    // stops a live call's media in the background (A-55). Row A-57 reads the
    // call with the service alone first; only if that fails is it read again
    // with this on, and only a passing second reading justifies turning it
    // on for everybody. Until then it is off, and in a release build it
    // cannot be turned on at all.

    private fun keepResumedWanted(context: Context): Boolean =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 &&
            File(context.filesDir, KEEP_RESUMED_FLAG).exists()

    private val keepResumedCheck = Runnable {
        val context = appContext ?: return@Runnable
        if (!CallService.running || !keepResumedWanted(context)) return@Runnable
        val view = webView?.get() ?: return@Runnable
        view.onResume()
        keptResumed = true
        Log.i(TAG, "[wherry] calls: webview kept resumed in the background (debug flag)")
    }

    private fun releaseKeptResumed() {
        if (!keptResumed) return
        keptResumed = false
        webView?.get()?.onPause()
        Log.i(TAG, "[wherry] calls: webview paused again after the call")
    }

    private val callbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityResumed(activity: Activity) {
            resumedCount += 1
            resumed = true
            main.removeCallbacks(keepResumedCheck)
            // WryActivity.onResume() resumes the WebView itself.
            keptResumed = false
            retryWanted(activity.applicationContext)
            watchFocus(activity)
            focused = activity.hasWindowFocus()
            if (focused) {
                cameToFront(activity.applicationContext)
            } else {
                val keyguard = activity.getSystemService(KeyguardManager::class.java)
                if (keyguard?.isKeyguardLocked == true) {
                    Log.i(TAG, "[wherry] calls: resumed behind the lock screen: rings stay posted")
                }
            }
        }

        override fun onActivityPaused(activity: Activity) {
            resumedCount = maxOf(0, resumedCount - 1)
            resumed = resumedCount > 0
            if (!resumed) focused = false
            main.removeCallbacks(keepResumedCheck)
            main.postDelayed(keepResumedCheck, KEEP_RESUMED_DELAY_MS)
            main.removeCallbacks(leftCheck)
            main.postDelayed(leftCheck, LEFT_DELAY_MS)
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
            adopt(activity, savedInstanceState)
        }

        override fun onActivityDestroyed(activity: Activity) {
            adopted.remove(activity)
            watched.remove(activity)
            RingLaunch.destroyed(activity)
        }

        override fun onActivityStarted(activity: Activity) {}
        override fun onActivityStopped(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    }
}
