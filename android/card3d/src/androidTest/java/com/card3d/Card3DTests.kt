package com.card3d

import android.graphics.BitmapFactory
import android.os.Build
import android.graphics.PixelFormat
import android.hardware.HardwareBuffer
import android.media.ImageReader
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.abs
import kotlin.math.max

private const val TAG = "card3d-test"

/** Plain, holo, glass, a face shader, a scene, a sticker GIF (the Swift package's pixel designs). */
private val pixelDesigns = listOf("brushed-silver", "holo-front", "glass-clear", "face-liquid-metal-mark", "scene-floor", "sticker-gif")
private val poses = listOf("front" to CardPose.FRONT, "tilt" to CardPose.TILT, "back" to CardPose.BACK, "edge" to CardPose.EDGE)

private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
private val context get() = instrumentation.targetContext

/** A test asset (build.gradle.kts copies the designs and the harness's renders to `card3d-test/`). */
private fun asset(path: String): ByteArray? = try {
  instrumentation.context.assets.open("card3d-test/$path").use { it.readBytes() }
} catch (e: java.io.IOException) {
  null
}

private fun design(name: String) = String(asset("$name.json") ?: error("no design $name"))

/** Straight RGBA pixels of a PNG, as stored (no premultiplication, no colour management). */
private fun pixels(png: ByteArray): Triple<Int, Int, ByteArray> {
  val o = BitmapFactory.Options().apply { inPremultiplied = false; inScaled = false }
  val bitmap = BitmapFactory.decodeByteArray(png, 0, png.size, o) ?: error("unreadable PNG")
  val buf = ByteBuffer.allocate(bitmap.byteCount)
  bitmap.copyPixelsToBuffer(buf)
  return Triple(bitmap.width, bitmap.height, buf.array())
}

/**
 * The harness's measure (crates/card3d-tools compare.rs): both over mid grey, the mean absolute error
 * per channel over the pixels either covers, the share of those off by more than 24, and their count.
 */
private fun compare(a: ByteArray, b: ByteArray): Triple<Double, Double, Int> {
  var sum = 0.0
  var card = 0
  var over = 0
  for (i in 0 until minOf(a.size, b.size) step 4) {
    val (aa, ab) = (a[i + 3].toInt() and 255) to (b[i + 3].toInt() and 255)
    if (aa == 0 && ab == 0) continue
    val (ka, kb) = aa / 255.0 to ab / 255.0
    var d = 0.0
    var worst = 0.0
    for (c in 0 until 3) {
      val e = abs(((a[i + c].toInt() and 255) * ka + 128 * (1 - ka)) - ((b[i + c].toInt() and 255) * kb + 128 * (1 - kb)))
      d += e
      worst = max(worst, e)
    }
    sum += d / 3
    card++
    if (worst > 24) over++
  }
  return Triple(sum / max(card, 1), 100.0 * over / max(card, 1), card)
}

/** `block` with wgpu's `WGPU_BACKEND` set to `backend` (read when a stage starts its GPU); null: the default (Vulkan, else GLES). */
private fun <T> withBackend(backend: String?, block: () -> T): T {
  if (backend == null) return block()
  android.system.Os.setenv("WGPU_BACKEND", backend, true)
  try {
    return block()
  } finally {
    android.system.Os.unsetenv("WGPU_BACKEND")
  }
}

class PixelMatch {
  /** The Kotlin path (validation, JNI, an offscreen stage) draws what the engine's harness draws (Metal there, Vulkan here). */
  @Test
  fun matchesTheHarness() = withBackend(null) { match("default") }

  /**
   * The same on GLES, the backend for devices without Vulkan. On the emulator's GLES (ANGLE on
   * SwiftShader) the glass card's coil and the scene floor's reflection and contact shadow don't draw,
   * so those two designs are measured and logged but not held to the limit (`known`).
   */
  @Test
  fun matchesTheHarnessOnGles() = withBackend("gl") { match("gles", known = if (Build.HARDWARE == "ranchu") setOf("glass-clear", "scene-floor") else emptySet()) }

