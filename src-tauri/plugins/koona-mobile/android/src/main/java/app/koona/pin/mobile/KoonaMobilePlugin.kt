package app.koona.pin.mobile

import android.app.Activity
import android.app.ActivityManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ComponentCallbacks
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.net.Uri
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.os.Message
import android.os.PowerManager
import android.os.Process
import android.util.Log
import android.view.KeyEvent
import android.view.ViewGroup
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.JavascriptInterface
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "KoonaPin"

/** A haptic of the page, by its name in src/platform/haptics.ts. */
@InvokeArg
class HapticArgs {
  var kind: String = ""
}

/**
 * Koona Pin on Android (NP-151): system Back, renderer loss, the insets, and a screen asking to
 * update a WebView too old for the interface; for the page's look battery saver, a low-RAM device
 * and the text scale, and haptics that follow the system's touch-feedback setting (NP-072b). The
 * page side is the bridge script of this plugin (`window.__KOONA_MOBILE__`); see the crate's lib.rs.
 */
@TauriPlugin
class KoonaMobilePlugin(private val activity: Activity) : Plugin(activity) {
  /** The last insets, in CSS pixels: top, right, bottom, left. Sent again after each page load. */
  private var insets: String? = null

  /** The WebView's Chromium, read once: from its user agent, else the provider's version. */
  private val found: WebViewVersion.Found by lazy {
    val provider = WebView.getCurrentWebViewPackage()
    val agent = try {
      WebSettings.getDefaultUserAgent(activity)
    } catch (error: Exception) {
      null
    }
    WebViewVersion.Found(provider?.packageName, provider?.versionName, WebViewVersion.chromiumMajor(agent, provider?.versionName))
  }

  /** The system Backs still waiting for the page, claimed by it, or given up on. */
  private val backs = BackLedger()

  /** The WebView the plugin was loaded into: haptics play on it, the signals go to its page. */
  private var webView: WebView? = null

  /**
   * What the page's look follows, read on the main thread whenever it can have changed. The page
   * reads it synchronously from its own thread as the bridge starts (`KoonaMobileAndroid.system`),
   * so its first render already draws flat glass on battery saver.
   */
  @Volatile
  private var signals = Signals(powerSave = false, lowRam = false, textScale = 1f)

  private val lowRam: Boolean by lazy {
    (activity.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)?.isLowRamDevice == true
  }

