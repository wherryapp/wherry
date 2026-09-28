// A2's ring (docs/prompts/phone-calls-plan.md §6.2): the incoming-call
// notification over the lock screen, and its end.
//
// Three ways in, one handler:
//   - the push: the push plugin's one FirebaseMessagingService opens the
//     ring (M-1 = E) and forwards its plaintext fields to
//     IncomingCallReceiver as an explicit broadcast (coordination §4, R9);
//   - the page: `reportIncoming` for a ring that came over the socket, and
//     `reportEnded` when it goes;
//   - debug builds: DebugPushReceiver (adb) and `debugIncoming` (the page's
//     console), which run the push path on plaintext fields.
// The fields are the plan's §4.2 closed set, each a string as FCM's data map
// is: `w`, `k`, `call`, `conv`, `dev`, `group`, `exp`, `dsig` for a ring;
// `w`, `k`, `call`, `why` for its end. No name is ever in them (D1): the
// label is the page's (reportIncoming) or the cache it wrote (setLabels),
// else "Wherry call".
//
// One ring UI per device (§2.7): while the activity is resumed the page's
// sheet rings and nothing is posted; a ring already posted is withdrawn when
// the page reports it in front. "Is the activity resumed" is the one
// decision made here, because it must be made when the page may not exist.
package app.wherry.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person

internal data class Ring(
    val callId: String,
    val conversationId: String?,
    /** This device's id as the server signed it into `dsig`. */
    val deviceId: String?,
    val group: Boolean,
    /** When the ring window closes, seconds since the epoch. */
    val exp: Long,
    /** The signed decline token; null when the page reported the ring, or
     *  the server has no CALL_ACTION_SECRET. */
    val dsig: String?,
    /** The page's label; null for a pushed ring (looked up in the cache). */
    val label: String?,
)

internal object RingHandler {
    /** This plugin's channel (coordination §4: CALLS owns `ringing` and
     *  `ongoing_call`). A channel's sound is fixed at creation, so a change
     *  to it is a new id, never an edit of this one. */
    const val CHANNEL_RINGING = "ringing"

    /** One id; the tag carries the call (`ring.<callId>`), so a second
     *  ring replaces nothing of the first and A-62 reads the tag's absence. */
    const val NOTIFICATION_ID = 0x7716
    private const val TAG_PREFIX = "ring."

    /** Calls whose ring is over here, so a late or duplicate ring for one is
     *  not posted again (a `ring_ended` can overtake its ring). Per process:
     *  after a kill, `exp` is the backstop. */
    private const val ENDED_KEPT = 64
    private val ended = LinkedHashSet<String>()
    private val rings = LinkedHashMap<String, Ring>()

    // -- ways in ------------------------------------------------------------

    /**
     * A push's plaintext fields (IncomingCallReceiver, DebugPushReceiver,
     * `debugIncoming`). Answers whether a ring notification is now posted.
     */
    fun fromPush(context: Context, fields: Map<String, String>, source: String): Boolean {
        val version = fields["w"]
        if (version != null && version != "1") {
            Log.w(TAG, "[wherry] calls: $source push dropped: payload version $version")
            return false
        }
        val callId = fields["call"]
        if (!Ids.isId(callId)) {
            Log.w(TAG, "[wherry] calls: $source push dropped: no call id")
            return false
        }
        callId!!
        return when (val kind = fields["k"]) {
            "call_ring" -> {
                val exp = fields["exp"]?.toLongOrNull()
                if (exp == null) {
                    Log.w(TAG, "[wherry] calls: $source ring dropped: no exp")
                    return false
                }
                val ring = Ring(
                    callId = callId,
                    conversationId = fields["conv"]?.takeIf { Ids.isId(it) },
                    deviceId = fields["dev"]?.takeIf { Ids.isId(it) },
                    group = fields["group"] == "true",
                    exp = exp,
                    dsig = fields["dsig"]?.takeIf { Ids.isSig(it) },
                    label = null,
                )
                ring(context, ring, source)
            }
            "ring_ended" -> {
                end(context, callId, fields["why"] ?: "ended", source)
                false
            }
            else -> {
                Log.w(TAG, "[wherry] calls: $source push dropped: kind $kind")
                false
            }
        }
    }

