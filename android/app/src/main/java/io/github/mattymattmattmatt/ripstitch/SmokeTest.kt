package io.github.mattymattmattmatt.ripstitch

import android.util.Log
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * CI self-test. Runs only when the test harness has pushed smoke.json into the app's own external
 * folder (which other apps can't write on current Android): reads a link, downloads video and audio,
 * opens the video in Stitch, exports it, and writes each step to smoke-result.txt beside it.
 */
class SmokeTest(private val act: MainActivity, private val cfg: File) {
    private val dir = cfg.parentFile!!
    private val out = File(dir, "smoke-result.txt")
    private lateinit var web: WebView
    @Volatile private var started = false

    init {
        out.delete()
        log("phase: launched")
    }

    private fun log(s: String) {
        Log.i("RipStitch-smoke", s)
        synchronized(this) { out.appendText(s + "\n") }
    }

    fun fail(msg: String) {
        log("result: fail $msg")
        copyLogs()
    }

    fun begin(w: WebView) {
        if (started) return
        started = true
        web = w
        Thread(::run, "rs-smoke").start()
    }

    private fun js(code: String, timeoutMs: Long = 20_000): String {
        val latch = CountDownLatch(1)
        var r = ""
        act.runOnUiThread {
            web.evaluateJavascript(code) { v ->
                r = try { JSONArray("[$v]").get(0).toString() } catch (_: Exception) { v ?: "" }
                latch.countDown()
            }
        }
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        return r
    }

    private fun waitFor(code: String, timeoutMs: Long): Boolean {
        val until = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < until) {
            if (js("!!($code)") == "true") return true
            Thread.sleep(500)
        }
        return false
    }

    private fun phase(name: String) {
        log("phase: $name")
        Thread.sleep(3000)   // time for the harness to take a screenshot
    }

    private fun jobIds(): Set<String> =
        try { JSONArray(js("JSON.stringify(Rip._debug.R.jobs.map(j=>j.id))")).let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } }
        catch (_: Exception) { emptySet() }

    /** Waits for the first new download of this kind (audio or not) to finish; returns its job object. */
    private fun job(audio: Boolean, before: Set<String>, timeoutMs: Long): JSONObject {
        val until = System.currentTimeMillis() + timeoutMs
        var last = JSONObject()
        while (System.currentTimeMillis() < until) {
            val s = js("JSON.stringify(Rip._debug.R.jobs.filter(j=>(j.kind==='audio')===$audio).map(j=>({id:j.id,status:j.status,kind:j.kind,label:j.label,dest:j.dest,size:j.size,error:j.error})))")
            val arr = try { JSONArray(s) } catch (_: Exception) { JSONArray() }
            for (i in 0 until arr.length()) {
                val j = arr.getJSONObject(i)
                if (j.optString("id") in before) continue
                last = j
                if (j.optString("status") in setOf("done", "error", "cancelled")) return j
            }
            Thread.sleep(1000)
        }
        return last.put("status", "timeout")
    }

    private fun run() {
        try {
            val url = JSONObject(cfg.readText()).getString("url")
            check(waitFor("window.Rip&&Rip.engine.state==='online'", 120_000)) { "the page never connected to the engine" }
            val h = JSONObject(js("JSON.stringify(Rip.engine.health)"))
            log("health: engine ${h.optString("version")} · yt-dlp ${h.optString("ytdlp")} (${h.optString("runtime")}) · ffmpeg ${h.optBoolean("ffmpeg")} ${h.optString("ffmpeg_version")} · js ${h.optString("js_runtime")} · ${h.optString("install")}/${h.optString("platform")} · ${h.optString("out_dir")}")
            check(h.optString("install") == "android") { "install kind is ${h.optString("install")}" }
            check(h.optString("ytdlp").isNotEmpty()) { "yt-dlp not found" }
            check(h.optBoolean("ffmpeg")) { "FFmpeg/ffprobe not found" }
            check(h.optString("js_runtime") == "quickjs") { "JS runtime is '${h.optString("js_runtime")}'" }
            phase("home")

            js("App.go('rip');Rip.read(${JSONObject.quote(url)})")
            check(waitFor("document.querySelector('#rPicks .rp-pick')", 120_000)) {
                "reading the link failed: " + js("(document.querySelector('#rFault')||{}).textContent||'no answer'")
            }
            phase("read")

            var before = jobIds()
            js("document.querySelector('#rPicks .rp-pick').click()")   // Best
            val video = job(false, before, 180_000)
            log("download best: $video")
            check(video.optString("status") == "done") { "video download ended as ${video.optString("status")}: ${video.optString("error")}" }
            val vf = File(video.optString("dest"))
            check(vf.isFile && vf.length() > 0) { "the video isn't in ${vf.path}" }

            before = jobIds()
            js("[...document.querySelectorAll('#rPicks .rp-pick')].find(b=>b.dataset.q==='audio')?.click()")
            val audio = job(true, before, 180_000)
            log("download audio: $audio")
            check(audio.optString("status") == "done") { "audio download ended as ${audio.optString("status")}: ${audio.optString("error")}" }
            check(File(audio.optString("dest")).isFile) { "the audio file is missing" }
            phase("downloaded")

            js("document.querySelector('.job.done [data-a=stitch]').click()")
            check(waitFor("Stitch.count()>0&&Stitch._debug.S.clips.every(c=>c.state==='ok')", 90_000)) { "the download never reached Stitch" }
            js("App.go('stitch')")
            phase("stitch")

            val stitchDir = File(Engine.downloadsDir(), "Stitch")
            val before = stitchDir.list()?.toSet() ?: emptySet()
            js("""(()=>{const s=document.getElementById('oFmt');const o=[...s.options].find(o=>o.value.startsWith('video/webm'))||s.options[0];
                 if(o){s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}))}
                 const a=document.getElementById('oAudio');if(a.checked)a.click();
                 document.getElementById('oName').value='smoke-export';document.getElementById('bExport').click()})()""")
            var exported: File? = null
            val until = System.currentTimeMillis() + 150_000
            while (exported == null && System.currentTimeMillis() < until) {
                Thread.sleep(1000)
                exported = stitchDir.listFiles()?.firstOrNull { it.name !in before && !it.name.endsWith(".part") && it.name.startsWith("smoke-export") }
            }
            check(exported != null && exported.length() > 0) { "the Stitch export never arrived: " + js("[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' | ')") }
            log("export: ${exported.name} ${exported.length()} bytes")
            phase("exported")

            js("Settings.open('downloads')")
            phase("settings")
            js("document.getElementById('dlgSet').close();App.go('rip')")

            // Real-world checks, for the log only: GitHub (yt-dlp updates) and YouTube from the CI network.
            js("window.__u='';fetch('/api/update',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()).then(d=>window.__u=JSON.stringify({ok:d.ok,note:d.note,ytdlp:d.ytdlp})).catch(e=>window.__u='error '+e)")
            if (waitFor("window.__u", 240_000)) log("info: yt-dlp update -> ${js("window.__u")}")
            js("window.__p='';fetch('/api/probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://www.youtube.com/watch?v=jNQXAC9IVRw'})}).then(r=>r.json()).then(d=>window.__p=d.ok?('ok '+d.result.title+' · '+d.result.formats.length+' formats'):('error '+d.error)).catch(e=>window.__p='error '+e)")
            if (waitFor("window.__p", 240_000)) log("info: YouTube -> ${js("window.__p")}")

            copyLogs()
            log("result: ok")
        } catch (e: Throwable) {
            fail(e.message ?: e.toString())
        }
    }

    private fun copyLogs() {
        for (n in listOf("engine.log", "engine-console.log")) {
            try {
                File(act.filesDir, "engine/$n").takeIf { it.isFile }?.copyTo(File(dir, n), overwrite = true)
            } catch (_: Exception) {
            }
        }
    }
}
