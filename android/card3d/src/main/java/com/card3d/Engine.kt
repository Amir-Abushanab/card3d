package com.card3d

import android.content.Context
import android.view.Surface
import java.io.File

/**
 * One engine stage over [Native]. Not thread-safe: used on the thread that made it (the main thread
 * for views). [close] frees it; a closed engine ignores calls (and throws on those that return data).
 */
internal class Engine private constructor(private var handle: Long) : AutoCloseable {
  private val wake = DoubleArray(1)
  private val pair = DoubleArray(2)

  val isClosed: Boolean get() = handle == 0L

  override fun close() {
    if (handle != 0L) Native.free(handle)
    handle = 0L
  }

  private fun live(): Long = handle.takeIf { it != 0L } ?: throw Card3DException.InvalidArgument("the stage was closed")

  fun setDesign(json: String, assets: String): DesignReport = DesignReport.parse(Native.setDesign(live(), json, assets))
  fun resize(width: Int, height: Int) { if (handle != 0L) Native.resize(handle, width.coerceAtLeast(1), height.coerceAtLeast(1)) }

  /** Flags (`Native.ANIMATING` …) and the ms until a scheduled change, if any. */
  fun advance(nowMs: Double): Pair<Int, Double?> {
    if (handle == 0L) return 0 to null
    val flags = Native.advance(handle, nowMs, wake)
    return flags to wake[0].takeIf { it >= 0 }
  }

  fun render() = Native.render(live())
  fun setQuality(q: CardQuality) = Native.setQuality(live(), q.code)
  fun setFit(f: CardFit) { if (handle != 0L) Native.setFit(handle, f.code) }
  fun setLighting(id: String?) = Native.setLighting(live(), id)
  fun setReducedMotion(on: Boolean) { if (handle != 0L) Native.setReducedMotion(handle, on) }
  fun setVisible(on: Boolean) { if (handle != 0L) Native.setVisible(handle, on) }
  fun setRotation(p: CardPose) { if (handle != 0L) Native.setRotation(handle, p.x, p.y, p.z) }
  fun setCameraOrbit(azimuth: Double, elevation: Double, distance: Double) { if (handle != 0L) Native.setCameraOrbit(handle, azimuth, elevation, distance) }

  fun pointerDown(id: Int, x: Double, y: Double, width: Double, height: Double, now: Double) = handle != 0L && Native.pointerDown(handle, id, x, y, width, height, now)
  fun pointerMove(id: Int, x: Double, y: Double, now: Double) = handle != 0L && Native.pointerMove(handle, id, x, y, now)
  fun pointerUp(id: Int, x: Double, y: Double, now: Double) { if (handle != 0L) Native.pointerUp(handle, id, x, y, now) }
  fun pointerCancel(id: Int) { if (handle != 0L) Native.pointerCancel(handle, id) }
  /** Normalised device coordinates, or null when the pointer left. */
  fun setPointer(x: Double?, y: Double?) { if (handle != 0L) Native.setPointer(handle, x != null && y != null, x ?: 0.0, y ?: 0.0) }
  fun wheel(delta: Double) { if (handle != 0L) Native.wheel(handle, delta) }
  fun doubleClick() { if (handle != 0L) Native.doubleClick(handle) }
  /** `reset`: Home / Escape; else flip (Enter / Space). */
  fun key(reset: Boolean, now: Double) = handle != 0L && Native.key(handle, if (reset) 1 else 2, now)
  fun toggleFlip(now: Double) { if (handle != 0L) Native.toggleFlip(handle, now) }
  fun setFlipped(on: Boolean, now: Double) { if (handle != 0L) Native.setFlipped(handle, on, now) }
  fun reset() { if (handle != 0L) Native.reset(handle) }
  val flipped: Boolean get() = handle != 0L && Native.flipped(handle)
  val rotation: Pair<Double, Double>
    get() {
      if (handle == 0L) return 0.0 to 0.0
      Native.rotation(handle, pair)
      return pair[0] to pair[1]
    }

  /** Straight-alpha RGBA rows, top first. */
  fun snapshot(width: Int, height: Int, pose: CardPose?): ByteArray = Native.snapshot(live(), width, height, pose?.toArray())
  fun exportPng(width: Int, height: Int, pose: CardPose?): ByteArray = Native.exportPng(live(), width, height, pose?.toArray())
  fun exportAr(format: ArFormat, size: Int, upright: Boolean): ByteArray = Native.exportAr(live(), format.code, size, upright)

  companion object {
    /** Starts the GPU on `surface` (null: an offscreen texture), `width` × `height` px. */
    fun make(context: Context, options: CardStage.Options, quality: CardQuality, fit: CardFit, surface: Surface?, width: Int, height: Int, reducedMotion: Boolean): Engine {
      check(Native.abiVersion() == Native.ABI_VERSION) { "libcard3d.so's ABI ${Native.abiVersion()} isn't the library's ${Native.ABI_VERSION}" }
      val handle = Native.newStage(
        quality.code, fit.code, options.interactive, options.intro && !reducedMotion, reducedMotion,
        options.restingRotationX, options.restingRotationY, Environments.directory(context)?.path,
        surface, width.coerceAtLeast(1), height.coerceAtLeast(1),
      )
      return Engine(handle)
    }

    fun validate(json: String): DesignReport = DesignReport.parse(Native.validate(json))
  }
}

/**
 * The scene environments the native host reads from disk (`<id>.webp`): bundled in the AAR's assets
 * (`card3d/environments/`), copied once to app storage, where the engine reads them.
 */
internal object Environments {
  private const val ASSETS = "card3d/environments"
  @Volatile private var dir: File? = null

  /** The directory, copied on first use (≈320 KB); null if the assets are missing or unwritable. */
  fun directory(context: Context): File? {
    dir?.let { return it }
    synchronized(this) {
      dir?.let { return it }
      val app = context.applicationContext ?: context
      val out = File(app.noBackupFilesDir, ASSETS)
      dir = try {
        val names = app.assets.list(ASSETS).orEmpty().filter { it.endsWith(".webp") }
        if (names.isEmpty()) return null
        out.mkdirs()
        for (name in names) {
          // Same size: the same file (the set changes only with the library, and then by size). A
          // compressed asset has no descriptor: then only a missing file is copied.
          val size = try {
            app.assets.openFd("$ASSETS/$name").use { it.length }
          } catch (e: java.io.IOException) {
            null
          }
          val target = File(out, name)
          if (target.isFile && (size == null || target.length() == size)) continue
          val tmp = File(out, "$name.tmp")
          app.assets.open("$ASSETS/$name").use { input -> tmp.outputStream().use { input.copyTo(it) } }
          tmp.renameTo(target)
        }
        out
      } catch (e: java.io.IOException) {
        null
      }
      return dir
    }
  }
}
