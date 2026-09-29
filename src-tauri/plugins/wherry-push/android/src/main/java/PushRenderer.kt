// The only place Android notification text exists (docs/prompts/native-push-plan.md
// §2, point 1, and §6.2). The server sends a kind and a per-device reference,
// never a name or a sentence, so what the lock screen says is decided here,
// by kind, from the same table the APNs builder uses (server/src/push/payload.ts).
// Since 2026-09-29 a message may be named -- who and which chat, from the
// page's own labels and ids sealed to this device, never what was said
// (NotificationNames.kt, docs/prompts/notification-names-plan.md) -- and the
// fixed text stays the fallback and the public version.
//
// Channels: this plugin owns `messages`, `calls` (missed calls, and the
// generic incoming call when no calls plugin takes a ring) and `other`
// (contacts). The phone-calls plan owns `ringing` and `ongoing_call`; nothing
// here posts on them (coordination §4, *Android*).

package app.wherry.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

internal object PushRenderer {
  private const val TAG = "wherry-push"

  /** The tap's action; PushPlugin reads it in `load` and `onNewIntent`.
   *  tauri-plugin-notification ignores every action but ACTION_MAIN. */
  const val ACTION_OPEN = "app.wherry.push.OPEN"
  const val EXTRA_KIND = "k"
  const val EXTRA_REF = "r"

  private const val CHANNEL_MESSAGES = "messages"
  private const val CHANNEL_CALLS = "calls"
  private const val CHANNEL_OTHER = "other"

  // One id per kind group; the tag carries the conversation. So a second
  // message for a conversation replaces the first (web's `tag`), and a missed
  // call replaces its ring (the server's `call.<ref>` collapse id, §4.4).
  private const val ID_MESSAGE = 1
  private const val ID_CALL = 2
  private const val ID_CONTACT = 3

  /** How long the generic incoming call stays when nothing ends it: the
   *  ring's own 45 s (`voice.ts`), since a dropped `ring_ended` cannot. */
  private const val RING_TIMEOUT_MS = 45_000L

  enum class Group { MESSAGE, CALL, CONTACT }

  /** The §2 table. An unknown kind (a newer server) reads as a message,
   *  the same rule as the page's `parseOpen`. */
  fun textFor(kind: String): String = when (kind) {
    "mention" -> "New mention"
    "call" -> "Incoming call"
    "missed_call" -> "Missed call"
    "contact_request" -> "New contact request"
    "contact_accepted" -> "Contact request accepted"
    else -> "New message"
  }

  fun groupFor(kind: String): Group = when (kind) {
    "call", "missed_call" -> Group.CALL
    "contact_request", "contact_accepted" -> Group.CONTACT
    else -> Group.MESSAGE
  }

  /** The notification's tag: the reference for a conversation, `call.` plus
   *  it for calls, `contact` for contacts (which carry no reference). */
  fun tagFor(group: Group, ref: String?): String = when (group) {
    Group.CONTACT -> "contact"
    Group.CALL -> "call." + (ref ?: "generic")
    Group.MESSAGE -> ref ?: "message"
  }

  private fun idFor(group: Group): Int = when (group) {
    Group.MESSAGE -> ID_MESSAGE
    Group.CALL -> ID_CALL
    Group.CONTACT -> ID_CONTACT
  }

  private fun channelFor(group: Group): String = when (group) {
    Group.MESSAGE -> CHANNEL_MESSAGES
    Group.CALL -> CHANNEL_CALLS
    Group.CONTACT -> CHANNEL_OTHER
  }

  /** Creates the three channels; idempotent (Android keeps a channel's
   *  first settings, so re-creating one changes nothing the person set). */
  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH),
    )
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_CALLS, "Calls", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Missed calls, and incoming calls this build cannot ring for"
      },
    )
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_OTHER, "Contacts", NotificationManager.IMPORTANCE_DEFAULT),
    )
  }

  /**
   * Posts the notification for one kind. Returns false when nothing was
   * posted (notifications off, or the permission refused).
   *
   * [ids] are what `e` named (PushDispatch): with a label for the
   * conversation, the notification is named (NamedText,
   * notification-names-plan.md §1.3).
   */
  fun show(context: Context, kind: String, ref: String?, ids: NamedIds? = null): Boolean {
    ensureChannels(context)
    val compat = NotificationManagerCompat.from(context)
    if (!compat.areNotificationsEnabled()) {
      Log.i(TAG, "not posted: notifications are off for this app")
      return false
    }
    val group = groupFor(kind)
    val tag = tagFor(group, ref)
    val fixed = textFor(kind)
    val labels = if (ids != null) LabelStore.get(context) else Labels.EMPTY
    val text = NamedText.compose(kind, fixed, ids, labels)
    val builder = NotificationCompat.Builder(context, channelFor(group))
      .setSmallIcon(R.drawable.ic_stat_wherry)
      .setContentText(text.text)
      .setAutoCancel(true)
      // The lock screen follows Android's sensitive-content setting through
      // this nameless public version (the maintainer's decision, 2026-09-29).
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(
        NotificationCompat.Builder(context, channelFor(group))
          .setSmallIcon(R.drawable.ic_stat_wherry)
          .setContentText(fixed)
          .build(),
      )
      .setCategory(
        when (group) {
          Group.CALL -> NotificationCompat.CATEGORY_MISSED_CALL
          Group.CONTACT -> NotificationCompat.CATEGORY_SOCIAL
          Group.MESSAGE -> NotificationCompat.CATEGORY_MESSAGE
        },
      )
      .setPriority(
        if (group == Group.CONTACT) NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH,
      )
    text.title?.let { builder.setContentTitle(it) }
    // A ring shown here is the generic fallback: nothing will cancel it, so
    // it goes away by itself when the ring would have.
    if (kind == "call") {
      builder.setCategory(NotificationCompat.CATEGORY_CALL).setTimeoutAfter(RING_TIMEOUT_MS)
    }
    contentIntent(context, kind, ref, tag)?.let { builder.setContentIntent(it) }
    return try {
      compat.notify(tag, idFor(group), builder.build())
      // Rows A-44 onward read this line. `why` never carries a name.
      Log.i(TAG, "posted $kind on ${channelFor(group)} (${text.why})")
      true
    } catch (e: SecurityException) {
      // POST_NOTIFICATIONS refused between the check and the post.
      Log.i(TAG, "not posted: ${e.javaClass.simpleName}")
      false
    }
  }

  /** Removes delivered notifications for a conversation: its messages and
   *  its call notification. Returns how many were showing. */
  fun clear(context: Context, ref: String): Int {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return 0
    val targets = setOf(
      tagFor(Group.MESSAGE, ref) to ID_MESSAGE,
      tagFor(Group.CALL, ref) to ID_CALL,
    )
    val showing = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      manager.activeNotifications.count { (it.tag to it.id) in targets }
    } else {
      0
    }
    for ((tag, id) in targets) manager.cancel(tag, id)
    return showing
  }

  /**
   * The tap: the launch activity (MainActivity, `singleTask`, so a running
   * app gets it in `onNewIntent`) with our action and the kind and reference.
   * The request code is derived from the tag so each notification keeps its
   * own extras under FLAG_UPDATE_CURRENT.
   */
  private fun contentIntent(context: Context, kind: String, ref: String?, tag: String): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.action = ACTION_OPEN
    launch.putExtra(EXTRA_KIND, kind)
    if (ref != null) launch.putExtra(EXTRA_REF, ref)
    return PendingIntent.getActivity(
      context,
      tag.hashCode(),
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }
}
