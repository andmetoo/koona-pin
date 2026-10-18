import SwiftRs
import Tauri
import UIKit
import WebKit

/// A haptic of the page, by its name in src/platform/haptics.ts.
class HapticArgs: Decodable {
  let kind: String
}

/// Koona Pin on iOS (NP-151): a swipe from the left edge goes back one level of the page, as
/// system Back does on Android (`window.__KOONA_MOBILE__.back()`, the plugin's bridge script). At
/// the library it does nothing. A WebContent process the system ends is reloaded by the app
/// through Tauri's own hook. The page's haptics are UIKit's feedback generators, which follow the
/// system's haptics setting (NP-072b).
class KoonaMobilePlugin: Plugin {
  /// How far the finger travels before the swipe counts, in points.
  private let distance: CGFloat = 60
  private weak var webView: WKWebView?

  @objc public override func load(webview: WKWebView) {
    webView = webview
    let swipe = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeSwipe(_:)))
    swipe.edges = .left
    webview.addGestureRecognizer(swipe)
  }

  @objc private func edgeSwipe(_ swipe: UIScreenEdgePanGestureRecognizer) {
    guard swipe.state == .ended, let webView = webView else { return }
    guard swipe.translation(in: webView).x >= distance else { return }
    webView.evaluateJavaScript("window.__KOONA_MOBILE__ && window.__KOONA_MOBILE__.back()", completionHandler: nil)
  }

  /// A haptic of the page; an unknown name plays nothing. It never fails.
  @objc public func haptic(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(HapticArgs.self)
    DispatchQueue.main.async {
      switch args.kind {
      case "selection":
        UISelectionFeedbackGenerator().selectionChanged()
      case "impactLight":
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
      case "impactMedium":
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      case "success":
        UINotificationFeedbackGenerator().notificationOccurred(.success)
      default:
        break
      }
    }
    invoke.resolve()
  }
}

@_cdecl("init_plugin_koona_mobile")
func initPlugin() -> Plugin {
  return KoonaMobilePlugin()
}
