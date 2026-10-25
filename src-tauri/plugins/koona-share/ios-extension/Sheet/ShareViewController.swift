import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// How long the sheet stays when nobody touches it, in seconds.
private let autoClose: TimeInterval = 2

/// "Share → Koona Pin" on iOS (frame S1, cut to the link alone, as Android's ShareActivity):
/// queues the shared link for the app in the App Group's container and says so on a sheet over the
/// app that shared it. No WebView, no Rust, no network: the app takes the queue in when it opens or
/// comes back, and at once when it is alive (the Darwin notification `queuedNotification`).
///
/// The sheet closes by itself after a moment; a touch keeps it until Done or a tap outside. With
/// VoiceOver on it stays until Done.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
  private let model = SheetModel()
  private var timer: Timer?
  private var closing = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    let sheet = UIHostingController(rootView: SheetView(model: model, done: { [weak self] in self?.close() }, touched: { [weak self] in self?.keep() }))
    sheet.view.backgroundColor = .clear
    addChild(sheet)
    sheet.view.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(sheet.view)
    NSLayoutConstraint.activate([
      sheet.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      sheet.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      sheet.view.topAnchor.constraint(equalTo: view.topAnchor),
      sheet.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    sheet.didMove(toParent: self)

    Shared.read(extensionContext?.inputItems as? [NSExtensionItem] ?? []) { [weak self] shared in
      DispatchQueue.main.async { self?.take(shared) }
    }
  }

  /// Queues the link shared and shows the sheet for it; a short word instead when there is none.
  private func take(_ shared: Shared?) {
    guard let shared = shared else {
      show(.message(text("noLink")))
      return
    }
    guard let folder = ShareQueue.folder() else {
      NSLog("Koona Pin: no App Group container for the shared link")
      show(.message(text("failed")))
      return
    }
    do {
      try ShareQueue.write(ShareItem(url: shared.url, title: shared.title), to: folder)
    } catch {
      NSLog("Koona Pin: cannot queue the shared link: \(error)")
      show(.message(text("failed")))
      return
    }
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(queuedNotification as CFString), nil, nil, true)
    show(.saved(url: shared.url, title: shared.title))
  }

  private func show(_ state: SheetModel.State) {
    model.state = state
    let words: String
    switch state {
    case .saved(let url, _): words = "\(text("saved")). \(String(format: text("inInbox"), ShareQueue.host(url)))"
    case .message(let message): words = message
    case .reading: return
    }
    UIAccessibility.post(notification: .announcement, argument: words)
    timer?.invalidate()
    if !UIAccessibility.isVoiceOverRunning {
      timer = Timer.scheduledTimer(withTimeInterval: autoClose, repeats: false) { [weak self] _ in self?.close() }
    }
  }

  /// A touch on the sheet keeps it until Done.
  private func keep() {
    timer?.invalidate()
    timer = nil
  }

  private func close() {
    guard !closing else { return }
    closing = true
    timer?.invalidate()
    model.leaving = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
      self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
  }
}

/// The words of the sheet, from the extension's Localizable.strings (made from `phone.share` of
/// src/locales by `bun run locales:ios`).
func text(_ key: String) -> String {
  NSLocalizedString(key, comment: "")
}

/// What was shared: the link the app can save and its title (empty when the sharing app gave none
/// that is not the link itself).
struct Shared {
  let url: String
  let title: String

