// Takes the call notifications' buttons (A1: the ongoing call's Hang up)
// and hands the press to the page through CallActions. Not exported: only
// this app's own explicit, immutable PendingIntents reach it.
//
// A broadcast rather than an activity: a Hang up must not bring the app to
// the front. A2 adds Decline here (§6.2: goAsync and the signed decline);
// Answer is a PendingIntent straight to the activity, never a trampoline
// through a receiver, which Android 12+ forbids.
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

        /** One PendingIntent per kind (the request code), refreshed with the
         *  current call's id whenever the notification is rebuilt. */
        fun pendingIntent(
            context: Context,
            kind: String,
            callId: String?,
            conversationId: String? = null,
        ): PendingIntent {
            val intent = Intent(context, CallActionReceiver::class.java)
                .setAction(ACTION_PREFIX + kind)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(EXTRA_CONVERSATION_ID, conversationId)
            return PendingIntent.getBroadcast(
                context,
                kind.hashCode(),
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        val kind = intent.action?.removePrefix(ACTION_PREFIX) ?: return
        if (kind != CallActions.HANGUP) {
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
        val live = CallActions.deliver(action)
        Log.i(TAG, "[wherry] calls: $kind pressed call=$callId (${if (live) "delivered" else "queued"})")
    }
}
