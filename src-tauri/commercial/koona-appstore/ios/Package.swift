// swift-tools-version:5.5

import PackageDescription

let package = Package(
  name: "tauri-plugin-koona-appstore",
  platforms: [
    // StoreKit 2 (Transaction, Product.purchase(options:), showManageSubscriptions) is iOS 15's.
    .iOS(.v15)
  ],
  products: [
    .library(
      name: "tauri-plugin-koona-appstore",
      type: .static,
      targets: ["tauri-plugin-koona-appstore"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-koona-appstore",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
