plugins {
  id("com.android.application")
}

android {
  namespace = "com.card3d.example"
  compileSdk = 37

  defaultConfig {
    applicationId = "com.card3d.example"
    minSdk = 26
    targetSdk = 37
    versionCode = 1
    versionName = "1.0"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  // The Swift example's preset designs, shared (apple/Example/Card3DExample/Presets).
  sourceSets["main"].assets.srcDir(rootDir.resolve("../apple/Example/Card3DExample/Presets"))

  packaging {
    jniLibs {
      keepDebugSymbols += "**/libcard3d.so"
    }
  }
}

dependencies {
  implementation(project(":card3d"))
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
}
