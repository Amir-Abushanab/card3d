plugins {
  id("com.android.library")
}

android {
  namespace = "com.card3d"
  compileSdk = 37

  defaultConfig {
    // Vulkan 1.0 (or GLES 3.0) and AHardwareBuffer-era drivers; the NDK links the engine for API 26.
    minSdk = 26
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    consumerProguardFiles("consumer-rules.pro")
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  packaging {
    jniLibs {
      // build.sh strips the library already; keep the exported symbols the JNI lookup needs.
      keepDebugSymbols += "**/libcard3d.so"
    }
  }
}

dependencies {
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
  androidTestImplementation("androidx.test:runner:1.7.0")
  androidTestImplementation("junit:junit:4.13.2")
  // Newer than the ones the test runner pulls in (annotation 1.7.0 with runner 1.7.0).
  androidTestImplementation("androidx.annotation:annotation:1.11.0")
  androidTestImplementation("androidx.annotation:annotation-experimental:1.6.0")
}

/** Copies files into a generated assets directory (`into` is the path inside the assets). */
abstract class CopyAssets : DefaultTask() {
  @get:InputFiles
  abstract val sources: ConfigurableFileCollection

  @get:Input
  abstract val into: Property<String>

  @get:OutputDirectory
  abstract val output: DirectoryProperty

  @TaskAction
  fun copy() {
    val out = output.get().asFile
    out.deleteRecursively()
    val dir = out.resolve(into.get())
    sources.asFileTree.visit {
      if (!isDirectory) file.copyTo(dir.resolve(relativePath.pathString), overwrite = true)
    }
  }
}

val repo = rootDir.resolve("..")

// The scene environments the native host reads from disk (packages/core/assets/environments): in the
// AAR's assets at card3d/environments/, copied to app storage on first use (Environments.kt).
val environments = tasks.register<CopyAssets>("card3dEnvironments") {
  sources.from(fileTree(repo.resolve("packages/core/assets/environments")) { include("*.webp") })
  into = "card3d/environments"
}

// The licences of the third-party code, fonts and environments in the library (the repository's
// THIRD_PARTY_NOTICES.md, whose Rust section `pnpm notices` regenerates): in the AAR's assets at
// card3d/THIRD_PARTY_NOTICES.md, so apps can show them.
val notices = tasks.register<CopyAssets>("card3dNotices") {
  sources.from(repo.resolve("THIRD_PARTY_NOTICES.md"))
  into = "card3d"
}

// The instrumented tests' designs and the harness's native renders of them (test.sh writes those to
// $CARD3D_REFERENCE_DIR, default target/android-reference).
val testDesigns = listOf("brushed-silver", "holo-front", "glass-clear", "face-liquid-metal-mark", "scene-floor", "sticker-gif")
val referenceDir = providers.environmentVariable("CARD3D_REFERENCE_DIR").getOrElse(repo.resolve("target/android-reference").path)
val testAssets = tasks.register<CopyAssets>("card3dTestAssets") {
  sources.from(fileTree(repo.resolve("crates/card3d-tools/designs")) { include(testDesigns.map { "$it.json" }) })
  sources.from(fileTree(referenceDir) { include(testDesigns.map { "$it/rust-*.png" }) })
  into = "card3d-test"
}

androidComponents {
  onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(environments, CopyAssets::output)
    variant.sources.assets?.addGeneratedSourceDirectory(notices, CopyAssets::output)
    variant.deviceTests.values.forEach { it.sources.assets?.addGeneratedSourceDirectory(testAssets, CopyAssets::output) }
  }
}
