# Card3D for Android

An Android library (`com.card3d`, minSdk 26) that shows a card drawn by the card engine (the Rust + wgpu
engine in `crates/`, on Vulkan, else GLES). `CardView` is a `TextureView` the engine draws on;
`CardStage` holds the design and does the rest (quality, framing, lighting, flipping, PNG and AR
exports). The engine is `libcard3d.so`: `crates/card3d-ffi` built as a shared library, whose small JNI
layer (`src/android.rs`) calls the same functions as its C ABI (`include/card3d.h`, which the Swift
package uses).

```
android/
  build.sh            the .so (Rust, per ABI) into card3d/src/main/jniLibs, then the AAR and the example APK
  test.sh             reference renders + the instrumented tests on a device or emulator
  card3d/             the library: CardStage, CardView, AssetCache, the JNI declarations (Native.kt)
    src/androidTest/  pixel tests against the engine's harness, stage tests
  example/            an app: a design picker over the preset designs (shared with apple/Example), flip, PNG, AR
```

## Build

```sh
android/build.sh               # arm64-v8a; prints the .so, AAR and APK sizes
android/test.sh                # with a device or a running emulator (adb)
```

`build.sh` needs Rust (it adds missing Android targets with `rustup target add`), the Android SDK
(`ANDROID_HOME`, default `~/Library/Android/sdk`) with an NDK (`ANDROID_NDK_HOME`, default the newest
in `$ANDROID_HOME/ndk`; its clang links the library, no `cargo-ndk` needed) and JDK 17+. It builds
with the workspace's `native` profile (fat LTO, panics unwind so the JNI layer can catch them), 16 KB
page alignment, and strips everything but the exported functions. `CARD3D_ABIS="arm64-v8a x86_64"`
adds Intel emulators; `CARD3D_SKIP_RUST=1` / `CARD3D_SKIP_GRADLE=1` run half; `CARD3D_CLEAN=1` drops
each target's intermediate Rust files; `GRADLE_FLAGS=--offline` builds from the Gradle cache. The
.so, AAR and APKs are build output (gitignored).

Outputs: `card3d/build/outputs/aar/card3d-release.aar`, `example/build/outputs/apk/debug/example-debug.apk`.
`adb shell am start -n com.card3d.example/.MainActivity -e preset glass-clear` picks the example's
first design.

Size: `libcard3d.so` (arm64-v8a) is 7.9 MB (3.8 MB gzipped); the AAR 4.2 MB; the example's debug APK
9.6 MB (the .so is stored uncompressed, so it can be mapped in place).

## Use

```kotlin
val stage = CardStage(context, CardStage.Options(quality = CardQuality.PERFORMANCE, fit = CardFit.CONTAIN))
findViewById<CardView>(R.id.card).stage = stage
lifecycleScope.launch {
    val report = stage.setDesign(json)        // validates, downloads, builds; throws only when nothing can be drawn
}
flipButton.setOnClickListener { stage.flip() }
arButton.setOnClickListener { startActivity(CardStage.arIntent(this, stage.exportArFile(ArFormat.GLB))) }
```

In Compose: `AndroidView(factory = { CardView(it).apply { this.stage = stage } })`.

- `setDesign(json, baseDirectory)` (a `suspend` function, from the main thread) validates the design
  as the web does (`ensureDesign` and `lintDesign`, in Rust), downloads its remote files, builds it,
  and returns a `DesignReport` (errors, warnings, failed downloads, face shader layers that didn't
  compile). `CardStage.validate(json)` validates without drawing, on any thread.
