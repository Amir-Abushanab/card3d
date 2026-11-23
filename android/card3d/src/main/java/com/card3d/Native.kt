package com.card3d

import android.view.Surface

/**
 * The engine's JNI methods (`libcard3d.so`, crates/card3d-ffi/src/android.rs): the C ABI
 * (`include/card3d.h`) with a stage as a `long` handle. Failures throw [Card3DException]s. A stage is
 * used on the thread that made it.
 */
internal object Native {
  init {
    System.loadLibrary("card3d")
  }

  /** `card3d.h`'s `CARD3D_ABI_VERSION`. */
  const val ABI_VERSION = 1
  const val ANIMATING = 1
  const val ROTATION_CHANGED = 2
  const val FLIPPED_CHANGED = 4

  @JvmStatic external fun abiVersion(): Int
  @JvmStatic external fun validate(json: String): String

  /** `surface` null: an offscreen texture. */
  @JvmStatic external fun newStage(
    quality: Int, fit: Int, interactive: Boolean, intro: Boolean, reducedMotion: Boolean,
    rotationX: Double, rotationY: Double, environments: String?, surface: Surface?, width: Int, height: Int,
  ): Long

  @JvmStatic external fun free(stage: Long)
  @JvmStatic external fun setDesign(stage: Long, json: String, assets: String?): String
  @JvmStatic external fun resize(stage: Long, width: Int, height: Int)
  @JvmStatic external fun advance(stage: Long, nowMs: Double, wake: DoubleArray): Int
  @JvmStatic external fun render(stage: Long)
  @JvmStatic external fun setQuality(stage: Long, quality: Int)
  @JvmStatic external fun setFit(stage: Long, fit: Int)
  @JvmStatic external fun setLighting(stage: Long, id: String?)
  @JvmStatic external fun setReducedMotion(stage: Long, reduced: Boolean)
  @JvmStatic external fun setVisible(stage: Long, visible: Boolean)
  @JvmStatic external fun setRotation(stage: Long, x: Double, y: Double, z: Double)
  @JvmStatic external fun setCameraOrbit(stage: Long, azimuth: Double, elevation: Double, distance: Double)
  @JvmStatic external fun pointerDown(stage: Long, id: Int, x: Double, y: Double, width: Double, height: Double, nowMs: Double): Boolean
  @JvmStatic external fun pointerMove(stage: Long, id: Int, x: Double, y: Double, nowMs: Double): Boolean
  @JvmStatic external fun pointerUp(stage: Long, id: Int, x: Double, y: Double, nowMs: Double)
  @JvmStatic external fun pointerCancel(stage: Long, id: Int)
  @JvmStatic external fun setPointer(stage: Long, inside: Boolean, x: Double, y: Double)
  @JvmStatic external fun wheel(stage: Long, delta: Double)
  @JvmStatic external fun doubleClick(stage: Long)
  @JvmStatic external fun key(stage: Long, key: Int, nowMs: Double): Boolean
  @JvmStatic external fun toggleFlip(stage: Long, nowMs: Double)
  @JvmStatic external fun setFlipped(stage: Long, flipped: Boolean, nowMs: Double)
  @JvmStatic external fun reset(stage: Long)
  @JvmStatic external fun flipped(stage: Long): Boolean
  @JvmStatic external fun rotation(stage: Long, out: DoubleArray)
  @JvmStatic external fun exportPng(stage: Long, width: Int, height: Int, pose: DoubleArray?): ByteArray
  @JvmStatic external fun snapshot(stage: Long, width: Int, height: Int, pose: DoubleArray?): ByteArray
  @JvmStatic external fun exportAr(stage: Long, format: Int, size: Int, upright: Boolean): ByteArray
}
