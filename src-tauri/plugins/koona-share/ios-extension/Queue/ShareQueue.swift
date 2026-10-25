import Foundation

/// The App Group the share extension and the app both open; the library stays in the app's own
/// container, only the queue lives here.
let appGroup = "group.app.koona.pin"

/// What the extension posts after a share lands in the queue; the app's koona-share plugin listens
/// while it runs (a Darwin notification: no payload, no network, works across the two processes).
let queuedNotification = "app.koona.pin.share.queued"

/// One shared link, as the queue keeps it (the format is in the crate's lib.rs): the app takes it
/// in with its `request_id`, so a file read twice still makes one bookmark. The iOS twin of
/// Android's `ShareItem` (ShareQueue.kt); both write the files of `queue-fixtures/written`.
struct ShareItem: Equatable {
  let requestId: String
  let url: String
  let title: String
  let createdAt: String

  /// A new share of `url`: a lower-case UUID v4 and the time now, RFC 3339 in UTC with milliseconds.
  init(url: String, title: String, now: Date = Date()) {
    self.init(requestId: UUID().uuidString.lowercased(), url: url, title: title, createdAt: ShareItem.timestamp(now))
  }

  init(requestId: String, url: String, title: String, createdAt: String) {
    self.requestId = requestId
    self.url = url
    self.title = title
    self.createdAt = createdAt
  }

  static func timestamp(_ date: Date) -> String {
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    format.timeZone = TimeZone(identifier: "UTC")
    return format.string(from: date)
  }

  /// The file's text: one JSON object, the keys always in this order.
  func json() -> String {
    "{\"request_id\":\(ShareItem.quote(requestId)),\"url\":\(ShareItem.quote(url)),\"title\":\(ShareItem.quote(title)),\"created_at\":\(ShareItem.quote(createdAt))}"
  }

  /// A JSON string: quotes, backslashes and control characters escaped (and the two line
  /// separators JavaScript reads as line ends), the rest as it is.
  static func quote(_ text: String) -> String {
    var out = "\""
    for scalar in text.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 || scalar.value == 0x2028 || scalar.value == 0x2029 {
          out += "\\u" + String(format: "%04x", scalar.value)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    return out + "\""
  }
}

enum ShareQueueError: Error {
  case cannotWrite(String)
}

/// The queue folder and what goes into it; the app's process reads it (share_queue.rs).
enum ShareQueue {
  /// `share-queue` in the App Group's container; nil when the build has no App Group entitlement.
  static func folder() -> URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
      .appendingPathComponent("share-queue", isDirectory: true)
  }

