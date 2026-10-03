package io.github.mattymattmattmatt.ripstitch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject

/**
 * Watches the engine's download queue. While anything downloads it runs in the foreground with a
 * progress notification (so Android keeps the downloads going with the screen off), says when
 * downloads finish while you're in another app, and stops the engine after a long idle spell.
 */
class EngineService : Service() {
    companion object {
        private const val TAG = "RipStitch"
        private const val CH_PROGRESS = "downloads"
        private const val CH_DONE = "finished"
        private const val NOTE_PROGRESS = 1
        private val ACTIVE = setOf("queued", "running", "merging")

        /** Something was just queued: show the notification right away, while the app is on screen. */
        fun busy(ctx: Context) {
            try {
                ctx.startService(Intent(ctx, EngineService::class.java).setAction("busy"))
            } catch (e: Exception) {
                Log.w(TAG, "service", e)
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var running = true
    @Volatile private var foreground = false
    private var wake: PowerManager.WakeLock? = null
    private val seen = HashMap<String, String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        channels()
        Thread(::watch, "rs-watch").apply { isDaemon = true }.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "busy") main.post { goForeground(progressNote("Starting download…", "", -1)) }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        releaseWake()
        super.onDestroy()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {   // Android 15's daily limit for this kind of service
        main.post { leaveForeground() }
    }

    private fun watch() {
        var idleSince = 0L
        while (running) {
            try {
                val jobs = Engine.jobs()
                if (jobs != null) update(jobs)
                val now = System.currentTimeMillis()
                if (!foreground && !MainActivity.visible) {
                    if (idleSince == 0L) idleSince = now
                    if (now - idleSince > 10 * 60_000) {   // nobody's using it: let the phone rest
                        Engine.stop()
                        stopSelf()
                        return
                    }
                } else idleSince = 0L
            } catch (e: Exception) {
                Log.w(TAG, "watch", e)
            }
            Thread.sleep(if (foreground) 1000 else 2500)
        }
    }

    private fun update(jobs: org.json.JSONArray) {
        val active = ArrayList<JSONObject>()
        for (i in 0 until jobs.length()) {
            val j = jobs.getJSONObject(i)
            val id = j.optString("id")
            val st = j.optString("status")
            val was = seen.put(id, st)
            if (st in ACTIVE) active.add(j)
            else if (was != null && was in ACTIVE && !MainActivity.visible && (st == "done" || st == "error")) finished(j, st == "done")
        }
        if (active.isNotEmpty()) {
            val going = active.filter { it.optString("status") != "queued" }
            val pct = if (going.isEmpty()) -1 else (going.sumOf { it.optDouble("pct", 0.0) } / going.size).toInt()
            val first = (going.firstOrNull() ?: active[0]).optString("title", "Download")
            val title = if (active.size == 1) "Downloading" else "Downloading ${active.size} items"
            val note = progressNote(title, first, pct)
            main.post { if (foreground) notifier().notify(NOTE_PROGRESS, note) else goForeground(note) }
        } else if (foreground) main.post { leaveForeground() }
    }

    private fun goForeground(n: Notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTE_PROGRESS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else startForeground(NOTE_PROGRESS, n)
            foreground = true
            if (wake == null) wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RipStitch:downloads").apply { acquire(6 * 3600_000L) }
        } catch (e: Exception) {
            Log.w(TAG, "foreground", e)   // e.g. not allowed from the background: downloads still run while the app is open
        }
    }

    private fun leaveForeground() {
        if (!foreground) return
        foreground = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
        releaseWake()
    }

    private fun releaseWake() {
        try {
            wake?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
        }
        wake = null
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    private fun builder(channel: String): Notification.Builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, channel)
        else @Suppress("DEPRECATION") Notification.Builder(this)

    private fun progressNote(title: String, text: String, pct: Int): Notification =
        builder(CH_PROGRESS)
            .setSmallIcon(R.drawable.ic_stat_rs)
            .setContentTitle(title)
            .setContentText(if (pct >= 0) "$pct% · $text" else text)
            .setProgress(100, pct.coerceIn(0, 100), pct < 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
            .setColor(0xFFFF6B1A.toInt())
            .build()

    private fun finished(j: JSONObject, ok: Boolean) {
        val n = builder(CH_DONE)
            .setSmallIcon(R.drawable.ic_stat_rs)
            .setContentTitle(if (ok) "Downloaded" else "Download failed")
            .setContentText(j.optString("title"))
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .setColor(0xFFFF6B1A.toInt())
            .build()
        try {
            notifier().notify(1000 + (j.optString("id").hashCode() and 0xffff), n)
        } catch (_: SecurityException) {   // notifications not allowed
        }
    }

    private fun notifier() = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun channels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        notifier().createNotificationChannel(NotificationChannel(CH_PROGRESS, "Downloads in progress", NotificationManager.IMPORTANCE_LOW))
        notifier().createNotificationChannel(NotificationChannel(CH_DONE, "Finished downloads", NotificationManager.IMPORTANCE_DEFAULT))
    }
}
