// A1's call service (docs/prompts/phone-calls-plan.md §6.1): a foreground
// service of type `microphone` that runs for the length of every call, so
// the webview engine keeps its microphone and its process keeps its
// foreground standing while the app is backgrounded or the screen is off.
// Android 11+ cuts a backgrounded app's microphone without one; row A-55
// measured the page's media stopping 6 to 8 s after HOME without one.
//
// Mechanism only. When it runs is the page's decision (phone-rules.ts's
// `callServiceWanted`, carried by `setActive`): from `connecting`, which is
// always a moment the person has just pressed call or answer in the app, so
// the start is while-in-use eligible, until the session is idle again.
package app.wherry.calls

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

class CallService : Service() {

    companion object {
        /** This plugin's channel (coordination §4: PUSH owns `messages`,
         *  `calls` and `other`; CALLS owns `ringing` and `ongoing_call`). */
        const val CHANNEL_ONGOING = "ongoing_call"

        /** Distinct from A2's ring notification, which is tagged per call. */
        private const val NOTIFICATION_ID = 0x7715

        private const val EXTRA_CALL_ID = "app.wherry.calls.extra.CALL_ID"
        private const val EXTRA_LABEL = "app.wherry.calls.extra.LABEL"
        private const val EXTRA_AUDIO_ONLY = "app.wherry.calls.extra.AUDIO_ONLY"

        /** A backstop only: the lock is released when the call ends or the
         *  call gains video. A call longer than this keeps its service and
         *  loses only the screen-off-at-the-ear. */
        private const val PROXIMITY_TIMEOUT_MS = 6L * 60 * 60 * 1000

        /** True between a successful start and the service's destruction. */
        @Volatile
        var running: Boolean = false
            private set

        /** A start was sent and its onStartCommand has not run yet, so
         *  CallLifecycle's retry does not send a second one. */
        @Volatile
        var starting: Boolean = false
            private set

        /**
         * Start the service, or update its notification and proximity lock
         * while it runs. `startService`, not `startForegroundService`: the
         * first call comes with the app in front, and an update comes while
         * the service already makes the app foreground, so neither needs the
         * background-start path, and a start that cannot go foreground can
         * stop itself without the 5-second `startForeground` obligation.
         * Answers false when the service was not asked to run.
         */
        fun update(context: Context, callId: String?, label: String?, audioOnly: Boolean): Boolean {
            if (!microphoneGranted(context)) {
                Log.w(TAG, "[wherry] calls: service not started: RECORD_AUDIO is not granted")
                return false
            }
            val intent = Intent(context, CallService::class.java)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(EXTRA_LABEL, label)
                .putExtra(EXTRA_AUDIO_ONLY, audioOnly)
            // Set before the start, since onStartCommand (which clears it)
            // may run on the main thread before startService returns here.
            if (!running) starting = true
            return try {
                (context.startService(intent) != null).also { if (!it) starting = false }
            } catch (e: IllegalStateException) {
                // The app is in the background with no service running yet
                // (a join that began in front and was backgrounded before
                // this call arrived). CallLifecycle starts it when the
                // activity next resumes, as does any later setActive.
                starting = false
                Log.w(TAG, "[wherry] calls: service not started: ${e.message}")
                false
            } catch (e: SecurityException) {
                starting = false
                Log.w(TAG, "[wherry] calls: service not started: ${e.message}")
                false
            }
        }

        fun stop(context: Context) {
            starting = false
            context.stopService(Intent(context, CallService::class.java))
        }

        /**
         * Android 14 (API 34) refuses a `microphone` foreground service to an
         * app without RECORD_AUDIO with a SecurityException from
         * `startForeground`. Before 34 the type needs no grant. The grant is
         * the page's getUserMedia ask (wry's WebChromeClient), which on a
         * first call comes *after* `connected`, the page asking for the
         * microphone last and sending no setActive after it: CallLifecycle
         * starts the service when the activity resumes from that dialog.
         */
        fun microphoneGranted(context: Context): Boolean =
            Build.VERSION.SDK_INT < 34 ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED

        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_ONGOING) != null) return
            val channel = NotificationChannel(
                CHANNEL_ONGOING,
                context.getString(R.string.wherry_calls_channel_ongoing),
                NotificationManager.IMPORTANCE_DEFAULT,
            )
            channel.description = context.getString(R.string.wherry_calls_channel_ongoing_description)
            // An ongoing call's notification is a status, never an alert.
            channel.setSound(null, null)
            channel.enableVibration(false)
            channel.setShowBadge(false)
            manager.createNotificationChannel(channel)
        }
    }

    private var startedAt = 0L
    private var proximity: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        startedAt = System.currentTimeMillis()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        starting = false
        if (intent == null) {
            // A restart with no intent has no call behind it. START_NOT_STICKY
            // should prevent it; this is the belt to that brace.
            stopSelf()
            return START_NOT_STICKY
        }
        val callId = intent.getStringExtra(EXTRA_CALL_ID)
        val label = intent.getStringExtra(EXTRA_LABEL)
        val audioOnly = intent.getBooleanExtra(EXTRA_AUDIO_ONLY, true)

        ensureChannel(this)
        val notification = ongoingNotification(callId, label)
        try {
            // The `microphone` type is API 30's; before it the manifest's
            // type is all there is, and no background microphone cut exists.
            if (Build.VERSION.SDK_INT >= 30) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            // SecurityException (no RECORD_AUDIO on 34+), or
            // ForegroundServiceStartNotAllowedException (31+, the app left
            // the foreground between the start and here). Started with
            // startService, so stopping here is allowed and crashes nothing.
            Log.w(TAG, "[wherry] calls: service could not go foreground: $e")
            if (!running) stopSelf()
            return START_NOT_STICKY
        }
        if (!running) {
            running = true
            Log.i(TAG, "[wherry] calls: service started (microphone) call=${callId ?: "-"}")
        } else {
            Log.i(TAG, "[wherry] calls: service updated call=${callId ?: "-"} audioOnly=$audioOnly")
        }
        setProximity(audioOnly)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        setProximity(false)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        if (running) Log.i(TAG, "[wherry] calls: service stopped")
        running = false
        starting = false
        super.onDestroy()
    }

    // -- the notification ---------------------------------------------------

    private fun ongoingNotification(callId: String?, label: String?): Notification {
        val unnamed = getString(R.string.wherry_calls_unnamed)
        val name = label?.takeIf { it.isNotBlank() } ?: unnamed
        val person = Person.Builder().setName(name).setImportant(true).build()
        val hangUp = CallActionReceiver.pendingIntent(this, CallActions.HANGUP, callId)

        // The lock screen's version names nobody: the label is a
        // conversation's name, and a locked phone shows it to whoever holds it.
        val public = NotificationCompat.Builder(this, CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.wherry_calls_ongoing)
            .setContentTitle(unnamed)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build()

        val builder = NotificationCompat.Builder(this, CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.wherry_calls_ongoing)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangUp))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setWhen(startedAt)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        openAppIntent()?.let { builder.setContentIntent(it) }
        return builder.build()
    }

    /** A tap on the notification's body brings the app back, to the call. */
    private fun openAppIntent(): PendingIntent? {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        return PendingIntent.getActivity(
            this,
            0,
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    // -- the proximity lock -------------------------------------------------

    /**
     * Screen off at the ear on an audio-only call. A web view cannot blank
     * the screen, and voice-efficiency.md names that lit screen as part of a
     * call's heat. Released as soon as anybody's video is on, since a video
     * call is held in front of the face.
     */
    @SuppressLint("WakelockTimeout")
    private fun setProximity(wanted: Boolean) {
        if (wanted) {
            if (proximity?.isHeld == true) return
            val power = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            if (!power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                Log.i(TAG, "[wherry] calls: no proximity sensor, screen stays as it is")
                return
            }
            val lock = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "wherry:call-proximity")
            lock.setReferenceCounted(false)
            try {
                lock.acquire(PROXIMITY_TIMEOUT_MS)
                proximity = lock
                Log.i(TAG, "[wherry] calls: proximity lock held")
            } catch (e: SecurityException) {
                Log.w(TAG, "[wherry] calls: proximity lock refused: ${e.message}")
            }
        } else {
            val lock = proximity ?: return
            proximity = null
            if (lock.isHeld) {
                // Wait for the phone to leave the ear, so the screen does not
                // come on against a cheek at hang-up.
                lock.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY)
                Log.i(TAG, "[wherry] calls: proximity lock released")
            }
        }
    }
}
