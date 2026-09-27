// Whether a call kind's fields may go to the calls plugin, decided with no
// Android API so RingGateTest runs it on the JVM.
//
// Under M-1 = E every ring the server sends is `{k, e}`: `e` is the RFC 8291
// body of the phone-calls plan's §4.2 JSON. A call kind with no `e` is
// therefore never genuine in a release build, whatever put it on this
// token (a server fallback bug, or anyone else holding the FCM sender), and
// its fields are neither trusted nor forwarded. Only the debug-only
// DebugPushReceiver may ask for the plaintext path, and only explicitly
// (`--ez plaintext true`), for row A-52 and the calls plugin's injected rows.

package app.wherry.push

internal sealed class RingDecision {
  /** Forward these fields to the calls plugin, when a receiver resolves. */
  data class Forward(val fields: Map<String, String>) : RingDecision()

  /** Do not forward: show the generic ring, or drop a `ring_ended`.
   *  `reason` is `unopened` (an `e` that did not open) or `unencrypted`
   *  (no `e`, and plaintext not allowed). Rows A-52 and A-53 read it. */
  data class Refuse(val reason: String) : RingDecision()
}

internal object RingGate {
  fun decide(
    data: Map<String, String>,
    allowPlaintext: Boolean,
    open: (String) -> Map<String, String>?,
  ): RingDecision {
    val encoded = data["e"]
    if (encoded != null) {
      val fields = open(encoded) ?: return RingDecision.Refuse("unopened")
      return RingDecision.Forward(fields)
    }
    return if (allowPlaintext) RingDecision.Forward(data) else RingDecision.Refuse("unencrypted")
  }
}
