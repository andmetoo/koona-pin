package app.koona.pin.mobile

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Message
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
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin

private const val TAG = "KoonaPin"

/**
 * Koona Pin on Android (NP-151): system Back, renderer loss and the insets. The page side is the
 * bridge script of this plugin (`window.__KOONA_MOBILE__`); see the crate's lib.rs.
 */
@TauriPlugin
class KoonaMobilePlugin(private val activity: Activity) : Plugin(activity) {
  /** The last insets, in CSS pixels: top, right, bottom, left. Sent again after each page load. */
  private var insets: String? = null

  override fun load(webView: WebView) {
    val owner = activity as AppCompatActivity
    // Added after Tauri's and wry's own callbacks, so it runs first: theirs would go back in the
    // WebView's history or finish the activity.
    owner.onBackPressedDispatcher.addCallback(owner, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript(BACK) { answer ->
          // The page closed something; otherwise (nothing to close, or no page yet) the app goes
          // to the background as Android apps do. It never exits here.
          if (answer != "true") activity.moveTaskToBack(true)
        }
      }
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
  }

  private fun sendInsets(webView: WebView) {
    val sides = insets ?: return
    webView.evaluateJavascript("window.__KOONA_MOBILE__ && window.__KOONA_MOBILE__.insets($sides)", null)
  }

  private fun watchRenderer(webView: WebView) {
    val client = webView.webViewClient
    if (client is RendererWatch) return
    webView.webViewClient = RendererWatch(client, onLoaded = { sendInsets(webView) }, onGone = { restart(webView) })
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
    const val BACK = "(function(){var m=window.__KOONA_MOBILE__;return !!(m&&m.back());})()"
  }
}

/**
 * wry's WebViewClient with a renderer-loss handler: every call goes to it unchanged, and
 * [onRenderProcessGone] restarts the app instead of letting Android end it as a crash.
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
