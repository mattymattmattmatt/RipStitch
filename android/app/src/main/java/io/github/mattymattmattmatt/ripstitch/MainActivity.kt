package io.github.mattymattmattmatt.ripstitch

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** The RipStitch window: the site, served by the engine on this phone, in a WebView. */
class MainActivity : ComponentActivity() {
    companion object {
        private const val TAG = "RipStitch"
        @Volatile var visible = false
            private set
    }

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var splash: View
    private lateinit var splashTitle: TextView
    private lateinit var splashText: TextView
    private lateinit var spinner: ProgressBar

    private var pageReady = false
    private var bridgeAdded = false
    private val pending = ArrayList<String>()          // events for the page once it has loaded
    private val shared = ConcurrentHashMap<String, Uri>()   // videos shared into the app, served at /__shared/<id>
    private val sharedIds = AtomicInteger()
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var folderAnswer: ((JSONObject) -> Unit)? = null
    private var smoke: SmokeTest? = null

    private val pickMany = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray()); fileCallback = null
    }
    private val pickOne = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        fileCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null); fileCallback = null
    }
    private val pickTree = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        val r = JSONObject()
        if (uri != null) {
            val path = treeToPath(uri)
            if (path != null) r.put("path", path)
            else r.put("error", "Android only lets apps save inside Download or Documents on the phone's own storage. Pick a folder in one of those.")
        }
        folderAnswer?.invoke(r); folderAnswer = null
    }
    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    // ------------------------------------------------------------------ lifecycle
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        getExternalFilesDir(null)?.let { dir -> File(dir, "smoke.json").takeIf { it.isFile }?.let { smoke = SmokeTest(this, it) } }
        buildUi()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!pageReady) { moveTaskToBack(true); return }
                web.evaluateJavascript("(window.RS_back&&RS_back())?'1':'0'") { r -> if (r?.contains("1") != true) moveTaskToBack(true) }
            }
        })
        handleIntent(intent)
        startEngine()
    }

    override fun onStart() {
        super.onStart()
        visible = true
        if (pageReady) Thread { if (!Engine.alive()) Engine.start(applicationContext) }.start()
        try {
            startService(Intent(this, EngineService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "service", e)
        }
    }

    override fun onStop() {
        visible = false
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            (web.parent as? ViewGroup)?.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }

    // ------------------------------------------------------------------ window
    @SuppressLint("SetJavaScriptEnabled")
    private fun buildUi() {
        val dp = resources.displayMetrics.density
        root = FrameLayout(this).apply { setBackgroundColor(0xFF0A0D12.toInt()) }
        web = WebView(this).apply {
            setBackgroundColor(0xFF0A0D12.toInt())
            visibility = View.INVISIBLE
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.textZoom = 100
            settings.userAgentString = settings.userAgentString + " RipStitchAndroid/" + BuildConfig.VERSION_NAME
            webViewClient = Client()
            webChromeClient = Chrome()
            setDownloadListener { url, _, _, _, _ -> openUrl(url) }
        }
        WebView.setWebContentsDebuggingEnabled(smoke != null)
        root.addView(web, FrameLayout.LayoutParams(-1, -1))

        splash = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xFF0A0D12.toInt())
            addView(ImageView(context).apply { setImageResource(R.drawable.logo) }, LinearLayout.LayoutParams((84 * dp).toInt(), (84 * dp).toInt()))
            splashTitle = TextView(context).apply {
                text = "Starting RipStitch…"; setTextColor(0xFFE8EDF3.toInt()); textSize = 19f; typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER; setPadding(0, (18 * dp).toInt(), 0, 0)
            }
            addView(splashTitle)
            splashText = TextView(context).apply {
                setTextColor(0xFF7F8A9A.toInt()); textSize = 13f; gravity = Gravity.CENTER
                setPadding((32 * dp).toInt(), (8 * dp).toInt(), (32 * dp).toInt(), 0)
            }
            addView(splashText)
            spinner = ProgressBar(context).apply {
                isIndeterminate = true
                indeterminateTintList = android.content.res.ColorStateList.valueOf(0xFFFF8A1F.toInt())
            }
            addView(spinner, LinearLayout.LayoutParams((28 * dp).toInt(), (28 * dp).toInt()).apply { topMargin = (22 * dp).toInt() })
        }
        root.addView(splash, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        window.statusBarColor = 0xFF10141A.toInt()
        window.navigationBarColor = 0xFF0A0D12.toInt()
    }

    private fun startEngine() {
        Thread {
            try {
                Engine.prepare(applicationContext) { msg -> runOnUiThread { splashText.text = msg } }
                runOnUiThread { splashText.text = "Starting the engine…" }
                val ok = Engine.start(applicationContext)
                runOnUiThread { if (ok) loadApp() else showError("The engine didn't start.", Engine.lastError) }
            } catch (e: Throwable) {
                Log.e(TAG, "startup", e)
                runOnUiThread { showError("RipStitch couldn't start.", e.toString()) }
            }
        }.start()
    }

    private fun loadApp() {
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setCookie(Engine.base, "rs_key=${Engine.secret}; Path=/; SameSite=Strict")
        cookies.flush()
        if (!bridgeAdded && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            bridgeAdded = true
            WebViewCompat.addWebMessageListener(web, "rsHost", setOf(Engine.base), object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
                    val data = message.data ?: return
                    if (isMainFrame) onMessage(data, replyProxy)
                }
            })
        }
        web.loadUrl(Engine.base + "/")
    }

    private fun showError(title: String, detail: String) {
        splash.visibility = View.VISIBLE
        spinner.visibility = View.GONE
        splashTitle.text = title
        splashText.text = detail.take(1500) + "\n\nClose RipStitch and open it again. If it keeps happening, reinstall the latest version."
        smoke?.fail("startup: $title $detail")
    }

    private fun pageLoaded() {
        if (pageReady) return
        pageReady = true
        web.visibility = View.VISIBLE
        splash.animate().alpha(0f).setDuration(220).withEndAction { splash.visibility = View.GONE }.start()
        pending.forEach(::emit); pending.clear()
        askPermissionsOnce()
        Thread { Updates.due(applicationContext)?.let { r -> runOnUiThread { send(JSONObject(r.toString()).put("event", "update")) } } }.start()
        smoke?.begin(web)
    }

    private fun askPermissionsOnce() {
        val want = ArrayList<String>()
        if (Build.VERSION.SDK_INT >= 33) want += Manifest.permission.POST_NOTIFICATIONS
        if (Build.VERSION.SDK_INT <= 29) want += Manifest.permission.WRITE_EXTERNAL_STORAGE
        val missing = want.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        val prefs = getSharedPreferences("app", MODE_PRIVATE)
        if (missing.isNotEmpty() && !prefs.getBoolean("asked", false)) {
            prefs.edit().putBoolean("asked", true).apply()
            askPermissions.launch(missing.toTypedArray())
        }
    }

    // ------------------------------------------------------------------ events for the page
    private fun send(event: JSONObject) {
        val s = event.toString()
        if (pageReady) emit(s) else pending.add(s)
    }

    private fun emit(json: String) = web.evaluateJavascript("window.__rsEvent&&__rsEvent($json)", null)

    private fun handleIntent(i: Intent?) {
        when (i?.action) {
            Intent.ACTION_SEND -> {
                if (i.type?.startsWith("text/") == true) {
                    val text = listOfNotNull(i.getStringExtra(Intent.EXTRA_TEXT), i.getStringExtra(Intent.EXTRA_SUBJECT)).joinToString(" ")
                    if (text.isNotBlank()) send(JSONObject().put("event", "share").put("text", text))
                } else IntentCompat.getParcelableExtra(i, Intent.EXTRA_STREAM, Uri::class.java)?.let { shareFiles(listOf(it)) }
            }
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(i, Intent.EXTRA_STREAM, Uri::class.java)?.let { shareFiles(it) }
        }
    }

    private fun shareFiles(uris: List<Uri>) {
        val files = JSONArray()
        for (u in uris) {
            val id = sharedIds.incrementAndGet().toString()
            shared[id] = u
            var name = "shared-$id.mp4"
            try {
                contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) c.getString(0)?.let { name = it }
                }
            } catch (_: Exception) {
            }
            files.put(JSONObject().put("url", "/__shared/$id").put("name", name).put("type", contentResolver.getType(u) ?: "video/mp4"))
        }
        if (files.length() > 0) send(JSONObject().put("event", "shareFiles").put("files", files))
    }

    // ------------------------------------------------------------------ requests from the page
    private fun onMessage(data: String, reply: JavaScriptReplyProxy) {
        val m = try { JSONObject(data) } catch (_: JSONException) { return }
        val id = m.optString("id")
        val answer: (JSONObject) -> Unit = { r ->
            if (id.isNotEmpty()) runOnUiThread { r.put("id", id); reply.postMessage(r.toString()) }
        }
        when (m.optString("cmd")) {
            "pickFolder" -> {
                folderAnswer?.invoke(JSONObject())
                folderAnswer = answer
                try {
                    pickTree.launch(DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Download"))
                } catch (e: ActivityNotFoundException) {
                    folderAnswer = null; answer(JSONObject().put("error", "This phone has no folder picker"))
                }
            }
            "open" -> answer(handOver(m.optString("path"), share = false))
            "share" -> answer(handOver(m.optString("path"), share = true))
            "folder" -> answer(openFolder(m.optString("path")))
            "paste" -> answer(JSONObject().put("text", clipboardText()))
            "keepAwake" -> if (m.optBoolean("on")) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                           else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            "downloads" -> EngineService.busy(this)
            "restartEngine" -> Thread { Engine.restart(applicationContext) }.start()
            "checkUpdate" -> Thread { answer(Updates.check()) }.start()
            "openUrl" -> openUrl(m.optString("url"))
            else -> answer(JSONObject().put("error", "unknown request"))
        }
    }

    /** "primary:Download/Clips" → /storage/emulated/0/Download/Clips, only where the engine may write. */
    private fun treeToPath(uri: Uri): String? = try {
        val id = DocumentsContract.getTreeDocumentId(uri)
        if (!id.startsWith("primary:")) null
        else {
            val rel = id.removePrefix("primary:").trim('/')
            val top = rel.substringBefore('/')
            if (top.equals("Download", true) || top.equals("Documents", true)) File(Environment.getExternalStorageDirectory(), rel).path else null
        }
    } catch (_: Exception) {
        null
    }

    private fun handOver(path: String, share: Boolean): JSONObject {
        val f = File(path)
        if (!f.isFile) return JSONObject().put("error", "That file isn't there any more.")
        return try {
            val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
            val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream"
            val intent = if (share) Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri)
                         else Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            startActivity(if (share) Intent.createChooser(intent, f.name) else intent)
            JSONObject()
        } catch (e: ActivityNotFoundException) {
            JSONObject().put("error", "No app on this phone can open ${f.extension.uppercase()} files.")
        } catch (e: Exception) {
            JSONObject().put("error", e.message ?: e.toString())
        }
    }

    private fun openFolder(path: String): JSONObject {
        val dir = File(path.ifBlank { Engine.downloadsDir().path })
        val rel = dir.path.removePrefix(Environment.getExternalStorageDirectory().path).trim('/')
        val doc = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:$rel")
        val tries = listOf(
            Intent(Intent.ACTION_VIEW).setDataAndType(doc, DocumentsContract.Document.MIME_TYPE_DIR),
            Intent(Intent.ACTION_VIEW).setDataAndType(doc, "resource/folder"),
            Intent(DownloadManager.ACTION_VIEW_DOWNLOADS),
        )
        for (t in tries) {
            try {
                startActivity(t); return JSONObject()
            } catch (_: Exception) {
            }
        }
        return JSONObject().put("error", "Open your Files app and look in $rel")
    }

    private fun clipboardText(): String = try {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString() ?: ""
    } catch (_: Exception) {
        ""
    }

    private fun openUrl(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
        }
    }

    // ------------------------------------------------------------------ WebView plumbing
    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val u = request.url.toString()
            if (u.startsWith(Engine.base + "/") || u == Engine.base) return false
            if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("mailto:")) openUrl(u)
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val u = request.url
            if (!u.toString().startsWith(Engine.base + "/__shared/")) return null
            val src = shared[u.lastPathSegment ?: ""] ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null)
            return try {
                WebResourceResponse(contentResolver.getType(src) ?: "video/mp4", null, 200, "OK",
                    mapOf("Cache-Control" to "no-store"), contentResolver.openInputStream(src))
            } catch (e: Exception) {
                WebResourceResponse("text/plain", "utf-8", 410, "Gone", null, null)
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (url.startsWith(Engine.base)) pageLoaded()
        }

        @android.annotation.TargetApi(26)
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(TAG, "WebView renderer gone (crash=${detail.didCrash()})")
            recreate()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            val accept = params.acceptTypes.joinToString(",").lowercase()
            val types = if ("video" in accept) arrayOf("video/*") else arrayOf("*/*")
            return try {
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) pickMany.launch(types) else pickOne.launch(types)
                true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null
                callback.onReceiveValue(null)
                false
            }
        }

        override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
            Log.println(if (msg.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.ERROR else Log.DEBUG, "RipStitch-web",
                "${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")
            return true
        }
    }
}
