// P2's stub of the Android half (docs/prompts/native-push-plan.md §5.2):
// every command of the §5.1 contract exists, `status` reports an
// unconfigured build, and the rest reject with "unconfigured" -- the answers
// §6.2 gives a build with no google-services.json, so the page's handling of
// that state can be built now. P3 owns android/** and replaces this with the
// Firebase implementation.

package app.wherry.push

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

private const val UNCONFIGURED = "unconfigured"

@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun status(invoke: Invoke) {
    val ret = JSObject()
    ret.put("provider", "fcm")
    ret.put("configured", false)
    ret.put("token", JSONObject.NULL)
    ret.put("environment", JSONObject.NULL)
    invoke.resolve(ret)
  }

  @Command
  fun register(invoke: Invoke) {
    invoke.reject(UNCONFIGURED)
  }

  @Command
  fun unregister(invoke: Invoke) {
    invoke.reject(UNCONFIGURED)
  }

  @Command
  fun takeOpen(invoke: Invoke) {
    invoke.reject(UNCONFIGURED)
  }

  @Command
  fun clear(invoke: Invoke) {
    invoke.reject(UNCONFIGURED)
  }

  @Command
  fun setBadge(invoke: Invoke) {
    invoke.reject(UNCONFIGURED)
  }

  @Command
  fun openSettings(invoke: Invoke) {
    invoke.reject(UNCONFIGURED)
  }
}
