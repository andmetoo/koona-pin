// swift-tools-version:5.3

import PackageDescription

// The app's side of the iOS share extension (koona-share): where the queue is and word of a new
// share while the app runs. The extension itself is ../ios-extension, an Xcode target of its own.
let package = Package(
  name: "tauri-plugin-koona-share",
  platforms: [
    .iOS(.v13)
  ],
  products: [
    .library(
      name: "tauri-plugin-koona-share",
      type: .static,
      targets: ["tauri-plugin-koona-share"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-koona-share",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
