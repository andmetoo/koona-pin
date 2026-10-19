import SwiftRs
import Tauri
import UIKit
import WebKit

/// A haptic of the page, by its name in src/platform/haptics.ts.
class HapticArgs: Decodable {
  let kind: String
}

/// The page's messages to the plugin, held weakly: the content controller keeps its handlers.
private class WeakMessages: NSObject, WKScriptMessageHandler {
  weak var plugin: KoonaMobilePlugin?

  init(_ plugin: KoonaMobilePlugin) {
    self.plugin = plugin
  }

  @MainActor func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    plugin?.received(message)
  }
}

/// Koona Pin on iOS (NP-151): a swipe from the left edge goes back one level of the page, as
/// system Back does on Android (`window.__KOONA_MOBILE__.back()`, the plugin's bridge script). At
/// the library it does nothing. A WebContent process the system ends is reloaded by the app
/// through Tauri's own hook. The page's haptics are UIKit's feedback generators, which follow the
/// system's haptics setting (NP-072b).
///
/// The look on iOS: Low Power Mode and Reduce Transparency draw the glass flat, as Android's
/// battery saver does (the bridge's `systemChanged`, src/platform/system.ts); WebKit has no
/// `prefers-reduced-transparency`. The status bar follows the page's theme, not only the
/// system's. The page itself does not rubber-band: its screens scroll, and bounce, inside it.
class KoonaMobilePlugin: Plugin {
  /// How far the finger travels before the swipe counts, in points.
  private let distance: CGFloat = 60
  private weak var webView: WKWebView?
  /// The theme the page draws ("light" or "dark"), for the status bar; nil until it says.
  private var pageTheme: String?

