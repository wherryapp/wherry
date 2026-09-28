// The ring's three ways into the activity (plan §6.2), and what the activity
// may do over the lock screen because of them.
//
//   show     the full-screen intent: the system launches it by itself when
//            the screen is off or locked. It brings the page up over the
//            keyguard, where the sheet rings; it answers nothing.
//   answer   the notification's Answer: a PendingIntent straight to the
//            activity, never a trampoline through a receiver (Android 12+
//            forbids one from a notification). The press reaches the page as
//            an `answer` action, live or queued.
//   decline  the fallback Decline, when there is neither a decline token nor
//            a page listening to carry the press (RingHandler.declineIntent).
//
// Captured from process start (CallsInitProvider installs CallLifecycle,
// which hands every created activity's launch intent and every new intent
// here), not from the plugin: a tap that re-creates the activity after a
// background kill reaches `onNewIntent` before any plugin exists, and
// PluginManager drops it (CLAUDE.md, "An Android Tauri plugin exists only
// once the webview does"; native-push-plan §16, P3-4 item 8).
//
// Over the lock screen. `setShowWhenLocked` and `setTurnScreenOn` are set on
// the activity for these launches only, and cleared when the ring ends
// without an answer here, when the call it led to ends
// (CallLifecycle.inactive), or 60 s on with no call up (`settle`): the whole page is on the other side of them, not
// a call screen, so they are held no longer than the call needs.
//
// And only when the keyguard is not secure (a swipe, or none). Behind a PIN,
// pattern or password the activity is never shown over it: the page would
// hand every conversation to whoever holds the ringing phone. There the
// system wakes the screen for the full-screen intent, the lock screen shows
// the ring with its Answer and Decline, Decline works without unlocking (a
// broadcast), and Answer asks for the unlock first, because SystemUI dismisses
// the keyguard before it starts an activity that does not declare itself
// shown-when-locked in its manifest (MainActivity does not).
package app.wherry.calls

import android.app.Activity
import android.app.KeyguardManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.WindowManager
import java.lang.ref.WeakReference

internal object RingLaunch {
    const val SHOW = "show"
    const val ANSWER = "answer"
    const val DECLINE = "decline"

    private const val ACTION_RING = "app.wherry.calls.RING"
    /** What a captured intent's action becomes, so the same Intent seen twice
     *  (a re-created activity keeps its launch intent) acts once. */
    private const val ACTION_READ = "app.wherry.calls.RING_READ"
    private const val EXTRA_KIND = "app.wherry.calls.extra.RING_KIND"
    private const val EXTRA_CALL_ID = "app.wherry.calls.extra.CALL_ID"
    private const val EXTRA_CONVERSATION_ID = "app.wherry.calls.extra.CONVERSATION_ID"

    private val main = Handler(Looper.getMainLooper())

    /** The activity shown over the keyguard, for which call, and whether that
     *  call was answered here (then it stays until the call ends). Main
     *  thread only. */
    private class OverLock(val activity: WeakReference<Activity>, val callId: String, var answered: Boolean)
    private var overLock: OverLock? = null

    /** An explicit intent to this app's launch activity (MainActivity), one
     *  PendingIntent per kind and call. */
    fun pendingIntent(context: Context, kind: String, ring: Ring): PendingIntent? {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        launch.action = ACTION_RING
        launch.putExtra(EXTRA_KIND, kind)
            .putExtra(EXTRA_CALL_ID, ring.callId)
            .putExtra(EXTRA_CONVERSATION_ID, ring.conversationId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(
            context,
            (kind + ring.callId).hashCode(),
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    /** From CallLifecycle: a created activity's launch intent, or a new one.
     *  Main thread. */
    fun capture(activity: Activity, intent: Intent?, source: String) {
        if (intent == null || intent.action != ACTION_RING) return
        intent.action = ACTION_READ
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) {
            Log.i(TAG, "[wherry] calls: ring launch ignored: relaunched from recents")
            return
        }
        val kind = intent.getStringExtra(EXTRA_KIND)
        val callId = intent.getStringExtra(EXTRA_CALL_ID)
        if (!Ids.isId(callId)) return
        callId!!
        val conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID)
        val context = activity.applicationContext
        Log.i(TAG, "[wherry] calls: ring launch $kind call=$callId via $source")
        when (kind) {
            SHOW -> showOverLock(activity, callId, answered = false)
            ANSWER -> {
                showOverLock(activity, callId, answered = true)
                RingHandler.end(context, callId, "answered", "notification")
                deliver(ANSWER, callId, conversationId)
            }
            DECLINE -> {
                RingHandler.end(context, callId, "declined", "notification")
                deliver(DECLINE, callId, conversationId)
            }
        }
    }

    private fun deliver(kind: String, callId: String, conversationId: String?) {
        val live = CallActions.deliver(CallAction(kind, callId, conversationId, System.currentTimeMillis()))
        Log.i(TAG, "[wherry] calls: $kind pressed call=$callId (${if (live) "delivered" else "queued"})")
    }

    private fun showOverLock(activity: Activity, callId: String, answered: Boolean) {
        val current = overLock
        if (current != null && current.callId == callId && current.activity.get() === activity) {
            current.answered = current.answered || answered
            return
        }
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        if (keyguard == null || keyguard.isKeyguardSecure) {
            Log.i(TAG, "[wherry] calls: not shown over the lock screen: the keyguard is secure")
            return
        }
        setOverLock(activity, true)
        overLock = OverLock(WeakReference(activity), callId, answered)
        main.removeCallbacks(settle)
        main.postDelayed(settle, SETTLE_MS)
        Log.i(TAG, "[wherry] calls: shown over the lock screen for call=$callId")
    }

    /** Past the ring window (45 s) with some margin: by then the ring has
     *  either led to a call or it never will. */
    private const val SETTLE_MS = 60_000L

    /** The backstop for the two ends that may never be reported: a ring that
     *  timed out with no `ring_ended` and no page to say so, and an Answer the
     *  page dropped (the call was over by the time it drained the press), so
     *  no setActive ever follows. Either would leave the whole page shown
     *  over the lock screen from then on. A call that is up keeps it; its
     *  setActive(false) releases it (callEnded). */
    private val settle = Runnable {
        if (overLock != null && !CallLifecycle.hasCall()) release("no call followed the ring")
    }

    /** RingHandler.end: a ring answered here keeps the activity over the lock
     *  screen for its call; any other end takes it away. Any thread. */
    fun ringEnded(callId: String, answered: Boolean) {
        main.post {
            val current = overLock ?: return@post
            if (current.callId != callId) return@post
            if (answered) {
                current.answered = true
            } else if (!current.answered) {
                release("the ring ended")
            }
        }
    }

    /** The call is over (setActive(false)): nothing is shown over the lock
     *  screen any more. Any thread. */
    fun callEnded() {
        main.post { if (overLock != null) release("the call ended") }
    }

    /** The activity went away. Main thread. */
    fun destroyed(activity: Activity) {
        if (overLock?.activity?.get() === activity) overLock = null
    }

    private fun release(why: String) {
        val current = overLock ?: return
        overLock = null
        val activity = current.activity.get() ?: return
        setOverLock(activity, false)
        Log.i(TAG, "[wherry] calls: no longer shown over the lock screen ($why)")
    }

    private fun setOverLock(activity: Activity, on: Boolean) {
        if (Build.VERSION.SDK_INT >= 27) {
            activity.setShowWhenLocked(on)
            activity.setTurnScreenOn(on)
        } else {
            @Suppress("DEPRECATION")
            val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            if (on) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
        }
    }
}
