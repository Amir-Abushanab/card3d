// swift-tools-version: 6.0
// The card engine for iOS and macOS: a SwiftUI `CardView` over a `CAMetalLayer`, driven by the Rust
// engine (crates/card3d-ffi) through its C ABI. `Card3DFFI.xcframework` is build output: run
// `./build-xcframework.sh` first (apple/README.md).
import PackageDescription

let package = Package(
    name: "Card3D",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "Card3D", targets: ["Card3D"]),
    ],
    targets: [
        // The engine's static library and its header (include/card3d.h), made by build-xcframework.sh.
        .binaryTarget(name: "Card3DFFI", path: "Card3DFFI.xcframework"),
        .target(
            name: "Card3D",
            dependencies: ["Card3DFFI"],
            // The scene environments the native host reads at run time, and the third-party notices
            // (copied in by build-xcframework.sh from packages/core/assets/environments and the
            // repository's THIRD_PARTY_NOTICES.md).
            resources: [.copy("Resources/environments"), .copy("Resources/THIRD_PARTY_NOTICES.md")],
            linkerSettings: [
                .linkedFramework("Metal"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("Foundation"),
            ]
        ),
        .testTarget(name: "Card3DTests", dependencies: ["Card3D"]),
    ]
)
