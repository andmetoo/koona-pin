// Capture the actual app window, never a browser preview or the runner wallpaper.
import AppKit
import CoreGraphics
import Foundation

let pid = Int(CommandLine.arguments[1])!
let output = CommandLine.arguments[2]
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
guard let window = windows.first(where: {
    ($0[kCGWindowOwnerPID as String] as? Int) == pid &&
    ($0[kCGWindowLayer as String] as? Int) == 0 &&
    (($0[kCGWindowBounds as String] as? [String: Any])?["Width"] as? Double ?? 0) >= 800
}), let id = window[kCGWindowNumber as String] as? UInt32 else {
    fputs("No drawable Koona Pin window or screen recording permission\n", stderr)
    exit(1)
}
let capture = Process()
capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
capture.arguments = ["-x", "-o", "-l", String(id), output]
try capture.run()
capture.waitUntilExit()
guard capture.terminationStatus == 0,
let bitmap = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: output))) else {
    fatalError("Screen capture failed")
}
guard bitmap.pixelsWide >= 800, bitmap.pixelsHigh >= 550 else { fatalError("Window is too small") }
// A screenshot that contains only one color is not evidence of a rendered interface.
let colors = Set(stride(from: 0, to: bitmap.pixelsWide, by: 20).flatMap { x in
    stride(from: 0, to: bitmap.pixelsHigh, by: 20).map { y in
        bitmap.colorAt(x: x, y: y)!.description
    }
})
guard colors.count > 20 else { fatalError("Window did not render: screenshot is blank") }
print("Captured window \(id): \(bitmap.pixelsWide)x\(bitmap.pixelsHigh), \(colors.count) sampled colors")
