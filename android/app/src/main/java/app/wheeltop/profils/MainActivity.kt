package app.wheeltop.profils

import android.Manifest
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

/**
 * Affiche l'interface web embarquée (assets/www) et lui fournit le Bluetooth via [BleBridge].
 * Les pages sont servies en https://appassets.androidplatform.net pour que les modules ES
 * et localStorage fonctionnent comme dans Chrome.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var bridge: BleBridge
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var permissionCallback: ((Boolean) -> Unit)? = null

    private val openDocument = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        fileCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        fileCallback = null
    }

    private val requestPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val cb = permissionCallback
        permissionCallback = null
        cb?.invoke(result.values.all { it })
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true) // inspection via chrome://inspect
        }

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // localStorage : profils et sauvegardes
            allowFileAccess = false
            allowContentAccess = true
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == ASSET_HOST) return false
                // Liens externes : navigateur
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // <input type="file"> (import JSON)
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                openDocument.launch(arrayOf("application/json", "text/plain", "application/octet-stream", "*/*"))
                return true
            }
        }

        bridge = BleBridge(this, webView)
        webView.addJavascriptInterface(bridge, "WheeltopAndroid")
        webView.loadUrl("https://$ASSET_HOST/assets/www/index.html")
    }

    /** Demande les permissions Bluetooth si nécessaire, puis appelle [cb] (true = accordées). */
    fun ensureBlePermissions(cb: (Boolean) -> Unit) {
        val needed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        val missing = needed.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) {
            cb(true)
        } else {
            permissionCallback = cb
            requestPermissions.launch(missing.toTypedArray())
        }
    }

    // L'interface déconnecte le dérailleur en arrière-plan (après l'opération en cours)
    override fun onStart() {
        super.onStart()
        if (::bridge.isInitialized) bridge.notifyLifecycle("foreground")
    }

    override fun onStop() {
        if (::bridge.isInitialized) bridge.notifyLifecycle("background")
        super.onStop()
    }

    override fun onDestroy() {
        bridge.close()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
    }
}
