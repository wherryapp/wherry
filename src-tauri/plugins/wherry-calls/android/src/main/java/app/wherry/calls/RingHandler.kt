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
//
// Behind a secure lock screen the ring names nobody (decision 7,
// 2026-09-29). The platform offers no way to ask for that: the ring is
// VISIBILITY_PRIVATE with a nameless public version, but the lock screen
// shows the private version whenever the person lets it show sensitive
// content, the default, and a channel's lock-screen visibility is not the
// app's to set (see ensureChannel). So the name is decided here, when the
// ring is posted (`nameHidden`), and the ring is posted again with its name
// once the phone is unlocked: from the activity coming to the front (the
// full-screen intent resumes it behind the lock, and the unlock focuses it),
// and from a receiver for the screen and unlock broadcasts, which is best
// effort, since Android 14 queues such broadcasts while the process is cached.
// A swipe keyguard is no privacy boundary and counts as unlocked, as it does
// for the platform's own redaction. docs/prompts/phone-calls-plan.md, the
// batch 0929 stage log.
package app.wherry.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.KeyguardManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat

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

    /** Rings whose notification this plugin posted and has not taken away,
     *  and the caller line each shows (a name, or "Wherry call" while the
     *  phone is locked), so an unlock or a lock posts again only what
     *  changes. */
    private val posted = HashMap<String, String>()

    /** Screen and unlock broadcasts, registered while a ring is posted. */
    private var lockReceiver: BroadcastReceiver? = null

    /** How long a ring that finds the screen off keeps it on (decision 8):
     *  long enough to read the lock screen's ring, and released by the
     *  timeout whatever happens to the ring. After it the screen follows the
     *  lock screen's own timeout. */
    private const val WAKE_MS = 5_000L

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
        for (callId in posted.keys.toList()) {
            if (rings[callId]?.pageKnown != true) continue
            cancel(context, callId)
            held.add(callId)
            Log.i(TAG, "[wherry] calls: ring withdrawn in front: the page rings call=$callId")
        }
        // A ring that stays (a push the page does not hold) was most often
        // posted while the phone was locked: the full-screen intent resumes
        // the activity behind the lock, and this is the unlock focusing it,
        // the one unlock signal that is never late.
        lockChanged(context, "in front")
    }

    /**
     * The phone may have been locked or unlocked (the screen and unlock
     * broadcasts, or the activity coming to the front): each posted ring
     * whose caller line should now differ is posted again over itself.
     *
     * Not with `setOnlyAlertOnce`: the platform treats a silent update of an
     * insistent notification as taking its sound away and stops the
     * ringtone (NotificationAttentionHelper: a muted update of a
     * FLAG_INSISTENT record clears `hasValidSound`, then `clearSoundLocked`;
     * read on API 36 as `mSoundNotificationKey=null` right after such an
     * update). An alerting update of the ring whose ringtone is looping is
     * its "insistent update", which keeps the sound going without restarting
     * it. Nor does an update launch the full-screen intent or wake the
     * screen again (SystemUI decides those for a new notification only).
     * The cost, believed and not read: a ring whose sound the system had
     * already stopped (opening the shade clears a notification's effects)
     * starts ringing again when the lock changes under it.
     */
    @Synchronized
    fun lockChanged(context: Context, why: String) {
        if (posted.isEmpty()) return
        val hidden = nameHidden(context)
        val now = System.currentTimeMillis()
        for ((callId, shown) in posted.toList()) {
            val ring = rings[callId]
            if (ring == null || callId in ended || ring.exp * 1000 <= now) {
                // Timed out by the platform (setTimeoutAfter), which tells
                // nobody: forget it, so the receiver goes with the last one.
                cancel(context, callId)
                continue
            }
            if (title(context, ring, hidden) == shown) continue
            if (!post(context, ring, why, update = true)) {
                Log.w(TAG, "[wherry] calls: ring not posted again ($why) call=$callId")
            }
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
        unwatchLock(context)
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
        if (posted.isEmpty()) unwatchLock(context)
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        val tag = TAG_PREFIX + callId
        val present = manager.activeNotifications.any { it.id == NOTIFICATION_ID && it.tag == tag }
        manager.cancel(tag, NOTIFICATION_ID)
        return present
    }

    // -- the notification -----------------------------------------------------

    /** Posts the ring, or with [update] posts it again over itself for a
     *  new caller line after a lock or an unlock (see lockChanged). */
    private fun post(context: Context, ring: Ring, source: String, update: Boolean = false): Boolean {
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
        val hidden = nameHidden(context)
        val label = title(context, ring, hidden)
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
            posted[ring.callId] = label
            watchLock(context)
            if (update) {
                Log.i(TAG, "[wherry] calls: ring posted again ($source) call=${ring.callId}, ${if (hidden) "unnamed: locked" else "named"}")
            } else {
                val unnamedWhy = if (hidden) ", unnamed: locked" else ""
                Log.i(TAG, "[wherry] calls: $source ring posted call=${ring.callId} on $CHANNEL_RINGING (${if (callStyle) "" else "plain, "}$how, ${delayMs / 1000} s$unnamedWhy)")
            }
            // After the notify, so the platform's full-screen decision sees
            // the screen as it was before this wake lock existed. Not for an
            // update (a new caller line): a person who turned the screen off
            // during the ring keeps it off.
            if (!update) wakeScreen(context, source)
            return true
        }
        return false
    }

    /** The caller line: "Wherry call" while the phone is locked
     *  ([hidden]), else the page's label, the cache's, or "Wherry call". */
    private fun title(context: Context, ring: Ring, hidden: Boolean): String =
        ringTitle(
            hidden = hidden,
            label = ring.label,
            cached = { CallsStore.label(context, ring.conversationId) },
            unnamed = context.getString(R.string.wherry_calls_unnamed),
        )

    /**
     * Whether the ring must not name anybody now: the phone is locked behind
     * a PIN, pattern or password (`isDeviceLocked`, false on a swipe
     * keyguard), or its screen is off with such a lock set, since the next
     * thing the screen shows is the lock screen (a phone locks when its
     * screen goes off, or a few seconds after, and `isDeviceLocked` may not
     * say so yet).
     */
    private fun nameHidden(context: Context): Boolean {
        val keyguard = context.getSystemService(KeyguardManager::class.java) ?: return false
        if (keyguard.isDeviceLocked) return true
        if (!keyguard.isKeyguardSecure) return false
        val power = context.getSystemService(PowerManager::class.java) ?: return false
        return !power.isInteractive
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

    /**
     * From the first posted ring until the last is gone, on the application
     * context. Exported, because USER_PRESENT comes from SystemUI's uid, not
     * the system's, and a RECEIVER_NOT_EXPORTED receiver is left out of it
     * (read on API 36: SCREEN_ON and SCREEN_OFF, sent by system_server,
     * arrived; USER_PRESENT listed every receiver but this one). Safe: all
     * three are protected broadcasts, which no app can send.
     *
     * Best effort: Android 14+ holds such broadcasts back from a process in
     * the background until it next runs, so a ring that no activity came to
     * the front for (full-screen intents refused, or the person unlocked
     * without it) may keep "Wherry call" after the unlock. It never errs
     * the other way on the unlock, and the activity's own focus (pageInFront)
     * is the signal that is not late.
     */
    private fun watchLock(context: Context) {
        if (lockReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val why = when (intent.action) {
                    Intent.ACTION_USER_PRESENT -> "unlocked"
                    Intent.ACTION_SCREEN_ON -> "screen on"
                    Intent.ACTION_SCREEN_OFF -> "screen off"
                    else -> return
                }
                lockChanged(context, why)
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
            Log.w(TAG, "[wherry] calls: lock broadcasts not watched: $e")
        }
    }

    private fun unwatchLock(context: Context) {
        val receiver = lockReceiver ?: return
        lockReceiver = null
        try {
            context.applicationContext.unregisterReceiver(receiver)
        } catch (e: Exception) {
            Log.w(TAG, "[wherry] calls: lock receiver not unregistered: $e")
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
        // Ignored by the platform: an app-created channel is given the
        // package's lock-screen visibility whatever the app asked
        // (PreferencesHelper, new channel: `if (fromTargetApp)
        // channel.setLockscreenVisibility(r.visibility)`), no override unless
        // the person set one. Kept because it states the intent; nameHidden
        // is what keeps names off the lock screen.
        channel.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }
}
