// The Android library (card3d: com.card3d) and its example app. build.sh builds the engine's shared
// library into card3d/src/main/jniLibs first; test.sh runs the instrumented tests on a device.
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "card3d-android"
include(":card3d", ":example")
