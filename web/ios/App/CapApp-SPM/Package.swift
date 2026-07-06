// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        // Vendored local clone (web/ios/capacitor-swift-pm @ 8.4.1) instead of the
        // remote URL: xcodebuild's remote-package loader hangs forever on this Mac
        // (waitForRemoteSourcePackagesToFinishLoading; plain git is fine). A local
        // path dep means SPM has nothing remote to load. NOTE: `cap sync ios`
        // regenerates this file — re-apply if Capacitor is updated.
        .package(path: "../../capacitor-swift-pm")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ]
        )
    ]
)
