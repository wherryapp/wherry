// The Android half of wherry-calls (docs/prompts/phone-calls-plan.md §5.2,
// §6). The page's PhoneCalls interface (client/src/voice/phone-calls.ts)
// reaches these commands through the plugin's Rust passthrough.
//
// PC1 is the skeleton: every command exists with the argument and answer
// shapes the page expects. Each native stage builds its piece and flips its
// own `capabilities` field:
//   A1  callService = true, with CallService behind setActive, the ongoing
//       notification's Hang up (CallActionReceiver -> CallActions), and
//       takePendingActions returning what that queued. Built.
//   A2  ringUi = "notification", with the ring, the receivers, Answer and
//       Decline. Still stubs below; until then the page's sheet rings.
// Events the page listens for, with their payloads (trigger(...)):
//   "action"  { kind: "answer"|"decline"|"hangup", callId, conversationId?, at? }
//   "mute"    { callId, muted }   (iOS only in practice)
// "push-token" is iOS's; Android has no VoIP token of its own (the ring
// comes over FCM through the push plugin's one messaging service).
package app.wherry.calls

import android.app.Activity
import android.content.pm.ApplicationInfo
import android.util.Log
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@TauriPlugin
class CallsPlugin(private val activity: Activity) : Plugin(activity) {

    /** Held here so CallActions' weak reference lives as long as the plugin. */
    private val sink = CallActions.Sink { action ->
        if (hasListener("action")) {
            trigger("action", action.toJS())
            true
        } else {
            false
        }
    }

    init {
        CallActions.attach(sink)
        // The service's start after a late RECORD_AUDIO grant, and
        // keep-resumed, both on the activity's lifecycle (CallLifecycle).
        // Not this class's onPause/onResume: tauri 2.11.5 never calls them.
        CallLifecycle.install(activity)
    }

    override fun load(webView: WebView) {
        CallLifecycle.attachWebView(webView)
    }

    private val debuggable: Boolean
        get() = (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    private fun stub(invoke: Invoke, command: String) {
        Log.d(TAG, "[wherry] calls: $command (stub)")
        invoke.resolve()
    }

    @Command
    fun capabilities(invoke: Invoke) {
        val answer = JSObject()
        answer.put("ringUi", "page")
        answer.put("callService", true)
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

    /** { active, callId, label, audioOnly }: starts CallService, updates it
     *  (a new label, video on or off), or stops it. Resolves either way: a
     *  service that could not start is logged, and the call goes on without
     *  it, as it did before A1, until CallLifecycle starts it when the
     *  activity next resumes (a first call's RECORD_AUDIO grant comes after
     *  the page's last setActive). */
    @Command
    fun setActive(invoke: Invoke) {
        val args = invoke.getArgs()
        val context = activity.applicationContext
        if (args.getBoolean("active", false)) {
            CallLifecycle.active(
                context,
                args.getString("callId", null),
                args.getString("label", null),
                args.getBoolean("audioOnly", true),
            )
        } else {
            if (CallService.running) Log.i(TAG, "[wherry] calls: setActive(false)")
            CallLifecycle.inactive(context)
        }
        invoke.resolve()
    }

    /** { callId, reason }: A2 cancels the ring notification, whatever the
     *  reason (phone-calls.ts's PhoneEndReason table). Never the ongoing
     *  call's notification: that one is CallService's, ended by setActive. */
    @Command
    fun reportEnded(invoke: Invoke) = stub(invoke, "reportEnded")

    /** { callId, label }: a no-op until A3's telecom integration. */
    @Command
    fun startOutgoing(invoke: Invoke) = stub(invoke, "startOutgoing")

    /** The presses made while the page was not listening, oldest first. */
    @Command
    fun takePendingActions(invoke: Invoke) {
        val actions = JSArray()
        for (action in CallActions.take()) actions.put(action.toJS())
        val answer = JSObject()
        answer.put("actions", actions)
        invoke.resolve(answer)
    }

    /** The account signed out of the page, which stays loaded: the queued
     *  actions are forgotten (A1). A2 also forgets the label cache and
     *  cancels any ring still posted. The configure values stay (they are
     *  the device's). The call service is not touched: a call still up is
     *  ended by the page, and its setActive(false) stops the service. */
    @Command
    fun resetAccount(invoke: Invoke) {
        CallActions.clear()
        Log.d(TAG, "[wherry] calls: resetAccount (queued actions cleared)")
        invoke.resolve()
    }

    /** { payload }: debug builds only, so a release APK cannot be rung
     *  from its own page. A2 hands the payload to RingHandler. */
    @Command
    fun debugIncoming(invoke: Invoke) {
        if (!debuggable) {
            invoke.reject("debugIncoming is available in debug builds only")
            return
        }
        stub(invoke, "debugIncoming")
    }
}
