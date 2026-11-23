// Kotlin is built into the Android Gradle plugin from 9.0, so no Kotlin plugin is applied; declaring the
// Kotlin Gradle plugin (`apply false`) only puts that version on the build classpath, newer than the one
// AGP depends on.
plugins {
  id("com.android.library") version "9.5.1" apply false
  id("com.android.application") version "9.5.1" apply false
  id("org.jetbrains.kotlin.android") version "2.4.21" apply false
}
