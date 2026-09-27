// The app's one FirebaseMessagingService (Android allows exactly one, and it
// is native push's: coordination §4, *Android*). Every FCM message is
// data-only (server/src/push/fcm.ts), so onMessageReceived runs whether the
// app is in front, in the background, or was killed and woken for it.

package app.wherry.push

import android.content.Context
import android.content.Intent
import android.util.Base64
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

class WherryMessagingService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    PushState.setToken(applicationContext, token)
    Log.i("wherry-push", "token rotated ${token.take(8)}...")
    PushState.plugin?.emitToken(token)
  }

  override fun onMessageReceived(message: RemoteMessage) {
    PushDispatch.handle(applicationContext, message.data)
  }
}

/**
 * What one push does, shared by the messaging service and the debug-only
 * receiver (src/debug), so an `adb` broadcast exercises exactly the path a
 * real FCM message takes.
 */
internal object PushDispatch {
  private const val TAG = "wherry-push"

  /** The phone-calls plan's closed set of data kinds (its §4.2). */
  private val CALL_KINDS = setOf("call_ring", "ring_ended")

  /** The explicit broadcast the calls plugin's receiver takes (R9). */
  const val ACTION_CALLS_PUSH = "app.wherry.calls.PUSH"

  /** A per-device conversation reference: 16 bytes of base64url (plan §2). */
  private val REF_PATTERN = Regex("^[A-Za-z0-9_-]{22}$")

  /**
   * [allowPlaintextRing] is false for every real FCM message; only the
   * debug-only DebugPushReceiver passes true, and only when asked (RingGate).
   */
  fun handle(context: Context, data: Map<String, String>, allowPlaintextRing: Boolean = false) {
    val kind = data["k"] ?: "message"
    if (kind in CALL_KINDS) {
      handleCall(context, kind, data, allowPlaintextRing)
    } else {
      val ref = data["r"]?.takeIf { REF_PATTERN.matches(it) }
      if (PushState.resumed && PushRenderer.groupFor(kind) != PushRenderer.Group.CALL) {
        // In front: the socket and the timeline carry it. Calls still post
        // (a ring is worth one duplicate), and a missed call must replace
        // its ring.
        Log.i(TAG, "in front: $kind not posted")
      } else {
        PushRenderer.show(context, kind, ref)
      }
    }
    PushState.plugin?.emitReceived(kind)
  }

  /**
   * A ring or its dismissal. Under M-1 = E it arrives as `{k, e}`, where `e`
   * is the RFC 8291 body (base64url) of the phone-calls plan's §4.2 JSON.
   * The key pair it is encrypted to is this plugin's (the `fcm` row's
   * `p256dh` / `auth`), so it is opened here and the calls plugin receives
   * the plaintext fields as string extras: the explicit broadcast is
   * addressed to this package (`setPackage`) and its receiver is not
   * exported, so the plaintext never leaves the app, and the calls plugin
   * needs neither the key nor any crypto (its debug receiver takes the same
   * plaintext extras from `adb`, phone-calls-plan §6.2).
   *
   * A call kind with no `e` is refused as `unencrypted` (RingGate): the
   * server never sends one, so it is shown as the generic ring or dropped,
   * never forwarded. Only the debug receiver can forward plaintext.
   */
  private fun handleCall(
    context: Context,
    kind: String,
    data: Map<String, String>,
    allowPlaintextRing: Boolean,
  ) {
    val decision = RingGate.decide(data, allowPlaintextRing) { open(context, kind, it) }
    if (decision is RingDecision.Refuse && decision.reason == "unencrypted") {
      // Whatever it carried crossed the wire in the clear; say so.
      Log.w(TAG, "ring not opened: unencrypted $kind refused")
    }
    val probe = Intent(ACTION_CALLS_PUSH).setPackage(context.packageName)
    @Suppress("DEPRECATION")
    val hasReceiver = context.packageManager.queryBroadcastReceivers(probe, 0).isNotEmpty()

    if (decision is RingDecision.Forward && hasReceiver) {
      for ((key, value) in decision.fields) probe.putExtra(key, value)
      context.sendBroadcast(probe)
      Log.i(TAG, "forward $kind to the calls plugin")
      return
    }
    val why = if (decision is RingDecision.Refuse) decision.reason else "no calls receiver"
    when (kind) {
      "call_ring" -> {
        // Somebody may be calling and this build cannot ring for it (no
        // calls plugin, or a body it cannot or may not open): the generic
        // alert, on `calls`. Rows A-52 and A-53 read this line.
        Log.i(TAG, "ring shown as the generic incoming call ($why)")
        PushRenderer.show(context, "call", null)
      }
      // Rows A-52 and A-53 read this line.
      else -> Log.i(TAG, "drop ring_ended ($why)")
    }
  }

  /** The plaintext fields of an encrypted ring, or null when it cannot be
   *  opened. Values are strings, as FCM's own data map is. */
  private fun open(context: Context, kind: String, encoded: String): Map<String, String>? {
    val keys = RingKeys.load(context)
    if (keys == null) {
      Log.w(TAG, "ring not opened: no key")
      return null
    }
    return try {
      val body = Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
      val plaintext = RingEnvelope.open(body, keys.privateKey, keys.publicPoint, keys.auth)
      val json = JSONObject(String(plaintext, Charsets.UTF_8))
      val out = LinkedHashMap<String, String>()
      for (key in json.keys()) {
        val value = json.get(key)
        if (value != JSONObject.NULL) out[key] = value.toString()
      }
      // The outer kind is what the service dispatched on; the inner one is
      // what the server signed into the ciphertext. They must agree.
      if (out["k"] != kind) {
        Log.w(TAG, "ring not opened: inner kind differs from outer")
        return null
      }
      // Row A-53 reads this line: the field names only, never the values
      // (the call id and the decline token are what the envelope hides).
      Log.i(TAG, "ring opened: $kind (${out.keys.sorted().joinToString(",")})")
      out
    } catch (e: EnvelopeException) {
      Log.w(TAG, "ring not opened: ${e.message}")
      null
    } catch (e: Exception) {
      Log.w(TAG, "ring not opened: ${e.javaClass.simpleName}")
      null
    }
  }
}