    /** `reportIncoming`: a ring that reached the page over the socket.
     *  Answers `shown` (phone-calls.ts's IncomingAnswer). */
    fun fromPage(context: Context, ring: Ring): Boolean = ring(context, ring, "page")

    /**
     * Posts the ring unless it is over, stale, or the activity is in front.
     * A ring already known (the push and the socket both bring one) is
     * merged: the push's decline token and device, the page's label.
     */
    @Synchronized
    private fun ring(context: Context, incoming: Ring, source: String): Boolean {
        val callId = incoming.callId
        if (callId in ended) {
            Log.i(TAG, "[wherry] calls: $source ring dropped: call=$callId already ended here")
            return false
        }
        val now = System.currentTimeMillis()
        if (incoming.exp * 1000 <= now) {
            Log.i(TAG, "[wherry] calls: $source ring dropped: stale (exp passed ${(now - incoming.exp * 1000) / 1000} s ago)")
            return false
        }
        val known = rings[callId]
        val ring = if (known == null) incoming else incoming.copy(
            conversationId = incoming.conversationId ?: known.conversationId,
            deviceId = incoming.deviceId ?: known.deviceId,
            dsig = incoming.dsig ?: known.dsig,
            label = incoming.label ?: known.label,
            exp = maxOf(incoming.exp, known.exp),
        )
        rings[callId] = ring
        if (CallLifecycle.resumed) {
            // The page's sheet rings; a ring posted before the activity came
            // to the front (a full-screen launch, or a tap) is withdrawn, so
            // the notification's ringtone does not play over the page's.
            val withdrawn = cancel(context, callId)
            Log.i(TAG, "[wherry] calls: $source ring in front: the page rings call=$callId${if (withdrawn) " (posted ring withdrawn)" else ""}")
            return false
        }
        return post(context, ring, source)
    }

    /** `ring_ended` from the push, `reportEnded` from the page, or this
     *  plugin's own Answer and Decline. Cancels the ring; never the ongoing
     *  call's notification, which is CallService's. */
    @Synchronized
    fun end(context: Context, callId: String, reason: String, source: String) {
        remember(callId)
        rings.remove(callId)
        val cancelled = cancel(context, callId)
        Log.i(TAG, "[wherry] calls: ring ended call=$callId ($reason, from $source)${if (cancelled) ", notification cancelled" else ""}")
        RingLaunch.ringEnded(callId, answered = reason == "answered")
    }

    /** The ring this device's Answer or Decline acted on, for the decline
     *  token (CallActionReceiver) and the conversation (the Answer). */
    @Synchronized
    fun known(callId: String): Ring? = rings[callId]

    /** Sign-out: every ring still posted goes, and nothing of it stays. */
    @Synchronized
    fun reset(context: Context) {
        rings.clear()
        val manager = context.getSystemService(NotificationManager::class.java)
        var count = 0
        if (manager != null) {
            for (active in manager.activeNotifications) {
                if (active.id == NOTIFICATION_ID && active.tag?.startsWith(TAG_PREFIX) == true) {
                    manager.cancel(active.tag, NOTIFICATION_ID)
                    count += 1
                }
            }
        }
        Log.i(TAG, "[wherry] calls: rings reset ($count cancelled)")
    }

    private fun remember(callId: String) {
        ended.remove(callId)
        ended.add(callId)
        while (ended.size > ENDED_KEPT) ended.remove(ended.first())
    }

    private fun cancel(context: Context, callId: String): Boolean {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        val tag = TAG_PREFIX + callId
        val present = manager.activeNotifications.any { it.id == NOTIFICATION_ID && it.tag == tag }
        manager.cancel(tag, NOTIFICATION_ID)
        return present
    }

    // -- the notification -----------------------------------------------------

