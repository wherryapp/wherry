// swift-tools-version:5.5
// The iOS half of wherry-calls, linked into the app through the plugin
// crate's build script (tauri-plugin's `ios_path`), so the Xcode project
// under gen/apple is not edited for it. PushKit, CallKit and AVFAudio are
// system frameworks and need no package dependency.

import PackageDescription

let package = Package(
  name: "tauri-plugin-wherry-calls",
  platforms: [
    // The app's own deployment target (gen/apple/project.yml).
    .iOS(.v15)
  ],
  products: [
    .library(
      name: "tauri-plugin-wherry-calls",
      type: .static,
      targets: ["tauri-plugin-wherry-calls"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-wherry-calls",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources/WherryCalls")
  ]
)