- `quality` and `lighting` (a preset id, or null for the design's) rebuild the card; `fit` applies
  from the next frame. `flip()`, `setFlipped()`, `reset()`, `isFlipped`, `addListener { }`.
- Exports: `exportPng(width, height, pose)`, `snapshot(...)` (raw straight-alpha RGBA),
  `exportAr(ArFormat.GLB | USDZ)`, `exportArFile(...)` (served by the library's `CardFileProvider`,
  authority `<applicationId>.card3d.files`). `CardStage.arIntent(context, file)` opens Scene Viewer
  (Google Play Services for AR) when installed, else any app for `model/gltf-binary`;
  `sceneViewerIntent(url)` takes a hosted GLB (Scene Viewer documents https URLs).
- `CardStage.offscreen(context, width, height)` draws without a view (exports, tests); `close()`
  frees it.
- Errors are `Card3DException` subclasses (`InvalidArgument`, `Design`, `Gpu`, `Export`, `Engine`),
  thrown from the engine through JNI. `Gpu` and `Engine` mean the stage stopped (`stoppedStage`):
  the next design or surface starts a new one.

### Interaction, frames and lifecycle

As the web stage: drag to turn, tap to flip, double tap to reset (positions in dp, the web's CSS px);
Enter / Space / D-pad centre flip and Escape / Home reset; a mouse's hover and wheel reach the effects
that follow them. A drag on the card keeps a scrolling parent from taking it. TalkBack reads a button
that flips, with a Reset action and the side shown.

`CardView` draws on demand: after input, a design or a resize, then on each `Choreographer` frame
only while the engine reports an animation, and once when it asks to be woken (`wake_ms`: an animated
GIF sticker's next frame). Nothing is drawn while it is hidden or its window is in the background
(that ends a drag and finishes a running flip). Its surface going away (detached from the window)
frees the engine; the next surface starts a new one with the same design. The system's "Remove
animations" (animator duration scale 0) turns the intro off and stops face shader clocks, followed
live. The drawable's scale is the screen density capped by the quality tier (1.25 performance, 2
full); the view scales it to fit.

## Assets

The engine reads only files and data URLs. `setDesign` downloads the http(s) URLs the validator lists
into `AssetCache` (`cacheDir/card3d-assets`, one file per URL keeping its extension; `java.net` on
`Dispatchers.IO`, in parallel) and hands the engine their paths; a file that fails is skipped, as the
web skips an image that fails to load. An asset provider (`CardAssetProvider`) gives the name font.
The five scene environments (`packages/core/assets/environments/*.webp`, 310 KB) are in
the AAR's assets (`card3d/environments/`, copied at build time, not duplicated in the repository) and
are copied once to `noBackupFilesDir/card3d/environments`, whose path the engine gets as its
environments directory. The card fonts are compiled into the library. The third-party notices are in
the AAR's assets too (`card3d/THIRD_PARTY_NOTICES.md`; see Licences).

## Licences

The library is MIT-licensed; `libcard3d.so` also carries third-party code and files: the Rust crates
compiled into it (wgpu, naga, ash, ICU4X, tiny-skia, ab_glyph, jni and more, MIT, Apache-2.0, BSD,
ISC, zlib and Unicode licences), code ported from Paper Shaders, three.js, drei and Earcut, the six card
fonts (SIL OFL 1.1) and the scene environments (CC0). Their notices are the repository's
`THIRD_PARTY_NOTICES.md`, which the build copies into the AAR's assets: an app reads it with
`context.assets.open("card3d/THIRD_PARTY_NOTICES.md")` (Markdown) and must include it, e.g. in its
open-source licences screen. The Rust section is generated from `Cargo.lock` by `pnpm notices`
(`pnpm check:notices` fails when it is stale).

The AAR declares one dependency, `org.jetbrains.kotlinx:kotlinx-coroutines-android` (Apache-2.0),
which Gradle resolves in the app; it is not inside the AAR, so its notice is the app's to include as
for any other dependency (the Play services OSS licences plugin, or similar, collects it).

## Tests

`test.sh` renders the reference images with the harness (`crates/card3d-tools render`, into
`$CARD3D_REFERENCE_DIR`, default `target/android-reference`; `apple/test.sh`'s `target/apple-reference`
holds the same renders), builds the test APK with the designs and references as its assets, installs
it, runs `am instrument` and prints each design's and pose's mean error. The pixel test draws six
designs (brushed-silver, holo-front, glass-clear, face-liquid-metal-mark, scene-floor, sticker-gif) at four
poses through Kotlin, JNI and an offscreen stage, with the harness's measure, under 0.5 per pose; once
on the default backend (Vulkan) and once on GLES (`WGPU_BACKEND=gl`). The stage tests draw on an
`ANativeWindow` (an `ImageReader`'s surface, Vulkan and GLES) and read the presented frame back, tap
to flip, rebuild on a recreated surface, export GLB / USDZ / PNG, change options, and use the cache.
`CARD3D_SAVE=1 CARD3D_KEEP=1` keeps the renders on the device.

On the emulator without a window (`emulator -no-window`) Vulkan is lavapipe and GLES is ANGLE on
SwiftShader. Measured there: Vulkan 0.005–0.452 per pose (all six designs pass); GLES passes four,
but draws neither the glass card's coil nor the scene floor's reflection and contact shadow (mean
error 2.6–6.0; logged as known on the emulator only).

The logcat tag `card3d` names the GPU each stage got.

## Not yet

armeabi-v7a; on GLES the window has no alpha (wgpu's EGL config on Android is RGBX, so the card draws
over black there); Google Fonts families as a design's custom font (as on Apple); building off the main
thread; Maven publishing.
