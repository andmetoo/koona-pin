package app.koona.pin.share

import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.WindowInsets
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedDispatcher
import java.io.IOException
import java.time.Instant
import java.util.UUID

private const val TAG = "KoonaPin"

/** How long the sheet stays when nobody touches it. */
private const val AUTO_CLOSE_MS = 2000

/**
 * "Share → Koona Pin" (frame S1, cut to the link alone): queues the shared link for the app and
 * says so on a sheet over the app that shared it. Runs in its own process, `:share`, without the
 * app's WebView or Rust: the app takes the queue in when it opens or comes back (share_queue.rs).
 *
 * The sheet closes by itself after a moment; a touch keeps it until Done, a tap outside or Back.
 */
class ShareActivity : Activity() {
  private val handler = Handler(Looper.getMainLooper())
  private val autoClose = Runnable { close() }
  private lateinit var sheet: LinearLayout

  override fun onCreate(saved: Bundle?) {
    super.onCreate(saved)
    // Edge to edge, as Android 15 and later make every window; the sheet keeps clear of the bars.
    if (Build.VERSION.SDK_INT in 30..34) {
      @Suppress("DEPRECATION")
      window.setDecorFitsSystemWindows(false)
    } else if (Build.VERSION.SDK_INT < 30) {
      @Suppress("DEPRECATION")
      window.decorView.systemUiVisibility =
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
    }
    // The frame's scrim as the window's dim, which the system fades in and out with the window.
    window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
    window.setDimAmount(if (night) 0.55f else 0.24f)
    if (Build.VERSION.SDK_INT >= 33) {
      onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { close() }
    }
    // A sheet made again (the phone turned) has queued its link already.
    take(intent, queue = saved == null)
  }

  /**
   * A share made while the sheet is open: the system hands it to this sheet, whose task it brings
   * back, instead of starting another. It is queued and shown like the first.
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    take(intent, queue = true)
  }

  /** Queues the link shared and shows the sheet for it; a short word instead when there is none. */
  private fun take(intent: Intent?, queue: Boolean) {
    val shared = try {
      shared(intent)
    } catch (error: RuntimeException) {
      // Extras another app made unreadable (a Parcelable of its own, a broken bundle).
      Log.w(TAG, "Cannot read what was shared", error)
      null
    }
    if (shared == null) {
      tell(R.string.koona_share_no_link)
      return
    }
    val (url, title) = shared
    if (queue) {
      try {
        ShareQueue.write(ShareQueue.folder(this), ShareItem(UUID.randomUUID().toString(), url, title, Instant.now().toString()))
      } catch (error: IOException) {
        Log.e(TAG, "Cannot queue the shared link", error)
        tell(R.string.koona_share_failed)
        return
      }
    }
    setContentView(content(url, title))
    val accessibility = getSystemService(AccessibilityManager::class.java)
    val stay = accessibility?.getRecommendedTimeoutMillis(
      AUTO_CLOSE_MS,
      AccessibilityManager.FLAG_CONTENT_TEXT or AccessibilityManager.FLAG_CONTENT_CONTROLS,
    ) ?: AUTO_CLOSE_MS
    handler.removeCallbacks(autoClose)
    handler.postDelayed(autoClose, stay.toLong())
  }

  /** The link the app can save and its title, from what was shared; null when there is no such link. */
  private fun shared(intent: Intent?): Pair<String, String>? {
    if (intent?.action != Intent.ACTION_SEND) return null
    val url = ShareQueue.firstLink(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()) ?: return null
    // Some apps send the link as the subject too: then there is no title, the app finds one.
    val title = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()?.trim()?.take(1000)?.takeIf { it != url }.orEmpty()
    return url to title
  }

  /** A short word; without a sheet showing a link already, away too. */
  private fun tell(message: Int) {
    Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
    if (!::sheet.isInitialized) finish()
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    // A touch on the sheet keeps it open until Done; one outside closes it (the click of the window around it).
    if (event.actionMasked == MotionEvent.ACTION_DOWN && ::sheet.isInitialized && inside(sheet, event)) {
      handler.removeCallbacks(autoClose)
    }
    return super.dispatchTouchEvent(event)
  }

  @Deprecated("Back before Android 13; later ones go through the OnBackInvokedCallback")
  override fun onBackPressed() {
    close()
  }

  override fun onDestroy() {
    handler.removeCallbacks(autoClose)
    super.onDestroy()
  }

