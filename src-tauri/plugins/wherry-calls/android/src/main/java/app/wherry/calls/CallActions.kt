// Presses on the native call UI, on their way to the page (plan §5.2): the
// `action` event when the page is listening, otherwise a queue that
// `takePendingActions` drains when it starts listening. Whether a press is
// still acted on is the page's decision (phone-rules.ts's
// `pendingActionVerdict`); this only carries it.
//
// A1 produces `hangup` (the ongoing notification's button). A2 adds
// `answer` (RingLaunch) and `decline` from the ring (CallActionReceiver, when
// the decline is not signed or the signed one failed; RingLaunch, when it
// had to open the app).
package app.wherry.calls

import app.tauri.plugin.JSObject
import java.lang.ref.WeakReference

internal const val TAG = "wherry-calls"

internal data class CallAction(
    /** "answer", "decline" or "hangup" (phone-calls.ts's PhoneActionKind). */
    val kind: String,
    val callId: String,
    val conversationId: String?,
    /** Milliseconds since the epoch, device clock: when the press happened. */
    val at: Long,
) {
    fun toJS(): JSObject {
        val js = JSObject()
        js.put("kind", kind)
        js.put("callId", callId)
        if (conversationId != null) js.put("conversationId", conversationId)
        js.put("at", at)
        return js
    }
}

internal object CallActions {
    const val ANSWER = "answer"
    const val DECLINE = "decline"
    const val HANGUP = "hangup"

    /** Enough for any real sequence of presses; a flood keeps the newest. */
    private const val QUEUE_MAX = 16

    /** Where a press goes when the page listens: the plugin, which answers
     *  whether a listener took it. */
    interface Sink {
        fun offer(action: CallAction): Boolean

        /** A page is listening for `action` now. */
        fun listening(): Boolean
    }

    private var sink: WeakReference<Sink>? = null
    private val queue = ArrayDeque<CallAction>()

    @Synchronized
    fun attach(sink: Sink) {
        this.sink = WeakReference(sink)
    }

    /** Whether a press made now would reach a page at once (A2 gives an
     *  unsigned Decline to the page only then). */
    @Synchronized
    fun live(): Boolean = sink?.get()?.listening() == true

    /** Delivered live, or queued for `takePendingActions`. Answers whether
     *  it was delivered live. */
    @Synchronized
    fun deliver(action: CallAction): Boolean {
        if (sink?.get()?.offer(action) == true) return true
        queue.addLast(action)
        while (queue.size > QUEUE_MAX) queue.removeFirst()
        return false
    }

    @Synchronized
    fun take(): List<CallAction> {
        val all = queue.toList()
        queue.clear()
        return all
    }

    /** Sign-out (`resetAccount`): a press made for one account is never
     *  carried out for the next. */
    @Synchronized
    fun clear() {
        queue.clear()
    }
}