  /// Reads the extension's items: Safari's page (its preprocessing script's address and title), a
  /// URL, or text with a link in it; the first that has a link the app takes.
  static func read(_ items: [NSExtensionItem], done: @escaping (Shared?) -> Void) {
    let group = DispatchGroup()
    let lock = NSLock()
    // Candidates in the order they count: page, URLs, texts, then the item's own text.
    var page: (url: String?, title: String?) = (nil, nil)
    var urls: [String] = []
    var texts: [String] = []
    var itemTexts: [String] = []
    for item in items {
      if let content = item.attributedContentText?.string, !content.isEmpty { itemTexts.append(content) }
      if let title = item.attributedTitle?.string, !title.isEmpty { itemTexts.append(title) }
      for provider in item.attachments ?? [] {
        if provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) {
          group.enter()
          provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier, options: nil) { value, _ in
            let results = (value as? NSDictionary)?[NSExtensionJavaScriptPreprocessingResultsKey] as? NSDictionary
            lock.lock()
            if let url = results?["url"] as? String { page.url = url }
            if let title = results?["title"] as? String { page.title = title }
            lock.unlock()
            group.leave()
          }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
          group.enter()
          provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { value, _ in
            var found: String?
            if let url = value as? URL { found = url.absoluteString }
            else if let data = value as? Data { found = URL(dataRepresentation: data, relativeTo: nil)?.absoluteString }
            else if let string = value as? String { found = string }
            lock.lock()
            if let found = found { urls.append(found) }
            lock.unlock()
            group.leave()
          }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
          group.enter()
          provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { value, _ in
            var found: String?
            if let string = value as? String { found = string }
            else if let data = value as? Data { found = String(data: data, encoding: .utf8) }
            lock.lock()
            if let found = found { texts.append(found) }
            lock.unlock()
            group.leave()
          }
        }
      }
    }
    group.notify(queue: .global(qos: .userInitiated)) {
      let candidates = [page.url].compactMap { $0 } + urls + texts + itemTexts
      guard let url = candidates.lazy.compactMap(ShareQueue.firstLink).first else {
        done(nil)
        return
      }
      // The page's title, else the item's text when it is no link (Safari and others put the
      // title there); the app finds one when there is none.
      let titles = [page.title].compactMap { $0 } + itemTexts
      let title = titles.lazy.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .first { !$0.isEmpty && ShareQueue.firstLink($0) == nil } ?? ""
      done(Shared(url: url, title: String(title.prefix(1000))))
    }
  }
}

final class SheetModel: ObservableObject {
  enum State {
    case reading
    case saved(url: String, title: String)
    case message(String)
  }

  @Published var state: State = .reading
  @Published var leaving = false
}

/// Frame S1's colours, light and dark, as Android's sheet has them.
private enum Palette {
  static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
    Color(UIColor { $0.userInterfaceStyle == .dark ? rgba(dark) : rgba(light) })
  }

  private static func rgba(_ argb: UInt32) -> UIColor {
    UIColor(
      red: CGFloat((argb >> 16) & 0xFF) / 255, green: CGFloat((argb >> 8) & 0xFF) / 255, blue: CGFloat(argb & 0xFF) / 255,
      alpha: CGFloat((argb >> 24) & 0xFF) / 255)
  }

  static let sheet = dynamic(0xFFF6_F5F1, 0xFF1C_1C1A)
  static let sheetEdge = dynamic(0x142E_302B, 0x14FF_FFFF)
  static let grabber = dynamic(0x999A_998E, 0x996E_6D67)
  static let title = dynamic(0xFF2E_302B, 0xFFEC_EBE6)
  static let meta = dynamic(0xFF66_665D, 0xFF9A_9990)
  static let card = dynamic(0xFFFF_FEFA, 0xFF26_2624)
  static let cardEdge = dynamic(0x0F2E_302B, 0x12FF_FFFF)
  static let primary = dynamic(0xFF2F_6B4F, 0xFF8F_D0AE)
  static let onPrimary = dynamic(0xFFFF_FFFF, 0xFF14_1413)
  static let scrim = dynamic(0x3D00_0000, 0x8C00_0000)
}

private struct SheetView: View {
  @ObservedObject var model: SheetModel
  let done: () -> Void
  let touched: () -> Void
  @State private var shown = false

  @ScaledMetric(relativeTo: .headline) private var headline: CGFloat = 18
  @ScaledMetric(relativeTo: .footnote) private var meta: CGFloat = 13
  @ScaledMetric(relativeTo: .subheadline) private var cardTitle: CGFloat = 15
  @ScaledMetric(relativeTo: .body) private var button: CGFloat = 16
  @ScaledMetric(relativeTo: .title3) private var tileLetter: CGFloat = 20

