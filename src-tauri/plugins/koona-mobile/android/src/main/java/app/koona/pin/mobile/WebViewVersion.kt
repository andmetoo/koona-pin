package app.koona.pin.mobile

/** The Chromium inside the WebView, and whether the interface runs on it (NP-151). */
object WebViewVersion {
  /** The oldest Chromium the interface runs on: Tailwind 4 needs Chrome 111. */
  const val MIN = 111

  data class Found(val packageName: String?, val versionName: String?, val major: Int?)

  private val CHROME = Regex("""\bChrome/(\d+)\.""")

  /**
   * The Chromium major version: from the user agent's `Chrome/NN`, which every Chromium WebView
   * carries whoever ships it; else the provider's version, which is Chromium's only for Google's
   * WebView; else unknown.
   */
  fun chromiumMajor(userAgent: String?, packageVersion: String?): Int? =
    userAgent?.let { CHROME.find(it)?.groupValues?.get(1)?.toIntOrNull() }
      ?: packageVersion?.substringBefore('.')?.toIntOrNull()

  /** An unknown version runs: better a page that may break than a phone locked out. */
  fun supported(major: Int?): Boolean = major == null || major >= MIN
}
