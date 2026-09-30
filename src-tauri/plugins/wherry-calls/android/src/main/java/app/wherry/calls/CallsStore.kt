// What the page tells the plugin that must outlive the page (plan §5.2):
// `configure`'s API base and device id, so a Decline pressed while the app is
// not running knows where `decline-signed` goes, and `setLabels`' cache, so a
// ring pushed to a killed app is named (the push carries no name, decision
// D1).
//
// Where it lives, and why: one small JSON file under `noBackupFilesDir`,
// which Android's Auto Backup and device-to-device transfer never copy. The
// app itself is now out of both (`allowBackup="false"` and its
// data-extraction rules, hand edit 15), but that is a hand edit `tauri
// android init` would erase, and this file does not depend on it: without
// it, anything in SharedPreferences or `filesDir` travels into a Google cloud
// backup (not client-side encrypted on a phone with no screen lock) and
// comes back on a restore before anyone signs in. The labels are conversation names (D1 keeps
// them out of the push for exactly that reason), and the device id is this
// device's, not a restored phone's, so neither may travel. wherry-push's
// RingKeys.kt meets the same default by sealing its key under the Keystore;
// here nothing needs sealing, only not copying.
//
// The labels are conversation names the phone already shows in its list,
// never content (rule 1). `resetAccount` forgets them at sign-out; the
// configure values stay, since they are the device's (phone-calls.ts).
//
// The device id is stored and read by nothing: a signed decline names the
// device its token was signed for (`DeclineToken`), never the configured
// one. It is kept because PC1 fixed `configure`'s shape on both phones.
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
     *  on the first read of each process so a debug install from then does
     *  not keep a copy. */
    private const val LEGACY_PREFS = "wherry-calls"

    /** The legacy file's removal has been tried this process. [read] runs for
     *  every ring post and every Decline, mostly on the main thread in a
     *  receiver, and the file has been gone since the first try. Under this
     *  object's lock. */
    private var legacyCleared = false

    private const val KEY_API_BASE = "apiBase"
    private const val KEY_DEVICE_ID = "deviceId"
    private const val KEY_LABELS = "labels"

    /** phone-rules.ts's MAX_LABELS: the page never sends more. */
    private const val MAX_LABELS = 500

    /** The file's contents, read once per process. Under this object's
     *  lock. */
    private var cached: JSONObject? = null

    private fun file(context: Context): JsonFile =
        AtomicJsonFile(AtomicFile(File(context.applicationContext.noBackupFilesDir, FILE)))

    /** [cached] if warm, else [file] read through [JsonFile.readBytes] and
     *  cached. Does not run the legacy-prefs cleanup [read] does -- that is
     *  a side effect on an unrelated file, not part of what [cached] means,
     *  so [commit] (which has no [Context] to clean up with) can share this
     *  without it. `internal` so `CallsStoreTest` can drive it directly. */
    @Synchronized
    internal fun readAndCache(file: JsonFile): JSONObject {
        cached?.let { return it }
        val json = try {
            JSONObject(String(file.readBytes(), Charsets.UTF_8))
        } catch (e: FileNotFoundException) {
            JSONObject()
        } catch (e: Exception) {
            Log.w(TAG, "[wherry] calls: store unreadable, starting empty: ${e.javaClass.simpleName}")
            JSONObject()
        }
        cached = json
        return json
    }

    @Synchronized
    private fun read(context: Context): JSONObject {
        val app = context.applicationContext
        val json = readAndCache(file(app))
        if (!legacyCleared) {
            legacyCleared = true
            try {
                app.deleteSharedPreferences(LEGACY_PREFS)
            } catch (e: Exception) {
                // Nothing to remove, or it cannot be: it holds nothing the
                // file does not.
            }
        }
        return json
    }

    /** Applies [change] to a copy and writes it whole ([AtomicJsonFile]: a
     *  crash mid-write leaves the previous file). [cached] only moves to
     *  the new value once [JsonFile.writeBytes] returns: on a failure the
     *  file is still the old one, and a process that has [cached] but no
     *  disk copy of it forgets on the next kill (a push can cause one) --
     *  `apiBase`/`deviceId` would then silently revert under a
     *  lock-screen Decline. Leaving [cached] at the old value keeps the
     *  two in agreement; the next `configure` or `setLabels` call tries
     *  the write again. `internal`, and split from [write], so
     *  `CallsStoreTest` can drive the same commit rule with a [JsonFile]
     *  that fails -- `android.util.AtomicFile` throws "not mocked" under
     *  `testDebugUnitTest` (verified 2026-09-30; there is no Robolectric
     *  here, matching every other JVM test in these plugins). */
    @Synchronized
    internal fun commit(file: JsonFile, change: (JSONObject) -> Unit) {
        val next = JSONObject(readAndCache(file).toString())
        change(next)
        try {
            file.writeBytes(next.toString().toByteArray(Charsets.UTF_8))
            cached = next
        } catch (e: Exception) {
            Log.w(TAG, "[wherry] calls: store not written: ${e.javaClass.simpleName}")
        }
    }

    @Synchronized
    private fun write(context: Context, change: (JSONObject) -> Unit) {
        commit(file(context), change)
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

    /** Forgets [cached], as a process kill and restart would. Never called
     *  outside `CallsStoreTest`, which uses it to check that a "fresh" read
     *  agrees with what [commit] actually left on the fake disk. */
    internal fun forgetCacheForTest() {
        cached = null
    }
}

/** The store's byte-level half, behind an interface so `CallsStoreTest` can
 *  fake a disk that fails: every `android.util.AtomicFile` method throws
 *  "not mocked" under `testDebugUnitTest`, whatever the real filesystem
 *  underneath it is asked to do (verified 2026-09-30), so the failure
 *  [commit]'s cache rule depends on cannot be produced by calling
 *  [CallsStore] itself from a JVM test. */
internal interface JsonFile {
    /** Throws `FileNotFoundException` if nothing has ever been written,
     *  any other `Exception` if the bytes on disk cannot be read. */
    fun readBytes(): ByteArray

    /** Throws on failure, leaving whatever was previously readable
     *  unchanged. */
    fun writeBytes(bytes: ByteArray)
}

/** [JsonFile] over one `AtomicFile`, so a crash mid-write leaves the
 *  previous contents rather than a half-written file. */
private class AtomicJsonFile(private val file: AtomicFile) : JsonFile {
    override fun readBytes(): ByteArray = file.readFully()

    override fun writeBytes(bytes: ByteArray) {
        val out = file.startWrite()
        try {
            out.write(bytes)
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }
}
