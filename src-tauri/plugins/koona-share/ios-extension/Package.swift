// swift-tools-version:5.9

// The share extension's queue code as a package of its own, so its tests run on the Mac with
// `swift test` (they read ../queue-fixtures, as the Rust and Kotlin tests do). The extension
// itself is the Xcode target koonapin_Share (src-tauri/gen/apple/project.yml), which compiles
// Queue/ and Sheet/ directly; this package is not linked into any app.
import PackageDescription

let package = Package(
  name: "KoonaShareQueue",
  platforms: [.macOS(.v13), .iOS(.v17)],
  targets: [
    .target(name: "KoonaShareQueue", path: "Queue"),
    .testTarget(name: "KoonaShareQueueTests", dependencies: ["KoonaShareQueue"], path: "Tests"),
  ]
)
