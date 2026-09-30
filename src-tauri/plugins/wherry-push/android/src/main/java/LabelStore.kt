// The push plugin's label map (docs/prompts/notification-names-plan.md §4):
// conversation id to its label and whether it is a group, user id to display
// name. Written whole by the page's `set_labels`, read when a push is
// rendered -- often in a process FCM woke with no webview, which is why it is
// on disk and not in the page.
//
// Where it lives, and why: one small JSON file under `noBackupFilesDir`,
// which Android's Auto Backup and device-to-device transfer never copy (the
// calls plugin's CallsStore.kt keeps its ring labels the same way, for the
// same reason). The app itself is now out of Auto Backup and device transfer
// (hand edit 15, decision 10), but that is a hand edit `tauri android init`
// would erase; this file does not depend on it. These are names of people
// and chats, which is what D1 keeps away from Google in the first place.
// Plaintext on the phone is the same exposure as the notification shade
// itself (plan §5).
//
// Names only, never content (rule 1). The page empties it at sign-out, at the
// end of an account's run, and whenever "Names in notifications" is off.
//
//   {"v":1,"c":{"<conversation id>":{"l":"<label>","g":<bool>}},"u":{"<user id>":"<name>"}}

package app.wherry.push

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import java.io.File
import java.io.FileNotFoundException
import org.json.JSONObject

internal object LabelStore {
  private const val TAG = "wherry-push"
  private const val FILE = "wherry-push-labels.json"

  /** Read once per process; under this object's lock. */
  private var cached: Labels? = null

  private fun file(context: Context): LabelsFile =
    AtomicLabelsFile(AtomicFile(File(context.applicationContext.noBackupFilesDir, FILE)))

  /** [cached] if warm, else [file] read through [LabelsFile.readBytes] and
   *  cached. `internal` so `LabelStoreTest` can drive it directly with a
   *  fake [file] -- see [LabelsFile]'s comment for why a real one cannot be
   *  used from a JVM test. */
  @Synchronized
  internal fun get(file: LabelsFile): Labels {
    cached?.let { return it }
    val labels = try {
      parse(JSONObject(String(file.readBytes(), Charsets.UTF_8)))
    } catch (e: FileNotFoundException) {
      Labels.EMPTY
    } catch (e: Exception) {
      Log.w(TAG, "labels unreadable, starting empty: ${e.javaClass.simpleName}")
      Labels.EMPTY
    }
    cached = labels
    return labels
  }

  @Synchronized
  fun get(context: Context): Labels = get(file(context))

  /** Replaces the map; an empty one deletes the file. A crash mid-write
   *  leaves the previous file (AtomicFile). [cached] only moves to [labels]
   *  once the write actually lands: a `startWrite` failure or a
   *  `failWrite` rollback leaves the old file in place, and moving
   *  [cached] anyway would let this process answer `get` from the new
   *  value while a process FCM starts later -- with no webview to call
   *  `set` again -- reads the old file and answers from that instead.
   *  Leaving [cached] alone keeps every process reading the same labels
   *  the disk holds until a later `set` writes successfully. `internal`,
   *  split from the Context-based [set], so `LabelStoreTest` can drive the
   *  same commit rule against a [LabelsFile] that fails --
   *  `android.util.AtomicFile` throws "not mocked" under
   *  `testDebugUnitTest` (verified 2026-09-30; there is no Robolectric
   *  here, matching every other JVM test in these plugins). */
  @Synchronized
  internal fun commit(file: LabelsFile, labels: Labels) {
    if (labels.conversations.isEmpty() && labels.users.isEmpty()) {
      file.delete()
      cached = labels
      Log.i(TAG, "labels cleared")
      return
    }
    try {
      file.writeBytes(serialise(labels).toString().toByteArray(Charsets.UTF_8))
      cached = labels
      // Rows read this line: counts only, never a name.
      Log.i(TAG, "labels set (${labels.conversations.size} conversations, ${labels.users.size} users)")
    } catch (e: Exception) {
      Log.w(TAG, "labels not written: ${e.javaClass.simpleName}")
    }
  }

  @Synchronized
  fun set(context: Context, labels: Labels) {
    commit(file(context), labels)
  }

  private fun parse(json: JSONObject): Labels {
    val conversations = ArrayList<Pair<String, ConversationLabel>>()
    json.optJSONObject("c")?.let { c ->
      for (id in c.keys()) {
        val entry = c.optJSONObject(id) ?: continue
        conversations += id to ConversationLabel(entry.optString("l", ""), entry.optBoolean("g", false))
      }
    }
    val users = ArrayList<Pair<String, String>>()
    json.optJSONObject("u")?.let { u ->
      for (id in u.keys()) users += id to u.optString(id, "")
    }
    return Labels.of(conversations, users)
  }

  private fun serialise(labels: Labels): JSONObject {
    val c = JSONObject()
    for ((id, value) in labels.conversations) {
      c.put(id, JSONObject().put("l", value.label).put("g", value.group))
    }
    val u = JSONObject()
    for ((id, name) in labels.users) u.put(id, name)
    return JSONObject().put("v", 1).put("c", c).put("u", u)
  }

  /** Forgets [cached], as a process kill and restart would. Never called
   *  outside `LabelStoreTest`, which uses it to check that a "fresh" read
   *  agrees with what [commit] actually left on the fake disk. */
  internal fun forgetCacheForTest() {
    cached = null
  }
}

/** The store's byte-level half, behind an interface so `LabelStoreTest` can
 *  fake a disk that fails: every `android.util.AtomicFile` method throws
 *  "not mocked" under `testDebugUnitTest`, whatever the real filesystem
 *  underneath it is asked to do (verified 2026-09-30; the calls plugin's
 *  CallsStore.kt hits the same wall and is tested the same way), so the
 *  failure `commit`'s cache rule depends on cannot be produced by calling
 *  `LabelStore` itself from a JVM test. */
internal interface LabelsFile {
  /** Throws `FileNotFoundException` if nothing has ever been written, any
   *  other `Exception` if the bytes on disk cannot be read. */
  fun readBytes(): ByteArray

  /** Throws on failure, leaving whatever was previously readable
   *  unchanged. */
  fun writeBytes(bytes: ByteArray)

  /** Best-effort; `AtomicFile.delete()` does not report failure. */
  fun delete()
}

/** [LabelsFile] over one `AtomicFile`, so a crash mid-write leaves the
 *  previous contents rather than a half-written file. */
private class AtomicLabelsFile(private val file: AtomicFile) : LabelsFile {
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

  override fun delete() = file.delete()
}
