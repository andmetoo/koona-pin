package app.koona.pin.mobile

import android.view.HapticFeedbackConstants
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SignalsTest {
  @Test
  fun theBridgeGetsOneJsonObject() {
    assertEquals(
      "{\"powerSave\":true,\"lowRam\":false,\"textScale\":1.3}",
      Signals(powerSave = true, lowRam = false, textScale = Signals.textScale(130)).json(),
    )
  }

  @Test
  fun theTextScaleIsTheWebViewsTextZoom() {
    assertEquals(1f, Signals.textScale(100), 0f)
    assertEquals(2f, Signals.textScale(200), 0f)
    assertEquals(0.01f, Signals.textScale(0), 0f)
  }

  @Test
  fun theTextZoomIsTheSystemsFontScale() {
    assertEquals(100, Signals.textZoom(1f))
    assertEquals(130, Signals.textZoom(1.3f))
    assertEquals(200, Signals.textZoom(2f))
    assertEquals(85, Signals.textZoom(0.85f))
  }

  @Test
  fun eachHapticOfThePageHasTheSystemsOwnFeedback() {
    assertEquals(HapticFeedbackConstants.CLOCK_TICK, Haptics.constant("selection", 29))
    assertEquals(HapticFeedbackConstants.CONTEXT_CLICK, Haptics.constant("impactLight", 33))
    assertEquals(HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE, Haptics.constant("impactLight", 34))
    assertEquals(HapticFeedbackConstants.VIRTUAL_KEY, Haptics.constant("impactMedium", 29))
    assertEquals(HapticFeedbackConstants.VIRTUAL_KEY, Haptics.constant("success", 29))
    assertEquals(HapticFeedbackConstants.CONFIRM, Haptics.constant("success", 30))
  }

  @Test
  fun anUnknownHapticPlaysNothing() {
    assertNull(Haptics.constant("vibrate", 37))
  }
}
