// The only place Android notification text exists (docs/prompts/native-push-plan.md
// §2, point 1, and §6.2). The server sends a kind and a per-device reference,
// never a name or a sentence, so what the lock screen says is decided here,
// by kind, from the same table the APNs builder uses (server/src/push/payload.ts).
// Since 2026-09-29 a message may be named -- who and which chat, from the
// page's own labels and ids sealed to this device, never what was said
// (NotificationNames.kt, docs/prompts/notification-names-plan.md) -- and the
// fixed text stays the fallback and the lock screen's version.
//
// Channels: this plugin owns `messages`, `calls` (missed calls, and the
// generic incoming call when no calls plugin takes a ring) and `other`
// (contacts). The phone-calls plan owns `ringing` and `ongoing_call`; nothing
// here posts on them (coordination §4, *Android*).

package app.wherry.push

import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

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
   * notification-names-plan.md §1.3). **Never on a secure lock screen**
   * (§1.4), by three layers, because Android gives an app no way to make the
   * lock screen show a public version while the person's "sensitive content"
   * setting says show all (an app-created channel's lockscreen visibility is
   * overwritten by the system, `PreferencesHelper.createNotificationChannel`;
   * batch 0929's lockscreen finding):
   *
   * 1. At post: while [nameHidden] the notification is posted nameless.
   * 2. On a lock-state change the process hears (screen off, screen on,
   *    unlock, the activity coming to the front: [refresh]) every tracked
   *    notification still showing is posted again, quietly, named or not
   *    as the new state says.
   * 3. A named notification is VISIBILITY_SECRET where a lock is set
   *    (measured on API 36: SystemUI then hides it on the lock screen even
   *    with "show all content" on; SECRET would hide it on a swipe keyguard
   *    too, so a phone with no lock keeps PRIVATE): should (2) miss the screen
   *    going off -- the process dead, or cached and its broadcast deferred
   *    (Android 14+) -- the secure lock screen hides it rather than show a
   *    name. A nameless one is VISIBILITY_PRIVATE with the fixed-text public
   *    version, so the lock screen still says "New message".
   *
   * A swipe keyguard is no privacy boundary (anyone can swipe it), so it
   * counts as unlocked, as the OS's own public mode does.
   *
   * [quiet] re-posts without sound or heads-up (a message is not insistent,
   * so setOnlyAlertOnce is right here; a ring's re-post must not use it).
   */
  fun show(context: Context, kind: String, ref: String?, ids: NamedIds? = null, quiet: Boolean = false): Boolean {
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
    val hidden = if (ids != null) nameHidden(context) else false
    val text = NamedText.compose(kind, fixed, ids, labels, hidden)
    if (ids != null) ensureLockReceiver(context)
    val builder = NotificationCompat.Builder(context, channelFor(group))
      .setSmallIcon(R.drawable.ic_stat_wherry)
      .setContentText(text.text)
      .setAutoCancel(true)
      .setOnlyAlertOnce(quiet)
      .setVisibility(
        // SECRET hides a notification on a swipe keyguard too (measured on
        // API 36), so it is used only where a lock is set: a phone with no
        // secure lock keeps its named notification on the lock screen.
        if (text.named && keyguardSecure(context)) {
          NotificationCompat.VISIBILITY_SECRET
        } else {
          NotificationCompat.VISIBILITY_PRIVATE
        },
      )
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
      Log.i(TAG, "posted $kind on ${channelFor(group)} (${text.why}${if (quiet) ", renamed" else ""})")
      // Tracked for [refresh] only while the newest post under this tag is
      // one the lock state decides; any other post replaced it, and a late
      // refresh must not bring the older ids back over it.
      if (ids != null && (text.why == "named" || text.why == "locked")) {
        track(Tracked(kind, ref, ids, tag, idFor(group), text.named))
      } else {
        untrack(tag)
      }
      true
    } catch (e: SecurityException) {
      // POST_NOTIFICATIONS refused between the check and the post.
      Log.i(TAG, "not posted: ${e.javaClass.simpleName}")
      false
    }
  }

  /**
   * Whether a name must not be shown now: the device is locked behind a
   * PIN, pattern or password (API 22's `isDeviceLocked`), or the screen is
   * off with such a lock set, since the next thing shown is the lock screen
   * and `isDeviceLocked` lags the screen going off (the calls plugin's rule,
   * measured on API 36 in batch 0929's lockscreen finding). A swipe keyguard
   * and an unlocked phone are false.
   */
  private fun nameHidden(context: Context): Boolean {
    val keyguard = context.getSystemService(KeyguardManager::class.java) ?: return true
    if (keyguard.isDeviceLocked) return true
    val power = context.getSystemService(PowerManager::class.java) ?: return keyguard.isKeyguardSecure
    return keyguard.isKeyguardSecure && !power.isInteractive
  }

  /** A PIN, pattern or password is set (whether or not locked now). */
  private fun keyguardSecure(context: Context): Boolean =
    context.getSystemService(KeyguardManager::class.java)?.isKeyguardSecure ?: true

  // MARK: - Named or not as the lock state changes

  /** A notification whose name depends on the lock state: posted named, or
   *  nameless only because the phone was locked. Process memory only: a
   *  process that dies leaves the notification as last posted, which layer
   *  3 of [show] (VISIBILITY_SECRET on a named one) keeps off the lock
   *  screen. */
  private data class Tracked(
    val kind: String,
    val ref: String?,
    val ids: NamedIds,
    val tag: String,
    val id: Int,
    val named: Boolean,
  )

  private val tracked = LinkedHashMap<String, Tracked>()
  private var lockReceiver: BroadcastReceiver? = null

  @Synchronized
  private fun track(entry: Tracked) {
    tracked[entry.tag] = entry
  }

  @Synchronized
  private fun untrack(tag: String) {
    tracked.remove(tag)
  }

  /**
   * Listens, for the life of the process, for the three broadcasts a lock
   * state change sends. **Exported on purpose** (batch 0929's lockscreen
   * finding): USER_PRESENT is sent by SystemUI's uid, and a not-exported
   * runtime receiver never gets it; all three are protected broadcasts, so
   * no app can send them. Best effort: Android 14+ defers broadcasts to a
   * cached process, which is what layer 3 is for.
   */
  @Synchronized
  fun ensureLockReceiver(context: Context) {
    if (lockReceiver != null) return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        refresh(context, intent.action ?: "?")
      }
    }
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_USER_PRESENT)
      addAction(Intent.ACTION_SCREEN_ON)
      addAction(Intent.ACTION_SCREEN_OFF)
    }
    try {
      ContextCompat.registerReceiver(context.applicationContext, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
      lockReceiver = receiver
    } catch (e: Exception) {
      Log.w(TAG, "lock receiver not registered: ${e.javaClass.simpleName}")
    }
  }

  /**
   * Posts again, quietly, every tracked notification still showing whose
   * name the lock state now says otherwise: named ones nameless when the
   * screen goes off behind a secure lock, nameless ones named at the unlock.
   * [why] is for the log line.
   */
  fun refresh(context: Context, why: String) {
    val hidden = nameHidden(context)
    val stale: List<Tracked>
    synchronized(this) {
      stale = tracked.values.filter { it.named == hidden }
    }
    if (stale.isEmpty()) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val showing = manager.activeNotifications.map { it.tag to it.id }.toSet()
    var count = 0
    for (entry in stale) {
      if ((entry.tag to entry.id) !in showing) {
        untrack(entry.tag)
        continue
      }
      show(context, entry.kind, entry.ref, entry.ids, quiet = true)
      count += 1
    }
    // Rows read this line: how many, and which way, never a name.
    Log.i(TAG, "posted again ${if (hidden) "nameless" else "named"}: $count ($why)")
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