  private fun match(backend: String, known: Set<String> = emptySet()) {
    val failures = mutableListOf<String>()
    for (name in pixelDesigns) {
      val stage = CardStage.offscreen(context, 1200, 750, CardStage.Options(CardQuality.FULL, CardFit.STUDIO, interactive = false, intro = false))
      try {
        val report = runBlocking { stage.setDesign(design(name)) }
        assertTrue("$name: ${report.shaderErrors}", report.shaderErrors.isEmpty())
        stage.render()
        for ((pose, p) in poses) {
          val reference = asset("$name/rust-$pose.png")
          assertNotNull("no reference render for $name $pose: run android/test.sh (it renders them with crates/card3d-tools)", reference)
          val (w, h, expected) = pixels(reference!!)
          assertEquals(1200 to 750, w to h)
          val actual = stage.snapshot(1200, 750, p)
          // `am instrument -e save 1` (test.sh: CARD3D_SAVE=1) keeps the renders to compare by eye.
          if (InstrumentationRegistry.getArguments().getString("save") != null) {
            File(context.getExternalFilesDir(null), "card3d-test/$backend-$name-$pose.png").apply { parentFile?.mkdirs() }.writeBytes(stage.exportPng(1200, 750, p))
          }
          assertEquals(expected.size, actual.size)
          val (mae, over24, card) = compare(actual, expected)
          val line = "$backend $name $pose: mean error ${"%.3f".format(mae)}, ${"%.2f".format(over24)} % over 24, $card px"
          Log.i(TAG, line)
          // Not vacuous: the card covers a good part of the frame.
          if (card <= 20_000) failures += "$name $pose: only $card card pixels"
          if (mae >= 0.5 && name !in known) failures += line
          if (mae >= 0.5 && name in known) Log.i(TAG, "$backend $name $pose: KNOWN on this device's GLES")
        }
      } finally {
        stage.close()
      }
    }
    assertTrue(failures.joinToString("\n"), failures.isEmpty())
  }
}

class Stage {
  @Test
  fun validationReportsAndRefuses() {
    val report = CardStage.validate("""{"recipe":{"texture":"no-such-texture"},"cardholderName":"A","logo":{"src":"https://example.com/l.png"}}""")
    assertTrue(report.errors.isNotEmpty())
    assertEquals(listOf("https://example.com/l.png"), report.remoteUrls)
    assertTrue(report.designJson?.startsWith("{") == true)
    assertThrows(Card3DException.Design::class.java) { CardStage.validate("[1]") }
  }

  /** An `ANativeWindow` (an ImageReader's surface): drawn, presented, tapped. */
  @Test
  fun drawsOnAWindow() = withBackend(null) { drawOnAWindow("default") }

  @Test
  fun drawsOnAWindowWithGles() = withBackend("gl") { drawOnAWindow("gles", opaque = true) }