  /** Battery saver went on or off. */
  private val powerSaveChanged = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      webView?.let { readSignals(it) }
    }
  }

  /**
   * The system's font size may have changed. The activity keeps its WebView over that change (the
   * manifest's `configChanges` names `fontScale`: a recreated activity would get a WebView without
   * this plugin), so the plugin gives the WebView the new size itself.
   */
  private val configurationChanged = object : ComponentCallbacks {
    override fun onConfigurationChanged(newConfig: Configuration) {
      webView?.let { view ->
        followFontScale(view, newConfig)
        readSignals(view)
      }
    }

    @Deprecated("Deprecated in Java")
    override fun onLowMemory() {}
  }

  /**
   * Whether the WebView runs the interface. The app asks once at its start, before it opens the
   * library: with an old WebView it starts nothing behind the update screen (lib.rs).
   */
  @Command
  fun webViewSupport(invoke: Invoke) {
    invoke.resolve(JSObject().put("supported", WebViewVersion.supported(found.major)))
  }

  /**
   * A haptic of the page (src/platform/haptics.ts) as the system's touch feedback on the WebView,
   * which plays only while "Touch feedback" is on. An unknown name plays nothing; it never fails.
   */
  @Command
  fun haptic(invoke: Invoke) {
    val args = invoke.parseArgs(HapticArgs::class.java)
    val constant = Haptics.constant(args.kind, Build.VERSION.SDK_INT)
    val view = webView
    if (constant != null && view != null) view.post { view.performHapticFeedback(constant) }
    invoke.resolve()
  }

  override fun load(webView: WebView) {
    val owner = activity as AppCompatActivity
    this.webView = webView
    // The interface needs Chrome 111 (Tailwind 4); Android 10 may still carry a WebView far older
    // until Play updates it. Then a native screen asks for the update instead of a blank page. wry
    // sets the WebView as the content after the plugins load: replace it once that has happened.
    val found = this.found
    if (!WebViewVersion.supported(found.major)) {
      Log.w(TAG, "The WebView (${found.packageName} ${found.versionName}, Chromium ${found.major}) is older than ${WebViewVersion.MIN}")
      webView.post { showWebViewTooOld(found) }
    }
    // A page sees the interface only from its next load on. Tauri loads the plugins from wry's
    // webview-created hook, before the first page (wry posts its loadUrl); should a page be on its
    // way already, it is loaded again, or its Backs would all be refused (bridge.js `claim`).
    followFontScale(webView, activity.resources.configuration)
    readSignals(webView)
    webView.addJavascriptInterface(PageCalls(), "KoonaMobileAndroid")
    val early = webView.url
    Log.d(TAG, "Plugin loaded; page: ${early ?: "not started"}")
    if (early != null) webView.reload()
    // Added after Tauri's and wry's own callbacks, so it runs first: theirs would go back in the
    // WebView's history or finish the activity.
    owner.onBackPressedDispatcher.addCallback(owner, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() = back(webView)
    })
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
      val bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
      val density = view.resources.displayMetrics.density
      fun css(px: Int) = px / density
      insets = "${css(bars.top)},${css(bars.right)},${css(maxOf(bars.bottom, keyboard.bottom))},${css(bars.left)}"
      sendInsets(webView)
      // The WebView still gets them: from version 140 it turns them into env(safe-area-inset-*).
      ViewCompat.onApplyWindowInsets(view, windowInsets)
    }
    // wry sets its WebViewClient after the plugins load: wrap it once that has happened.
    webView.post { watchRenderer(webView) }
    // A system broadcast reaches a receiver that is not exported.
    ContextCompat.registerReceiver(
      activity.applicationContext,
      powerSaveChanged,
      IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    activity.applicationContext.registerComponentCallbacks(configurationChanged)
  }

  override fun onDestroy() {
    activity.applicationContext.unregisterReceiver(powerSaveChanged)
    activity.applicationContext.unregisterComponentCallbacks(configurationChanged)
    webView = null
  }

  /**
   * The WebView's text zoom is the system's font scale (doc/mobile-design.md, Dynamic Type): it
   * scales `font-size` and `line-height`, not boxes. Chromium sets it so only when it makes the
   * WebView; this keeps it so while the app runs.
   */
  private fun followFontScale(webView: WebView, configuration: Configuration) {
    val zoom = Signals.textZoom(configuration.fontScale)
    if (webView.settings.textZoom != zoom) webView.settings.textZoom = zoom
  }

  /** Reads the signals again; when they changed, the page hears it (bridge.js `systemChanged`). */
  private fun readSignals(webView: WebView) {
    val power = activity.getSystemService(Context.POWER_SERVICE) as? PowerManager
    val now = Signals(power?.isPowerSaveMode == true, lowRam, Signals.textScale(webView.settings.textZoom))
    if (now == signals) return
    signals = now
    sendSignals(webView)
  }

  private fun sendSignals(webView: WebView) {
    webView.evaluateJavascript("window.__KOONA_MOBILE__ && window.__KOONA_MOBILE__.systemChanged(${signals.json()})", null)
  }

  /**
   * System Back, with exactly one outcome: the page closes one level, or the app goes to the
   * background (nothing open, no page yet, or a page busy for BACK_WAIT_MS). It never exits here.
   * The page claims the Back by its number before it closes anything (`KoonaMobileAndroid.claimBack`,
   * a synchronous call); the timer takes it only while it is unclaimed, so a late page closes
   * nothing once the app has gone to the background.
   */
  private fun back(webView: WebView) {
    val back = backs.open()
    val giveUp = Runnable {
      if (back.giveUp()) activity.moveTaskToBack(true)
    }
    webView.postDelayed(giveUp, BACK_WAIT_MS)
    webView.evaluateJavascript("(function(){var m=window.__KOONA_MOBILE__;return !!(m&&m.back(${back.id}));})()") { answer ->
      webView.removeCallbacks(giveUp)
      // Nothing closed: unless the timer already went, the app goes to the background now.
      if (back.answered(answer == "true")) activity.moveTaskToBack(true)
    }
  }

  /** What the page calls synchronously, on its own thread. */
  private inner class PageCalls {
    /** The page's side of [back]: called before it closes anything. */
    @JavascriptInterface
    fun claimBack(id: Int): Boolean = backs.claim(id)

    /** The signals as the bridge starts, before the page's first render. */
    @JavascriptInterface
    fun system(): String = signals.json()
  }

  /**
   * «Update Android System WebView», shown instead of the interface. Its words are the plugin's
   * string resources (res/values/strings.xml): the page's translations never load here. The button
   * opens the WebView's page in Google Play, or on the web without Play.
   */
  private fun showWebViewTooOld(found: WebViewVersion.Found) {
    val density = activity.resources.displayMetrics.density
    fun dp(value: Int) = (value * density).toInt()
    val packageName = found.packageName ?: "com.google.android.webview"
    val title = TextView(activity).apply {
      text = activity.getString(R.string.koona_webview_title)
      textSize = 22f
    }
    val body = TextView(activity).apply {
      text = activity.getString(R.string.koona_webview_body, WebViewVersion.MIN, found.versionName ?: "?")
      textSize = 16f
      setPadding(0, dp(12), 0, dp(24))
    }
    val update = Button(activity).apply {
      text = activity.getString(R.string.koona_webview_button)
      setOnClickListener {
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$packageName"))
        try {
          activity.startActivity(market)
        } catch (_: ActivityNotFoundException) {
          activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$packageName")))
        }
      }
    }
    val content = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(32), dp(32), dp(32), dp(32))
      addView(title)
      addView(body)
      addView(update)
    }
    // Clear of the system bars: the outer layout takes them as padding, the inner keeps its own.
    val screen = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_VERTICAL
      fitsSystemWindows = true
      addView(content)
    }
    activity.setContentView(screen)
  }

  private fun sendInsets(webView: WebView) {
    val sides = insets ?: return
    webView.evaluateJavascript("window.__KOONA_MOBILE__ && window.__KOONA_MOBILE__.insets($sides)", null)
  }

  private fun watchRenderer(webView: WebView) {
    val client = webView.webViewClient
    if (client is RendererWatch) return
    webView.webViewClient = RendererWatch(client, onLoaded = {
        sendInsets(webView)
        sendSignals(webView)
      }, onGone = { restart(webView) })
  }

  /**
   * The renderer is gone and this WebView with it; Tauri owns the WebView and makes it only at
   * the process's start. So the process ends without running exit handlers (other threads may
   * still hold the library's locks), and on the screen the app starts again at once. The library
   * keeps what was committed.
   */
  private fun restart(webView: WebView) {
    (webView.parent as? ViewGroup)?.removeView(webView)
    webView.destroy()
    val onScreen = (activity as AppCompatActivity).lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
    if (onScreen) {
      activity.packageManager.getLaunchIntentForPackage(activity.packageName)?.let { launch ->
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity.startActivity(launch)
      }
    }
    Process.killProcess(Process.myPid())
  }

  private companion object {
    /** How long Back waits for a busy page before it moves the app to the background anyway. */
    const val BACK_WAIT_MS = 1000L
  }
}

