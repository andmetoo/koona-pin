// Safari's `runtime.sendNativeMessage` lands here, not in a host named by a manifest (NP-119). The
// handler passes the message to the running Koona Pin unchanged (Relay.swift) and returns its answer;
// it adds nothing and keeps no queue: the extension's queue stays the only one.
import AppKit
import SafariServices
import os

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let log = Logger(subsystem: Relay.caller, category: "relay")

    func beginRequest(with context: NSExtensionContext) {
        let message = (context.inputItems.first as? NSExtensionItem)?.userInfo?[SFExtensionMessageKey]
        // The socket waits up to START_WAIT plus READ_TIMEOUT: never on the thread that called us.
        // One path, one completeRequest.
        DispatchQueue.global(qos: .userInitiated).async {
            let reply = Relay.answer(message, start: Self.startApp)
            let ok = (reply as? [String: Any])?["ok"] as? Bool
            Self.log.debug("relayed: ok \(String(describing: ok), privacy: .public)")
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: reply]
            context.completeRequest(returningItems: [response], completionHandler: nil)
        }
    }

    /// The host's `open -g -j` from the sandbox: Koona Pin.app around this extension
    /// (Contents/PlugIns/<this>.appex), hidden, not activated. Only our own app is opened.
    private static func startApp() -> Bool {
        let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard Bundle(url: app)?.bundleIdentifier == "app.koona.pin" else {
            log.error("not inside Koona Pin.app: \(app.path, privacy: .public)")
            return false
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = true
        configuration.addsToRecentItems = false
        // Not waited for: Relay polls the socket instead, which is what tells that the app is ready.
        NSWorkspace.shared.openApplication(at: app, configuration: configuration) { _, error in
            if let error { log.error("start failed: \(error.localizedDescription, privacy: .public)") }
        }
        return true
    }
}
