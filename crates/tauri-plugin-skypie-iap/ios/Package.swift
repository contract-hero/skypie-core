// swift-tools-version:5.9
import PackageDescription

// The Swift half of the IAP plugin.
//
// `purchases-ios` is RevenueCat's OFFICIAL SDK: the dependency that makes
// "the purchase is powered by RevenueCat" unarguable. A silent bump is not
// something a payment path should take from a resolver, so the range is
// `.upToNextMinor` and `Package.resolved` is committed. `from: "5.0.0"` was
// neither: with no lock file checked in it floated to any 5.x per machine,
// which is how a macOS-floor change once broke the iOS build outright.
let package = Package(
  name: "tauri-plugin-skypie-iap",
  // This package builds for iOS ONLY. A host build (`swift build`,
  // SourceKit-LSP, Xcode with a "My Mac" destination) cannot work and is
  // not a supported path: the vendored Tauri Swift API under `.tauri/`
  // imports UIKit unconditionally in four files while declaring
  // `.macOS(.v10_13)`, so a host build fails inside Tauri's own
  // `Invoke.swift` no matter what this package declares. Editor tooling
  // will show errors here; the `scripts/build-ios-sim.sh` gate is the
  // source of truth.
  //
  // Nothing ships on macOS. `.macOS` is here only because swift-rs builds
  // this package with `--sdk` + `-Xswiftc -target` and no `--triple`, so
  // SwiftPM resolves against the HOST platform and validates the macOS row
  // of the matrix: without it the library defaults to macOS 10.13 and
  // collides with RevenueCat's 10.15 floor. Every RevenueCat 5.x needs
  // 10.15, so pinning cannot avoid this.
  platforms: [.iOS(.v14), .macOS(.v10_15)],
  products: [
    .library(name: "tauri-plugin-skypie-iap", type: .static, targets: ["tauri-plugin-skypie-iap"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api"),
    .package(url: "https://github.com/RevenueCat/purchases-ios.git", .upToNextMinor(from: "5.89.0")),
  ],
  targets: [
    .target(
      name: "tauri-plugin-skypie-iap",
      dependencies: [
        .byName(name: "Tauri"),
        .product(name: "RevenueCat", package: "purchases-ios"),
      ],
      path: "Sources"
    )
  ]
)
