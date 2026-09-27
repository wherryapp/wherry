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
// Why not the plugin's own onPause/onResume: in tauri 2.11.5 nothing calls
// them. `TauriLifecycleObserver` (mobile/android-codegen/TauriActivity.kt) is
// defined and never registered; the only ProcessLifecycleOwner observer is
// wry's `WryLifecycleObserver`, which calls Rust, not PluginManager.
//
// One per process: installed once, holding the WebView weakly.
package app.wherry.calls

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import java.io.File
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

    /** Called by the plugin's constructor and load (any thread). */
    fun install(activity: Activity) {
        val app = activity.application
        main.post {
            if (installed) return@post
            installed = true
            appContext = app.applicationContext
            app.registerActivityLifecycleCallbacks(callbacks)
        }
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

    /** setActive(false): forget it, stop the service, and put the WebView
     *  back where WryActivity left it if the call ended in the background. */
    fun inactive(context: Context) {
        synchronized(lock) {
            wanted = null
            CallService.stop(context)
        }
        main.post { releaseKeptResumed() }
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
            main.removeCallbacks(keepResumedCheck)
            // WryActivity.onResume() resumes the WebView itself.
            keptResumed = false
            retryWanted(activity.applicationContext)
        }

        override fun onActivityPaused(activity: Activity) {
            main.removeCallbacks(keepResumedCheck)
            main.postDelayed(keepResumedCheck, KEEP_RESUMED_DELAY_MS)
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityStarted(activity: Activity) {}
        override fun onActivityStopped(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    }
}
