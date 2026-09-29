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

  private fun file(context: Context) =
    AtomicFile(File(context.applicationContext.noBackupFilesDir, FILE))

  @Synchronized
  fun get(context: Context): Labels {
    cached?.let { return it }
    val labels = try {
      parse(JSONObject(String(file(context).readFully(), Charsets.UTF_8)))
    } catch (e: FileNotFoundException) {
      Labels.EMPTY
    } catch (e: Exception) {
      Log.w(TAG, "labels unreadable, starting empty: ${e.javaClass.simpleName}")
      Labels.EMPTY
    }
    cached = labels
    return labels
  }

  /** Replaces the map; an empty one deletes the file. A crash mid-write
   *  leaves the previous file (AtomicFile). */
  @Synchronized
  fun set(context: Context, labels: Labels) {
    cached = labels
    val file = file(context)
    if (labels.conversations.isEmpty() && labels.users.isEmpty()) {
      file.delete()
      Log.i(TAG, "labels cleared")
      return
    }
    val out = try {
      file.startWrite()
    } catch (e: Exception) {
      Log.w(TAG, "labels not written: ${e.javaClass.simpleName}")
      return
    }
    try {
      out.write(serialise(labels).toString().toByteArray(Charsets.UTF_8))
      file.finishWrite(out)
      // Rows read this line: counts only, never a name.
      Log.i(TAG, "labels set (${labels.conversations.size} conversations, ${labels.users.size} users)")
    } catch (e: Exception) {
      file.failWrite(out)
      Log.w(TAG, "labels not written: ${e.javaClass.simpleName}")
    }
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
}
