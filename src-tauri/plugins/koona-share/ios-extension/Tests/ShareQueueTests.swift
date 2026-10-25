import Foundation
import XCTest

@testable import KoonaShareQueue

/// The iOS twin of Android's ShareQueueTest.kt: the same fixtures, the same cases.
final class ShareQueueTests: XCTestCase {
  /// The format's examples, shared with the app crate's tests (share_queue.rs) and Kotlin's.
  private let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("queue-fixtures")

  private func written(_ name: String) throws -> String {
    let text = try String(contentsOf: fixtures.appendingPathComponent("written/\(name).json"), encoding: .utf8)
    return String(text.reversed().drop(while: { $0.isWhitespace }).reversed())
  }

  private func links(_ name: String) throws -> [String] {
    try String(contentsOf: fixtures.appendingPathComponent("links/\(name).txt"), encoding: .utf8)
      .components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
  }

  func testAShareIsWrittenAsTheFixturesSay() throws {
    XCTAssertEqual(
      try written("titled"),
      ShareItem(
        requestId: "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f", url: "https://www.inkandswitch.com/essay/local-first/",
        title: "Local-first software: you own your data, in spite of the cloud", createdAt: "2026-10-20T09:41:00.123Z"
      ).json())
    XCTAssertEqual(
      try written("untitled"),
      ShareItem(
        requestId: "0b5e7c1d-2f4a-4e6b-8c9d-0e1f2a3b4c5d", url: "https://example.com/a?b=1&c=%D0%BF#top", title: "",
        createdAt: "2026-10-20T09:42:00Z"
      ).json())
  }

  func testQuotesBackslashesAndControlCharactersAreEscaped() throws {
    XCTAssertEqual(
      try written("escaped"),
      ShareItem(
        requestId: "a3c8e2f1-7d6b-4a59-b0e4-c1d2e3f4a5b6", url: "https://example.org/quotes",
        title: "Ink \"&\" Switch \\ essays\n\tпривет 東京 😀\u{0001}", createdAt: "2026-10-20T09:43:00.5Z"
      ).json())
    XCTAssertEqual(ShareItem.quote("a\u{2028}b\u{2029}"), "\"a\\u2028b\\u2029\"")
  }

  func testANewShareHasALowerCaseIdAndAnRFC3339Time() {
    let item = ShareItem(url: "https://example.com/", title: "", now: Date(timeIntervalSince1970: 1_792_489_260.123))
    XCTAssertEqual(item.requestId, item.requestId.lowercased())
    XCTAssertNotNil(UUID(uuidString: item.requestId))
    XCTAssertEqual(item.createdAt, "2026-10-20T09:41:00.123Z")
  }

