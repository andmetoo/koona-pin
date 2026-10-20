package app.koona.pin.share

import android.content.Context
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.IDN

/**
 * One shared link, as the queue keeps it (the format is in the crate's lib.rs): the app takes it
 * in with its `request_id`, so a file read twice still makes one bookmark.
 */
data class ShareItem(val requestId: String, val url: String, val title: String, val createdAt: String) {
  /** The file's text: one JSON object, the keys always in this order. */
  fun json(): String =
    "{\"request_id\":${quote(requestId)},\"url\":${quote(url)},\"title\":${quote(title)},\"created_at\":${quote(createdAt)}}"

  companion object {
    /** A JSON string: quotes, backslashes and control characters escaped, the rest as it is. */
    fun quote(text: String): String {
      val out = StringBuilder(text.length + 2).append('"')
      for (c in text) {
        when (c) {
          '"' -> out.append("\\\"")
          '\\' -> out.append("\\\\")
          '\n' -> out.append("\\n")
          '\r' -> out.append("\\r")
          '\t' -> out.append("\\t")
          else -> if (c < ' ' || c == ' ' || c == ' ') out.append("\\u").append(Integer.toHexString(c.code).padStart(4, '0')) else out.append(c)
        }
      }
      return out.append('"').toString()
    }
  }
}

/** The queue folder and what goes into it; the app's process reads it (share_queue.rs). */
object ShareQueue {
  /** In the app's own storage, which the app's process reads as well: `filesDir/share-queue`. */
  fun folder(context: Context): File = File(context.filesDir, "share-queue")

  /**
   * Writes the item as `<request_id>.json`: first under `.tmp`, synced to disk, then renamed, so
   * the app never reads half a file. Throws when the file cannot be written.
   */
  fun write(folder: File, item: ShareItem): File {
    if (!folder.isDirectory && !folder.mkdirs()) throw IOException("cannot create $folder")
    val done = File(folder, "${item.requestId}.json")
    val partial = File(folder, "${item.requestId}.json.tmp")
    FileOutputStream(partial).use { stream ->
      stream.write(item.json().toByteArray(Charsets.UTF_8))
      stream.fd.sync()
    }
    if (!partial.renameTo(done)) {
      partial.delete()
      throw IOException("cannot rename $partial")
    }
    syncFolder(folder)
    return done
  }

  /** The rename itself to disk, where the system lets a folder be synced; it is done either way. */
  private fun syncFolder(folder: File) {
    try {
      val fd = Os.open(folder.path, OsConstants.O_RDONLY, 0)
      try {
        Os.fsync(fd)
      } finally {
        Os.close(fd)
      }
    } catch (error: Exception) {
      // An ErrnoException, or a JVM test without Android's Os.
    }
  }

  /** As capture.rs refuses a longer one. */
  private const val MAX_LINK_BYTES = 8192

  /**
   * A link in a text ends at a space, a quote, an angle bracket, a backslash, a backtick, or the
   * punctuation of Chinese and Japanese text (the ideographic block and the full-width brackets,
   * comma, stop and marks).
   */
  private val link = Regex("""https?://[^\s<>"`\\　-〿！（），．：；？]+""", RegexOption.IGNORE_CASE)

  /** What ends a sentence rather than a link, when it is the link's last character. */
  private const val TRAILING = ".,;:!?'|”’»›…"

  /**
   * The first link of a shared text the app can save: the whole text when it is one address, as a
   * browser shares it, else the first http(s) link inside it. Punctuation that ends a sentence is
   * not part of a link inside a text, nor a closing bracket the link did not open. Null when there
   * is none.
   */
  fun firstLink(text: String?): String? {
    val whole = text?.trim() ?: return null
    if (whole.none { it.isWhitespace() }) normalized(whole)?.let { return it }
    for (match in link.findAll(whole)) {
      var found = match.value
      while (found.isNotEmpty()) {
        val last = found.last()
        val unopened = when (last) {
          ')' -> found.count { it == ')' } > found.count { it == '(' }
          ']' -> found.count { it == ']' } > found.count { it == '[' }
          '}' -> found.count { it == '}' } > found.count { it == '{' }
          else -> false
        }
        if (last in TRAILING || unopened) found = found.dropLast(1) else break
      }
      normalized(found)?.let { return it }
    }
    return null
  }