  /// Writes the item as `<request_id>.json`: first under `.tmp`, synced to disk, then renamed, so
  /// the app never reads half a file. Throws when the file cannot be written.
  @discardableResult
  static func write(_ item: ShareItem, to folder: URL) throws -> URL {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let done = folder.appendingPathComponent("\(item.requestId).json")
    let partial = folder.appendingPathComponent("\(item.requestId).json.tmp")
    let bytes = Array(item.json().utf8)
    let fd = open(partial.path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    if fd < 0 { throw ShareQueueError.cannotWrite("cannot create \(partial.path)") }
    var written = 0
    while written < bytes.count {
      let n = bytes[written...].withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
      if n <= 0 {
        close(fd)
        unlink(partial.path)
        throw ShareQueueError.cannotWrite("cannot write \(partial.path)")
      }
      written += n
    }
    let synced = fsync(fd) == 0
    close(fd)
    if !synced || rename(partial.path, done.path) != 0 {
      unlink(partial.path)
      throw ShareQueueError.cannotWrite("cannot rename \(partial.path)")
    }
    // The rename itself to disk; it is done either way.
    let folderFd = open(folder.path, O_RDONLY)
    if folderFd >= 0 {
      fsync(folderFd)
      close(folderFd)
    }
    return done
  }

  /// As capture.rs refuses a longer one.
  static let maxLinkBytes = 8192

  /// A link in a text ends at a space, a quote, an angle bracket, a backslash, a backtick, or the
  /// punctuation of Chinese and Japanese text (the ideographic block and the full-width brackets,
  /// comma, stop and marks): the expression of Android's sheet.
  private static let link = try! NSRegularExpression(
    pattern: "https?://[^\\s<>\"`\\\\\u{3000}-\u{303F}\u{FF01}\u{FF08}\u{FF09}\u{FF0C}\u{FF0E}\u{FF1A}\u{FF1B}\u{FF1F}]+",
    options: [.caseInsensitive])

  /// What ends a sentence rather than a link, when it is the link's last character.
  private static let trailing: Set<Unicode.Scalar> = Set(".,;:!?'|\u{201D}\u{2019}\u{00BB}\u{203A}\u{2026}".unicodeScalars)

  /// The first link of a shared text the app can save: the whole text when it is one address, as a
  /// browser shares it, else the first http(s) link inside it. Either way punctuation that ends a
  /// sentence is not part of it, nor a closing bracket it did not open. Nil when there is none.
  static func firstLink(_ text: String?) -> String? {
    guard let whole = text?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
    if !whole.unicodeScalars.contains(where: { $0.properties.isWhitespace }), let found = normalized(trimmed(whole)) {
      return found
    }
    let range = NSRange(whole.startIndex..., in: whole)
    for match in link.matches(in: whole, range: range) {
      guard let found = Range(match.range, in: whole) else { continue }
      if let link = normalized(trimmed(String(whole[found]))) { return link }
    }
    return nil
  }

  /// Without the sentence's punctuation after it.
  private static func trimmed(_ link: String) -> String {
    var found = Array(link.unicodeScalars)
    func count(_ c: Unicode.Scalar) -> Int { found.filter { $0 == c }.count }
    while let last = found.last {
      let unopened: Bool
      switch last {
      case ")": unopened = count(")") > count("(")
      case "]": unopened = count("]") > count("[")
      case "}": unopened = count("}") > count("{")
      default: unopened = false
      }
      if trailing.contains(last) || unopened { found.removeLast() } else { break }
    }
    var out = String.UnicodeScalarView()
    out.append(contentsOf: found)
    return String(out)
  }

  /// The scheme of a link, as written; empty without `://`.
  private static func scheme(_ url: String) -> String {
    guard let range = url.range(of: "://") else { return "" }
    return String(url[..<range.lowerBound])
  }

  private static func afterScheme(_ url: String) -> String {
    guard let range = url.range(of: "://") else { return "" }
    return String(url[range.upperBound...])
  }

  /// The link with its scheme in lower case, if the app can save it.
  private static func normalized(_ found: String) -> String? {
    let scheme = scheme(found).lowercased()
    guard scheme == "http" || scheme == "https" else { return nil }
    let link = "\(scheme)://\(afterScheme(found))"
    return acceptable(link) ? link : nil
  }

  /// Characters a host never has (the URL Standard's forbidden host code points, and `%`).
  private static let forbiddenHost: Set<Unicode.Scalar> = Set(" #%/:<>?@[\\]^|".unicodeScalars)

  /// The full stops of a host: ASCII's and the ideographic and full-width ones.
  private static let dots: Set<Unicode.Scalar> = [".", "\u{3002}", "\u{FF0E}", "\u{FF61}"]

  /// The host and the port of a link as written: an IPv6 literal keeps its brackets.
  private struct Authority {
    let host: String
    let port: String?
  }

  /// The host and port, as the url crate splits them for http and https: the authority ends at `/`,
  /// `\`, `?` or `#`, the user's name and password end at its last `@`. Nil when the brackets of an
  /// IPv6 literal are not closed or something follows them other than a port.
  private static func authority(_ url: String) -> Authority? {
    let authority = String(afterScheme(url).prefix { $0 != "/" && $0 != "?" && $0 != "#" && $0 != "\\" })
    let hostPort = authority.range(of: "@", options: .backwards).map { String(authority[$0.upperBound...]) } ?? authority
    if !hostPort.hasPrefix("[") {
      if let colon = hostPort.firstIndex(of: ":") {
        return Authority(host: String(hostPort[..<colon]), port: String(hostPort[hostPort.index(after: colon)...]))
      }
      return Authority(host: hostPort, port: nil)
    }
    guard let end = hostPort.firstIndex(of: "]") else { return nil }
    let after = String(hostPort[hostPort.index(after: end)...])
    if !after.isEmpty && !after.hasPrefix(":") { return nil }
    return Authority(host: String(hostPort[...end]), port: after.isEmpty ? nil : String(after.dropFirst()))
  }

  /// Whether the app's capture takes the link (capture.rs `validate_url`, the url crate): http or
  /// https, at most 8192 bytes, a host, a port up to 65535. Where this side cannot be sure it
  /// refuses, so the sheet never says saved for a link the app puts aside. As Android's sheet does,
  /// a host outside ASCII may hold letters, digits, marks and the full stops of other scripts only;
  /// Foundation has no IDNA, so its mapping is approximated by NFKC and lower case, and a label of a
  /// right-to-left script must be one of that script alone.
  static func acceptable(_ url: String) -> Bool {
    if url.utf8.count > maxLinkBytes { return false }
    if url.unicodeScalars.contains(where: { $0.properties.isWhitespace || $0.value < 0x20 }) { return false }
    let scheme = scheme(url).lowercased()
    guard scheme == "http" || scheme == "https" else { return false }
    guard let authority = authority(url) else { return false }
    let host = authority.host
    if host.hasPrefix("[") {
      if !ipv6(String(host.dropFirst().dropLast())) { return false }
    } else if !acceptableHost(host) {
      return false
    }
    guard let port = authority.port else { return true }
    return port.isEmpty || (port.count <= 5 && port.allSatisfy { ("0"..."9").contains($0) } && Int(port)! <= 65535)
  }

  private static func acceptableHost(_ host: String) -> Bool {
    if host.isEmpty || !host.unicodeScalars.allSatisfy(hostCodePoint) { return false }
    let labels = split(host)
    // A label may not begin with a mark (UTS 46; IDNA2003 lets it).
    if labels.contains(where: { $0.first.map(mark) ?? false }) { return false }
    // IDNA's mapping, near enough for what follows: full-width forms to ASCII, upper case to lower.
    let mapped = split(host.precomposedStringWithCompatibilityMapping.lowercased())
    // No empty label, but for the root's after a final dot.
    if mapped.dropLast().contains(where: { $0.isEmpty }) || mapped.allSatisfy({ $0.isEmpty }) { return false }
    for label in mapped {
      if label.allSatisfy({ $0.isASCII }) {
        if label.count > 63 || label.contains(where: { forbiddenHost.contains($0) || $0.value <= 0x20 || $0.value > 0x7e }) { return false }
      } else if label.contains(where: { $0.isASCII && forbiddenHost.contains($0) }) {
        return false
      }
    }
    if !bidiSafe(mapped) { return false }
    // A host that ends in a number is an IPv4 address to the url crate: only the dotted four.
    let named = mapped.last?.isEmpty == true ? Array(mapped.dropLast()) : mapped
    if let last = named.last, !last.isEmpty {
      let text = String(String.UnicodeScalarView(last))
      let numeric = last.allSatisfy { ("0"..."9").contains($0) } || text.hasPrefix("0x")
      if numeric && !ipv4(named.map { String(String.UnicodeScalarView($0)) }.joined(separator: ".")) { return false }
    }
    return true
  }

  private static func split(_ host: String) -> [[Unicode.Scalar]] {
    var labels: [[Unicode.Scalar]] = [[]]
    for scalar in host.unicodeScalars {
      if dots.contains(scalar) { labels.append([]) } else { labels[labels.count - 1].append(scalar) }
    }
    return labels
  }

  /// A character of a host the IDNA versions read alike: ASCII, or a letter, digit or mark of the
  /// Basic Multilingual Plane.
  private static func hostCodePoint(_ scalar: Unicode.Scalar) -> Bool {
    if scalar.isASCII || dots.contains(scalar) { return true }
    if scalar.value > 0xFFFF { return false }
    switch scalar.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
      .nonspacingMark, .spacingMark, .decimalNumber:
      return true
    default:
      return false
    }
  }

