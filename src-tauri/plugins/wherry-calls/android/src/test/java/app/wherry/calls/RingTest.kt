// Ring.mergedWith on the JVM: when one call's ring arrives from the page and
// from the push, the Decline carries the token exactly as the server signed
// it. The server's HMAC covers `exp`, and the page's `exp` (its own clock at
// receipt + 45 s) is routinely a second later than the push's, so a token
// assembled from the push's `sig` and the merged `exp` does not verify, and
// the route's 204 hides that (A2's review, finding 1).
package app.wherry.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RingTest {
    private val call = "01990000-0000-7000-8000-00000000a60a"
    private val conv = "01990000-0000-7000-8000-0000000c0e01"
    private val dev = "01990000-0000-7000-8000-0000000de71c"
    private val sig = "A".repeat(43)

    /** The push: the server's `exp` and the token it signed over it. */
    private fun push(exp: Long, signature: String = sig) = Ring(
        callId = call,
        conversationId = conv,
        group = false,
        exp = exp,
        token = DeclineToken(dev, exp, signature),
        label = null,
        pageKnown = false,
    )

    /** The page: `ringExpiry(receivedAt)`, no token, a label. */
    private fun page(exp: Long) = Ring(
        callId = call,
        conversationId = conv,
        group = false,
        exp = exp,
        token = null,
        label = "Garden group",
        pageKnown = true,
    )

    @Test fun pageFirstThenPushKeepsThePushTokenWithItsOwnExp() {
        val merged = push(exp = 1_790_000_045).mergedWith(page(exp = 1_790_000_046))
        assertEquals(DeclineToken(dev, 1_790_000_045, sig), merged.token)
        // The later exp is the notification's timeout only.
        assertEquals(1_790_000_046, merged.exp)
        assertEquals("Garden group", merged.label)
        assertTrue(merged.pageKnown)
    }

    @Test fun pushFirstThenPageKeepsThePushTokenWithItsOwnExp() {
        val merged = page(exp = 1_790_000_046).mergedWith(push(exp = 1_790_000_045))
        assertEquals(DeclineToken(dev, 1_790_000_045, sig), merged.token)
        assertEquals(1_790_000_046, merged.exp)
        assertEquals("Garden group", merged.label)
        assertTrue(merged.pageKnown)
    }

    @Test fun aNewerPushReplacesTheTokenWhole() {
        val newer = "B".repeat(43)
        val merged = push(exp = 1_790_000_050, signature = newer).mergedWith(push(exp = 1_790_000_045))
        assertEquals(DeclineToken(dev, 1_790_000_050, newer), merged.token)
    }

    @Test fun thePageAloneHasNoToken() {
        val merged = page(exp = 1_790_000_046).mergedWith(null)
        assertNull(merged.token)
        assertTrue(merged.pageKnown)
    }

    @Test fun aPushAloneIsNotPageKnown() {
        assertFalse(push(exp = 1_790_000_045).mergedWith(null).pageKnown)
    }

    @Test fun aTokenPastItsExpIsExpired() {
        val token = DeclineToken(dev, 1_790_000_045, sig)
        assertFalse(token.expired(1_790_000_044_999))
        assertTrue(token.expired(1_790_000_045_000))
    }

    // ringTitle: decision 7, a locked phone's ring names nobody.

    private val unnamed = "Wherry call"

    @Test fun aLockedPhoneNamesNobodyWhateverIsKnown() {
        var looked = false
        val title = ringTitle(hidden = true, label = "Garden group", cached = { looked = true; "Garden" }, unnamed = unnamed)
        assertEquals(unnamed, title)
        assertFalse(looked)
    }

    @Test fun anUnlockedPhoneTakesThePageLabelFirst() {
        assertEquals("Garden group", ringTitle(hidden = false, label = "Garden group", cached = { "Garden" }, unnamed = unnamed))
    }

    @Test fun anUnlockedPhoneFallsBackToTheCacheThenTheFixedText() {
        assertEquals("Garden", ringTitle(hidden = false, label = null, cached = { "Garden" }, unnamed = unnamed))
        assertEquals("Garden", ringTitle(hidden = false, label = " ", cached = { "Garden" }, unnamed = unnamed))
        assertEquals(unnamed, ringTitle(hidden = false, label = null, cached = { null }, unnamed = unnamed))
        // The names setting off empties the cache: the fixed text.
        assertEquals(unnamed, ringTitle(hidden = false, label = null, cached = { "" }, unnamed = unnamed))
    }
}
