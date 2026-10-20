package app.koona.pin.share

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareQueueTest {
  /** The format's examples, shared with the app crate's tests (share_queue.rs); Gradle runs this in `android/`. */
  private fun written(name: String) = File("../queue-fixtures/written/$name.json").readText(Charsets.UTF_8).trimEnd()

  @Test
  fun aShareIsWrittenAsTheFixturesSay() {
    assertEquals(
      written("titled"),
      ShareItem(
        "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f",
        "https://www.inkandswitch.com/essay/local-first/",
        "Local-first software: you own your data, in spite of the cloud",
        "2026-10-20T09:41:00.123Z",
      ).json(),
    )
    assertEquals(
      written("untitled"),
      ShareItem("0b5e7c1d-2f4a-4e6b-8c9d-0e1f2a3b4c5d", "https://example.com/a?b=1&c=%D0%BF#top", "", "2026-10-20T09:42:00Z").json(),
    )
  }

  @Test
  fun quotesBackslashesAndControlCharactersAreEscaped() {
    assertEquals(
      written("escaped"),
      ShareItem(
        "a3c8e2f1-7d6b-4a59-b0e4-c1d2e3f4a5b6",
        "https://example.org/quotes",
        "Ink \"&\" Switch \\ essays\n\tпривет 東京 😀\u0001",
        "2026-10-20T09:43:00.5Z",
      ).json(),
    )
  }

  @Test
  fun theFileAppearsOnlyWhole() {
    val root = Files.createTempDirectory("koona-share").toFile()
    val folder = root.resolve("share-queue")
    val item = ShareItem("6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f", "https://example.com/", "", "2026-10-20T09:41:00Z")
    val file = ShareQueue.write(folder, item)
    assertEquals(File(folder, "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f.json"), file)
    assertEquals(item.json(), file.readText(Charsets.UTF_8))
    assertEquals(listOf(file.name), folder.list()!!.toList())
    root.deleteRecursively()
  }

  @Test
  fun theFirstWebLinkOfTheTextIsShared() {
    assertEquals("https://example.com/a", ShareQueue.firstLink("https://example.com/a"))
    assertEquals("https://example.com/a?b=c", ShareQueue.firstLink("Look at this: https://example.com/a?b=c, and tell me."))
    assertEquals("http://example.com/", ShareQueue.firstLink("ftp://example.com/x then http://example.com/"))
    assertEquals("https://example.com/", ShareQueue.firstLink("HTTPS://example.com/"))
    assertEquals("https://example.com/", ShareQueue.firstLink("(see https://example.com/)"))
    assertEquals("https://en.wikipedia.org/wiki/Bracket_(disambiguation)", ShareQueue.firstLink("See https://en.wikipedia.org/wiki/Bracket_(disambiguation)."))
    assertEquals("https://example.com/b", ShareQueue.firstLink("https:// broken https://example.com/b"))
  }

  /** Links the app's capture takes and refuses, one per line; share_queue.rs tests them against validate_url. */
  private fun links(name: String) = File("../queue-fixtures/links/$name.txt").readLines(Charsets.UTF_8).map { it.trim() }.filter { it.isNotEmpty() }

  @Test
  fun theSheetTakesTheLinksTheAppTakes() {
    for (url in links("accepted")) {
      assertTrue(url, ShareQueue.acceptable(url))
      assertEquals(url, ShareQueue.firstLink(url))
    }
    assertTrue(ShareQueue.acceptable("https://example.com/" + "a".repeat(8192 - 20)))
  }

  @Test
  fun theSheetRefusesTheLinksTheAppRefuses() {
    for (url in links("refused")) assertFalse(url, ShareQueue.acceptable(url))
    // The app takes these; IDNA2003 and UTS 46 may read them differently, so the sheet does not.
    for (url in links("sheet-refuses")) assertFalse(url, ShareQueue.acceptable(url))
    assertFalse(ShareQueue.acceptable("https://example.com/" + "a".repeat(8192 - 19)))
    assertNull(ShareQueue.firstLink("https://example.com/" + "я".repeat(4100)))
    assertNull(ShareQueue.firstLink("https://example.com:99999/"))
    assertNull(ShareQueue.firstLink("look: http://[::1 and more"))
  }

  @Test
  fun aWholeAddressIsTakenWholeOneInATextUpToItsEnd() {
    assertEquals("https://en.wikipedia.org/wiki/Conan_O'Brien", ShareQueue.firstLink("https://en.wikipedia.org/wiki/Conan_O'Brien"))
    assertEquals("https://en.wikipedia.org/wiki/Conan_O'Brien", ShareQueue.firstLink("About him: https://en.wikipedia.org/wiki/Conan_O'Brien."))
    assertEquals("https://example.com/a", ShareQueue.firstLink("'https://example.com/a'"))
    assertEquals("https://fonts.googleapis.com/css2?family=A|B", ShareQueue.firstLink("fonts https://fonts.googleapis.com/css2?family=A|B|"))
    assertEquals("https://example.com/{id}", ShareQueue.firstLink("route https://example.com/{id}}"))
    assertEquals("https://example.com/page", ShareQueue.firstLink("https://example.com/page."))
    assertEquals("https://example.com/page", ShareQueue.firstLink("https://example.com/page…"))
    assertEquals("https://example.com/page", ShareQueue.firstLink("https://example.com/page)"))
    assertEquals("https://example.com/a_(b)", ShareQueue.firstLink("https://example.com/a_(b)!"))
    assertEquals("https://en.wikipedia.org/wiki/Conan_O'Brien", ShareQueue.firstLink("https://en.wikipedia.org/wiki/Conan_O'Brien."))
  }

  @Test
  fun chineseAndJapanesePunctuationEndsALink() {
    assertEquals("https://example.jp/a", ShareQueue.firstLink("これを見て https://example.jp/a。次へ"))
    assertEquals("https://example.jp/a", ShareQueue.firstLink("「https://example.jp/a」"))
    assertEquals("https://example.cn/a", ShareQueue.firstLink("看看（https://example.cn/a），好"))
    assertEquals("https://example.cn/a", ShareQueue.firstLink("《https://example.cn/a》、【x】"))
    assertEquals("https://example.com/a", ShareQueue.firstLink("“https://example.com/a”"))
    assertEquals("https://example.com/a", ShareQueue.firstLink("‘https://example.com/a’…"))
  }

  @Test
  fun aTextWithoutAWebLinkHasNothingToSave() {
    assertNull(ShareQueue.firstLink(null))
    assertNull(ShareQueue.firstLink(""))
    assertNull(ShareQueue.firstLink("Just words, example.com and mailto:me@example.com"))
    assertNull(ShareQueue.firstLink("ftp://example.com/file"))
  }

  @Test
  fun theSiteIsNamedAsTheAppNamesIt() {
    assertEquals("inkandswitch.com", ShareQueue.host("https://www.inkandswitch.com/essay/"))
    assertEquals("example.com", ShareQueue.host("https://user:secret@Example.COM:8443/a?b#c"))
    assertEquals("[::1]", ShareQueue.host("http://[::1]:8080/"))
    assertEquals("пример.рф", ShareQueue.host("https://пример.рф"))
  }

  @Test
  fun theTileShowsTheFirstLetter() {
    assertEquals("L", ShareQueue.letter("local-first software", "inkandswitch.com"))
    assertEquals("I", ShareQueue.letter("", "inkandswitch.com"))
    assertEquals("Ж", ShareQueue.letter("«жизнь»", "example.com"))
    assertEquals("東", ShareQueue.letter("東京", "example.jp"))
    assertEquals("E", ShareQueue.letter("😀 ", "example.com"))
    assertTrue(ShareQueue.letter("", "").isEmpty())
    assertFalse(ShareQueue.letter("…", "...").isNotEmpty())
  }
}
