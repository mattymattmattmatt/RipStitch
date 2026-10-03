package io.github.mattymattmattmatt.ripstitch

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Asks GitHub whether a newer RipStitch APK has been published. */
object Updates {
    const val APK = "https://github.com/mattymattmattmatt/RipStitch/releases/download/android-latest/RipStitch.apk"
    private const val INFO = "https://github.com/mattymattmattmatt/RipStitch/releases/download/android-latest/android-version.json"

    fun check(): JSONObject {
        val r = JSONObject().put("current", BuildConfig.VERSION_NAME)
        return try {
            val c = URL(INFO).openConnection() as HttpURLConnection
            c.connectTimeout = 10_000
            c.readTimeout = 15_000
            c.instanceFollowRedirects = true
            c.setRequestProperty("User-Agent", "RipStitchAndroid/" + BuildConfig.VERSION_NAME)
            val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            r.put("latest", j.optString("versionName")).put("newer", j.optInt("versionCode") > BuildConfig.VERSION_CODE)
        } catch (e: Exception) {
            r.put("error", e.message ?: e.toString())
        }
    }

    /** At most twice a day, in the background: returns the answer only when there's something newer. */
    fun due(ctx: Context): JSONObject? {
        val prefs = ctx.getSharedPreferences("updates", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (now - prefs.getLong("checked", 0) < 12 * 3600_000L) return null
        val r = check()
        if (!r.has("error")) prefs.edit().putLong("checked", now).apply()
        return if (r.optBoolean("newer")) r else null
    }
}
