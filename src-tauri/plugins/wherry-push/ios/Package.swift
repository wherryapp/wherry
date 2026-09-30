// swift-tools-version:5.5
// The Swift half of tauri-plugin-wherry-push. tauri-plugin's build step
// compiles this package and links it into the app's static library, so the
// Xcode project in gen/apple/ needs no reference to it. `../.tauri/tauri-api`
// is a copy of Tauri's Swift API that the same build step writes (gitignored),
// exactly as tauri-plugin-notification's Package.swift does.

import PackageDescription

let package = Package(
  name: "tauri-plugin-wherry-push",
  platforms: [
    // The app's deployment target (gen/apple/project.yml). macOS only so that
    // `swift build` on the Mac can resolve the package; the plugin is never
    // linked into the desktop shell.
    .macOS(.v10_13),
    .iOS("15.4"),
  ],
  products: [
    .library(
      name: "tauri-plugin-wherry-push",
      type: .static,
      targets: ["tauri-plugin-wherry-push"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-wherry-push",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