  private fun inside(view: View, event: MotionEvent): Boolean {
    val at = IntArray(2)
    view.getLocationOnScreen(at)
    return event.rawX >= at[0] && event.rawX < at[0] + view.width && event.rawY >= at[1] && event.rawY < at[1] + view.height
  }

  /** Away with the system's own window animation, which slides the sheet down with its dim. */
  private fun close() {
    handler.removeCallbacks(autoClose)
    if (!isFinishing) finish()
  }

  // The sheet, drawn from the frame's measures in dp.

  private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

  private fun px(dp: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp, resources.displayMetrics)

  private fun px(dp: Int) = (px(dp.toFloat()) + 0.5f).toInt()

  private fun sp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, resources.displayMetrics)

  private fun rounded(color: Int, radius: Float, stroke: Int? = null) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = px(radius)
    if (stroke != null) setStroke(px(1), stroke)
  }

  private fun text(size: Float, line: Float, weight: Int, color: Int, value: String) = TextView(this).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
    lineHeight = sp(line).toInt()
    typeface = Typeface.create(Typeface.DEFAULT, weight, false)
    setTextColor(color)
    text = value
    includeFontPadding = false
  }

  private fun content(url: String, title: String): View {
    val colors = if (night) Colors.DARK else Colors.LIGHT
    val host = ShareQueue.host(url)
    val root = FrameLayout(this).apply { setOnClickListener { close() } }

    sheet = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(px(20), px(8), px(20), px(20))
      background = rounded(colors.sheet, 34f, colors.sheetEdge)
      elevation = px(12f)
      isClickable = true
      accessibilityPaneTitle = getString(R.string.koona_share_saved)
    }
    sheet.addView(View(this).apply { background = rounded(colors.grabber, 2.5f) }, LinearLayout.LayoutParams(px(36), px(5)).apply {
      gravity = Gravity.CENTER_HORIZONTAL
      bottomMargin = px(13)
    })

    // The app's icon with the check, the words beside it.
    val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    val icon = FrameLayout(this).apply { clipChildren = false }
    icon.addView(appIcon(), FrameLayout.LayoutParams(px(44), px(44)))
    icon.addView(Check(colors), FrameLayout.LayoutParams(px(24), px(24)).apply {
      leftMargin = px(28)
      topMargin = px(28)
    })
    header.addView(icon, LinearLayout.LayoutParams(px(52), px(52)))
    val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    words.addView(text(18f, 24f, 600, colors.title, getString(R.string.koona_share_saved)).apply { oneLine() })
    words.addView(text(13f, 18f, 500, colors.meta, getString(R.string.koona_share_in_inbox, host)).apply { oneLine() })
    header.addView(words, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
      marginStart = px(8)
      topMargin = px(1)
    })
    sheet.addView(header)

    // The link: a letter tile and its title, or the address while it has none.
    val card = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(px(8), px(8), px(16), px(8))
      background = rounded(colors.card, 22f, colors.cardEdge)
    }
    val tile = text(20f, 24f, 600, 0xEBFFFFFF.toInt(), ShareQueue.letter(title, host)).apply {
      gravity = Gravity.CENTER
      background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(0xFFA49C8E.toInt(), 0xFF5B564E.toInt())).apply {
        cornerRadius = px(14f)
      }
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    card.addView(tile, LinearLayout.LayoutParams(px(48), px(48)))
    card.addView(text(15f, 20f, 600, colors.title, title.ifEmpty { url.substringAfter("://") }).apply {
      maxLines = 2
      ellipsize = TextUtils.TruncateAt.END
    }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = px(12) })
    // 16 dp below the icon, whose box holds the check's overhang too.
    sheet.addView(card, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(64)).apply { topMargin = px(8) })

    val done = text(16f, 20f, 600, colors.onPrimary, getString(R.string.koona_share_done)).apply {
      gravity = Gravity.CENTER
      background = RippleDrawable(ColorStateList.valueOf(colors.ripple), rounded(colors.primary, 26f), null)
      isClickable = true
      isFocusable = true
      setOnClickListener { close() }
    }
    sheet.addView(done, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(52)).apply { topMargin = px(16) })

    // Full width on a phone held upright, 480 dp at most on anything wider.
    val width = minOf(resources.configuration.screenWidthDp - 16, 480).let { if (it > 0) px(it) else ViewGroup.LayoutParams.MATCH_PARENT }
    val margin = px(8)
    root.addView(sheet, FrameLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {
      setMargins(margin, margin, margin, margin)
    })
    // Above the navigation bar and clear of a cutout, whatever the bars are.
    root.setOnApplyWindowInsetsListener { _, insets ->
      val (left, right, bottom) = if (Build.VERSION.SDK_INT >= 30) {
        val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        Triple(bars.left, bars.right, bars.bottom)
      } else {
        @Suppress("DEPRECATION")
        Triple(insets.systemWindowInsetLeft, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
      }
      (sheet.layoutParams as ViewGroup.MarginLayoutParams).setMargins(margin + left, margin, margin + right, margin + bottom)
      sheet.requestLayout()
      insets
    }
    return root
  }

  private fun TextView.oneLine() {
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
  }

  /** The launcher's icon as the square tile it is drawn from, with the frame's corners. */
  private fun appIcon(): View {
    val tile = FrameLayout(this).apply {
      outlineProvider = object : ViewOutlineProvider() {
        override fun getOutline(view: View, outline: Outline) {
          outline.setRoundRect(0, 0, view.width, view.height, px(10f))
        }
      }
      clipToOutline = true
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    val drawable: Drawable = packageManager.getApplicationIcon(applicationInfo)
    if (drawable is AdaptiveIconDrawable) {
      // An adaptive icon's layers are a half larger than the icon on every side, its mask aside.
      val layers = LayerDrawable(arrayOf(drawable.background, drawable.foreground).filterNotNull().toTypedArray())
      tile.addView(ImageView(this).apply { setImageDrawable(layers) }, FrameLayout.LayoutParams(px(66), px(66), Gravity.CENTER))
    } else {
      tile.addView(ImageView(this).apply { setImageDrawable(drawable) }, FrameLayout.LayoutParams(px(44), px(44)))
    }
    return tile
  }

  /** The green check on the icon's corner, ringed with the sheet's colour. */
  private inner class Check(private val colors: Colors) : View(this@ShareActivity) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()

    override fun onDraw(canvas: Canvas) {
      val unit = width / 24f
      paint.style = Paint.Style.FILL
      paint.color = colors.sheet
      canvas.drawCircle(12 * unit, 12 * unit, 12 * unit, paint)
      paint.color = colors.primary
      canvas.drawCircle(12 * unit, 12 * unit, 10 * unit, paint)
      // The frame's check: a 12 dp icon in the middle of the 20 dp badge.
      path.reset()
      path.moveTo(8 * unit, 12 * unit)
      path.lineTo(10.5f * unit, 14.5f * unit)
      path.lineTo(16 * unit, 9 * unit)
      paint.style = Paint.Style.STROKE
      paint.strokeWidth = 2.6f * unit
      paint.strokeCap = Paint.Cap.ROUND
      paint.strokeJoin = Paint.Join.ROUND
      paint.color = colors.onPrimary
      canvas.drawPath(path, paint)
    }
  }

  /** Frame S1's colours, light and dark. */
  private class Colors(
    val sheet: Int,
    val sheetEdge: Int,
    val grabber: Int,
    val title: Int,
    val meta: Int,
    val card: Int,
    val cardEdge: Int,
    val primary: Int,
    val onPrimary: Int,
    val ripple: Int,
  ) {
    companion object {
      val LIGHT = Colors(
        sheet = 0xFFF6F5F1.toInt(), sheetEdge = 0x142E302B, grabber = 0x999A998E.toInt(),
        title = 0xFF2E302B.toInt(), meta = 0xFF66665D.toInt(), card = 0xFFFFFEFA.toInt(), cardEdge = 0x0F2E302B,
        primary = 0xFF2F6B4F.toInt(), onPrimary = 0xFFFFFFFF.toInt(), ripple = 0x33FFFFFF,
      )
      val DARK = Colors(
        sheet = 0xFF1C1C1A.toInt(), sheetEdge = 0x14FFFFFF, grabber = 0x996E6D67.toInt(),
        title = 0xFFECEBE6.toInt(), meta = 0xFF9A9990.toInt(), card = 0xFF262624.toInt(), cardEdge = 0x12FFFFFF,
        primary = 0xFF8FD0AE.toInt(), onPrimary = 0xFF141413.toInt(), ripple = 0x26000000,
      )
    }
  }
}
