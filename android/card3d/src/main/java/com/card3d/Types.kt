package com.card3d

import org.json.JSONArray
import org.json.JSONObject

/** The rendering tier (`Quality` in the engine): surface map size, environment resolution and the pixel-ratio ceiling. */
enum class CardQuality(internal val code: Int, /** The largest pixel ratio the tier draws at. */ val maxPixelRatio: Float) {
  /** Phones and embeds (the default): 256 px surface maps, pixel ratio up to 1.25. */
  PERFORMANCE(0, 1.25f),

  /** Desktop: 512 px surface maps, pixel ratio up to 2. */
  FULL(1, 2f),
}

/** How the card is framed. */
enum class CardFit(internal val code: Int) {
  /** The fixed studio camera, with room for a full turn. */
  STUDIO(0),

  /** The card fills the view with a margin; the camera backs off as it turns. */
  CONTAIN(1),
}

/** The slot's rotation for a still (radians, Euler XYZ), the interaction's pose left out. */
data class CardPose(val x: Double = 0.0, val y: Double = 0.0, val z: Double = 0.0) {
  internal fun toArray() = doubleArrayOf(x, y, z)

  companion object {
    /** The comparison harness's parity poses. */
    @JvmField val FRONT = CardPose()
    @JvmField val TILT = CardPose(-0.22, 0.38, 0.04)
    @JvmField val BACK = CardPose(y = Math.PI)
    @JvmField val EDGE = CardPose(0.1, 1.25)
  }
}

/** An AR model's file format. */
enum class ArFormat(internal val code: Int, val extension: String, val mimeType: String) {
  /** glTF binary: Scene Viewer, model viewers, Blender. */
  GLB(0, "glb", "model/gltf-binary"),

  /** USDZ (AR Quick Look on Apple devices). */
  USDZ(1, "usdz", "model/vnd.usdz+zip"),
}

/** One validation finding: where (`recipe.texture`, "" for the whole design) and what. */
data class DesignIssue(val path: String, val message: String)

/** A face shader layer that didn't compile (the card still draws without it). */
data class ShaderLayerError(val index: Int, /** "front" or "back". */ val side: String, val errors: List<Line>) {
  /** `line`: in the layer's own code (0: the whole shader). */
  data class Line(val line: Int, val message: String)
}

/** What validation and `CardStage.setDesign` found: the design still draws, with the sanitizer's fixes. */
data class DesignReport(
  /** Parts that aren't what was written (unknown fields or ids, values of the wrong kind): dropped or replaced. */
  val errors: List<DesignIssue>,
  /** Clamped values and likely mistakes. */
  val warnings: List<DesignIssue>,
  /** The design's remote files (images, GIFs, a font, a model, an environment). */
  val remoteUrls: List<String>,
  /** Remote files that couldn't be downloaded (their layers are skipped, as on the web). */
  val failedDownloads: List<String> = emptyList(),
  /** Face shader layers that didn't compile (after `setDesign`). */
  val shaderErrors: List<ShaderLayerError> = emptyList(),
  /** The complete design JSON as the engine draws it (`CardStage.validate` only). */
  val designJson: String? = null,
) {
  internal companion object {
    /** The library's report: `{ design?, errors, warnings, remote, shaderErrors }`. */
    fun parse(json: String): DesignReport {
      val o = try {
        JSONObject(json)
      } catch (e: org.json.JSONException) {
        throw Card3DException.Engine("unreadable report: ${e.message}")
      }
      fun issues(a: JSONArray?) = (0 until (a?.length() ?: 0)).map { a!!.getJSONObject(it).let { i -> DesignIssue(i.optString("path"), i.optString("message")) } }
      val remote = o.optJSONArray("remote")
      val shaders = o.optJSONArray("shaderErrors")
      // The design is the report's first member (`{"design":{…},"errors":…`): cut out as text, so it
      // keeps the engine's property order and number formatting.
      val design = if (json.startsWith("{\"design\":")) json.lastIndexOf(",\"errors\":").takeIf { it > 10 }?.let { json.substring(10, it) } else null
      return DesignReport(
        errors = issues(o.optJSONArray("errors")),
        warnings = issues(o.optJSONArray("warnings")),
        remoteUrls = (0 until (remote?.length() ?: 0)).map { remote!!.getString(it) },
        shaderErrors = (0 until (shaders?.length() ?: 0)).map {
          val s = shaders!!.getJSONObject(it)
          val lines = s.optJSONArray("errors")
          ShaderLayerError(s.optInt("index"), s.optString("side"), (0 until (lines?.length() ?: 0)).map { l -> lines!!.getJSONObject(l).let { e -> ShaderLayerError.Line(e.optInt("line"), e.optString("message")) } })
        },
        designJson = design,
      )
    }
  }
}

/**
 * What went wrong. The engine throws these through JNI (by class name: keep them, see
 * consumer-rules.pro).
 */
sealed class Card3DException(message: String) : Exception(message) {
  /** A bad argument, or no card yet. */
  class InvalidArgument(message: String) : Card3DException(message)

  /** The design couldn't be read at all: nothing to draw. */
  class Design(message: String) : Card3DException(message)

  /** No GPU, a lost device or a GPU error. The stage stopped; `CardView` starts a new one with the next design or surface. */
  class Gpu(message: String) : Card3DException(message)

  /** An export couldn't be made. */
  class Export(message: String) : Card3DException(message)

  /** The engine failed unexpectedly (caught at the library's boundary). The stage stopped. */
  class Engine(message: String) : Card3DException(message)

  /** Whether the stage stopped (a new one is needed). */
  val stoppedStage: Boolean get() = this is Gpu || this is Engine
}

/** An asset provider (`AssetProvider` on the web): its name font, for designs without a font of their own. */
data class CardAssetProvider(
  val nameFontFamily: String? = null,
)
