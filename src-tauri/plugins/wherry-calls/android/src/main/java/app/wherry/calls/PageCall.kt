// The call the page last reported through setActive, kept as the edge the
// report does not carry.
//
// The page's report is a level, not an edge: phone-bridge.ts sends
// setActive(false) whenever its report changes and again at every account
// run's start, so a page that reloaded mid-call tells the plugin its call is
// gone and a stale call service stops. So a setActive(false) arrives when no
// call was ever up -- the ring's own page coming to the front is enough --
// and only one that follows a setActive(true) ends a call. Row A-59 lost the
// over-the-lock-screen show 66 ms after it began to exactly that
// (2026-09-29). Pure, for the JVM test (PageCallTest).
package app.wherry.calls

internal class PageCall<T : Any> {
    /** What the last setActive(true) said, until a setActive(false). */
    var current: T? = null
        private set

    /** setActive(true). */
    fun active(call: T) {
        current = call
    }

    /** setActive(false). True only when a call was up, that is when this
     *  report ends one; false for a repeat or a first report of no call. */
    fun inactive(): Boolean {
        val ended = current != null
        current = null
        return ended
    }
}
