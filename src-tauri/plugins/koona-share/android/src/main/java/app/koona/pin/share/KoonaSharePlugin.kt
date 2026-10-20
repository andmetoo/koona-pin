package app.koona.pin.share

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * The app's side of the share sheet: only where the queue is, asked once by the crate's Rust side.
 * The sheet itself is [ShareActivity], in a process of its own.
 */
@TauriPlugin
class KoonaSharePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun queueFolder(invoke: Invoke) {
    invoke.resolve(JSObject().put("path", ShareQueue.folder(activity).absolutePath))
  }
}
