// What koonapin-host does for Chrome, Edge and Firefox, for Safari (NP-119): the extension's message
// goes to the running app as one JSON line in the host's envelope, and the app's line comes back.
// The channel is a Unix socket in this app extension's own sandbox container, which the app binds
// (docs/macos-test.md, «Safari»). Foundation only, so Tests/RelayCheck.swift compiles it without Safari.
import Foundation

enum Relay {
    /// The `caller` of the envelope: the app admits Safari only from its own extension.
    static let caller = "app.koona.pin.safari"
    /// src-tauri/src/channel_client.rs: START_WAIT, MAX_LINE; capture_channel.rs: READ_TIMEOUT.
    static let startWait: TimeInterval = 10
    static let readTimeout: TimeInterval = 10
    static let maxLine = 1024 * 1024

    /// `~/Library/Containers/app.koona.pin.safari/Data/capture.sock` inside the sandbox: the one
    /// folder the extension may connect in without an App Group or an exception.
    static var socketPath: String { NSHomeDirectory() + "/capture.sock" }

    /// The host's own replies, word for word, so the extension maps them the same way.
    static func failure(_ code: String, _ message: String) -> [String: Any] {
        ["ok": false, "code": code, "message": message]
    }
    static var unavailable: [String: Any] {
        failure("app_unavailable", "Koona Pin is not running or does not answer")
    }

    /// Saving, searching from the popup and «Open Koona Pin» start a closed app; a hello does not
    /// open an app the person closed (koonapin-host.rs `relay`).
    static func starts(_ message: Any?) -> Bool {
        guard let type = (message as? [String: Any])?["type"] as? String else { return false }
        return ["capture", "search", "show"].contains(type)
    }

    /// `{"caller":…,"message":…}` and a newline, keys in the host's order (sorted); nil when the message
    /// is not JSON or larger than the app takes.
    static func envelope(_ message: Any?) -> Data? {
        guard let message else { return nil }
        let envelope: [String: Any] = ["caller": caller, "message": message]
        guard JSONSerialization.isValidJSONObject(envelope),
              var line = try? JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys, .withoutEscapingSlashes]),
              line.count <= maxLine
        else { return nil }
        line.append(0x0A)
        return line
    }

    enum Outcome { case reply(Any), refused, broken }

    /// The whole answer to one message. `start` opens the app hidden; it is called at most once.
    static func answer(_ message: Any?, socket: String = socketPath, start: () -> Bool) -> Any {
        guard let line = envelope(message) else { return failure("invalid_request", "message is not JSON or too large") }
        switch exchange(line, socket: socket) {
        case .reply(let reply): return reply
        case .broken: return unavailable
        case .refused:
            guard starts(message), start() else { return unavailable }
            // Asked again until START_WAIT runs out, as channel_client.rs `ask` does.
            let deadline = Date().addingTimeInterval(startWait)
            while Date() < deadline {
                Thread.sleep(forTimeInterval: 0.05)
                switch exchange(line, socket: socket) {
                case .reply(let reply): return reply
                case .refused: continue
                case .broken: return unavailable
                }
            }
            return unavailable
        }
    }

    /// One connection, one line each way. `.refused` means nobody listens (start the app), `.broken`
    /// that the app took the line and did not answer (starting it again would not help).
    static func exchange(_ line: Data, socket path: String) -> Outcome {
        var address = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return .refused }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return .refused }
        defer { close(fd) }
        // A closed peer must not kill the extension with SIGPIPE; reads and writes are bounded.
        // connect() on a Unix socket does not wait: a missing socket or a full backlog is refused.
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: Int(readTimeout), tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { return .refused }

        let written = line.withUnsafeBytes { raw -> Bool in
            var offset = 0
            while offset < raw.count {
                let n = write(fd, raw.baseAddress! + offset, raw.count - offset)
                if n <= 0 { return false }
                offset += n
            }
            return true
        }
        guard written else { return .broken }

        // Until the newline, the end of the stream, MAX_LINE or READ_TIMEOUT, whichever comes first.
        let deadline = Date().addingTimeInterval(readTimeout)
        var reply = Data()
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while !reply.contains(0x0A), reply.count <= maxLine {
            let left = deadline.timeIntervalSinceNow
            if left <= 0 { break }
            var wait = timeval(tv_sec: Int(left), tv_usec: Int32((left - left.rounded(.down)) * 1_000_000))
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &wait, socklen_t(MemoryLayout<timeval>.size))
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            reply.append(contentsOf: chunk[0..<n])
        }
        if let newline = reply.firstIndex(of: 0x0A) { reply = reply[..<newline] }
        guard reply.count <= maxLine,
              let value = try? JSONSerialization.jsonObject(with: reply, options: [.fragmentsAllowed])
        else { return .broken }
        return .reply(value)
    }
}
