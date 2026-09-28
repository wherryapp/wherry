// The ring from the push (coordination §4, *Android*; plan §3 R9): the push
// plugin's one FirebaseMessagingService opens an encrypted `call_ring` or
// `ring_ended` and sends its plaintext fields here as an explicit broadcast
// (`app.wherry.calls.PUSH`, `setPackage(packageName)`), each a string. Not
// exported, so nothing outside this app can send it; it holds no key and
// does no crypto. The push plugin forwards only when this receiver resolves,
// and otherwise shows its generic "Incoming call" itself.
//
// Also installs the lifecycle callbacks, in case this runs in a process the
// provider has not (it always has: providers start before receivers).
package app.wherry.calls

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class IncomingCallReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_PUSH = "app.wherry.calls.PUSH"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_PUSH) return
        (context.applicationContext as? Application)?.let { CallLifecycle.install(it) }
        RingHandler.fromPush(context.applicationContext, stringExtras(intent), "push")
    }
}

/** A broadcast's extras as the string map a push's data is. */
internal fun stringExtras(intent: Intent): Map<String, String> {
    val extras = intent.extras ?: return emptyMap()
    val out = LinkedHashMap<String, String>()
    for (key in extras.keySet()) {
        @Suppress("DEPRECATION")
        val value = extras.get(key)
        if (value != null) out[key] = value.toString()
    }
    return out
}