    private fun post(context: Context, ring: Ring, source: String): Boolean {
        val compat = NotificationManagerCompat.from(context)
        if (!compat.areNotificationsEnabled()) {
            // Refused notifications: nothing native can ring, so the page must.
            Log.w(TAG, "[wherry] calls: $source ring not posted: notifications are off")
            return false
        }
        ensureChannel(context)
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        if (Build.VERSION.SDK_INT >= 34 && !manager.canUseFullScreenIntent()) {
            // Android 14+ grants USE_FULL_SCREEN_INTENT only to calling and
            // alarm apps: without it the ring is a heads-up, and a locked
            // phone lights its screen for the notification but shows no
            // call screen.
            Log.w(TAG, "[wherry] calls: full-screen intent not permitted; the ring is a heads-up")
        }

        val unnamed = context.getString(R.string.wherry_calls_unnamed)
        val label = ring.label?.takeIf { it.isNotBlank() }
            ?: CallsStore.label(context, ring.conversationId)
            ?: unnamed
        val show = RingLaunch.pendingIntent(context, RingLaunch.SHOW, ring) ?: return false
        val answer = RingLaunch.pendingIntent(context, RingLaunch.ANSWER, ring) ?: return false
        val decline = declineIntent(context, ring) ?: return false
        val delayMs = maxOf(1_000L, ring.exp * 1000 - System.currentTimeMillis())

        val notification = try {
            build(context, CHANNEL_RINGING, label, show, answer, decline, delayMs, unnamed)
        } catch (e: Exception) {
            // IllegalArgumentException from CallStyle's own checks is the
            // one foreseen; any failure leaves the page ringing.
            Log.w(TAG, "[wherry] calls: $source ring not built: $e")
            return false
        }
        return try {
            manager.notify(TAG_PREFIX + ring.callId, NOTIFICATION_ID, notification)
            Log.i(TAG, "[wherry] calls: $source ring posted call=${ring.callId} on $CHANNEL_RINGING (${if (ring.dsig != null) "signed decline" else "decline through the page"}, ${delayMs / 1000} s)")
            true
        } catch (e: Exception) {
            Log.w(TAG, "[wherry] calls: $source ring not posted: $e")
            false
        }
    }

    private fun build(
        context: Context,
        channel: String,
        label: String,
        show: PendingIntent,
        answer: PendingIntent,
        decline: PendingIntent,
        timeoutMs: Long,
        unnamed: String,
    ): Notification {
        val incoming = context.getString(R.string.wherry_calls_incoming)
        // The lock screen's version names nobody (the label is a
        // conversation's name, and whoever holds a locked phone sees it),
        // and keeps both buttons, so a lock screen that hides notification
        // content still offers Answer and Decline.
        val public = base(context, channel, show, timeoutMs)
            .setStyle(
                NotificationCompat.CallStyle.forIncomingCall(
                    Person.Builder().setName(unnamed).build(),
                    decline,
                    answer,
                ),
            )
            .setContentText(incoming)
            .build()
        val person = Person.Builder().setName(label).setImportant(true).build()
        val notification = base(context, channel, show, timeoutMs)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer))
            .setContentText(incoming)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .build()
        // The ringtone repeats until the ring is answered, declined, ended
        // or times out, as a phone's does; the channel's sound plays it.
        notification.flags = notification.flags or Notification.FLAG_INSISTENT
        return notification
    }

    private fun base(
        context: Context,
        channel: String,
        show: PendingIntent,
        timeoutMs: Long,
    ): NotificationCompat.Builder =
        NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.wherry_calls_ongoing)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            // Over the lock screen: the activity, whose sheet rings. Never the
            // Answer: the system launches a full-screen intent by itself when
            // the screen is off or locked, so an Answer here would pick up
            // every call unasked.
            .setFullScreenIntent(show, true)
            .setContentIntent(show)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(timeoutMs)

    /**
     * Decline without opening the app when it can: a broadcast whose receiver
     * posts the signed decline (§2.5), or hands the press to a page that is
     * listening. Otherwise (no token, and no page to carry it) it opens the
     * app with the press, the plan's fallback: a receiver may not start an
     * activity from a notification on Android 12+.
     */
    private fun declineIntent(context: Context, ring: Ring): PendingIntent? {
        val signed = ring.dsig != null && ring.deviceId != null && CallsStore.apiBase(context) != null
        return if (signed || CallActions.live()) {
            CallActionReceiver.declineIntent(context, ring, signed)
        } else {
            RingLaunch.pendingIntent(context, RingLaunch.DECLINE, ring)
        }
    }

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_RINGING) != null) return
        val channel = NotificationChannel(
            CHANNEL_RINGING,
            context.getString(R.string.wherry_calls_channel_ringing),
            NotificationManager.IMPORTANCE_HIGH,
        )
        channel.description = context.getString(R.string.wherry_calls_channel_ringing_description)
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), attributes)
        channel.enableVibration(true)
        channel.vibrationPattern = longArrayOf(0, 1000, 1000)
        channel.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }
}
