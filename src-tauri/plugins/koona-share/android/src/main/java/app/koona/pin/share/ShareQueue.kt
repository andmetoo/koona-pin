package app.koona.pin.share

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

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
    return done
  }

  private val link = Regex("""https?://[^\s<>"'`{}|\\^]+""", RegexOption.IGNORE_CASE)

  /**
   * The first http(s) link in a shared text: the whole text from a browser, a link inside a message
   * from other apps. Punctuation that ends a sentence is not part of it, nor a closing bracket the
   * link did not open. Null when there is none.
   */
  fun firstLink(text: String?): String? {
    if (text == null) return null
    for (match in link.findAll(text)) {
      var found = match.value
      while (found.isNotEmpty()) {
        val last = found.last()
        val unopened = when (last) {
          ')' -> found.count { it == ')' } > found.count { it == '(' }
          ']' -> found.count { it == ']' } > found.count { it == '[' }
          else -> false
        }
        if (last in ".,;:!?" || unopened) found = found.dropLast(1) else break
      }
      val scheme = found.substringBefore("://")
      val rest = found.substringAfter("://")
      if (host("$scheme://$rest").isEmpty()) continue
      return "${scheme.lowercase()}://$rest"
    }
    return null
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