  private static func mark(_ scalar: Unicode.Scalar) -> Bool {
    let category = scalar.properties.generalCategory
    return category == .nonspacingMark || category == .spacingMark
  }

  /// Hebrew, Arabic and the other right-to-left blocks of the BMP.
  private static func rightToLeft(_ scalar: Unicode.Scalar) -> Bool {
    let v = scalar.value
    return (0x0590...0x08FF).contains(v) || (0xFB1D...0xFDFF).contains(v) || (0xFE70...0xFEFF).contains(v)
  }

  /// The Bidi Rule (RFC 5893), on the safe side: in a host with a right-to-left label, that label
  /// starts with a right-to-left letter and holds nothing left-to-right, and every other label
  /// starts with an ASCII letter.
  private static func bidiSafe(_ labels: [[Unicode.Scalar]]) -> Bool {
    guard labels.contains(where: { $0.contains(where: rightToLeft) }) else { return true }
    for label in labels where !label.isEmpty {
      if label.contains(where: rightToLeft) {
        guard let first = label.first, rightToLeft(first), !mark(first) else { return false }
        if label.contains(where: { !rightToLeft($0) && !mark($0) && !("0"..."9").contains($0) && $0 != "-" }) {
          return false
        }
        if label.last == "-" { return false }
      } else if let first = label.first, !(first.isASCII && first.properties.isAlphabetic) {
        return false
      }
    }
    return true
  }

  private static func ipv4(_ host: String) -> Bool {
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    return parts.count == 4 && parts.allSatisfy { part in
      !part.isEmpty && part.count <= 3 && part.allSatisfy { ("0"..."9").contains($0) } && Int(part)! <= 255
    }
  }

  private static func ipv6(_ address: String) -> Bool {
    if address.isEmpty || address.filter({ $0 == ":" }).count < 2 { return false }
    let halves = address.components(separatedBy: "::")
    if halves.count > 2 { return false }
    let groups = halves.flatMap { half in half.isEmpty ? [] : half.components(separatedBy: ":") }
    var count = 0
    for (i, group) in groups.enumerated() {
      if i == groups.count - 1 && group.contains(".") {
        if !ipv4(group) { return false }
        count += 2
      } else if (1...4).contains(group.count) && group.allSatisfy({ $0.isHexDigit && $0.isASCII }) {
        count += 1
      } else {
        return false
      }
    }
    return halves.count == 2 ? count <= 7 : count == 8
  }

  /// The site of a link as the app names it: the host in lower case, without `www.`.
  static func host(_ url: String) -> String {
    let host = authority(url)?.host.lowercased() ?? ""
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
  }

  /// The letter of the title's tile: its first letter or digit, else the site's, else none.
  static func letter(_ title: String, _ host: String) -> String {
    for text in [title, host] {
      for scalar in text.unicodeScalars {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber:
          return String(scalar).uppercased()
        default:
          continue
        }
      }
    }
    return ""
  }
}
