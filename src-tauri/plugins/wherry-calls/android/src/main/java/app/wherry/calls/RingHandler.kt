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
// One ring UI per device (§2.7): while the activity is in front (resumed,
// its window focused, as the page tests it) the page's sheet rings and nothing is
// posted. A ring posted while the page was alive but not in front, and that
// the page has reported, is withdrawn when the activity comes to the front
// (the page's sheet then rings with its tone) and posted again if the person
// leaves while it still rings: the page answered `shown: true` for it and
// will not ring it in the background. "Is the activity in front" is the one
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

    /** Rings whose notification this plugin posted and has not taken away. */
    private val posted = HashSet<String>()

    /** Posted rings withdrawn because the activity came to the front and
     *  the page holds them: posted again if the person leaves (`left`). */
    private val held = HashSet<String>()

    /** Rings the page rings itself: it reported them while the activity was
     *  in front, was answered `shown: false`, and so sounds and notifies for
     *  them on its own (phone-rules.ts's pageRingDuties). A later push for
     *  one is not posted, or the phone would ring twice. */
    private val pageOwned = HashSet<String>()

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
                // The token is the three fields the server signed together
                // (`dev`, `exp`, `dsig`), kept together from here on.
                val dev = fields["dev"]?.takeIf { Ids.isId(it) }
                val sig = fields["dsig"]?.takeIf { Ids.isSig(it) }
                val ring = Ring(
                    callId = callId,
                    conversationId = fields["conv"]?.takeIf { Ids.isId(it) },
                    group = fields["group"] == "true",
                    exp = exp,
                    token = if (dev != null && sig != null) DeclineToken(dev, exp, sig) else null,
                    label = null,
                    pageKnown = false,
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
    fun fromPage(context: Context, ring: Ring): Boolean = ring(context, ring.copy(pageKnown = true), "page")

    /**
     * Posts the ring unless it is over, stale, the page rings it, or the
     * activity is in front. A ring already known (the push and the socket
     * both bring one) is merged (`Ring.mergedWith`): the push's decline
     * token whole, the page's label, the later `exp` for the timeout.
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
        val ring = incoming.mergedWith(rings[callId])
        rings[callId] = ring
        if (callId in pageOwned) {
            Log.i(TAG, "[wherry] calls: $source ring not posted: the page rings call=$callId")
            return false
        }
        if (CallLifecycle.inFront()) {
            // The page's sheet rings; a ring posted before the activity came
            // to the front (a full-screen launch, or a tap) is withdrawn, so
            // the notification's ringtone does not play over the page's.
            val withdrawn = cancel(context, callId)
            held.remove(callId)
            if (incoming.pageKnown) pageOwned.add(callId)
            Log.i(TAG, "[wherry] calls: $source ring in front: the page rings call=$callId${if (withdrawn) " (posted ring withdrawn)" else ""}")
            return false
        }
        if (callId in held) {
            // Withdrawn for the page a moment ago, and the activity has left
            // the front since: `left` posts it again.
            return true
        }
        return post(context, ring, source)
    }

    /**
     * The activity came to the front (CallLifecycle). A posted ring the page
     * has reported is withdrawn: the page's bridge was answered `shown: true`
     * for it, so its sheet now rings with its own tone, and the insistent
     * ringtone would play over it until the ring ends (the bridge reports a
     * ring once, so no later report withdraws it). A ring only a push
     * brought stays: its page may not be signed in, and the notification's
     * buttons are then the only way to answer it.
     */
    @Synchronized
    fun pageInFront(context: Context) {
        if (posted.isEmpty()) return
        for (callId in posted.toList()) {
            if (rings[callId]?.pageKnown != true) continue
            cancel(context, callId)
            held.add(callId)
            Log.i(TAG, "[wherry] calls: ring withdrawn in front: the page rings call=$callId")
        }
    }

    /** The activity has left the front (CallLifecycle, after a settle). A
     *  ring withdrawn for the page and still ringing is posted again: the
     *  page was answered `shown: true` for it and does not ring it in the
     *  background. */
    @Synchronized
    fun left(context: Context) {
        if (held.isEmpty()) return
        val now = System.currentTimeMillis()
        for (callId in held.toList()) {
            held.remove(callId)
            val ring = rings[callId] ?: continue
            if (callId in ended || ring.exp * 1000 <= now) continue
            if (!post(context, ring, "left")) {
                Log.w(TAG, "[wherry] calls: ring not posted again on leaving call=$callId")
            }
        }
    }

    /** `ring_ended` from the push, `reportEnded` from the page, or this
     *  plugin's own Answer and Decline. Cancels the ring; never the ongoing
     *  call's notification, which is CallService's. */
    @Synchronized
    fun end(context: Context, callId: String, reason: String, source: String) {
        remember(callId)
        rings.remove(callId)
        held.remove(callId)
        pageOwned.remove(callId)
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
        posted.clear()
        held.clear()
        pageOwned.clear()
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
        posted.remove(callId)
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
        val tag = TAG_PREFIX + ring.callId
        val how = if (ring.token != null) "signed decline" else "decline through the page"

        // CallStyle first. The platform refuses a CallStyle notification
        // that is neither a foreground service's nor carries a full-screen
        // intent (IllegalArgumentException from notify, or from build on an
        // OEM's copy of the check); Android 14+ lets one whose full-screen
        // intent was denied through (FLAG_FSI_REQUESTED_BUT_DENIED). A
        // refusal must not cost the ring: a killed app has no page to ring
        // instead, and the push plugin no longer rings once this plugin's
        // receiver takes the push. So a refused CallStyle is posted again as
        // a plain notification with the same two buttons as actions.
        for (callStyle in listOf(true, false)) {
            val notification = try {
                build(context, CHANNEL_RINGING, label, show, answer, decline, delayMs, unnamed, callStyle)
            } catch (e: Exception) {
                Log.w(TAG, "[wherry] calls: $source ring not built (${if (callStyle) "CallStyle" else "plain"}): $e")
                continue
            }
            try {
                manager.notify(tag, NOTIFICATION_ID, notification)
            } catch (e: Exception) {
                Log.w(TAG, "[wherry] calls: $source ring not posted (${if (callStyle) "CallStyle" else "plain"}): $e")
                continue
            }
            posted.add(ring.callId)
            Log.i(TAG, "[wherry] calls: $source ring posted call=${ring.callId} on $CHANNEL_RINGING (${if (callStyle) "" else "plain, "}$how, ${delayMs / 1000} s)")
            return true
        }
        return false
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
        callStyle: Boolean,
    ): Notification {
        val incoming = context.getString(R.string.wherry_calls_incoming)
        // The lock screen's version names nobody (the label is a
        // conversation's name, and whoever holds a locked phone sees it),
        // and keeps both buttons, so a lock screen that hides notification
        // content still offers Answer and Decline.
        val public = styled(context, base(context, channel, show, timeoutMs), unnamed, false, decline, answer, callStyle)
            .setContentText(incoming)
            .build()
        val notification = styled(context, base(context, channel, show, timeoutMs), label, true, decline, answer, callStyle)
            .setContentText(incoming)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .build()
        // The ringtone repeats until the ring is answered, declined, ended
        // or times out, as a phone's does; the channel's sound plays it.
        notification.flags = notification.flags or Notification.FLAG_INSISTENT
        return notification
    }

    /** The caller line and the two buttons: CallStyle's, or (the fallback)
     *  a title and two actions, Decline first as CallStyle orders them. */
    private fun styled(
        context: Context,
        builder: NotificationCompat.Builder,
        name: String,
        important: Boolean,
        decline: PendingIntent,
        answer: PendingIntent,
        callStyle: Boolean,
    ): NotificationCompat.Builder {
        if (callStyle) {
            val person = Person.Builder().setName(name).setImportant(important).build()
            return builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer))
        }
        return builder
            .setContentTitle(name)
            .addAction(R.drawable.wherry_calls_ongoing, context.getString(R.string.wherry_calls_decline), decline)
            .addAction(R.drawable.wherry_calls_ongoing, context.getString(R.string.wherry_calls_answer), answer)
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
        val token = ring.token?.takeIf { CallsStore.apiBase(context) != null }
        return if (token != null || CallActions.live()) {
            CallActionReceiver.declineIntent(context, ring.callId, ring.conversationId, token)
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
