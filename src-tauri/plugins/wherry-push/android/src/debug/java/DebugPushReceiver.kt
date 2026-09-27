// DEBUG BUILDS ONLY (src/debug; a release build has neither this class nor
// its manifest entry). Takes a push's data map as string extras from adb and
// runs it through the same PushDispatch a real FCM message takes, so the
// rendering, the foreground rule, the tap and the call-kind forward can be
// verified before google-services.json exists (native-push-plan.md §6.4):
//
//   adb shell am broadcast -n app.wherry.debug/app.wherry.push.DebugPushReceiver \
//     --es k message --es r <ref>
//
// A ring is sent encrypted (`--es k call_ring --es e <base64url body>`, the
// body made by the server's encryptFor for this install's `status` keys), and
// is then treated exactly as an FCM one. A ring's plaintext fields are
// refused as `unencrypted`, as they are from FCM, unless the broadcast also
// carries `--ez plaintext true`: the one way to forward a plaintext ring,
// which exists only in this debug-only receiver (row A-52; RingGate).

package app.wherry.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class DebugPushReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val extras = intent.extras ?: return
    val plaintext = intent.getBooleanExtra(PLAINTEXT, false)
    val data = LinkedHashMap<String, String>()
    for (key in extras.keySet()) {
      if (key == PLAINTEXT) continue
      @Suppress("DEPRECATION")
      val value = extras.get(key)
      if (value != null) data[key] = value.toString()
    }
    Log.i("wherry-push", "debug push ${data["k"] ?: "?"}${if (plaintext) " (plaintext allowed)" else ""}")
    PushDispatch.handle(context.applicationContext, data, allowPlaintextRing = plaintext)
  }

  private companion object {
    const val PLAINTEXT = "plaintext"
  }
}