  func testTheFileAppearsOnlyWhole() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("koona-share-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let folder = root.appendingPathComponent("share-queue")
    let item = ShareItem(requestId: "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f", url: "https://example.com/", title: "", createdAt: "2026-10-20T09:41:00Z")
    let file = try ShareQueue.write(item, to: folder)
    XCTAssertEqual(file.lastPathComponent, "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f.json")
    XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), item.json())
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), [file.lastPathComponent])
  }

  func testTheFirstWebLinkOfTheTextIsShared() {
    XCTAssertEqual(ShareQueue.firstLink("https://example.com/a"), "https://example.com/a")
    XCTAssertEqual(ShareQueue.firstLink("Look at this: https://example.com/a?b=c, and tell me."), "https://example.com/a?b=c")
    XCTAssertEqual(ShareQueue.firstLink("ftp://example.com/x then http://example.com/"), "http://example.com/")
    XCTAssertEqual(ShareQueue.firstLink("HTTPS://example.com/"), "https://example.com/")
    XCTAssertEqual(ShareQueue.firstLink("(see https://example.com/)"), "https://example.com/")
    XCTAssertEqual(
      ShareQueue.firstLink("See https://en.wikipedia.org/wiki/Bracket_(disambiguation)."), "https://en.wikipedia.org/wiki/Bracket_(disambiguation)")
    XCTAssertEqual(ShareQueue.firstLink("https:// broken https://example.com/b"), "https://example.com/b")
    // Notes shares a note's text with the link on a line of its own.
    XCTAssertEqual(ShareQueue.firstLink("Reading list\n\nhttps://example.com/essay\nfor later"), "https://example.com/essay")
  }

  func testTheSheetTakesTheLinksTheAppTakes() throws {
    for url in try links("accepted") {
      XCTAssertTrue(ShareQueue.acceptable(url), url)
      XCTAssertEqual(ShareQueue.firstLink(url), url)
    }
    XCTAssertTrue(ShareQueue.acceptable("https://example.com/" + String(repeating: "a", count: 8192 - 20)))
  }

  func testTheSheetRefusesTheLinksTheAppRefuses() throws {
    for url in try links("refused") { XCTAssertFalse(ShareQueue.acceptable(url), url) }
    // The app takes these; IDNA2003 and UTS 46 may read them differently, so the sheet does not.
    for url in try links("sheet-refuses") { XCTAssertFalse(ShareQueue.acceptable(url), url) }
    XCTAssertFalse(ShareQueue.acceptable("https://example.com/" + String(repeating: "a", count: 8192 - 19)))
    XCTAssertNil(ShareQueue.firstLink("https://example.com/" + String(repeating: "я", count: 4100)))
    XCTAssertNil(ShareQueue.firstLink("https://example.com:99999/"))
    XCTAssertNil(ShareQueue.firstLink("look: http://[::1 and more"))
    // Right-to-left and left-to-right letters in one label: the Bidi Rule refuses it.
    XCTAssertFalse(ShareQueue.acceptable("https://aא.com/"))
    XCTAssertTrue(ShareQueue.acceptable("https://מבחן.com/"))
  }

  func testAWholeAddressIsTakenWholeOneInATextUpToItsEnd() {
    XCTAssertEqual(ShareQueue.firstLink("https://en.wikipedia.org/wiki/Conan_O'Brien"), "https://en.wikipedia.org/wiki/Conan_O'Brien")
    XCTAssertEqual(ShareQueue.firstLink("About him: https://en.wikipedia.org/wiki/Conan_O'Brien."), "https://en.wikipedia.org/wiki/Conan_O'Brien")
    XCTAssertEqual(ShareQueue.firstLink("'https://example.com/a'"), "https://example.com/a")
    XCTAssertEqual(ShareQueue.firstLink("fonts https://fonts.googleapis.com/css2?family=A|B|"), "https://fonts.googleapis.com/css2?family=A|B")
    XCTAssertEqual(ShareQueue.firstLink("route https://example.com/{id}}"), "https://example.com/{id}")
    XCTAssertEqual(ShareQueue.firstLink("https://example.com/page."), "https://example.com/page")
    XCTAssertEqual(ShareQueue.firstLink("https://example.com/page…"), "https://example.com/page")
    XCTAssertEqual(ShareQueue.firstLink("https://example.com/page)"), "https://example.com/page")
    XCTAssertEqual(ShareQueue.firstLink("https://example.com/a_(b)!"), "https://example.com/a_(b)")
    XCTAssertEqual(ShareQueue.firstLink("https://en.wikipedia.org/wiki/Conan_O'Brien."), "https://en.wikipedia.org/wiki/Conan_O'Brien")
  }

  func testChineseAndJapanesePunctuationEndsALink() {
    XCTAssertEqual(ShareQueue.firstLink("これを見て https://example.jp/a。次へ"), "https://example.jp/a")
    XCTAssertEqual(ShareQueue.firstLink("「https://example.jp/a」"), "https://example.jp/a")
    XCTAssertEqual(ShareQueue.firstLink("看看（https://example.cn/a），好"), "https://example.cn/a")
    XCTAssertEqual(ShareQueue.firstLink("《https://example.cn/a》、【x】"), "https://example.cn/a")
    XCTAssertEqual(ShareQueue.firstLink("“https://example.com/a”"), "https://example.com/a")
    XCTAssertEqual(ShareQueue.firstLink("‘https://example.com/a’…"), "https://example.com/a")
  }

  func testATextWithoutAWebLinkHasNothingToSave() {
    XCTAssertNil(ShareQueue.firstLink(nil))
    XCTAssertNil(ShareQueue.firstLink(""))
    XCTAssertNil(ShareQueue.firstLink("Just words, example.com and mailto:me@example.com"))
    XCTAssertNil(ShareQueue.firstLink("ftp://example.com/file"))
  }

  func testTheSiteIsNamedAsTheAppNamesIt() {
    XCTAssertEqual(ShareQueue.host("https://www.inkandswitch.com/essay/"), "inkandswitch.com")
    XCTAssertEqual(ShareQueue.host("https://user:secret@Example.COM:8443/a?b#c"), "example.com")
    XCTAssertEqual(ShareQueue.host("http://[::1]:8080/"), "[::1]")
    XCTAssertEqual(ShareQueue.host("https://пример.рф"), "пример.рф")
  }

  func testTheTileShowsTheFirstLetter() {
    XCTAssertEqual(ShareQueue.letter("local-first software", "inkandswitch.com"), "L")
    XCTAssertEqual(ShareQueue.letter("", "inkandswitch.com"), "I")
    XCTAssertEqual(ShareQueue.letter("«жизнь»", "example.com"), "Ж")
    XCTAssertEqual(ShareQueue.letter("東京", "example.jp"), "東")
    XCTAssertEqual(ShareQueue.letter("😀 ", "example.com"), "E")
    XCTAssertTrue(ShareQueue.letter("", "").isEmpty)
    XCTAssertTrue(ShareQueue.letter("…", "...").isEmpty)
  }
}