  /** The link with its scheme in lower case, if the app can save it. */
  private fun normalized(found: String): String? {
    val scheme = found.substringBefore("://", "").lowercase()
    if (scheme != "http" && scheme != "https") return null
    return "$scheme://${found.substringAfter("://")}".takeIf(::acceptable)
  }

  /** Characters a host never has (the URL Standard's forbidden host code points, and `%`). */
  private const val FORBIDDEN_HOST = " #%/:<>?@[\\]^|"

  /**
   * Whether the app's capture takes the link (capture.rs `validate_url`, the url crate): http or
   * https, at most 8192 bytes, a host, a port up to 65535. Read here by hand: java.net.URI is
   * stricter than browsers and the url crate (it refuses `|`, `{}`, `[` in a path, a second `#`),
   * and InetAddress may look a name up. Where the two may differ, this side refuses, so a link the
   * sheet calls saved is never put aside by the app.
   */
  fun acceptable(url: String): Boolean {
    if (url.toByteArray(Charsets.UTF_8).size > MAX_LINK_BYTES || url.any { it.isWhitespace() || it < ' ' }) return false
    val scheme = url.substringBefore("://", "").lowercase()
    if (scheme != "http" && scheme != "https") return false
    val authority = url.substringAfter("://").takeWhile { it != '/' && it != '?' && it != '#' && it != '\\' }
    val hostPort = authority.substringAfterLast('@')
    val port: String
    if (hostPort.startsWith("[")) {
      val end = hostPort.indexOf(']')
      if (end < 0 || !ipv6(hostPort.substring(1, end))) return false
      val after = hostPort.substring(end + 1)
      if (after.isNotEmpty() && !after.startsWith(":")) return false
      port = after.removePrefix(":")
    } else {
      val host = hostPort.substringBefore(':')
      port = hostPort.substringAfter(':', "")
      val ascii = try {
        IDN.toASCII(host, IDN.ALLOW_UNASSIGNED)
      } catch (error: IllegalArgumentException) {
        return false
      }
      if (ascii.isEmpty() || ascii.any { it in FORBIDDEN_HOST || it.code > 0x7e }) return false
      // A host that ends in a number is an IPv4 address to the url crate: only the dotted four.
      val last = ascii.trimEnd('.').substringAfterLast('.')
      if (last.isNotEmpty() && (last.all { it.isDigit() } || last.startsWith("0x", ignoreCase = true)) && !ipv4(ascii.trimEnd('.'))) return false
    }
    return port.isEmpty() || (port.length <= 5 && port.all { it in '0'..'9' } && port.toInt() <= 65535)
  }

  private fun ipv4(host: String): Boolean {
    val parts = host.split('.')
    return parts.size == 4 && parts.all { it.isNotEmpty() && it.length <= 3 && it.all { c -> c in '0'..'9' } && it.toInt() <= 255 }
  }

  private fun ipv6(address: String): Boolean {
    if (address.isEmpty() || address.count { it == ':' } < 2) return false
    val halves = address.split("::")
    if (halves.size > 2) return false
    val groups = halves.flatMap { half -> if (half.isEmpty()) emptyList() else half.split(':') }
    var count = 0
    for ((i, group) in groups.withIndex()) {
      if (i == groups.lastIndex && '.' in group) {
        if (!ipv4(group)) return false
        count += 2
      } else if (group.length in 1..4 && group.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
        count += 1
      } else {
        return false
      }
    }
    return if (halves.size == 2) count <= 7 else count == 8
  }

  /** The site of a link as the app names it: the host in lower case, without `www.`. */
  fun host(url: String): String {
    val authority = url.substringAfter("://", "").takeWhile { it != '/' && it != '?' && it != '#' }
    val host = authority.substringAfterLast('@').let { hostPort ->
      if (hostPort.startsWith("[")) hostPort.substringBefore(']') + "]" else hostPort.substringBefore(':')
    }.lowercase()
    return host.removePrefix("www.")
  }

  /** The letter of the title's tile: its first letter or digit, else the site's, else none. */
  fun letter(title: String, host: String): String {
    for (text in listOf(title, host)) {
      var i = 0
      while (i < text.length) {
        val point = text.codePointAt(i)
        if (Character.isLetterOrDigit(point)) return String(Character.toChars(point)).uppercase()
        i += Character.charCount(point)
      }
    }
    return ""
  }
}
