// What the page tells the plugin that must outlive the page (plan §5.2):
// `configure`'s API base and device id, so a Decline pressed while the app is
// not running knows where `decline-signed` goes, and `setLabels`' cache, so a
// ring pushed to a killed app is named (the push carries no name, decision
// D1).
//
// Where it lives, and why: one small JSON file under `noBackupFilesDir`,
// which Android's Auto Backup and device-to-device transfer never copy. The
// app's manifest leaves `allowBackup` at its default (true), so anything in
// SharedPreferences or `filesDir` travels into a Google cloud backup (not
// client-side encrypted on a phone with no screen lock) and comes back on a
// restore before anyone signs in. The labels are conversation names (D1 keeps
// them out of the push for exactly that reason), and the device id is this
// device's, not a restored phone's, so neither may travel. wherry-push's
// RingKeys.kt meets the same default by sealing its key under the Keystore;
// here nothing needs sealing, only not copying.
//
// The labels are conversation names the phone already shows in its list,
// never content (rule 1). `resetAccount` forgets them at sign-out; the
// configure values stay, since they are the device's (phone-calls.ts).
package app.wherry.calls

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException

internal object CallsStore {
    private const val FILE = "wherry-calls.json"
    /** A2's first cut kept these in SharedPreferences (backed up); removed
     *  on first use so a debug install from then does not keep a copy. */
    private const val LEGACY_PREFS = "wherry-calls"

    private const val KEY_API_BASE = "apiBase"
    private const val KEY_DEVICE_ID = "deviceId"
    private const val KEY_LABELS = "labels"

    /** phone-rules.ts's MAX_LABELS: the page never sends more. */
    private const val MAX_LABELS = 500

    /** The file's contents, read once per process. Under this object's
     *  lock. */
    private var cached: JSONObject? = null

    private fun file(context: Context) =
        AtomicFile(File(context.applicationContext.noBackupFilesDir, FILE))

    @Synchronized
    private fun read(context: Context): JSONObject {
        cached?.let { return it }
        val app = context.applicationContext
        val json = try {
            JSONObject(String(file(app).readFully(), Charsets.UTF_8))
        } catch (e: FileNotFoundException) {
            JSONObject()
        } catch (e: Exception) {
            Log.w(TAG, "[wherry] calls: store unreadable, starting empty: ${e.javaClass.simpleName}")
            JSONObject()
        }
        try {
            app.deleteSharedPreferences(LEGACY_PREFS)
        } catch (e: Exception) {
            // Nothing to remove, or it cannot be: it holds nothing the file
            // does not.
        }
        cached = json
        return json
    }

    /** Applies [change] to a copy and writes it whole (AtomicFile: a crash
     *  mid-write leaves the previous file). */
    @Synchronized
    private fun write(context: Context, change: (JSONObject) -> Unit) {
        val next = JSONObject(read(context).toString())
        change(next)
        val file = file(context)
        val out = try {
            file.startWrite()
        } catch (e: Exception) {
            Log.w(TAG, "[wherry] calls: store not written: ${e.javaClass.simpleName}")
            cached = next
            return
        }
        try {
            out.write(next.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            Log.w(TAG, "[wherry] calls: store not written: ${e.javaClass.simpleName}")
        }
        cached = next
    }

    /** Only an absolute http(s) base is kept: native HTTP has no page origin
     *  to resolve a relative one against (phone-rules.ts's nativeApiBase). */
    fun configure(context: Context, apiBase: String?, deviceId: String?) {
        val base = apiBase?.trim()?.trimEnd('/')?.takeIf { ABSOLUTE.matches(it) }
        val device = deviceId?.takeIf { Ids.isId(it) }
        write(context) { json ->
            if (base != null) json.put(KEY_API_BASE, base) else json.remove(KEY_API_BASE)
            if (device != null) json.put(KEY_DEVICE_ID, device) else json.remove(KEY_DEVICE_ID)
        }
        Log.i(TAG, "[wherry] calls: configured (apiBase ${if (base != null) "set" else "unset"}, deviceId ${if (device != null) "set" else "unset"})")
    }

    fun apiBase(context: Context): String? = read(context).optString(KEY_API_BASE, "").ifEmpty { null }

    fun deviceId(context: Context): String? = read(context).optString(KEY_DEVICE_ID, "").ifEmpty { null }

    fun setLabels(context: Context, labels: Map<String, String>) {
        val names = JSONObject()
        var count = 0
        for ((id, name) in labels) {
            if (count >= MAX_LABELS) break
            if (!Ids.isId(id) || name.isBlank()) continue
            names.put(id, name)
            count += 1
        }
        write(context) { json -> json.put(KEY_LABELS, names) }
        Log.i(TAG, "[wherry] calls: labels set ($count)")
    }

    fun label(context: Context, conversationId: String?): String? {
        if (conversationId == null) return null
        val names = read(context).optJSONObject(KEY_LABELS) ?: return null
        return names.optString(conversationId, "").takeIf { it.isNotBlank() }
    }

    fun clearLabels(context: Context) {
        write(context) { json -> json.remove(KEY_LABELS) }
    }

    private val ABSOLUTE = Regex("^https?://[^/].*$", RegexOption.IGNORE_CASE)
}
