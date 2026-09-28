// DEBUG BUILDS ONLY (src/debug; a release build has neither this class nor
// its manifest entry). Takes a ring's plaintext fields (phone-calls-plan.md
// §4.2) as string extras from adb and runs them through RingHandler, the
// handler the push plugin's forward reaches (IncomingCallReceiver), so the
// ring, its Answer and Decline and its dismissal are read on the emulator
// with no Firebase project (rows A-59 to A-64):
//
//   adb shell am broadcast -n app.wherry.debug/app.wherry.calls.DebugPushReceiver \
//     --es k call_ring --es call <uuid> --es conv <uuid> --es dev <uuid> \
//     --es exp <unix seconds> [--es dsig <43 base64url>] [--es group true]
//   adb shell am broadcast -n app.wherry.debug/app.wherry.calls.DebugPushReceiver \
//     --es k ring_ended --es call <uuid> --es why cancelled
//
// A ring with no `exp` is given 45 s from now (the ring window), as
// `?devring` does. Exported because adb's shell user sends it; it does
// nothing the push plugin's own debug receiver (`--ez plaintext true`) could
// not, and no release build carries either.
package app.wherry.calls

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class DebugPushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        (context.applicationContext as? Application)?.let { CallLifecycle.install(it) }
        val fields = LinkedHashMap(stringExtras(intent))
        if (fields["k"] == "call_ring" && fields["exp"] == null) {
            fields["exp"] = (System.currentTimeMillis() / 1000 + 45).toString()
        }
        Log.i(TAG, "[wherry] calls: debug push ${fields["k"] ?: "?"}")
        RingHandler.fromPush(context.applicationContext, fields, "debug")
    }
}
