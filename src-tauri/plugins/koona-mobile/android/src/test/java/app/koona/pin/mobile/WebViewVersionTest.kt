package app.koona.pin.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WebViewVersionTest {
  @Test
  fun googleWebViewIsReadFromItsUserAgent() {
    val agent = "Mozilla/5.0 (Linux; Android 10; sdk_gphone64_arm64 Build/QSR1.210802.001; wv) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Mobile Safari/537.36"
    assertEquals(91, WebViewVersion.chromiumMajor(agent, "91.0.4472.114"))
    assertFalse(WebViewVersion.supported(91))
  }

  @Test
  fun aVendorWebViewCountsItsChromiumNotItsOwnVersion() {
    val agent = "Mozilla/5.0 (Linux; Android 12; NOH-NX9 Build/HUAWEINOH-N29; wv) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36"
    assertEquals(114, WebViewVersion.chromiumMajor(agent, "14.0.0.302"))
    assertTrue(WebViewVersion.supported(114))
  }

  @Test
  fun withoutAChromeTokenThePackageVersionCounts() {
    assertEquals(145, WebViewVersion.chromiumMajor("Mozilla/5.0 (Linux; Android 15; wv)", "145.0.7632.218"))
  }

  @Test
  fun anUnknownVersionLetsTheAppStart() {
    assertNull(WebViewVersion.chromiumMajor("Mozilla/5.0 (Linux; Android 15; wv)", null))
    assertNull(WebViewVersion.chromiumMajor(null, "unknown"))
    assertTrue(WebViewVersion.supported(null))
  }
}
