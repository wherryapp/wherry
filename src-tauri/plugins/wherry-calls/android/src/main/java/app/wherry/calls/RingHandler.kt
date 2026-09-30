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
// leaves while it still rings. A ring the page reported while in front (so
// never posted) is posted too when the person leaves: the page's own tone is
// not relied on in the background, where WebView's pause and the freezer
// stop it within seconds (mobile-2, 2026-10-01). Each of those moves is told
// to the page (`ring-shown`), so its tone plays exactly while nothing native
// rings. "Is the activity in front" is the one decision made here, because
// it must be made when the page may not exist.
package app.wherry.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import java.lang.ref.WeakReference

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

    /** How long a ring that finds the screen off keeps it on (decision 8):
     *  long enough to read the lock screen's ring, and released by the
     *  timeout whatever happens to the ring. After it the screen follows the
     *  lock screen's own timeout. */
    private const val WAKE_MS = 5_000L

    /** Posted rings withdrawn because the activity came to the front and
     *  the page holds them: posted again if the person leaves (`left`). */
    private val held = HashSet<String>()

    /** Rings the page rings itself: it reported them while the activity was
     *  in front and was answered `shown: false`, so its sheet sounds for them
     *  (phone-rules.ts's pageRingDuties; it posts no notification for them).
     *  A later push for one is not posted while the page is in front, or the
     *  phone would ring twice; `left` posts it when the person leaves. */
    private val pageOwned = HashSet<String>()

    /** Where the page hears that the native ring took a ring it reported, or
     *  gave one back to its sheet: the plugin's `ring-shown` event. */
    interface PageSink {
        fun ringShown(callId: String, shown: Boolean)
    }

    private var pageSink: WeakReference<PageSink>? = null

    /** CallsPlugin, once per plugin instance. */
    @Synchronized
    fun attach(sink: PageSink) {
        pageSink = WeakReference(sink)
    }

    /** Best-effort: a page that is not listening re-reads nothing, and its
     *  sheet keeps the answer it had (the tone plays over a posted ring, or
     *  is silent over a withdrawn one, until the ring ends). */
    private fun tellPage(callId: String, shown: Boolean) {
        try {
            pageSink?.get()?.ringShown(callId, shown)
        } catch (e: Exception) {
            Log.w(TAG, "[wherry] calls: ring-shown not sent: $e")
        }
    }

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
            // Declined or ended here already (a signed Decline on the ring,
            // which leaves the page no `decline` to act on): nothing is
            // posted, and the page is told its native side has the ring, as
            // iOS answers for a call CallKit has ended, so its sheet does not
            // ring in front for a call just declined (mobile-4). A push is
            // told nothing was posted.
            Log.i(TAG, "[wherry] calls: $source ring dropped: call=$callId already ended here")
            return incoming.pageKnown
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
            tellPage(callId, false)
            Log.i(TAG, "[wherry] calls: ring withdrawn in front: the page rings call=$callId")
        }
    }

    /**
     * The activity has left the front (CallLifecycle, after a settle). Every
     * ring the page reported and that still rings is posted:
     *  - one withdrawn for the page (`held`), again;
     *  - one the page has rung from the start (`pageOwned`: reported while in
     *    front, so never posted), for the first time. Without this a ring
     *    that began with the app in front had nothing in the shade once the
     *    person left, and no Answer outside the app: the page posts no
     *    notification for a ring its plugin answered `shown: false` for
     *    (467d0dc), and its tone stops with WebView's pause (mobile-2).
     * Posted, it is the plugin's again: `pageInFront` withdraws it into
     * `held` when the person comes back. The page is told each one it
     * posts, so its sheet's tone stops while the notification rings.
     */
    @Synchronized
    fun left(context: Context) {
        if (held.isEmpty() && pageOwned.isEmpty()) return
        val now = System.currentTimeMillis()
        for (callId in held.toList()) {
            held.remove(callId)
            val ring = rings[callId] ?: continue
            if (callId in ended || ring.exp * 1000 <= now) continue
            if (post(context, ring, "left")) {
                tellPage(callId, true)
            } else {
                Log.w(TAG, "[wherry] calls: ring not posted again on leaving call=$callId")
            }
        }
        for (callId in pageOwned.toList()) {
            val ring = rings[callId]
            if (ring == null || callId in ended || ring.exp * 1000 <= now) {
                pageOwned.remove(callId)
                continue
            }
            // Not posted (notifications off): the page's sheet is all there
            // is, so the page keeps it.
            if (post(context, ring, "left")) {
                pageOwned.remove(callId)
                tellPage(callId, true)
            } else {
                Log.w(TAG, "[wherry] calls: page's ring not posted on leaving call=$callId")
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
        val label = ringTitle(ring.label, { CallsStore.label(context, ring.conversationId) }, unnamed)
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
            // After the notify, so the platform's full-screen decision sees
            // the screen as it was before this wake lock existed.
            wakeScreen(context, source)
            return true
        }
        return false
    }

    /**
     * Decision 8: a ring that finds the screen off lights it, briefly.
     *
     * Why the full-screen intent alone does not do it. The screen is woken
     * by SystemUI, not by the app or the activity it starts: when SystemUI
     * decides to launch a full-screen intent with the screen off, it wakes
     * the device first (`Waking up from Asleep (uid=<SystemUI>,
     * reason=WAKE_REASON_APPLICATION, details=com.android.systemui:
     * full_screen_intent)`, read on API 36), and the activity, behind a PIN
     * never shown over the lock (RingLaunch), turns nothing on. SystemUI
     * makes that decision only for a notification it has not seen: a ring
     * posted again over itself (the push and the socket both bring one, and
     * the second post merges into the first) neither launches nor wakes, and
     * where full-screen intents are refused (Android 14+ without the grant,
     * row A-59c) nothing wakes at all. Measured on the emulator, API 36, the
     * app alive behind a PIN: a new ring woke the screen, the same ring
     * posted again after KEYCODE_SLEEP left it `Asleep`, and with
     * USE_FULL_SCREEN_INTENT denied a new ring left it `Asleep`. (Row A-59b's
     * alive half read `Asleep` for a new ring on 2026-09-27; one of these is
     * believed to be what it met, not established.) So every alerting post
     * that finds the screen off lights it here; where SystemUI has already
     * woken it, `isInteractive` is true by now and nothing is acquired.
     *
     * ACQUIRE_CAUSES_WAKEUP needs no TURN_SCREEN_ON permission at targetSdk
     * 36: the compat change that would require it
     * (REQUIRE_TURN_SCREEN_ON_PERMISSION, 216114297) is enabled only from
     * target 10000 on API 36 (`dumpsys platform_compat`). Revisit when
     * targetSdk moves.
     *
     * A timed acquire: the wake lock releases itself after [WAKE_MS] however
     * the ring ends, and ON_AFTER_RELEASE lets the screen then time out as
     * the lock screen's does rather than go dark at once.
     */
    private fun wakeScreen(context: Context, source: String) {
        val power = context.getSystemService(PowerManager::class.java) ?: return
        if (power.isInteractive) return
        try {
            // SCREEN_BRIGHT_WAKE_LOCK is deprecated in favour of an
            // activity's FLAG_KEEP_SCREEN_ON, and there is no activity here.
            @Suppress("DEPRECATION")
            val lock = power.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
                    PowerManager.ACQUIRE_CAUSES_WAKEUP or
                    PowerManager.ON_AFTER_RELEASE,
                "wherry:ring",
            )
            lock.setReferenceCounted(false)
            lock.acquire(WAKE_MS)
            Log.i(TAG, "[wherry] calls: $source ring lit the screen (${WAKE_MS / 1000} s wake lock)")
        } catch (e: Exception) {
            Log.w(TAG, "[wherry] calls: $source ring could not light the screen: $e")
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
        callStyle: Boolean,
    ): Notification {
        val incoming = context.getString(R.string.wherry_calls_incoming)
        // The lock screen follows Android's sensitive-content setting through
        // this public version (the maintainer's decision, 2026-09-29): it
        // names nobody, and keeps both buttons, so a lock screen that hides
        // notification content still offers Answer and Decline.
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
        // Ignored by the platform: an app-created channel is given the
        // package's lock-screen visibility whatever the app asked
        // (PreferencesHelper, new channel: `if (fromTargetApp)
        // channel.setLockscreenVisibility(r.visibility)`), no override unless
        // the person set one. Kept because it states the intent; the
        // notification's own visibility is what the lock screen reads.
        channel.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }
}
