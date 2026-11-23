# Card3D for iOS and macOS

A Swift package that shows a card drawn by the card engine (the Rust + wgpu engine in `crates/`, on
Metal). `CardView` is a SwiftUI view over a `CAMetalLayer`; `CardStage` holds the design and does the
rest (quality, framing, lighting, flipping, PNG and AR exports). The engine is a static library behind a
small C ABI (`crates/card3d-ffi`, header `include/card3d.h`), packaged as `Card3DFFI.xcframework`.

```
apple/
  Package.swift              the Card3D library (iOS 17, macOS 14) + the binary target
  build-xcframework.sh       builds Card3DFFI.xcframework (build output, not committed)
  test.sh                    reference renders + `swift test`
  Sources/Card3D/            CardStage, CardView, the asset cache, the C ABI in Swift
  Tests/Card3DTests/         pixel tests against the engine's harness, stage tests
  Example/                   a SwiftUI app (iOS and macOS): a design picker, flip, PNG and AR export
```

## Build

```sh
apple/build-xcframework.sh     # iOS device, iOS simulator, macOS (arm64); prints each slice's size
apple/test.sh                  # macOS: harness renders, then swift test
```

The script needs Rust with the Apple targets (it adds missing ones with `rustup target add`) and
Xcode. It regenerates the header with cbindgen when installed (`cargo install cbindgen`), and copies
the scene environments and `THIRD_PARTY_NOTICES.md` into the package's resources. `CARD3D_TARGETS="aarch64-apple-darwin"` builds one
slice; `CARD3D_CLEAN=1` deletes each target's intermediate files once its library is copied.

The example app, without signing:

```sh
cd apple/Example
xcodebuild -project Card3DExample.xcodeproj -scheme Card3DExample -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Card3DExample.xcodeproj -scheme Card3DExample -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
```

`-preset <id>` on the app's command line picks its first design (`holo-front`, `glass-clear`, …).

The XCFramework has arm64 slices only (iOS devices, Apple-silicon simulators and Macs). An app that
builds universal binaries excludes x86_64 (`EXCLUDED_ARCHS[sdk=iphonesimulator*] = x86_64`, and the
same for `macosx*`), as the example does.

Size: each slice's `libcard3d.a` is about 10.3 MB (3.8 MB gzipped). Linked into the example app (iOS,
Release, arm64) the whole app binary is 8.6 MB, 7.4 MB stripped (3.6 MB gzipped), plus 0.3 MB of
environments.

## Use

```swift
import Card3D
import SwiftUI

struct CardScreen: View {
    @State private var stage = CardStage(options: .init(quality: .performance, fit: .contain))
    @State private var arFile: URL?
    let json: String

    var body: some View {
        CardView(stage: stage)
            .task { try? await stage.setDesign(json: json) }
            .toolbar {
                Button("Flip") { stage.flip() }
                Button("AR") { arFile = try? stage.exportARFile(.usdz) }
            }
            .quickLookPreview($arFile)   // AR Quick Look on iPhone and iPad
    }
}
```

- `setDesign(json:baseDirectory:)` validates the design as the web does (`ensureDesign` and
  `lintDesign`, in Rust), downloads its remote files, builds it, and returns a `DesignReport` (errors,
  warnings, failed downloads, face shader layers that didn't compile). It throws `Card3DError.design`
  only when there is nothing to draw. `CardStage.validate(_:)` validates without drawing, on any thread.
- `quality` (`.performance`, the default, or `.full`) and `lighting` (a preset id, or nil for the
  design's) rebuild the card; `fit` (`.studio` or `.contain`) applies from the next frame.
- `flip()`, `setFlipped(_:)`, `reset()`, `isFlipped`; `exportPNG(width:height:pose:)`,
  `snapshot(...)` (raw RGBA), `exportAR(.usdz | .glb)`, `exportARFile`.
- `CardStage(offscreenWidth:height:)` draws without a view (exports, tests).
- Errors are `Card3DError`. `.gpu` and `.engine` mean the stage stopped (a lost GPU, or an engine
  failure caught at the library's boundary); the next `setDesign`, or the view reappearing, starts a
  new one.

### Interaction

As the web stage: drag to turn, tap (click) to flip, double tap (double click) to reset. On macOS,
Return / Space flip and Escape / Home reset, the scroll wheel reaches effects that react to it, and the
pointer reaches effects that follow it (live liquid metal). VoiceOver reads the card as a button that flips, with a
Reset action. There is no pinch, as on the web.

### Frames, motion and lifecycle

`CardView` draws on demand: after input, a new design or a resize, then on every display frame only
while the engine reports an animation (an intro, a flip, a live face shader, an effect), and once
whenever it asks to be woken (an animated GIF sticker's next frame). It draws nothing in the background
(iOS) or while the app is hidden (macOS); going there ends a drag and finishes a running flip. The
system's reduced-motion setting turns the intro off and stops face shader clocks, and is followed live.

The drawable's scale is the screen's, capped by the quality tier as on the web (1.25 for performance,
2 for full).

## Assets

The engine reads only files and data URLs. For each design, `setDesign` takes the http(s) URLs the
validator lists (artwork, stickers and GIFs, a logo, a custom font file, a scene's environment file), downloads them into `AssetCache` (Caches/card3d-assets, one file per URL,
keeping its extension), and hands the engine their local paths. A file that fails to download is
skipped, as the web skips an image that fails to load. An asset provider (`CardAssetProvider`) gives
the name font.

Bundled with the package: the five scene environments (`Resources/environments`, 316 KB), the only
files the native host reads from disk, and the third-party notices (`Resources/THIRD_PARTY_NOTICES.md`;
see Licences). The six card fonts are compiled into the library.

Not yet: Google Fonts families as a design's custom font (they draw with the default font; `url` and
`upload` fonts work).

## Licences

The package is MIT-licensed; the library also carries third-party code and files: the Rust crates
compiled into `libcard3d.a` (wgpu, naga, ICU4X, tiny-skia, ab_glyph and more, MIT, Apache-2.0, BSD,
ISC, zlib and Unicode licences), code ported from Paper Shaders, three.js, drei and Earcut, the six card
fonts (SIL OFL 1.1) and the scene environments (CC0). Their notices are the repository's
`THIRD_PARTY_NOTICES.md`, which `build-xcframework.sh` copies into the package's resources and an app
reaches as `Card3DNotices.url` (a Markdown file in the `Card3D` resource bundle). An app shipping the
package must include those notices, e.g. in its acknowledgements screen or settings bundle. A release
of `Card3DFFI.xcframework` on its own (a zip) should carry the same file beside it. The Rust section is
generated from `Cargo.lock` by `pnpm notices` (`pnpm check:notices` fails when it is stale).

## Threading

`CardStage` is main-actor bound: the engine builds and draws on the thread that owns its GPU device.
Validation and downloads run off the main thread; the card build itself (about 0.1–0.3 s for most
designs) runs on it. Animated GIF stickers decode on a worker thread inside the library.

## The C ABI

`crates/card3d-ffi/include/card3d.h` (generated by cbindgen from `src/lib.rs`) documents every
function, and its header comment states the ownership rules: strings and buffers the library returns
are freed with `card3d_string_free` / `card3d_bytes_free`; a stage is used on the thread that made it;
after a GPU failure or a caught panic a stage refuses further work. No wgpu type crosses it: the surface
is a `CAMetalLayer` pointer (the Android library passes an `ANativeWindow` pointer instead; see android/).
