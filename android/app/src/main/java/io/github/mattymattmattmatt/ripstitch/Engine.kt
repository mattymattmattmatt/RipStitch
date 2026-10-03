package io.github.mattymattmattmatt.ripstitch

import android.content.Context
import android.os.Environment
import android.util.Log
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import java.security.SecureRandom

/**
 * The RipStitch Engine on the phone: docs/engine/ripstitch_engine.py running on the Python, FFmpeg and
 * QuickJS that youtubedl-android ships, serving the site and its API on 127.0.0.1.
 */
object Engine {
    private const val TAG = "RipStitch"
    private const val FIRST_PORT = 8751

    @Volatile var port = FIRST_PORT
        private set
    val base: String get() = "http://127.0.0.1:$port"

    @Volatile private var process: Process? = null
    @Volatile var lastError: String = ""
        private set
    lateinit var secret: String
        private set

    fun downloadsDir(): File =
        File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "RipStitch")

    /** Unpacks Python, yt-dlp and FFmpeg (once per app version) and the site + engine. */
    @Synchronized
    fun prepare(ctx: Context, status: (String) -> Unit) {
        val prefs = ctx.getSharedPreferences("engine", Context.MODE_PRIVATE)
        secret = prefs.getString("secret", null) ?: ByteArray(24).also { SecureRandom().nextBytes(it) }
            .joinToString("") { "%02x".format(it) }.also { prefs.edit().putString("secret", it).apply() }

        status("Unpacking Python and yt-dlp…")
        YoutubeDL.init(ctx)
        status("Unpacking FFmpeg…")
        FFmpeg.init(ctx)

        val root = File(ctx.filesDir, "app")
        val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        val stamp = "${BuildConfig.VERSION_CODE}-${info.lastUpdateTime}"
        val stampFile = File(root, ".stamp")
        if (!stampFile.isFile || stampFile.readText() != stamp) {
            status("Unpacking RipStitch…")
            root.deleteRecursively()
            copyAssets(ctx, "app", root)
            stampFile.writeText(stamp)
        }
    }

    private fun copyAssets(ctx: Context, from: String, to: File) {
        val names = ctx.assets.list(from) ?: emptyArray()
        if (names.isEmpty()) {
            to.parentFile?.mkdirs()
            ctx.assets.open(from).use { i -> to.outputStream().use { o -> i.copyTo(o) } }
            return
        }
        to.mkdirs()
        for (n in names) copyAssets(ctx, "$from/$n", File(to, n))
    }

    fun alive(): Boolean = process?.isAliveCompat() == true

    /** Starts the engine (or reuses a running one). Returns once it answers, or false. */
    @Synchronized
    fun start(ctx: Context): Boolean {
        if (alive() && ping()) return true
        stop()
        port = freePort()
        val native = ctx.applicationInfo.nativeLibraryDir
        val ydl = File(ctx.noBackupFilesDir, "youtubedl-android")
        val pkgs = File(ydl, "packages")
        val home = File(ctx.filesDir, "home").apply { mkdirs() }
        val conf = File(ctx.filesDir, "engine").apply { mkdirs() }
        val script = File(ctx.filesDir, "app/engine/ripstitch_engine.py")
        val pb = ProcessBuilder(
            File(native, "libpython.so").path, "-u", script.path,
            "--background", "--no-browser", "--port", port.toString()
        ).directory(home)
        pb.environment().apply {
            put("LD_LIBRARY_PATH", "$pkgs/python/usr/lib:$pkgs/ffmpeg/usr/lib")
            put("SSL_CERT_FILE", "$pkgs/python/usr/etc/tls/cert.pem")
            put("PYTHONHOME", "$pkgs/python/usr")
            put("PYTHONIOENCODING", "utf-8")
            put("HOME", home.path)
            put("TMPDIR", ctx.cacheDir.path)
            put("PATH", (System.getenv("PATH") ?: "/system/bin") + ":" + native)
            put("RIPSTITCH_PLATFORM", "android")
            put("RIPSTITCH_HOME", conf.path)
            put("RIPSTITCH_SECRET", secret)
            put("RIPSTITCH_FFMPEG", File(native, "libffmpeg.so").path)
            put("RIPSTITCH_JS", "quickjs:" + File(native, "libqjs.so").path)
            put("RIPSTITCH_YTDLP_ZIP", File(ydl, "yt-dlp/yt-dlp").path)
            put("RIPSTITCH_DEFAULT_OUT", downloadsDir().path)
        }
        pb.redirectErrorStream(true)
        pb.redirectOutput(File(conf, "engine-console.log"))
        return try {
            process = pb.start()
            val until = System.currentTimeMillis() + 90_000
            while (System.currentTimeMillis() < until) {
                if (ping()) return true
                if (process?.isAliveCompat() != true) break
                Thread.sleep(300)
            }
            lastError = "The engine didn't answer. " + tail(File(conf, "engine-console.log")) + tail(File(conf, "engine.log"))
            Log.e(TAG, lastError)
            false
        } catch (e: Exception) {
            lastError = e.toString()
            Log.e(TAG, "engine start", e)
            false
        }
    }

    @Synchronized
    fun stop() {
        val p = process ?: return
        process = null
        try {
            p.destroy()   // SIGTERM: the engine stops its downloads cleanly
            if (!p.waitForCompat(4000)) p.destroyForcibly()
        } catch (_: Exception) {
        }
    }

    fun restart(ctx: Context): Boolean {
        stop()
        return start(ctx)
    }

    private fun freePort(): Int {
        for (p in FIRST_PORT until FIRST_PORT + 20) {
            try {
                ServerSocket(p, 1, InetAddress.getByName("127.0.0.1")).close()
                return p
            } catch (_: Exception) {
            }
        }
        return FIRST_PORT
    }

    private fun request(path: String, timeout: Int = 3000, body: String? = null): String? = try {
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.connectTimeout = timeout
        c.readTimeout = timeout
        c.setRequestProperty("X-RipStitch-Key", secret)
        if (body != null) {
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        if (c.responseCode == 200) c.inputStream.bufferedReader().use { it.readText() } else null
    } catch (_: Exception) {
        null
    }

    fun ping(): Boolean = request("/api/ping") != null

    /** The download list, or null when the engine isn't answering. */
    fun jobs(): JSONArray? = request("/api/jobs")?.let { JSONObject(it).optJSONArray("jobs") }

    fun health(): JSONObject? = request("/api/health", 8000)?.let { JSONObject(it) }

    private fun tail(f: File): String = try {
        if (f.isFile) f.readLines().takeLast(8).joinToString("\n") + "\n" else ""
    } catch (_: Exception) {
        ""
    }
}

private fun Process.isAliveCompat(): Boolean = try {
    exitValue(); false
} catch (_: IllegalThreadStateException) {
    true
}

private fun Process.waitForCompat(ms: Long): Boolean {
    val until = System.currentTimeMillis() + ms
    while (System.currentTimeMillis() < until) {
        if (!isAliveCompat()) return true
        Thread.sleep(100)
    }
    return false
}
