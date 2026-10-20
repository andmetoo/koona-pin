package app.koona.pin.share

import android.app.Activity
import android.os.FileObserver
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * The app's side of the share sheet, in the app's process: where the queue is, asked once by the
 * crate's Rust side, and the `queued` event when the sheet renames a share into it while the app
 * runs, so a share made beside a Koona Pin that stays on the screen (split screen, a pop-up window)
 * is taken in at once rather than at the next resume. The sheet itself is [ShareActivity], in a
 * process of its own.
 */
@TauriPlugin
class KoonaSharePlugin(private val activity: Activity) : Plugin(activity) {
  private val folder = ShareQueue.folder(activity).apply { mkdirs() }

  /** Kept for as long as the plugin: a FileObserver that is collected stops watching. */
  @Suppress("unused")
  private val observer = object : FileObserver(folder, MOVED_TO or CLOSE_WRITE) {
    override fun onEvent(event: Int, path: String?) {
      if (path != null && path.endsWith(".json")) activity.runOnUiThread { trigger("queued", JSObject()) }
    }
  }.apply { startWatching() }

  @Command
  fun queueFolder(invoke: Invoke) {
    invoke.resolve(JSObject().put("path", folder.absolutePath))
  }
}