  var body: some View {
    ZStack(alignment: .bottom) {
      // The frame's scrim; a tap on it closes the sheet.
      Palette.scrim
        .opacity(visible ? 1 : 0)
        .ignoresSafeArea()
        .onTapGesture(perform: done)
        .accessibilityHidden(true)
      if case .reading = model.state {
        EmptyView()
      } else {
        sheet
          .frame(maxWidth: 480)
          .padding(.horizontal, 8)
          .padding(.bottom, 8)
          .offset(y: visible ? 0 : 400)
      }
    }
    .animation(.spring(response: 0.35, dampingFraction: 0.86), value: visible)
    .onReceive(model.$state) { state in
      if case .reading = state { return }
      DispatchQueue.main.async { shown = true }
    }
  }

  private var visible: Bool { shown && !model.leaving }

  @ViewBuilder private var sheet: some View {
    VStack(alignment: .leading, spacing: 0) {
      Capsule().fill(Palette.grabber).frame(width: 36, height: 5).frame(maxWidth: .infinity).padding(.bottom, 13)
        .accessibilityHidden(true)
      switch model.state {
      case .saved(let url, let title):
        header(subtitle: String(format: text("inInbox"), ShareQueue.host(url)))
        linkCard(url: url, title: title).padding(.top, 8)
      case .message(let message):
        HStack(spacing: 8) {
          icon(check: false)
          Text(message).font(.system(size: headline, weight: .semibold)).foregroundColor(Palette.title)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
      case .reading:
        EmptyView()
      }
      Button(action: done) {
        Text(text("done"))
          .font(.system(size: button, weight: .semibold))
          .foregroundColor(Palette.onPrimary)
          .frame(maxWidth: .infinity, minHeight: 52)
          .background(Capsule().fill(Palette.primary))
      }
      .buttonStyle(.plain)
      .padding(.top, 16)
    }
    .padding(EdgeInsets(top: 8, leading: 20, bottom: 20, trailing: 20))
    .background(
      RoundedRectangle(cornerRadius: 34, style: .continuous).fill(Palette.sheet)
        .overlay(RoundedRectangle(cornerRadius: 34, style: .continuous).strokeBorder(Palette.sheetEdge, lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
    )
    .contentShape(Rectangle())
    .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in touched() })
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.isModal)
  }

  private func header(subtitle: String) -> some View {
    HStack(alignment: .top, spacing: 8) {
      icon(check: true)
      VStack(alignment: .leading, spacing: 0) {
        Text(text("saved")).font(.system(size: headline, weight: .semibold)).foregroundColor(Palette.title).lineLimit(1)
        Text(subtitle).font(.system(size: meta, weight: .medium)).foregroundColor(Palette.meta).lineLimit(1)
      }
      .padding(.top, 1)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }

  /// The app's icon with the check on its corner.
  private func icon(check: Bool) -> some View {
    ZStack(alignment: .topLeading) {
      Image("Icon").resizable().frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      if check {
        ZStack {
          Circle().fill(Palette.sheet).frame(width: 24, height: 24)
          Circle().fill(Palette.primary).frame(width: 20, height: 20)
          Image(systemName: "checkmark").font(.system(size: 10, weight: .heavy)).foregroundColor(Palette.onPrimary)
        }
        .offset(x: 28, y: 28)
      }
    }
    .frame(width: 52, height: 52, alignment: .topLeading)
    .accessibilityHidden(true)
  }

  /// The link: a letter tile and its title, or the address while it has none.
  private func linkCard(url: String, title: String) -> some View {
    HStack(spacing: 12) {
      Text(ShareQueue.letter(title, ShareQueue.host(url)))
        .font(.system(size: tileLetter, weight: .semibold))
        .foregroundColor(Color.white.opacity(0.92))
        .frame(width: 48, height: 48)
        .background(
          RoundedRectangle(cornerRadius: 14, style: .continuous).fill(
            LinearGradient(
              colors: [Color(red: 0xA4 / 255, green: 0x9C / 255, blue: 0x8E / 255), Color(red: 0x5B / 255, green: 0x56 / 255, blue: 0x4E / 255)],
              startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .accessibilityHidden(true)
      Text(title.isEmpty ? (url.range(of: "://").map { String(url[$0.upperBound...]) } ?? url) : title)
        .font(.system(size: cardTitle, weight: .semibold))
        .foregroundColor(Palette.title)
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 16))
    .frame(minHeight: 64)
    .background(
      RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Palette.card)
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Palette.cardEdge, lineWidth: 1))
    )
  }
}
