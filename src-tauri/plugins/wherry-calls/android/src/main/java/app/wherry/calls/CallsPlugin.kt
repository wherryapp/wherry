// The Android half of wherry-calls (docs/prompts/phone-calls-plan.md §5.2,
// §6). The page's PhoneCalls interface (client/src/voice/phone-calls.ts)
// reaches these commands through the plugin's Rust passthrough.
//
// PC1 is the skeleton: every command exists with the argument and answer
// shapes the page expects, and every body is a stub. `capabilities` answers
// "page" and false, so the page keeps ringing on its own sheet until a stage
// has built the native piece that replaces it and flips its own field:
//   A1  callService = true, with CallService behind setActive;
//   A2  ringUi = "notification", with the ring, the receivers, Answer and
//       Decline, and takePendingActions returning what they queued.
// Events the page listens for, with their payloads (trigger(...)):
//   "action"  { kind: "answer"|"decline"|"hangup", callId, conversationId?, at? }
//   "mute"    { callId, muted }   (iOS only in practice)
// "push-token" is iOS's; Android has no VoIP token of its own (the ring
// comes over FCM through the push plugin's one messaging service).
package app.wherry.calls

import android.app.Activity
import android.content.pm.ApplicationInfo
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

private const val TAG = "wherry-calls"

@TauriPlugin
class CallsPlugin(private val activity: Activity) : Plugin(activity) {

    private fun stub(invoke: Invoke, command: String) {
        Log.d(TAG, "[wherry] calls: $command (stub)")
        invoke.resolve()
    }

    @Command
    fun capabilities(invoke: Invoke) {
        val answer = JSObject()
        answer.put("ringUi", "page")
        answer.put("callService", false)
        answer.put("voip", false)
        invoke.resolve(answer)
    }

    /** { apiBase, deviceId }: A2 persists them for CallActionReceiver. */
    @Command
    fun configure(invoke: Invoke) = stub(invoke, "configure")

    /** { labels: { conversationId: name } }: A2 persists the label cache. */
    @Command
    fun setLabels(invoke: Invoke) = stub(invoke, "setLabels")

    /** Android has no PushKit: always { token: null }. */
    @Command
    fun pushToken(invoke: Invoke) {
        val answer = JSObject()
        answer.put("token", JSONObject.NULL)
        invoke.resolve(answer)
    }

    /** { callId, conversationId, label, group, exp } -> { shown }: A2 posts
     *  the ring only while the activity is not resumed, and answers
     *  shown = true only when it posted one. False (resumed, or any
     *  failure) leaves the page's sheet and tone ringing
     *  (phone-calls.ts's IncomingAnswer). */
    @Command
    fun reportIncoming(invoke: Invoke) {
        Log.d(TAG, "[wherry] calls: reportIncoming (stub)")
        val answer = JSObject()
        answer.put("shown", false)
        invoke.resolve(answer)
    }

    /** { active, callId, label, audioOnly }: A1 starts or stops CallService. */
    @Command
    fun setActive(invoke: Invoke) = stub(invoke, "setActive")

    /** { callId, reason }: A2 cancels the ring notification, whatever the
     *  reason (phone-calls.ts's PhoneEndReason table). Never the ongoing
     *  call's notification: that one is CallService's, ended by setActive. */
    @Command
    fun reportEnded(invoke: Invoke) = stub(invoke, "reportEnded")

    /** { callId, label }: a no-op until A3's telecom integration. */
    @Command
    fun startOutgoing(invoke: Invoke) = stub(invoke, "startOutgoing")

    @Command
    fun takePendingActions(invoke: Invoke) {
        val answer = JSObject()
        answer.put("actions", JSArray())
        invoke.resolve(answer)
    }

    /** The account signed out of the page, which stays loaded: A2 forgets
     *  the label cache and the queued actions, and cancels any ring still
     *  posted. The configure values stay (they are the device's). */
    @Command
    fun resetAccount(invoke: Invoke) = stub(invoke, "resetAccount")

    /** { payload }: debug builds only, so a release APK cannot be rung
     *  from its own page. A2 hands the payload to RingHandler. */
    @Command
    fun debugIncoming(invoke: Invoke) {
        val debuggable =
            (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!debuggable) {
            invoke.reject("debugIncoming is available in debug builds only")
            return
        }
        stub(invoke, "debugIncoming")
    }
}
