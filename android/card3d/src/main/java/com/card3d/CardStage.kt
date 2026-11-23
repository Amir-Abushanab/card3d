package com.card3d

import android.animation.ValueAnimator
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.view.Surface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/**
 * One card: its design, how it's drawn, its pose, and its exports. Show it with [CardView], or make
 * an offscreen stage ([CardStage.offscreen]) for exports and tests.
 *
 * Confined to one thread: the engine builds and draws on the thread that owns its GPU device. For a
 * view that is the main thread; call [setDesign] from a main-thread coroutine (`lifecycleScope`), as
 * validation and downloads switch to background dispatchers and the build comes back to the caller's.
 * Building blocks that thread for the build itself (~0.1–0.3 s for most designs).
 */
class CardStage @JvmOverloads constructor(
  context: Context,
  val options: Options = Options(),
  val assetProvider: CardAssetProvider = CardAssetProvider(),
  val assetCache: AssetCache = AssetCache(context),
) : AutoCloseable {
  /** How the stage is set up (the web stage's options). */
  data class Options(
    val quality: CardQuality = CardQuality.PERFORMANCE,
    val fit: CardFit = CardFit.STUDIO,
    /** Drag to turn, tap to flip, double tap to reset, keys and accessibility actions. */
    val interactive: Boolean = true,
    /** The one-shot intro on the first card (never when the system turns animations off). */
    val intro: Boolean = true,
    /** The resting rotation, degrees (pitch, yaw). */
    val restingRotationX: Double = 0.0,
    val restingRotationY: Double = 0.0,
    /** What TalkBack calls the card. */
    val label: String = "Card",
  )

  /** Told when the stage's state changes: a design loaded or failed, the card flipped. */
  fun interface Listener {
    fun onStageChanged(stage: CardStage)
  }

  private val appContext: Context = context.applicationContext ?: context

  /** Whether the back faces the viewer. */
  var isFlipped = false
    private set

  /** The last design's report. */
  var report: DesignReport? = null
    private set

  /** The last failure (a design that couldn't be read, a lost GPU…); cleared by the next design. */
  var lastError: Card3DException? = null
    private set

  /** A design is being validated, downloaded or built. */
  var isLoading = false
    private set

  /** The card is built and drawn. */
  var hasCard = false
    private set

  /** The rendering tier; changing it rebuilds the card. */
  var quality: CardQuality = options.quality
    set(value) {
      if (field == value) return
      field = value
      rebuildWith { it.setQuality(value) }
      view?.layoutDrawable()
    }

  /** The framing, from the next frame. */
  var fit: CardFit = options.fit
    set(value) {
      field = value
      engine?.setFit(value)
      requestFrame()
    }

  /**
   * A lighting preset id ("studio", "warm", "cool", "dramatic", "light", "dark") in place of the
   * design's own; null for the design's. Changing it rebuilds the card.
   */
  var lighting: String? = null
    set(value) {
      if (field == value) return
      field = value
      rebuildWith { it.setLighting(value) }
    }

  internal var engine: Engine? = null
  internal var view: CardView? = null
  /** The design on the stage (JSON) and its assets JSON: replayed on a new engine. */
  private var current: Pair<String, String>? = null
  private var token = 0
  internal var reducedMotion = systemReducedMotion()
    private set
  private var offscreenSize: Pair<Int, Int>? = null
  private val listeners = CopyOnWriteArrayList<Listener>()

  fun addListener(listener: Listener) = listeners.add(listener)
  fun removeListener(listener: Listener) = listeners.remove(listener)
  private fun changed() = listeners.forEach { it.onStageChanged(this) }

  // ── designs ──────────────────────────────────────────────────────────────

  /**
   * Shows a design (`CardDesign` JSON): validates it, downloads its remote files, builds the card.
   * `baseDirectory`: where relative `src`s are (a design file's folder). The card keeps its pose. A
   * newer call supersedes one still loading (that one returns its report without drawing). Throws
   * [Card3DException.Design] only when there is nothing to draw.
   */
  suspend fun setDesign(json: String, baseDirectory: File? = null): DesignReport {
    val mine = ++token
    isLoading = true
    changed()
    try {
      var report = withContext(Dispatchers.Default) { Engine.validate(json) }
      val downloads = assetCache.files(report.remoteUrls)
      report = report.copy(failedDownloads = downloads.failed, designJson = null)
      if (mine != token) return report
      val assets = assetsJson(downloads.files, baseDirectory)
      current = json to assets
      lastError = null
      this.report = report
      for (url in downloads.failed) Log.w(TAG, "couldn't download $url; its layer is skipped")
      val size = offscreenSize
      if (engine == null && size != null) startOffscreen(size.first, size.second)
      val e = engine
      if (e != null) {
        val built = e.setDesign(json, assets)
        this.report = report.copy(shaderErrors = built.shaderErrors)
        hasCard = true
        isFlipped = e.flipped
        requestFrame()
      } else {
        // Built when the view's surface is ready (`attach`), now if it is.
        view?.startEngine()
      }
      return this.report ?: report
    } catch (e: Card3DException) {
      fail(e)
      throw e
    } finally {
      if (mine == token) isLoading = false
      changed()
    }
  }

  /** A design from a JSON file (relative `src`s resolve against its folder). */
  suspend fun setDesign(file: File): DesignReport {
    val json = withContext(Dispatchers.IO) { file.readText() }
    return setDesign(json, file.absoluteFile.parentFile)
  }

  private fun assetsJson(files: Map<String, File>, base: File?): String {
    val o = JSONObject()
    o.put("files", JSONObject(files.mapValues { it.value.path }))
    base?.let { o.put("base", it.path) }
    assetProvider.nameFontFamily?.let { o.put("nameFontFamily", it) }
    return o.toString()
  }

  /** Runs an option change on the engine (rebuilds), reporting a failure. */
  private fun rebuildWith(change: (Engine) -> Unit) {
    val e = engine ?: return
    try {
      change(e)
      requestFrame()
    } catch (x: Card3DException) {
      fail(x)
      changed()
    }
  }

  private fun fail(e: Card3DException) {
    lastError = e
    Log.e(TAG, e.message ?: e.toString())
    if (e.stoppedStage) {
      // The engine stopped: drop it; the next design (or surface) starts a new one.
      engine?.close()
      engine = null
      hasCard = false
      view?.stopEngine()
    }
  }

  // ── the card ─────────────────────────────────────────────────────────────

  /** Turns the card over (animated). */
  fun flip() {
    engine?.toggleFlip(now)
    requestFrame()
  }

  /** Shows the front (false) or the back (true). */
  fun setFlipped(flipped: Boolean) {
    engine?.setFlipped(flipped, now)
    requestFrame()
  }

  /** Back to the resting pose, front up. */
  fun reset() {
    engine?.reset()
    requestFrame()
  }

  /** The slot's rotation, independent of the interaction (radians, Euler XYZ). */
  fun setRotation(pose: CardPose) {
    engine?.setRotation(pose)
    requestFrame()
  }

  /** Orbits the camera around the card: azimuth and extra elevation (degrees), × the distance. */
  fun setCameraOrbit(azimuth: Double, elevation: Double, distance: Double = 1.0) {
    engine?.setCameraOrbit(azimuth, elevation, distance)
    requestFrame()
  }

  /** The interaction's pitch and yaw, degrees. */
  val rotation: Pair<Double, Double> get() = engine?.rotation ?: (0.0 to 0.0)

  // ── exports ──────────────────────────────────────────────────────────────

  private fun live(): Engine = engine ?: throw Card3DException.InvalidArgument("no card yet")

  /** A PNG of the card, `width` × `height` px, transparent around it. `pose`: null for the card as it is on screen; else the slot's rotation with the interaction's pose left out. */
  @JvmOverloads
  fun exportPng(width: Int, height: Int, pose: CardPose? = null): ByteArray = live().exportPng(width, height, pose)

  /** The raw pixels of a still: straight-alpha RGBA, rows top first. */
  @JvmOverloads
  fun snapshot(width: Int, height: Int, pose: CardPose? = null): ByteArray = live().snapshot(width, height, pose)

  /** The card's AR model, GLB (Scene Viewer) or USDZ; its baked maps `size` px. */
  @JvmOverloads
  fun exportAr(format: ArFormat = ArFormat.GLB, size: Int = 2048, upright: Boolean = false): ByteArray = live().exportAr(format, size, upright)

  /** [exportAr] written to a file [CardFileProvider] serves, ready for [arIntent]. */
  @JvmOverloads
  fun exportArFile(format: ArFormat = ArFormat.GLB, size: Int = 2048, upright: Boolean = false, name: String = "card"): File {
    val data = exportAr(format, size, upright)
    val dir = File(CardFileProvider.directory(appContext), UUID.randomUUID().toString()).apply { mkdirs() }
    return File(dir, "$name.${format.extension}").apply { writeBytes(data) }
  }

  /** Draws a frame now (offscreen stages; views draw on their own). */
  fun render() {
    val e = live()
    e.advance(now)
    try {
      e.render()
    } catch (x: Card3DException) {
      fail(x)
      throw x
    }
  }

  /** Frees the engine (an offscreen stage; a view's stage stops with its view). The design stays for a new one. */
  override fun close() {
    engine?.close()
    engine = null
    hasCard = false
  }

  // ── the view's side ──────────────────────────────────────────────────────

  private fun startOffscreen(width: Int, height: Int) {
    engine = Engine.make(appContext, options, quality, fit, null, width, height, reducedMotion)
    lighting?.let { engine?.setLighting(it) }
  }

  /** Starts the engine on the view's surface and builds the current design. */
  internal fun attach(view: CardView, surface: Surface, width: Int, height: Int) {
    if (this.view !== view) this.view?.let { detach(it) }
    this.view = view
    if (engine != null) return
    try {
      val e = Engine.make(appContext, options, quality, fit, surface, width, height, reducedMotion)
      engine = e
      lighting?.let { e.setLighting(it) }
      current?.let { (json, assets) ->
        val built = e.setDesign(json, assets)
        report = report?.copy(shaderErrors = built.shaderErrors)
        hasCard = true
        isFlipped = e.flipped
      }
    } catch (x: Card3DException) {
      fail(x)
    }
    changed()
  }

  /** The view's surface is going away: the engine stops; the design stays for the next surface. */
  internal fun detach(view: CardView) {
    if (this.view !== view) return
    engine?.close()
    engine = null
    hasCard = false
    this.view = null
  }

  internal fun requestFrame() {
    view?.requestFrame()
  }

  /** One frame: advance, draw. Whether to draw the next frame too, and when to wake otherwise. */
  internal fun frame(width: Int, height: Int): Pair<Boolean, Double?> {
    val e = engine ?: return false to null
    e.resize(width, height)
    val (flags, wake) = e.advance(now)
    if (flags and Native.FLIPPED_CHANGED != 0) {
      isFlipped = e.flipped
      changed()
    }
    try {
      e.render()
    } catch (x: Card3DException) {
      fail(x)
      changed()
      return false to null
    }
    return (flags and Native.ANIMATING != 0) to wake
  }

  internal fun setSystemReducedMotion(reduced: Boolean) {
    reducedMotion = reduced
    engine?.setReducedMotion(reduced)
    requestFrame()
  }

  internal fun setVisible(visible: Boolean) {
    engine?.setVisible(visible)
  }

  // Input, forwarded by the view (dp from its top left: the web's CSS px).
  internal fun pointerDown(id: Int, x: Double, y: Double, width: Double, height: Double): Boolean {
    if (!options.interactive) return false
    return engine?.pointerDown(id, x, y, width, height, now) ?: false
  }
  internal fun pointerMove(id: Int, x: Double, y: Double) = engine?.pointerMove(id, x, y, now) ?: false
  internal fun pointerUp(id: Int, x: Double, y: Double) { engine?.pointerUp(id, x, y, now) }
  internal fun pointerCancel(id: Int) { engine?.pointerCancel(id) }
  internal fun setPointer(x: Double?, y: Double?) { engine?.setPointer(x, y) }
  internal fun wheel(delta: Double) { engine?.wheel(delta) }
  internal fun doubleClick() { if (options.interactive) engine?.doubleClick() }
  internal fun key(reset: Boolean) = options.interactive && (engine?.key(reset, now) ?: false)

  companion object {
    private const val TAG = "card3d"

    /** The monotonic clock the engine runs on, ms (`System.nanoTime`, as `Choreographer`'s frame times). */
    internal val now: Double get() = System.nanoTime() / 1e6

    /** Validates a design (`ensureDesign` + `lintDesign`, as the web does) without drawing it. Any thread. Throws [Card3DException.Design] when there is nothing to draw. */
    @JvmStatic
    fun validate(json: String): DesignReport = Engine.validate(json)

    /** A stage without a view, drawing into a `width` × `height` px texture: stills and AR files. Starts the GPU now (throws [Card3DException.Gpu] without one). */
    @JvmStatic
    @JvmOverloads
    fun offscreen(
      context: Context,
      width: Int,
      height: Int,
      options: Options = Options(interactive = false, intro = false),
      assetProvider: CardAssetProvider = CardAssetProvider(),
      assetCache: AssetCache = AssetCache(context),
    ): CardStage = CardStage(context, options, assetProvider, assetCache).apply {
      offscreenSize = width to height
      startOffscreen(width, height)
    }

    /** The system's "remove animations" (animator duration scale 0, or battery saver turning animators off). */
    internal fun systemReducedMotion() = !ValueAnimator.areAnimatorsEnabled()

    /** Scene Viewer's package (Google Play Services for AR). */
    const val SCENE_VIEWER_PACKAGE = "com.google.ar.core"

    /**
     * An intent that shows a GLB in AR: Scene Viewer when it's installed, else any app that opens
     * `model/gltf-binary`. `file` must be one [exportArFile] wrote; read access is granted with it.
     * (Scene Viewer documents https URLs for `file`; a hosted copy goes through [sceneViewerIntent].)
     */
    @JvmStatic
    @JvmOverloads
    fun arIntent(context: Context, file: File, title: String? = null): Intent {
      val uri = CardFileProvider.uriFor(context, file)
      val sceneViewer = sceneViewerIntent(uri.toString(), title).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        clipData = ClipData.newRawUri(title ?: file.name, uri)
      }
      if (sceneViewer.resolveActivity(context.packageManager) != null) return sceneViewer
      return Intent(Intent.ACTION_VIEW).setDataAndType(uri, ArFormat.GLB.mimeType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    /** Scene Viewer's intent for a GLB at `url` (AR where supported, else its 3D viewer). */
    @JvmStatic
    @JvmOverloads
    fun sceneViewerIntent(url: String, title: String? = null): Intent {
      val data = Uri.parse("https://arvr.google.com/scene-viewer/1.0").buildUpon()
        .appendQueryParameter("file", url)
        .appendQueryParameter("mode", "ar_preferred")
        .apply { title?.let { appendQueryParameter("title", it) } }
        .build()
      return Intent(Intent.ACTION_VIEW).setData(data).setPackage(SCENE_VIEWER_PACKAGE)
    }
  }
}
