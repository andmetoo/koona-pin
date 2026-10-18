package app.koona.pin.mobile

import android.view.HapticFeedbackConstants
import kotlin.math.roundToInt

/**
 * What the system says about how the page should draw (NP-072b), as the bridge script reads it
 * (`window.__KOONA_MOBILE__.system()`): battery saver and a low-RAM device draw the glass flat
 * (doc/mobile-design.md, performance rule 6); the text scale is the WebView's text zoom, which
 * follows the system's font size.
 */
internal data class Signals(val powerSave: Boolean, val lowRam: Boolean, val textScale: Float) {
  /** A JSON object, and a JavaScript literal as well: the bridge parses it or gets it as is. */
  fun json(): String = "{\"powerSave\":$powerSave,\"lowRam\":$lowRam,\"textScale\":$textScale}"

  companion object {
    /** The text scale from the WebView's text zoom in percent, never below 1 % of a pixel. */
    fun textScale(textZoom: Int): Float = maxOf(textZoom, 1) / 100f

    /** The WebView's text zoom in percent for the system's font scale, as Chromium computes it. */
    fun textZoom(fontScale: Float): Int = maxOf((fontScale * 100).roundToInt(), 1)
  }
}

/**
 * The page's haptics (src/platform/haptics.ts) as the system's own touch feedback on the WebView,
 * which follows the system's touch-feedback setting (a vibration pattern does not).
 */
internal object Haptics {
  /** The constant for `performHapticFeedback` on this system version; null for a name it does not know. */
  fun constant(kind: String, sdk: Int): Int? = when (kind) {
    // A section or tab changed, a menu opened, pull-to-refresh armed.
    "selection" -> HapticFeedbackConstants.CLOCK_TICK
    // A triage swipe passed its threshold: Android 14 has a feedback for exactly that.
    "impactLight" -> if (sdk >= 34) HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE else HapticFeedbackConstants.CONTEXT_CLICK
    // A decision landed.
    "impactMedium" -> HapticFeedbackConstants.VIRTUAL_KEY
    // The inbox is sorted.
    "success" -> if (sdk >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
    else -> null
  }
}
