// Names in notifications (docs/prompts/notification-names-plan.md), the
// decisions only, with no Android API so NotificationNamesTest runs them on
// the JVM.
//
// A message, mention or missed-call push carries `e`: the conversation id and
// the sender's user id, encrypted to this device by the server exactly as a
// ring is (PushDispatch opens it with RingKeys). No name crosses the wire.
// The page writes a label map (`set_labels`, LabelStore) from the names it
// already shows, and this file turns the two ids into a title and a text:
//
//   direct             title = the conversation's label, text = "New message"
//   group or channel   title = the conversation's label,
//                      text = "<sender>: New message" (sender omitted if unknown)
//
// Anything missing -- no `e`, an `e` that did not open or whose inner kind is
// not the outer one, no label for the conversation -- falls back to the fixed
// text of the §2 table, silently. And while the device is locked behind a
// PIN, pattern or password the text is the fixed one whatever the labels
// say (plan §1.4); see PushRenderer for why that is decided at post time.

package app.wherry.push

internal data class ConversationLabel(val label: String, val group: Boolean)

/** The page's label map, sanitised: ids only, names trimmed and bounded,
 *  blank ones dropped, both maps capped. */
internal class Labels private constructor(
  val conversations: Map<String, ConversationLabel>,
  val users: Map<String, String>,
) {
  companion object {
    /** phone-rules.ts's MAX_LABELS: the page never sends more. */
    const val MAX_CONVERSATIONS = 500

    /** native-push-rules.ts's MAX_LABEL_USERS. */
    const val MAX_USERS = 1000

    /** A label longer than this is cut; a notification title shows less. */
    const val MAX_NAME_CHARS = 200

    val EMPTY = Labels(emptyMap(), emptyMap())

    private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    fun isId(value: String?): Boolean = value != null && UUID.matches(value)

    private fun clean(name: String?): String? =
      name?.trim()?.take(MAX_NAME_CHARS)?.takeIf { it.isNotEmpty() }

    fun of(
      conversations: Iterable<Pair<String, ConversationLabel>>,
      users: Iterable<Pair<String, String>>,
    ): Labels {
      val c = LinkedHashMap<String, ConversationLabel>()
      for ((id, value) in conversations) {
        if (c.size >= MAX_CONVERSATIONS) break
        val label = clean(value.label) ?: continue
        if (isId(id)) c[id] = ConversationLabel(label, value.group)
      }
      val u = LinkedHashMap<String, String>()
      for ((id, name) in users) {
        if (u.size >= MAX_USERS) break
        val clean = clean(name) ?: continue
        if (isId(id)) u[id] = clean
      }
      return Labels(c, u)
    }
  }
}

/** The ids an opened `e` names. */
internal data class NamedIds(val conversation: String, val sender: String?)

internal sealed class NamesDecision {
  data class Named(val ids: NamedIds) : NamesDecision()

  /** `reason` is logged (never the ids): `unopened`, `kind`, `format`. */
  data class Refuse(val reason: String) : NamesDecision()
}

internal object NamesGate {
  /**
   * The ids in an opened `e` (the server's `{w, k, conv, from}`), or why not:
   * [fields] is null when the body did not open; `w` must be "1"; the inner
   * `k` must be the outer kind the service dispatched on (the server signed
   * it into the ciphertext); `conv` must be an id, and `from`, when present,
   * too. A `from` that is not an id drops the sender, not the conversation.
   */
  fun decide(outerKind: String, fields: Map<String, String>?): NamesDecision {
    if (fields == null) return NamesDecision.Refuse("unopened")
    if (fields["k"] != outerKind) return NamesDecision.Refuse("kind")
    val conversation = fields["conv"]
    if (fields["w"] != "1" || !Labels.isId(conversation)) return NamesDecision.Refuse("format")
    val sender = fields["from"]?.takeIf { Labels.isId(it) }
    return NamesDecision.Named(NamedIds(conversation!!, sender))
  }
}

internal object NamedText {
  /** The kinds a name may be put on: the ones the server seals ids for. */
  private val NAMED_KINDS = setOf("message", "mention", "missed_call")

  /**
   * What one notification says. `why` is for the log line only: `named`,
   * `locked`, `no ids`, `no label` or `kind`; it never carries a name.
   */
  data class Text(val title: String?, val text: String, val why: String) {
    val named: Boolean get() = why == "named"
  }

  fun compose(kind: String, fixed: String, ids: NamedIds?, labels: Labels, locked: Boolean): Text {
    if (kind !in NAMED_KINDS) return Text(null, fixed, "kind")
    if (ids == null) return Text(null, fixed, "no ids")
    if (locked) return Text(null, fixed, "locked")
    val conversation = labels.conversations[ids.conversation] ?: return Text(null, fixed, "no label")
    if (!conversation.group) return Text(conversation.label, fixed, "named")
    val sender = ids.sender?.let { labels.users[it] }
    return Text(conversation.label, if (sender != null) "$sender: $fixed" else fixed, "named")
  }
}