  /** `opaque`: the window's format has no alpha (wgpu's EGL picks an RGBX config on Android), so drawn pixels are told by colour. */
  private fun drawOnAWindow(backend: String, opaque: Boolean = false) {
    val format = if (opaque) PixelFormat.RGBX_8888 else PixelFormat.RGBA_8888
    val reader = ImageReader.newInstance(320, 200, format, 3, HardwareBuffer.USAGE_GPU_COLOR_OUTPUT or HardwareBuffer.USAGE_CPU_READ_OFTEN)
    val engine = Engine.make(context, CardStage.Options(), CardQuality.PERFORMANCE, CardFit.STUDIO, reader.surface, 320, 200, reducedMotion = false)
    try {
      engine.setDesign(design("holo-front"), "")
      // The intro runs first; a tap flips (as a click does on the web).
      val (flags, _) = engine.advance(CardStage.now)
      assertTrue(flags and Native.ANIMATING != 0)
      engine.render()
      val t = CardStage.now
      assertTrue(engine.pointerDown(1, 160.0, 100.0, 320.0, 200.0, t))
      engine.pointerUp(1, 160.0, 100.0, t + 50)
      engine.advance(t + 60)
      assertTrue(engine.flipped)
      engine.render()
      // The frame reached the window: some of it is card.
      val image = (0 until 50).firstNotNullOfOrNull { reader.acquireLatestImage() ?: run { Thread.sleep(20); null } }
      assertNotNull("no frame presented", image)
      image!!.use {
        val plane = it.planes[0]
        val buf = plane.buffer
        var covered = 0
        for (y in 0 until 200) {
          for (x in 0 until 320) {
            val i = y * plane.rowStride + x * plane.pixelStride
            if (if (opaque) (0 until 3).any { c -> buf.get(i + c).toInt() != 0 } else buf.get(i + 3).toInt() != 0) covered++
          }
        }
        Log.i(TAG, "$backend window frame: $covered of 64000 px covered")
        assertTrue("only $covered px drawn", covered > 5_000)
      }
      val png = engine.exportPng(160, 100, null)
      assertArrayEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47), png.copyOf(4))
    } finally {
      engine.close()
      reader.close()
    }
  }

  /** The view's surface goes and comes back (a TextureView detached and attached): a new engine draws the same design. */
  @Test
  fun surfaceRecreatedRebuilds() {
    instrumentation.runOnMainSync {
      val stage = CardStage(context, CardStage.Options(intro = false))
      val view = CardView(context)
      val first = ImageReader.newInstance(200, 125, PixelFormat.RGBA_8888, 3, HardwareBuffer.USAGE_GPU_COLOR_OUTPUT)
      val second = ImageReader.newInstance(200, 125, PixelFormat.RGBA_8888, 3, HardwareBuffer.USAGE_GPU_COLOR_OUTPUT)
      try {
        view.stage = stage
        stage.attach(view, first.surface, 200, 125)
        assertNotNull(stage.engine)
        assertFalse(stage.hasCard)
        // A design set while attached builds at once (the coroutine runs to completion here: nothing is downloaded).
        runBlocking { stage.setDesign(design("brushed-silver")) }
        assertTrue(stage.hasCard)
        stage.frame(200, 125)
        stage.detach(view)
        assertNull(stage.engine)
        stage.attach(view, second.surface, 200, 125)
        assertTrue(stage.hasCard)
        assertNull(stage.lastError)
        stage.frame(200, 125)
      } finally {
        stage.detach(view)
        first.close()
        second.close()
      }
    }
  }

  @Test
  fun exportsAr() {
    val stage = CardStage.offscreen(context, 64, 40)
    try {
      runBlocking { stage.setDesign(design("brushed-silver")) }
      val glb = stage.exportArFile(ArFormat.GLB, size = 256)
      try {
        assertEquals("glTF", String(glb.readBytes().copyOf(4)))
        assertEquals("content", CardFileProvider.uriFor(context, glb).scheme)
        val intent = CardStage.arIntent(context, glb)
        assertNotNull(intent.data)
      } finally {
        glb.parentFile?.deleteRecursively()
      }
      val usdz = stage.exportAr(ArFormat.USDZ, size = 256)
      assertEquals("PK", String(usdz.copyOf(2)))
    } finally {
      stage.close()
    }
  }

  @Test
  fun optionChangesRebuild() {
    val stage = CardStage.offscreen(context, 120, 75)
    try {
      runBlocking { stage.setDesign(design("brushed-silver")) }
      val before = stage.snapshot(120, 75, CardPose.FRONT)
      stage.lighting = "dark"
      assertNull(stage.lastError)
      val after = stage.snapshot(120, 75, CardPose.FRONT)
      assertNotEquals(before.toList(), after.toList())
      stage.quality = CardQuality.FULL
      assertNull(stage.lastError)
      assertThrows(Card3DException.InvalidArgument::class.java) { stage.exportPng(0, 10) }
    } finally {
      stage.close()
    }
    assertThrows(Card3DException.InvalidArgument::class.java) { stage.exportPng(10, 10) }
  }

  @Test
  fun remoteFilesComeFromTheCache() {
    val dir = File(context.cacheDir, "card3d-cache-test-${System.nanoTime()}")
    try {
      val cache = AssetCache(dir)
      // A file URL stands in for a download.
      val source = File(context.cacheDir, "source.json").apply { writeText("{}") }
      val missing = File(dir, "nope.png")
      val (files, failed) = runBlocking { cache.files(listOf(source.toURI().toString(), missing.toURI().toString())) }
      assertEquals("json", files[source.toURI().toString()]?.extension)
      assertEquals(listOf(missing.toURI().toString()), failed)
    } finally {
      dir.deleteRecursively()
    }
  }
}
