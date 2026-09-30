// LabelStore's write commit rule on the JVM (review finding, 2026-09-30,
// the same one CallsStore.kt's CallsStoreTest pins): a failed write must
// never move the cache ahead of disk. get() answers from the cache once it
// is warm, often in a process FCM woke with no webview to call set() again,
// so a cache that got ahead of a write that never landed would leave that
// process naming a push from labels nothing on disk agrees with.
// android.util.AtomicFile throws "not mocked" under testDebugUnitTest
// (LabelStore.kt's LabelsFile comment), so this drives
// LabelStore.commit/get directly against a fake disk instead of
// set()/get(context), which need a real Context.

package app.wherry.push

import java.io.FileNotFoundException
import java.io.IOException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LabelStoreTest {
  /** A disk that remembers what was written, and can be told to refuse its
   *  next write -- the shape of an AtomicFile whose startWrite, write or
   *  finishWrite fails. */
  private class FakeFile(private var bytes: ByteArray? = null) : LabelsFile {
    var failNextWrite = false
    var deleted = false

    override fun readBytes(): ByteArray = bytes ?: throw FileNotFoundException()

    override fun writeBytes(bytes: ByteArray) {
      if (failNextWrite) {
        failNextWrite = false
        throw IOException("disk full")
      }
      this.bytes = bytes
    }

    override fun delete() {
      deleted = true
      bytes = null
    }
  }

  private val garden = Labels.of(
    listOf("01990000-0000-7000-8000-0000000c0e01" to ConversationLabel("Garden group", true)),
    emptyList(),
  )
  private val kitchen = Labels.of(
    listOf("01990000-0000-7000-8000-0000000c0e02" to ConversationLabel("Kitchen", false)),
    emptyList(),
  )

  /** LabelStore is a singleton: forget its cache after every test so one
   *  test's commit cannot leak into the next. */
  @After
  fun forgetCache() {
    LabelStore.forgetCacheForTest()
  }

  @Test
  fun aSuccessfulCommitMovesTheCache() {
    val file = FakeFile()
    LabelStore.commit(file, garden)
    assertEquals("Garden group", LabelStore.get(file).conversations.values.single().label)
  }

  @Test
  fun aFailedCommitLeavesTheCacheAtTheOldValue() {
    val file = FakeFile()
    LabelStore.commit(file, garden)
    file.failNextWrite = true

    LabelStore.commit(file, kitchen)

    assertEquals("Garden group", LabelStore.get(file).conversations.values.single().label)
  }

  @Test
  fun aFailedCommitAgreesWithARestartedProcess() {
    val file = FakeFile()
    LabelStore.commit(file, garden)
    file.failNextWrite = true
    LabelStore.commit(file, kitchen)
    val warm = LabelStore.get(file).conversations.values.single().label

    // A kill and restart: the cache is gone, only the fake disk remains.
    LabelStore.forgetCacheForTest()
    val fresh = LabelStore.get(file).conversations.values.single().label

    assertEquals("Garden group", warm)
    assertEquals(warm, fresh)
  }

  @Test
  fun aFailedFirstEverWriteLeavesNothingCachedOrOnDisk() {
    val file = FakeFile()
    file.failNextWrite = true

    LabelStore.commit(file, garden)

    LabelStore.forgetCacheForTest()
    assertTrue(LabelStore.get(file).conversations.isEmpty())
  }

  @Test
  fun clearingToEmptyDeletesRatherThanFailing() {
    val file = FakeFile()
    LabelStore.commit(file, garden)

    LabelStore.commit(file, Labels.EMPTY)

    assertTrue(file.deleted)
    LabelStore.forgetCacheForTest()
    assertTrue(LabelStore.get(file).conversations.isEmpty())
  }
}