  @objc public override func load(webview: WKWebView) {
    webView = webview
    let swipe = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeSwipe(_:)))
    swipe.edges = .left
    webview.addGestureRecognizer(swipe)

    // The page is a fixed frame whose screens scroll by themselves: the WebView's own scroll view
    // bouncing would move the bars with it.
    webview.scrollView.bounces = false
    // Nor does its edge effect (iOS 26) belong there: it would shade the status bar in the
    // system's appearance, not the page's, and the page draws its own fades.
    if #available(iOS 26.0, *) {
      MainActor.assumeIsolated {
        let scroll = webview.scrollView
        for edge in [scroll.topEdgeEffect, scroll.leftEdgeEffect, scroll.bottomEdgeEffect, scroll.rightEdgeEffect] {
          edge.isHidden = true
        }
      }
    }

    // The keyboard: the page learns its height as the bottom inset, as Android passes it
    // (`--kp-inset-bottom`, the bridge's `insets`), so sheets and bars rise above it; while it is
    // up the WebView does not scroll the whole page up to reveal a field, which moved the bars off
    // the screen. Otherwise WebKit's own scrolling is left alone.
    pinned = webview.scrollView.observe(\.contentOffset, options: [.new]) { [weak self] scroll, _ in
      MainActor.assumeIsolated {
        guard let self = self, self.keyboard > 0 else { return }
        if scroll.contentOffset != .zero { scroll.contentOffset = .zero }
      }
    }

    // Each page load asks for the system's signals and reports its theme as it changes.
    let controller = webview.configuration.userContentController
    // A second load must not add the handler twice (WebKit throws on a name it has).
    controller.removeScriptMessageHandler(forName: "koonaMobile")
    controller.add(WeakMessages(self), name: "koonaMobile")
    controller.addUserScript(WKUserScript(source: Self.pageScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    center.addObserver(self, selector: #selector(systemChanged), name: .NSProcessInfoPowerStateDidChange, object: nil)
    center.addObserver(
      self, selector: #selector(systemChanged), name: UIAccessibility.reduceTransparencyStatusDidChangeNotification, object: nil)
    #if DEBUG
      center.addObserver(self, selector: #selector(logLayout), name: UIApplication.didBecomeActiveNotification, object: nil)
      center.addObserver(self, selector: #selector(logLayout), name: UIDevice.orientationDidChangeNotification, object: nil)
    #endif
    // iOS 27.1's vertical bar (iPhone Duo): where it is, again as the display, the fold or the
    // orientation changes.
    center.addObserver(self, selector: #selector(barSoon), name: UIDevice.orientationDidChangeNotification, object: nil)
    center.addObserver(self, selector: #selector(barSoon), name: UIApplication.didBecomeActiveNotification, object: nil)
    if #available(iOS 27.1, *) {
      MainActor.assumeIsolated {
        let traits = UITraitCollection.systemTraitsAffectingVerticalBarEdge + [
          UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self, UITraitLayoutDirection.self,
        ]
        webview.registerForTraitChanges(traits) { [weak self] (_: WKWebView, _: UITraitCollection) in self?.barSoon() }
        webview.addInteraction(UIHingeInteraction { [weak self] _, _ in self?.barSoon() })
      }
    }
    // The page may be loading already: tell it now as well.
    systemChanged()
  }

  /// What the page was last told of the vertical bar (JSON), so a change is sent once.
  private var sentBar: String?

  /// The bar now and again once the layout has settled: a fold or a rotation moves the safe area
  /// and the reserved regions after the traits change.
  @objc private func barSoon() {
    for delay in [0.0, 0.35, 1.0] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.sendBar() }
    }
  }

  @MainActor private func sendBar() {
    guard let webView = webView else { return }
    var json = "null"
    if #available(iOS 27.1, *) { json = Self.bar(of: webView) }
    if json == sentBar { return }
    sentBar = json
    webView.evaluateJavaScript("window.__KOONA_MOBILE__ && window.__KOONA_MOBILE__.barChanged(\(json))", completionHandler: nil)
  }

  /// The vertical bar as src/platform/verticalBar.ts reads it, in the WebView's points (the page's
  /// CSS pixels): the edge it is on, the column (the safe area's inset on that side), the status
  /// block at its top (the occlusion regions in it) and the fold (the division region). "null"
  /// where the system places no vertical bar.
  @available(iOS 27.1, *)
  @MainActor private static func bar(of webView: WKWebView) -> String {
    let edge = webView.traitCollection.verticalBarEdge
    guard edge != .unspecified else { return "null" }
    let rtl = webView.effectiveUserInterfaceLayoutDirection == .rightToLeft
    let right = (edge == .trailing) != rtl
    let bounds = webView.bounds
    let inset = right ? webView.safeAreaInsets.right : webView.safeAreaInsets.left
    guard inset > 0 else { return "null" }
    let column = CGRect(x: right ? bounds.maxX - inset : bounds.minX, y: bounds.minY, width: inset, height: bounds.height)
    let status = webView.reservedRegions(kind: .occlusion).map(\.frame).filter { $0.intersects(column) }
      .reduce(CGRect.null) { $0.union($1) }
    let division = webView.reservedRegions(kind: .division, options: .includeInactive).first?.frame
    func rect(_ r: CGRect?) -> String {
      guard let r = r, !r.isNull else { return "null" }
      return String(format: "[%.1f,%.1f,%.1f,%.1f]", r.minX, r.minY, r.width, r.height)
    }
    return "{\"edge\":\"\(right ? "right" : "left")\",\"column\":\(rect(column)),\"status\":\(rect(status)),\"division\":\(rect(division))}"
  }

  private var pinned: NSKeyValueObservation?
  /// The keyboard's height over the WebView now, in points; 0 without it.
  private var keyboard: CGFloat = 0

  @objc private func keyboardChanged(_ note: Notification) {
    DispatchQueue.main.async {
      guard let webView = self.webView else { return }
      var height: CGFloat = 0
      if note.name != UIResponder.keyboardWillHideNotification,
        let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
      {
        let inView = webView.convert(frame, from: nil)
        height = max(0, webView.bounds.maxY - inView.minY)
      }
      if height == self.keyboard { return }
      self.keyboard = height
      // Up or down again: the page where it belongs, whatever WebKit scrolled before we heard.
      if webView.scrollView.contentOffset != .zero { webView.scrollView.contentOffset = .zero }
      self.sendInsets()
    }
  }

  /// Only the keyboard: the other sides come from `env(safe-area-inset-*)`, which iOS fills.
  @MainActor private func sendInsets() {
    webView?.evaluateJavaScript(
      "window.__KOONA_MOBILE__ && window.__KOONA_MOBILE__.insets(0,0,\(Int(keyboard.rounded())),0)", completionHandler: nil)
  }

  /// Runs at the end of each page's document: the page asks for the signals, and the root's
  /// `data-theme` (src/services/preferences.ts) is passed on whenever it changes.
  private static let pageScript = """
    (function () {
      var post = function (message) { window.webkit.messageHandlers.koonaMobile.postMessage(message); };
      post({ kind: 'ready' });
      var root = document.documentElement;
      var theme = function () { post({ kind: 'theme', theme: root.getAttribute('data-theme') || '' }); };
      theme();
      new MutationObserver(theme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    })();
    """

  @MainActor fileprivate func received(_ message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
    switch kind {
    case "ready":
      systemChanged()
      // A new page: its bridge knows nothing yet.
      sentBar = nil
      barSoon()
      if keyboard > 0 { sendInsets() }
      #if DEBUG
        logLayout()
      #endif
    case "theme":
      pageTheme = body["theme"] as? String
      followTheme()
    default:
      break
    }
  }

  /// The signals now, for the bridge: `powerSave` is Low Power Mode, `reduceTransparency` the
  /// accessibility setting. iOS has no low-RAM class and no text zoom for the page (Dynamic Type
  /// does not reach a WebView's CSS pixels), so those stay as the bridge has them.
  @objc private func systemChanged() {
    DispatchQueue.main.async {
      guard let webView = self.webView else { return }
      let powerSave = ProcessInfo.processInfo.isLowPowerModeEnabled
      let reduceTransparency = UIAccessibility.isReduceTransparencyEnabled
      #if DEBUG
        NSLog("Koona Pin: system powerSave=%d reduceTransparency=%d", powerSave ? 1 : 0, reduceTransparency ? 1 : 0)
      #endif
      webView.evaluateJavaScript(
        "window.__KOONA_MOBILE__ && window.__KOONA_MOBILE__.systemChanged({powerSave:\(powerSave),reduceTransparency:\(reduceTransparency)})",
        completionHandler: nil)
    }
  }

  /// The status bar takes the page's theme: its style comes from the root view controller's
  /// appearance, so that follows the page. The WebView keeps the system's own, which the page reads
  /// as `prefers-color-scheme` when its theme follows the system.
  @MainActor private func followTheme() {
    guard let webView = webView, let window = webView.window, let root = window.rootViewController else { return }
    let style: UIUserInterfaceStyle = pageTheme == "dark" ? .dark : pageTheme == "light" ? .light : .unspecified
    if root.overrideUserInterfaceStyle != style {
      root.overrideUserInterfaceStyle = style
      root.setNeedsStatusBarAppearanceUpdate()
    }
    keepSystemStyle()
  }

  /// The WebView's appearance stays the system's under the root's override (see `followTheme`).
  @MainActor private func keepSystemStyle() {
    guard let webView = webView, let scene = webView.window?.windowScene else { return }
    let system = scene.traitCollection.userInterfaceStyle
    if webView.overrideUserInterfaceStyle != system { webView.overrideUserInterfaceStyle = system }
    if #available(iOS 17.0, *), !observingScene {
      observingScene = true
      scene.registerForTraitChanges([UITraitUserInterfaceStyle.self]) { [weak self] (_: UIWindowScene, _: UITraitCollection) in
        self?.keepSystemStyle()
      }
    }
  }
  private var observingScene = false

  @objc private func edgeSwipe(_ swipe: UIScreenEdgePanGestureRecognizer) {
    guard swipe.state == .ended, let webView = webView else { return }
    guard swipe.translation(in: webView).x >= distance else { return }
    #if DEBUG
      NSLog("Koona Pin: edge swipe, back")
    #endif
    webView.evaluateJavaScript("window.__KOONA_MOBILE__ && window.__KOONA_MOBILE__.back()", completionHandler: nil)
  }

  #if DEBUG
    /// The WebView's size and safe area as the page gets them (`env(safe-area-inset-*)`), for
    /// checking a device's insets in the Simulator's log.
    @objc private func logLayout() {
      DispatchQueue.main.async {
        guard let webView = self.webView else { return }
        let insets = webView.safeAreaInsets
        let size = webView.bounds.size
        NSLog(
          "Koona Pin: layout %.0fx%.0f safe top %.0f right %.0f bottom %.0f left %.0f", size.width, size.height, insets.top,
          insets.right, insets.bottom, insets.left)
      }
    }
  #endif

  /// A haptic of the page; an unknown name plays nothing. It never fails.
  @objc public func haptic(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(HapticArgs.self)
    DispatchQueue.main.async {
      #if DEBUG
        NSLog("Koona Pin: haptic %@", args.kind)
      #endif
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
