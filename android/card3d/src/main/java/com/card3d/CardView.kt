package com.card3d

import android.content.Context
import android.database.ContentObserver
import android.graphics.SurfaceTexture
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.AttributeSet
import android.view.Choreographer
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Surface
import android.view.TextureView
import android.view.ViewConfiguration
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The card in a view: a [TextureView] the engine draws on (transparent around the card, so it
 * composites like any view, in scrolling lists and Compose's `AndroidView` too). Drag to turn it, tap
 * to flip, double tap to reset, as on the web; with a keyboard Enter / Space flip and Escape / Home
 * reset, a mouse's hover and wheel reach the effects that follow them. TalkBack reads it as a button
 * that flips, with a Reset action.
 *
 * ```kotlin
 * val stage = CardStage(context)
 * cardView.stage = stage
 * lifecycleScope.launch { stage.setDesign(json) }
 * ```
 *
 * Frames are drawn on demand: after input, a design or a resize, then on every `Choreographer` frame
 * only while the engine reports something animating (an intro, a flip, a live face shader), and once
 * whenever it asks to be woken (an animated GIF sticker's next frame). Nothing is drawn while the view
 * is hidden or its window is in the background. Its surface going away (the view detached) stops the
 * engine; the next surface starts a new one with the same design, as does the next design after a GPU
 * failure.
 */
class CardView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = 0) :
  TextureView(context, attrs, defStyleAttr), TextureView.SurfaceTextureListener, Choreographer.FrameCallback {

  /** The stage this view shows. */
  var stage: CardStage? = null
    set(value) {
      if (field === value) return
      field?.detach(this)
      field = value
      startEngine()
      updateAccessibility()
    }

  private var surface: Surface? = null
  private var texture: SurfaceTexture? = null
  private var frameScheduled = false
  private var shown = true
  private val handler = Handler(Looper.getMainLooper())
  private val wake = Runnable { requestFrame() }
  /** Touch pointers the card took (MotionEvent pointer ids). */
  private val tracked = mutableSetOf<Int>()
  private var downTime = 0L
  private var downX = 0f
  private var downY = 0f
  private var lastTapTime = 0L
  private var lastTapX = 0f
  private var lastTapY = 0f
  private var lastFlipped: Boolean? = null

  private val motionObserver = object : ContentObserver(handler) {
    override fun onChange(selfChange: Boolean) {
      stage?.setSystemReducedMotion(CardStage.systemReducedMotion())
    }
  }

  init {
    isOpaque = false
    surfaceTextureListener = this
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  /** The scale the engine draws at: the screen's density, capped by the quality tier. */
  private val drawScale: Float
    get() = resources.displayMetrics.density.coerceAtLeast(1f).coerceAtMost(stage?.quality?.maxPixelRatio ?: 1.25f)

  /** The drawable size in px: the view's size in dp × the draw scale (the view scales it to fit). */
  private val drawableSize: Pair<Int, Int>
    get() {
      val k = drawScale / resources.displayMetrics.density
      return max(1, (width * k).roundToInt()) to max(1, (height * k).roundToInt())
    }

  internal fun layoutDrawable() {
    val (w, h) = drawableSize
    texture?.setDefaultBufferSize(w, h)
    requestFrame()
  }

  /** Starts the engine on this view's surface once it has one. */
  internal fun startEngine() {
    val s = stage ?: return
    val surf = surface ?: return
    val (w, h) = drawableSize
    texture?.setDefaultBufferSize(w, h)
    s.attach(this, surf, w, h)
    updateAccessibility()
    requestFrame()
  }

  /** The engine stopped (a GPU failure): no more frames until it starts again. */
  internal fun stopEngine() {
    Choreographer.getInstance().removeFrameCallback(this)
    frameScheduled = false
    handler.removeCallbacks(wake)
  }

  // ── the surface ──────────────────────────────────────────────────────────

  override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
    texture = st
    surface = Surface(st)
    startEngine()
  }

  override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) = layoutDrawable()

  override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
    // The engine goes before its window.
    stopEngine()
    stage?.detach(this)
    surface?.release()
    surface = null
    texture = null
    return true
  }

  override fun onSurfaceTextureUpdated(st: SurfaceTexture) = Unit

  // ── the frame loop ───────────────────────────────────────────────────────

  internal fun requestFrame() {
    if (surface == null || !shown || frameScheduled || stage?.engine == null) return
    frameScheduled = true
    Choreographer.getInstance().postFrameCallback(this)
  }

  override fun doFrame(frameTimeNanos: Long) {
    frameScheduled = false
    handler.removeCallbacks(wake)
    val s = stage ?: return
    if (surface == null || !shown) return
    val (w, h) = drawableSize
    val (animating, wakeMs) = s.frame(w, h)
    updateAccessibility()
    if (animating) {
      requestFrame()
    } else if (wakeMs != null) {
      handler.postDelayed(wake, max(1L, wakeMs.toLong()))
    }
  }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    if (isVisible == shown) return
    shown = isVisible
    stage?.setVisible(isVisible)
    if (isVisible) {
      requestFrame()
    } else {
      stopEngine()
      cancelPointers()
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    context.contentResolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, motionObserver)
    stage?.let { if (it.reducedMotion != CardStage.systemReducedMotion()) it.setSystemReducedMotion(CardStage.systemReducedMotion()) }
  }

  override fun onDetachedFromWindow() {
    context.contentResolver.unregisterContentObserver(motionObserver)
    stopEngine()
    cancelPointers()
    super.onDetachedFromWindow()
  }

  // ── input (the web stage's pointer events, in dp: the web's CSS px) ──────

  override fun onTouchEvent(e: MotionEvent): Boolean {
    val s = stage ?: return super.onTouchEvent(e)
    if (!s.options.interactive) return super.onTouchEvent(e)
    val d = resources.displayMetrics.density.toDouble()
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
        val i = e.actionIndex
        val id = e.getPointerId(i)
        trackPointer(e.getX(i), e.getY(i))
        if (e.actionMasked == MotionEvent.ACTION_DOWN) {
          downTime = e.eventTime
          downX = e.x
          downY = e.y
        }
        if (s.pointerDown(id + 1, e.getX(i) / d, e.getY(i) / d, width / d, height / d)) {
          tracked += id
          // A drag on the card turns it: the scrolling parent doesn't take it.
          parent?.requestDisallowInterceptTouchEvent(true)
          requestFrame()
        }
        return e.actionMasked != MotionEvent.ACTION_DOWN || tracked.isNotEmpty() || s.hasCard
      }
      MotionEvent.ACTION_MOVE -> {
        trackPointer(e.x, e.y)
        var draw = false
        for (i in 0 until e.pointerCount) {
          val id = e.getPointerId(i)
          if (id in tracked && s.pointerMove(id + 1, e.getX(i) / d, e.getY(i) / d)) draw = true
        }
        if (draw) requestFrame()
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
        val i = e.actionIndex
        val id = e.getPointerId(i)
        if (tracked.remove(id)) {
          s.pointerUp(id + 1, e.getX(i) / d, e.getY(i) / d)
          requestFrame()
        }
        if (e.actionMasked == MotionEvent.ACTION_UP) {
          doubleTap(e)
          trackPointer(null, null)
        }
      }
      MotionEvent.ACTION_CANCEL -> {
        cancelPointers()
        trackPointer(null, null)
      }
    }
    return true
  }

  /** The second tap's release: the web's `dblclick` (the taps themselves flip, as clicks do there). */
  private fun doubleTap(e: MotionEvent) {
    val config = ViewConfiguration.get(context)
    val tap = e.eventTime - downTime <= ViewConfiguration.getTapTimeout() + ViewConfiguration.getLongPressTimeout() &&
      hypot(e.x - downX, e.y - downY) <= config.scaledTouchSlop
    if (!tap) {
      lastTapTime = 0
      return
    }
    val near = hypot(e.x - lastTapX, e.y - lastTapY) <= config.scaledDoubleTapSlop
    if (lastTapTime != 0L && e.eventTime - lastTapTime <= ViewConfiguration.getDoubleTapTimeout() && near) {
      stage?.doubleClick()
      requestFrame()
      lastTapTime = 0
    } else {
      lastTapTime = e.eventTime
      lastTapX = e.x
      lastTapY = e.y
    }
  }

  private fun cancelPointers() {
    for (id in tracked) stage?.pointerCancel(id + 1)
    tracked.clear()
  }

  /** Effects that follow the pointer (live liquid metal) get its position; they keep drawing by themselves. */
  private fun trackPointer(x: Float?, y: Float?) {
    val s = stage ?: return
    if (x == null || y == null || width <= 0 || height <= 0) return s.setPointer(null, null)
    s.setPointer(x / width * 2.0 - 1, -(y / height) * 2.0 + 1)
  }

  override fun onGenericMotionEvent(e: MotionEvent): Boolean {
    val s = stage ?: return super.onGenericMotionEvent(e)
    when (e.actionMasked) {
      MotionEvent.ACTION_HOVER_ENTER, MotionEvent.ACTION_HOVER_MOVE -> trackPointer(e.x, e.y)
      MotionEvent.ACTION_HOVER_EXIT -> trackPointer(null, null)
      MotionEvent.ACTION_SCROLL -> {
        // A wheel notch in dp, as a browser's wheel delta in CSS px.
        val step = ViewConfiguration.get(context).scaledVerticalScrollFactor / resources.displayMetrics.density
        val (dx, dy) = e.getAxisValue(MotionEvent.AXIS_HSCROLL) to e.getAxisValue(MotionEvent.AXIS_VSCROLL)
        s.wheel(-(if (kotlin.math.abs(dx) > kotlin.math.abs(dy)) dx else dy) * step.toDouble())
        requestFrame()
        return true
      }
      else -> return super.onGenericMotionEvent(e)
    }
    return true
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    val reset = keyCode == KeyEvent.KEYCODE_ESCAPE || keyCode == KeyEvent.KEYCODE_MOVE_HOME
    val flip = keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER || keyCode == KeyEvent.KEYCODE_SPACE || keyCode == KeyEvent.KEYCODE_DPAD_CENTER
    if ((reset || flip) && stage?.key(reset) == true) {
      requestFrame()
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  // ── accessibility ────────────────────────────────────────────────────────

  private fun updateAccessibility() {
    val flipped = stage?.isFlipped ?: false
    if (flipped == lastFlipped) return
    lastFlipped = flipped
    val state = if (flipped) "showing the back" else "showing the front"
    contentDescription = stage?.options?.label ?: "Card"
    if (Build.VERSION.SDK_INT >= 30) stateDescription = state else contentDescription = "$contentDescription, $state"
  }

  override fun getAccessibilityClassName(): CharSequence = if (stage?.options?.interactive == true) Button::class.java.name else super.getAccessibilityClassName()

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    if (stage?.options?.interactive != true) return
    info.isClickable = true
    info.addAction(AccessibilityNodeInfo.AccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, "Flip"))
    info.addAction(AccessibilityNodeInfo.AccessibilityAction(R.id.card3d_action_reset, "Reset"))
  }

  override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
    val s = stage
    if (s != null && s.options.interactive) {
      when (action) {
        AccessibilityNodeInfo.ACTION_CLICK -> {
          s.flip()
          return true
        }
        R.id.card3d_action_reset -> {
          s.reset()
          return true
        }
      }
    }
    return super.performAccessibilityAction(action, arguments)
  }
}
