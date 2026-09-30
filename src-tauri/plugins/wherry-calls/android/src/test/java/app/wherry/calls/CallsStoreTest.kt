// CallsStore's write commit rule on the JVM (review finding, 2026-09-30):
// a failed write must never move the cache ahead of disk. apiBase()/
// deviceId() answer from the cache once it is warm, and a process is killed
// and restarted between calls more often than not (a push can do it), so a
// cache that got ahead of a write that never landed would have a
// lock-screen Decline read an apiBase or deviceId nothing on disk agrees
// with. android.util.AtomicFile throws "not mocked" under
// testDebugUnitTest (CallsStore.kt's JsonFile comment), so this drives
// CallsStore.commit/readAndCache directly against a fake disk instead of
// configure()/apiBase(), which need a real Context.
package app.wherry.calls

import java.io.FileNotFoundException
import java.io.IOException
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class CallsStoreTest {
    /** A disk that remembers what was written, and can be told to refuse
     *  its next write -- the shape of an AtomicFile whose startWrite,
     *  write or finishWrite fails. */
    private class FakeFile(private var bytes: ByteArray? = null) : JsonFile {
        var failNextWrite = false

        override fun readBytes(): ByteArray = bytes ?: throw FileNotFoundException()

        override fun writeBytes(bytes: ByteArray) {
            if (failNextWrite) {
                failNextWrite = false
                throw IOException("disk full")
            }
            this.bytes = bytes
        }
    }

    /** CallsStore is a singleton: forget its cache after every test so one
     *  test's commit cannot leak into the next. */
    @After
    fun forgetCache() {
        CallsStore.forgetCacheForTest()
    }

    @Test
    fun aSuccessfulCommitMovesTheCache() {
        val file = FakeFile()
        CallsStore.commit(file) { it.put("apiBase", "https://a.example") }
        assertEquals("https://a.example", CallsStore.readAndCache(file).optString("apiBase"))
    }

    @Test
    fun aFailedCommitLeavesTheCacheAtTheOldValue() {
        val file = FakeFile()
        CallsStore.commit(file) { it.put("apiBase", "https://old.example") }
        file.failNextWrite = true

        CallsStore.commit(file) { it.put("apiBase", "https://new.example") }

        assertEquals("https://old.example", CallsStore.readAndCache(file).optString("apiBase"))
    }

    @Test
    fun aFailedCommitAgreesWithARestartedProcess() {
        val file = FakeFile()
        CallsStore.commit(file) { it.put("apiBase", "https://old.example") }
        file.failNextWrite = true
        CallsStore.commit(file) { it.put("apiBase", "https://new.example") }
        val warm = CallsStore.readAndCache(file).optString("apiBase")

        // A kill and restart: the cache is gone, only the fake disk remains.
        CallsStore.forgetCacheForTest()
        val fresh = CallsStore.readAndCache(file).optString("apiBase")

        assertEquals("https://old.example", warm)
        assertEquals(warm, fresh)
    }

    @Test
    fun aFailedFirstEverWriteLeavesNothingCachedOrOnDisk() {
        val file = FakeFile()
        file.failNextWrite = true

        CallsStore.commit(file) { it.put("apiBase", "https://new.example") }

        CallsStore.forgetCacheForTest()
        assertFalse(CallsStore.readAndCache(file).has("apiBase"))
    }

    @Test
    fun anUnreadableExistingFileStartsEmptyButStillReadsAfterAWrite() {
        val file = object : JsonFile {
            override fun readBytes(): ByteArray = throw IOException("corrupt")
            override fun writeBytes(bytes: ByteArray) {}
        }
        val empty = CallsStore.readAndCache(file)
        assertEquals(0, empty.length())
    }

    @Test
    fun aJsonRoundTripSurvivesACommit() {
        val file = FakeFile()
        CallsStore.commit(file) {
            it.put("apiBase", "https://a.example")
            it.put("deviceId", "01990000-0000-7000-8000-0000000de71c")
        }
        val read = JSONObject(String(file.readBytes()))
        assertEquals("https://a.example", read.optString("apiBase"))
        assertEquals("01990000-0000-7000-8000-0000000de71c", read.optString("deviceId"))
    }
}
