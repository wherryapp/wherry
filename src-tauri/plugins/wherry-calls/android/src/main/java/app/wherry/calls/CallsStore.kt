// What the page tells the plugin that must outlive the page (plan §5.2):
// `configure`'s API base and device id, so a Decline pressed while the app is
// not running knows where `decline-signed` goes, and `setLabels`' cache, so a
// ring pushed to a killed app is named (the push carries no name, decision
// D1). App-private SharedPreferences: nothing here leaves the phone.
//
// The labels are conversation names the phone already shows in its list,
// never content (rule 1). `resetAccount` forgets them at sign-out; the
// configure values stay, since they are the device's (phone-calls.ts).
package app.wherry.calls

import android.content.Context
import android.util.Log
import org.json.JSONObject

internal object CallsStore {
    private const val PREFS = "wherry-calls"
    private const val KEY_API_BASE = "apiBase"
    private const val KEY_DEVICE_ID = "deviceId"
    private const val KEY_LABELS = "labels"

    /** phone-rules.ts's MAX_LABELS: the page never sends more. */
    private const val MAX_LABELS = 500

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Only an absolute http(s) base is kept: native HTTP has no page origin
     *  to resolve a relative one against (phone-rules.ts's nativeApiBase). */
    fun configure(context: Context, apiBase: String?, deviceId: String?) {
        val base = apiBase?.trim()?.trimEnd('/')?.takeIf { ABSOLUTE.matches(it) }
        val device = deviceId?.takeIf { Ids.isId(it) }
        prefs(context).edit()
            .apply { if (base != null) putString(KEY_API_BASE, base) else remove(KEY_API_BASE) }
            .apply { if (device != null) putString(KEY_DEVICE_ID, device) else remove(KEY_DEVICE_ID) }
            .apply()
        Log.i(TAG, "[wherry] calls: configured (apiBase ${if (base != null) "set" else "unset"}, deviceId ${if (device != null) "set" else "unset"})")
    }

    fun apiBase(context: Context): String? = prefs(context).getString(KEY_API_BASE, null)

    fun deviceId(context: Context): String? = prefs(context).getString(KEY_DEVICE_ID, null)

    fun setLabels(context: Context, labels: Map<String, String>) {
        val json = JSONObject()
        var count = 0
        for ((id, name) in labels) {
            if (count >= MAX_LABELS) break
            if (!Ids.isId(id) || name.isBlank()) continue
            json.put(id, name)
            count += 1
        }
        prefs(context).edit().putString(KEY_LABELS, json.toString()).apply()
        Log.i(TAG, "[wherry] calls: labels set ($count)")
    }

    fun label(context: Context, conversationId: String?): String? {
        if (conversationId == null) return null
        val raw = prefs(context).getString(KEY_LABELS, null) ?: return null
        return try {
            JSONObject(raw).optString(conversationId, "").takeIf { it.isNotBlank() }
        } catch (e: Exception) {
            null
        }
    }

    fun clearLabels(context: Context) {
        prefs(context).edit().remove(KEY_LABELS).apply()
    }

    private val ABSOLUTE = Regex("^https?://[^/].*$", RegexOption.IGNORE_CASE)
}

/** The shapes of the ids that reach a URL path or a request body. */
internal object Ids {
    /** A UUID (calls, conversations and devices are UUIDv7). */
    private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    /** HMAC-SHA256 in unpadded base64url: 43 characters (api.md). */
    private val SIG = Regex("^[A-Za-z0-9_-]{43}$")

    fun isId(value: String?): Boolean = value != null && UUID.matches(value)

    fun isSig(value: String?): Boolean = value != null && SIG.matches(value)
}
