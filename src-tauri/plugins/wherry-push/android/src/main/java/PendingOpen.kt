// The process-wide state the plugin, the messaging service and the debug
// receiver share: the most recent notification tap (for `take_open`), whether
// the activity is in front, the plugin instance (for events), and the token.

package app.wherry.push

import android.content.Context
import android.util.Log

internal object PendingOpen {
  private const val TAG = "wherry-push"

  class Open(val kind: String, val ref: String?)

  private var pending: Open? = null

  /** Stores a tap; the page takes it once (`take_open`). A cold-start tap
   *  lands before the page listens, which is why it is stored, not sent. */
  @Synchronized
  fun store(kind: String, ref: String?) {
    pending = Open(kind, ref)
    // Row A-46 reads this line.
    Log.i(TAG, "open $kind${if (ref != null) " $ref" else ""}")
  }

  /** The stored tap, consumed exactly once. */
  @Synchronized
  fun take(): Open? {
    val open = pending
    pending = null
    return open
  }
}

internal object PushState {
  private const val PREFS = "wherry-push"
  private const val PREF_TOKEN = "fcm.token"

  /** The activity is resumed: messages, mentions and contacts then post
   *  nothing (the page has them), the same rule as iOS and sw.js. Set by
   *  PushPlugin from the activity's lifecycle; false while no activity is
   *  alive, which is what a service woken for a killed app sees. */
  @Volatile
  var resumed: Boolean = false

  /** The loaded plugin, for the `token` and `received` events. Null while
   *  the app has no webview (a push that woke a killed process). */
  @Volatile
  var plugin: PushPlugin? = null

  /** The last FCM token this install obtained. Kept across launches, so the
   *  page's once-per-launch registration (hunk H5) has one to send from
   *  `status` without asking Firebase again. */
  fun token(context: Context): String? =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREF_TOKEN, null)

  fun setToken(context: Context, token: String?) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
    if (token == null) prefs.remove(PREF_TOKEN) else prefs.putString(PREF_TOKEN, token)
    prefs.apply()
  }
}
