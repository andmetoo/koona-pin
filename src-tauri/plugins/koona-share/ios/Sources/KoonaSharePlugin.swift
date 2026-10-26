import Foundation
import SwiftRs
import Tauri
import UIKit
import WebKit

/// The App Group of the app and its share extension, and the queue folder in its container: the
/// same names as the extension's ShareQueue.swift (ios-extension/Queue).
private let appGroup = "group.app.koona.pin"
private let queueFolderName = "share-queue"
/// The Darwin notification the extension posts after each share it queues.
private let queuedNotification = "app.koona.pin.share.queued"

/// The app's side of the share extension, in the app's process: where the queue is, asked once by
/// the crate's Rust side, and the `queued` event when the extension renames a share into it while
/// the app runs, so a share made over a Koona Pin that stays alive is taken in at once rather than
/// at the next resume. The extension itself runs in a process of its own (koonapin_Share).
class KoonaSharePlugin: Plugin {
  private var observing = false

  @objc public override func load(webview: WKWebView) {
    if observing { return }
    let observer = Unmanaged.passUnretained(self).toOpaque()
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(), observer,
      { _, observer, _, _, _ in
        guard let observer = observer else { return }
        let plugin = Unmanaged<KoonaSharePlugin>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async { plugin.trigger("queued", data: JSObject()) }
      },
      queuedNotification as CFString, nil, .deliverImmediately)
    observing = true
  }

  deinit {
    if observing {
      CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
    }
  }

  /// The queue folder in the App Group's container, made if missing; an error when the build has
  /// no App Group entitlement (the share extension then has nowhere to write either).
  @objc public func queueFolder(_ invoke: Invoke) {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
      invoke.reject("no App Group container: the app is signed without \(appGroup)")
      return
    }
    let folder = container.appendingPathComponent(queueFolderName, isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    invoke.resolve(["path": folder.path])
  }
}

@_cdecl("init_plugin_koona_share")
func initPlugin() -> Plugin {
  return KoonaSharePlugin()
}
