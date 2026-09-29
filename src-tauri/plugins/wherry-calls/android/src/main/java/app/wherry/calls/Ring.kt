// A ring as the plugin holds it, and what happens when one call's ring
// arrives twice (the page's socket and the push both bring it). No Android
// API here, so RingTest runs it on the JVM.
package app.wherry.calls

/**
 * The signed decline token (plan §2.5), exactly as the server signed it:
 * the HMAC covers the call, this device and **this** `exp`, so the three
 * travel together and are never mixed with another source's values. A
 * different `exp` beside the same `sig` is a token that does not verify, and
 * the route answers 204 whatever happened, so nothing would say so.
 */
internal data class DeclineToken(
    /** This device's id as the server signed it (`dev`). */
    val deviceId: String,
    /** The `exp` the server signed, seconds since the epoch. */
    val exp: Long,
    /** `dsig`: HMAC-SHA256, unpadded base64url. */
    val sig: String,
) {
    /** Past its `exp`: the server would refuse it silently (204), so it is
     *  not sent and the press goes to the page instead. */
    fun expired(nowMs: Long): Boolean = exp * 1000 <= nowMs
}

internal data class Ring(
    val callId: String,
    val conversationId: String?,
    val group: Boolean,
    /** When the ring window closes here, seconds since the epoch: the
     *  notification's timeout and the stale check. Never sent with the
     *  token (the token carries its own). */
    val exp: Long,
    /** Null when the page reported the ring, or the server has no
     *  CALL_ACTION_SECRET. */
    val token: DeclineToken?,
    /** The page's label; null for a pushed ring (looked up in the cache). */
    val label: String?,
    /** The page has reported this ring (`reportIncoming`), so its bridge
     *  holds it and its sheet will ring once the activity is in front. A ring
     *  only a push brought is not: its page may not be signed in. */
    val pageKnown: Boolean,
) {
    /**
     * This ring, arriving for a call already [known]. Each field comes from
     * whichever source has it, the newer first, except that the token is
     * taken whole from one source (never the push's `sig` beside the page's
     * `exp`), and `exp`, which is only the notification's timeout, is the
     * later of the two.
     */
    fun mergedWith(known: Ring?): Ring {
        if (known == null) return this
        return copy(
            conversationId = conversationId ?: known.conversationId,
            token = token ?: known.token,
            label = label ?: known.label,
            exp = maxOf(exp, known.exp),
            pageKnown = pageKnown || known.pageKnown,
        )
    }
}

/**
 * The ring's caller line: the page's label, then the cache's ([cached], read
 * only when needed), then [unnamed]. A blank name counts as none.
 */
internal fun ringTitle(label: String?, cached: () -> String?, unnamed: String): String =
    label?.takeIf { it.isNotBlank() }
        ?: cached()?.takeIf { it.isNotBlank() }
        ?: unnamed

/** The shapes of the ids that reach a URL path or a request body. */
internal object Ids {
    /** A UUID (calls, conversations and devices are UUIDv7). */
    private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    /** HMAC-SHA256 in unpadded base64url: 43 characters (api.md). */
    private val SIG = Regex("^[A-Za-z0-9_-]{43}$")

    fun isId(value: String?): Boolean = value != null && UUID.matches(value)

    fun isSig(value: String?): Boolean = value != null && SIG.matches(value)
}
