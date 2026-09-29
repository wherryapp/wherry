// NotificationNames on the JVM: what an opened `e` may name, what the
// label map keeps, and the title and text a notification gets
// (docs/prompts/notification-names-plan.md §1.3, §1.4).

package app.wherry.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationNamesTest {
  private val direct = "0192f3a0-0000-7000-8000-000000000001"
  private val group = "0192f3a0-0000-7000-8000-000000000002"
  private val alice = "0192f3a0-0000-7000-8000-0000000000aa"
  private val bob = "0192f3a0-0000-7000-8000-0000000000bb"

  private val labels = Labels.of(
    listOf(
      direct to ConversationLabel("Alice", false),
      group to ConversationLabel("Hiking", true),
    ),
    listOf(alice to "Alice"),
  )

  // -- the gate ---------------------------------------------------------------

  @Test fun namesTheIdsOfAWellFormedBody() {
    val decision = NamesGate.decide("message", mapOf("w" to "1", "k" to "message", "conv" to group, "from" to alice))
    assertEquals(NamesDecision.Named(NamedIds(group, alice)), decision)
  }

  @Test fun refusesABodyThatDidNotOpen() {
    assertEquals(NamesDecision.Refuse("unopened"), NamesGate.decide("message", null))
  }

  @Test fun refusesAnInnerKindThatIsNotTheOuterOne() {
    val fields = mapOf("w" to "1", "k" to "mention", "conv" to group)
    assertEquals(NamesDecision.Refuse("kind"), NamesGate.decide("message", fields))
  }

  @Test fun refusesAnUnknownFormatOrAConversationThatIsNotAnId() {
    assertEquals(
      NamesDecision.Refuse("format"),
      NamesGate.decide("message", mapOf("w" to "2", "k" to "message", "conv" to group)),
    )
    assertEquals(
      NamesDecision.Refuse("format"),
      NamesGate.decide("message", mapOf("w" to "1", "k" to "message", "conv" to "Alice")),
    )
  }

  @Test fun aSenderThatIsNotAnIdIsDroppedNotTheConversation() {
    val decision = NamesGate.decide("message", mapOf("w" to "1", "k" to "message", "conv" to group, "from" to "x"))
    assertEquals(NamesDecision.Named(NamedIds(group, null)), decision)
  }

  // -- the text ---------------------------------------------------------------

  @Test fun aDirectMessageIsTitledWithTheConversation() {
    val text = NamedText.compose("message", "New message", NamedIds(direct, alice), labels, locked = false)
    assertEquals("Alice", text.title)
    assertEquals("New message", text.text)
    assertTrue(text.named)
  }

  @Test fun aGroupMessageNamesTheSenderInTheText() {
    val text = NamedText.compose("mention", "New mention", NamedIds(group, alice), labels, locked = false)
    assertEquals("Hiking", text.title)
    assertEquals("Alice: New mention", text.text)
  }

  @Test fun anUnknownSenderIsOmitted() {
    val text = NamedText.compose("message", "New message", NamedIds(group, bob), labels, locked = false)
    assertEquals("Hiking", text.title)
    assertEquals("New message", text.text)
  }

  @Test fun anUnknownConversationFallsBackToTheFixedText() {
    val text = NamedText.compose(
      "message", "New message", NamedIds("0192f3a0-0000-7000-8000-00000000ffff", alice), labels, locked = false,
    )
    assertNull(text.title)
    assertEquals("New message", text.text)
    assertEquals("no label", text.why)
  }

  @Test fun lockedIsNamelessWhateverTheLabels() {
    val text = NamedText.compose("message", "New message", NamedIds(group, alice), labels, locked = true)
    assertNull(text.title)
    assertEquals("New message", text.text)
    assertEquals("locked", text.why)
  }

  @Test fun noIdsOrAnUnnamedKindIsTheFixedText() {
    assertEquals(NamedText.Text(null, "New message", "no ids"), NamedText.compose("message", "New message", null, labels, false))
    assertEquals(
      NamedText.Text(null, "New contact request", "kind"),
      NamedText.compose("contact_request", "New contact request", NamedIds(direct, alice), labels, false),
    )
  }

  @Test fun theEmptyMapNamesNothing() {
    val text = NamedText.compose("message", "New message", NamedIds(direct, alice), Labels.EMPTY, locked = false)
    assertEquals(NamedText.Text(null, "New message", "no label"), text)
  }

  // -- the label map ----------------------------------------------------------

  @Test fun theMapKeepsIdsOnlyTrimsAndDropsBlankNames() {
    val map = Labels.of(
      listOf(
        direct to ConversationLabel("  Alice  ", false),
        "not-an-id" to ConversationLabel("Nope", false),
        group to ConversationLabel("   ", true),
      ),
      listOf(alice to "Alice", "x" to "X", bob to ""),
    )
    assertEquals(mapOf(direct to ConversationLabel("Alice", false)), map.conversations)
    assertEquals(mapOf(alice to "Alice"), map.users)
  }

  @Test fun theMapIsCapped() {
    fun id(i: Int) = "0192f3a0-0000-7000-8000-%012d".format(i)
    val many = Labels.of(
      (0 until Labels.MAX_CONVERSATIONS + 10).map { id(it) to ConversationLabel("c$it", false) },
      (0 until Labels.MAX_USERS + 10).map { id(it) to "u$it" },
    )
    assertEquals(Labels.MAX_CONVERSATIONS, many.conversations.size)
    assertEquals(Labels.MAX_USERS, many.users.size)
    val long = Labels.of(listOf(direct to ConversationLabel("a".repeat(500), false)), emptyList())
    assertEquals(Labels.MAX_NAME_CHARS, long.conversations.getValue(direct).label.length)
  }
}