/**
 * wry's WebViewClient with a renderer-loss handler: every call goes to it unchanged, and
 * [onRenderProcessGone] restarts the app instead of letting Android end it as a crash.
 *
 * wry has no supported hook for this: its only one is a build-time text extension of the class
 * (WRY_RUSTWEBVIEWCLIENT_CLASS_EXTENSION), which NP-151 left out. RustWebViewClient of wry 0.57.0
 * overrides shouldInterceptRequest, shouldOverrideUrlLoading, onPageStarted, onPageFinished and
 * onReceivedError; the rest of WebViewClient is forwarded too, for a later wry.
 * `bun run build:android` (and CI) fail when wry overrides a method this class does not.
 */
private class RendererWatch(
  private val inner: WebViewClient,
  private val onLoaded: () -> Unit,
  private val onGone: () -> Unit,
) : WebViewClient() {
  override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
    Log.w(TAG, "The WebView renderer is gone (crashed: ${detail.didCrash()}); the app starts afresh")
    onGone()
    return true
  }

  override fun onPageFinished(view: WebView, url: String?) {
    inner.onPageFinished(view, url)
    onLoaded()
  }

  override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
    inner.shouldInterceptRequest(view, request)

  @Deprecated("Deprecated in Java")
  override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? =
    @Suppress("DEPRECATION") inner.shouldInterceptRequest(view, url)

  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
    inner.shouldOverrideUrlLoading(view, request)

  @Deprecated("Deprecated in Java")
  override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
    @Suppress("DEPRECATION") inner.shouldOverrideUrlLoading(view, url)

  override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) = inner.onPageStarted(view, url, favicon)
  override fun onLoadResource(view: WebView, url: String?) = inner.onLoadResource(view, url)
  override fun onPageCommitVisible(view: WebView, url: String?) = inner.onPageCommitVisible(view, url)

  override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
    inner.onReceivedError(view, request, error)

  @Deprecated("Deprecated in Java")
  override fun onReceivedError(view: WebView, errorCode: Int, description: String?, failingUrl: String?) =
    @Suppress("DEPRECATION") inner.onReceivedError(view, errorCode, description, failingUrl)

  override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) =
    inner.onReceivedHttpError(view, request, errorResponse)

  override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) =
    inner.onReceivedSslError(view, handler, error)

  override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) =
    inner.onReceivedClientCertRequest(view, request)

  override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String?, realm: String?) =
    inner.onReceivedHttpAuthRequest(view, handler, host, realm)

  override fun onReceivedLoginRequest(view: WebView, realm: String?, account: String?, args: String?) =
    inner.onReceivedLoginRequest(view, realm, account, args)

  override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) =
    inner.doUpdateVisitedHistory(view, url, isReload)

  override fun onFormResubmission(view: WebView, dontResend: Message, resend: Message) =
    inner.onFormResubmission(view, dontResend, resend)

  override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) = inner.onScaleChanged(view, oldScale, newScale)
  override fun shouldOverrideKeyEvent(view: WebView, event: KeyEvent): Boolean = inner.shouldOverrideKeyEvent(view, event)
  override fun onUnhandledKeyEvent(view: WebView, event: KeyEvent) = inner.onUnhandledKeyEvent(view, event)

  override fun onSafeBrowsingHit(view: WebView, request: WebResourceRequest, threatType: Int, callback: SafeBrowsingResponse) =
    inner.onSafeBrowsingHit(view, request, threatType, callback)

  @Deprecated("Deprecated in Java")
  override fun onTooManyRedirects(view: WebView, cancelMsg: Message, continueMsg: Message) =
    @Suppress("DEPRECATION") inner.onTooManyRedirects(view, cancelMsg, continueMsg)
}
