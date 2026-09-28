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
//   A2  ringUi = "notification": the ring over the lock screen
//       (RingHandler), its Answer (RingLaunch) and Decline
//       (CallActionReceiver, SignedDecline), the push's way in
//       (IncomingCallReceiver) and the label cache (CallsStore). Built.
//   fullScreen, a PC1 follow-up: whether the ring may take the screen
//       (canUseFullScreenIntent on API 34+), for Settings -> Voice.
// Events the page listens for, with their payloads (trigger(...)):
//   "action"  { kind: "answer"|"decline"|"hangup", callId, conversationId?, at? }
//   "mute"    { callId, muted }   (iOS only in practice)
// "push-token" is iOS's; Android has no VoIP token of its own (the ring
// comes over FCM through the push plugin's one messaging service).
package app.wherry.calls

import android.app.Activity
import android.app.NotificationManager
import android.content.pm.ApplicationInfo
import android.os.Build
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
    private val sink = object : CallActions.Sink {
        override fun offer(action: CallAction): Boolean {
            if (!hasListener("action")) return false
            trigger("action", action.toJS())
            return true
        }

        override fun listening(): Boolean = hasListener("action")
    }

    init {
        CallActions.attach(sink)
        // The service's start after a late RECORD_AUDIO grant, keep-resumed,
        // and the ring's launches and resumed state, all on the activity's
        // lifecycle (CallLifecycle), which CallsInitProvider normally
        // installed at process start. Not this class's onPause/onResume:
        // tauri 2.11.5 never calls them.
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
        answer.put("ringUi", "notification")
        answer.put("callService", true)
        answer.put("voip", false)
        // Android 14+ grants USE_FULL_SCREEN_INTENT only to calling and alarm
        // apps; without it RingHandler's ring is a heads-up and a sleeping
        // phone stays dark (row A-59c), which Settings -> Voice states.
        val manager = activity.getSystemService(NotificationManager::class.java)
        answer.put("fullScreen", Build.VERSION.SDK_INT < 34 || manager?.canUseFullScreenIntent() == true)
        invoke.resolve(answer)
    }

    /** { apiBase, deviceId }: kept for CallActionReceiver's signed decline,
     *  which may run with no page at all. */
    @Command
    fun configure(invoke: Invoke) {
        val args = invoke.getArgs()
        CallsStore.configure(activity.applicationContext, args.getString("apiBase", null), args.getString("deviceId", null))
        invoke.resolve()
    }

    /** { labels: { conversationId: name } }: the cache that names a pushed
     *  ring (the push carries no name, D1). Replaces the whole cache. */
    @Command
    fun setLabels(invoke: Invoke) {
        val labels = invoke.getArgs().getJSObject("labels")
        val map = LinkedHashMap<String, String>()
        if (labels != null) {
            for (key in labels.keys()) {
                val value = labels.optString(key, "")
                if (value.isNotBlank()) map[key] = value
            }
        }
        CallsStore.setLabels(activity.applicationContext, map)
        invoke.resolve()
    }

    /** Android has no PushKit: always { token: null }. */
    @Command
    fun pushToken(invoke: Invoke) {
        val answer = JSObject()
        answer.put("token", JSONObject.NULL)
        invoke.resolve(answer)
    }

    /** { callId, conversationId, label, group, exp } -> { shown }: the ring
     *  is posted only while no activity is in front, and shown = true only
     *  when it was. False (in front, notifications off, or any failure)
     *  leaves the page's sheet and tone ringing (phone-calls.ts's
     *  IncomingAnswer). */
    @Command
    fun reportIncoming(invoke: Invoke) {
        val args = invoke.getArgs()
        val answer = JSObject()
        val callId = args.getString("callId", null)
        val exp = args.optLong("exp", 0L)
        val shown = if (Ids.isId(callId) && exp > 0) {
            RingHandler.fromPage(
                activity.applicationContext,
                Ring(
                    callId = callId!!,
                    conversationId = args.getString("conversationId", null)?.takeIf { Ids.isId(it) },
                    group = args.getBoolean("group", false),
                    exp = exp,
                    token = null,
                    label = args.getString("label", null),
                    pageKnown = true,
                ),
            )
        } else {
            Log.w(TAG, "[wherry] calls: reportIncoming without a call id or exp")
            false
        }
        answer.put("shown", shown)
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

    /** { callId, reason }: cancels the ring notification, whatever the
     *  reason (phone-calls.ts's PhoneEndReason table). Never the ongoing
     *  call's notification: that one is CallService's, ended by setActive. */
    @Command
    fun reportEnded(invoke: Invoke) {
        val args = invoke.getArgs()
        val callId = args.getString("callId", null)
        if (Ids.isId(callId)) {
            RingHandler.end(activity.applicationContext, callId!!, args.getString("reason", null) ?: "ended", "page")
        }
        invoke.resolve()
    }

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
     *  actions, the label cache and any ring still posted are forgotten. The
     *  configure values stay (they are the device's). The call service is
     *  not touched: a call still up is ended by the page, and its
     *  setActive(false) stops the service. */
    @Command
    fun resetAccount(invoke: Invoke) {
        val context = activity.applicationContext
        CallActions.clear()
        CallsStore.clearLabels(context)
        RingHandler.reset(context)
        Log.d(TAG, "[wherry] calls: resetAccount (queued actions, labels and rings cleared)")
        invoke.resolve()
    }

    /** { payload }: debug builds only, so a release APK cannot be rung from
     *  its own page. The payload is a ring's plaintext fields (plan §4.2),
     *  run through the push's own handler; on Android the calls plugin never
     *  sees ciphertext (the push plugin opens it, R9). */
    @Command
    fun debugIncoming(invoke: Invoke) {
        if (!debuggable) {
            invoke.reject("debugIncoming is available in debug builds only")
            return
        }
        val payload = invoke.getArgs().getJSObject("payload")
        val fields = LinkedHashMap<String, String>()
        if (payload != null) {
            for (key in payload.keys()) {
                val value = payload.opt(key)
                if (value != null && value != JSONObject.NULL) fields[key] = value.toString()
            }
        }
        RingHandler.fromPush(activity.applicationContext, fields, "debugIncoming")
        invoke.resolve()
    }
}
