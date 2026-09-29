// PageCall on the JVM: only a setActive(false) that follows a
// setActive(true) ends a call, so a ring shown over the lock screen is not
// released by the page's first report of no call (row A-59, 2026-09-29).
package app.wherry.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PageCallTest {
    @Test
    fun aFirstReportOfNoCallEndsNothing() {
        val page = PageCall<String>()
        assertFalse(page.inactive())
        assertNull(page.current)
    }

    @Test
    fun inactiveAfterActiveEndsTheCall() {
        val page = PageCall<String>()
        page.active("call")
        assertEquals("call", page.current)
        assertTrue(page.inactive())
        assertNull(page.current)
    }

    @Test
    fun aRepeatedReportOfNoCallEndsNothing() {
        val page = PageCall<String>()
        page.active("call")
        assertTrue(page.inactive())
        assertFalse(page.inactive())
    }

    @Test
    fun anUpdatedCallIsStillOneCall() {
        val page = PageCall<String>()
        page.active("audio")
        page.active("video")
        assertEquals("video", page.current)
        assertTrue(page.inactive())
    }
}
