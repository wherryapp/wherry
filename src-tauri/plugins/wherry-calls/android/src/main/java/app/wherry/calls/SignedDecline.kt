// The lock screen's Decline without a session (plan §2.5): POST
// `/api/calls/:id/decline-signed` with the token the ring carried. Native
// Android code holds no session at all (the vault is a no-op there), and the
// token can decline that one call, for this device's user, until `exp`, and
// nothing else. The server answers 204 whatever happened (api.md), so a 204
// says the request arrived, not that a call was declined; 503 means the
// server has no CALL_ACTION_SECRET.
//
// Blocking: called on a background thread by CallActionReceiver (goAsync).
package app.wherry.calls

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

internal object SignedDecline {
    /** Well inside a receiver's goAsync budget (about 10 s). */
    private const val TIMEOUT_MS = 4_000

    /** The status code, or null when the request never completed. */
    fun post(apiBase: String, callId: String, deviceId: String, exp: Long, sig: String): Int? {
        // Every part of the URL and body is shape-checked: the ids reach a
        // path, and a stray `/` or `?` must never.
        if (!Ids.isId(callId) || !Ids.isId(deviceId) || !Ids.isSig(sig)) return null
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("exp", exp)
            .put("sig", sig)
            .toString()
            .toByteArray(Charsets.UTF_8)
        var connection: HttpURLConnection? = null
        return try {
            connection = URL("$apiBase/calls/$callId/decline-signed").openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.doOutput = true
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            connection.responseCode
        } catch (e: Exception) {
            Log.w(TAG, "[wherry] calls: signed decline failed: ${e.javaClass.simpleName}")
            null
        } finally {
            connection?.disconnect()
        }
    }
}
