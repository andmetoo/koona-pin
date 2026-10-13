// A check of Relay.swift without Safari (NP-119): the envelope, the host's replies and one exchange over
// a real Unix socket. CI and build-macos.mjs --safari run it:
//   swiftc -swift-version 5 -parse-as-library -o <out> src-tauri/macos/safari/Extension/Relay.swift src-tauri/macos/safari/Tests/RelayCheck.swift && <out>
import Foundation

@main
enum RelayCheck {
    static var failures = 0
    nonisolated(unsafe) static var received = Data()

    static func check(_ condition: Bool, _ what: String) {
        if !condition { failures += 1; print("FAIL: \(what)") }
    }
    static func code(_ reply: Any) -> String? { (reply as? [String: Any])?["code"] as? String }

    /// The app's side: one connection, its line kept, one answer.
    nonisolated static func serveOnce(_ path: String) {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: Array(path.utf8)); raw[path.utf8.count] = 0
        }
        _ = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        listen(fd, 4)
        let peer = accept(fd, nil, nil)
        var buffer = [UInt8](repeating: 0, count: 4096)
        while !received.contains(0x0A) {
            let n = read(peer, &buffer, buffer.count)
            if n <= 0 { break }
            received.append(contentsOf: buffer[0..<n])
        }
        _ = "{\"ok\":true,\"status\":\"created\",\"id\":7}\n".withCString { write(peer, $0, strlen($0)) }
        close(peer); close(fd)
    }

    static func main() {
        // The envelope: the message unchanged under the extension's caller, one line, slashes as they are.
        let message: [String: Any] = ["type": "capture", "url": "https://example.com/a/b", "title": "A", "protocol": 2]
        let line = Relay.envelope(message)!
        check(line.last == 0x0A && !line.dropLast().contains(0x0A), "one line")
        let text = String(decoding: line, as: UTF8.self)
        check(text.hasPrefix(#"{"caller":"app.koona.pin.safari","message":{"#), "the host's envelope")
        check(text.contains("https://example.com/a/b"), "slashes are not escaped")
        let parsed = try! JSONSerialization.jsonObject(with: line) as! [String: Any]
        check(Set(parsed.keys) == ["caller", "message"] && parsed["caller"] as? String == "app.koona.pin.safari", "envelope keys")
        check(NSDictionary(dictionary: parsed["message"] as! [String: Any]).isEqual(to: message), "message unchanged")
        check(Relay.envelope(nil) == nil && Relay.envelope(["big": String(repeating: "x", count: Relay.maxLine)]) == nil, "refused input")
        check(code(Relay.answer(nil, start: { true })) == "invalid_request", "invalid_request")
        check(Relay.starts(message) && Relay.starts(["type": "search"]) && Relay.starts(["type": "show"])
              && !Relay.starts(["type": "hello"]), "what starts the app")

        // Nobody listens: a hello does not start the app, a capture asks once and gives up when it cannot.
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("relay-\(getpid())")
        try! FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let path = folder.appendingPathComponent("capture.sock").path
        var starts = 0
        check(code(Relay.answer(["type": "hello"], socket: path, start: { starts += 1; return true })) == "app_unavailable" && starts == 0,
              "hello without the app")
        check(code(Relay.answer(message, socket: path, start: { starts += 1; return false })) == "app_unavailable" && starts == 1,
              "capture without the app")

        // The app «starts» 0.3 s later: the capture waits for it and returns its line unchanged.
        let reply = Relay.answer(message, socket: path, start: {
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { serveOnce(path) }
            return true
        })
        check((reply as? [String: Any])?["status"] as? String == "created" && (reply as? [String: Any])?["id"] as? Int == 7, "the app's reply")
        check(received == line, "the app reads the envelope as sent")

        print(failures == 0 ? "RelayCheck: ok" : "RelayCheck: \(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }
}
