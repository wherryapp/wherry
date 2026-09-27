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
import java.io.File
import org.json.JSONObject

/** Debug builds only: a file in the app's own files directory that turns
 *  on keep-resumed (below). `adb shell run-as app.wherry.debug touch
 *  files/wherry-keep-resumed` to set it, `rm` to clear it. */
private const val KEEP_RESUMED_FLAG = "wherry-keep-resumed"

@TauriPlugin
class CallsPlugin(private val activity: Activity) : Plugin(activity) {

    private var webView: WebView? = null
    private var keptResumed = false

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
    }

    override fun load(webView: WebView) {
        this.webView = webView
    }

    private val debuggable: Boolean
        get() = (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    // -- keep-resumed (plan §6.1, measured before it is ever on) ------------
    //
    // wry's WryActivity.onPause() calls WebView.onPause(), which may be what
    // stops a live call's media in the background (A-55). Row A-57 reads the
    // call with the service alone first; only if that fails is it read again
    // with this on, and only a passing second reading justifies turning it
    // on for everybody. Until then it is off, and in a release build it
    // cannot be turned on at all.
    //
    // Plugin.onPause/onResume are the *process's* (Tauri's
    // TauriLifecycleObserver on ProcessLifecycleOwner, ~700 ms after the
    // last activity pauses), so they always come after WryActivity has
    // paused the WebView: undoing it here is not undone again.

    private fun keepResumedWanted(): Boolean =
        debuggable && File(activity.filesDir, KEEP_RESUMED_FLAG).exists()

    override fun onPause() {
        if (!CallService.running || !keepResumedWanted()) return
        webView?.onResume()
        keptResumed = true
        Log.i(TAG, "[wherry] calls: webview kept resumed in the background (debug flag)")
    }

    override fun onResume() {
        keptResumed = false
    }

    /** The call ended with the app still in the background: put the WebView
     *  back where WryActivity left it. */
    private fun releaseKeptResumed() {
        if (!keptResumed) return
        keptResumed = false
        webView?.onPause()
        Log.i(TAG, "[wherry] calls: webview paused again after the call")
    }

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
     *  it, as it did before A1. */
    @Command
    fun setActive(invoke: Invoke) {
        val args = invoke.getArgs()
        val context = activity.applicationContext
        if (args.getBoolean("active", false)) {
            CallService.update(
                context,
                args.getString("callId", null),
                args.getString("label", null),
                args.getBoolean("audioOnly", true),
            )
        } else {
            if (CallService.running) Log.i(TAG, "[wherry] calls: setActive(false)")
            CallService.stop(context)
            releaseKeptResumed()
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
