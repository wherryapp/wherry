// Takes the call notifications' buttons: A1's Hang up (the ongoing call) and
// A2's Decline (the ring). Not exported: only this app's own explicit,
// immutable PendingIntents reach it.
//
// A broadcast rather than an activity: neither press may bring the app to the
// front. Answer is a PendingIntent straight to the activity (RingLaunch),
// never a trampoline through here, which Android 12+ forbids.
//
// Decline (plan §6.2): the ring notification goes at once; then, on a
// background thread under goAsync, the signed decline (§2.5) when the ring
// carried a token, so it works with the app killed and without opening it.
// A ring with no token (the page reported it; or the server has no
// CALL_ACTION_SECRET) was given this receiver only while a page listened
// (RingHandler.declineIntent): the press goes to the page, which declines
// through its session. A signed decline that fails (no network, 503) is also
// handed to the page, live or queued, so it declines when it next can.
package app.wherry.calls

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class CallActionReceiver : BroadcastReceiver() {

    companion object {
        private const val ACTION_PREFIX = "app.wherry.calls.action."
        private const val EXTRA_CALL_ID = "app.wherry.calls.extra.CALL_ID"
        private const val EXTRA_CONVERSATION_ID = "app.wherry.calls.extra.CONVERSATION_ID"
        private const val EXTRA_DEVICE_ID = "app.wherry.calls.extra.DEVICE_ID"
        private const val EXTRA_EXP = "app.wherry.calls.extra.EXP"
        private const val EXTRA_SIG = "app.wherry.calls.extra.SIG"

        /** Hang up: one PendingIntent (the request code is the kind), refreshed
         *  with the current call's id whenever the notification is rebuilt. */
        fun pendingIntent(
            context: Context,
            kind: String,
            callId: String?,
            conversationId: String? = null,
        ): PendingIntent = PendingIntent.getBroadcast(
            context,
            kind.hashCode(),
            intent(context, kind, callId, conversationId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        /** Decline: one PendingIntent per call, since two rings can be posted
         *  at once and each Decline must name its own. The token rides in the
         *  PendingIntent, not in memory, so a press after the process was
         *  killed still carries it. */
        internal fun declineIntent(context: Context, ring: Ring, signed: Boolean): PendingIntent {
            val intent = intent(context, CallActions.DECLINE, ring.callId, ring.conversationId)
            if (signed) {
                intent.putExtra(EXTRA_DEVICE_ID, ring.deviceId)
                    .putExtra(EXTRA_EXP, ring.exp)
                    .putExtra(EXTRA_SIG, ring.dsig)
            }
            return PendingIntent.getBroadcast(
                context,
                (CallActions.DECLINE + ring.callId).hashCode(),
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        private fun intent(context: Context, kind: String, callId: String?, conversationId: String?): Intent =
            Intent(context, CallActionReceiver::class.java)
                .setAction(ACTION_PREFIX + kind)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(EXTRA_CONVERSATION_ID, conversationId)
    }

    override fun onReceive(context: Context, intent: Intent) {
        val kind = intent.action?.removePrefix(ACTION_PREFIX) ?: return
        if (kind != CallActions.HANGUP && kind != CallActions.DECLINE) {
            Log.w(TAG, "[wherry] calls: unknown notification action $kind")
            return
        }
        // No id yet (the join had not been given one when the notification
        // was built): the page drops a press without one (readAction), so
        // it is logged and goes no further.
        val callId = intent.getStringExtra(EXTRA_CALL_ID)
        if (callId.isNullOrEmpty()) {
            Log.w(TAG, "[wherry] calls: $kind pressed before the call had an id")
            return
        }
        val action = CallAction(
            kind = kind,
            callId = callId,
            conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID),
            at = System.currentTimeMillis(),
        )
        if (kind == CallActions.HANGUP) {
            deliver(action)
            return
        }
        decline(context.applicationContext, intent, action)
    }

    private fun deliver(action: CallAction) {
        val live = CallActions.deliver(action)
        Log.i(TAG, "[wherry] calls: ${action.kind} pressed call=${action.callId} (${if (live) "delivered" else "queued"})")
    }

    private fun decline(context: Context, intent: Intent, action: CallAction) {
        val callId = action.callId
        RingHandler.end(context, callId, "declined", "notification")
        val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID)
        val exp = intent.getLongExtra(EXTRA_EXP, 0L)
        val sig = intent.getStringExtra(EXTRA_SIG)
        val apiBase = CallsStore.apiBase(context)
        if (deviceId == null || sig == null || apiBase == null) {
            // No token: the page carries it (it was listening when the ring
            // was posted).
            deliver(action)
            return
        }
        val pending = goAsync()
        Thread {
            try {
                val status = SignedDecline.post(apiBase, callId, deviceId, exp, sig)
                if (status == 204) {
                    Log.i(TAG, "[wherry] calls: decline pressed call=$callId (signed decline sent, 204)")
                } else {
                    Log.w(TAG, "[wherry] calls: signed decline answered ${status ?: "nothing"}; the page carries the press")
                    deliver(action)
                }
            } finally {
                pending.finish()
            }
        }.start()
    }
}
