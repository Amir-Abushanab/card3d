/**
 * `mountMarquee(container, opts)` on the Rust engine (crates/card3d-engine/src/marquee.rs): a
 * carousel strip of cards in one canvas — 7 recycled slots on an infinite strip, arc poses,
 * drift / drag / wheel / fling / click-to-seek-and-flip, the intro fly-in, and reduced-motion and
 * offscreen gating. No three.js.
 *
 * The engine runs the strip's motion, the slots and poses, the intro, the gestures and the drawing
 * (every card in one frame, sharing one environment and its pipelines); this module is the page side:
 * the canvas and its size and pixel ratio, the frame loop, the DOM listeners and the page-wide pointer
 * lock, the layout measurement, the design order and pins, each card's fonts and images, and the
 * `MarqueeStrip` object pages may share between instances (handed to the engine around each call).
 *
 * Not implemented (dormant in production): the focus / stand / press / reader / portal
 * state machine and field effects. Page chrome (scroll morph, headline, wordmark intro, root wheel →
 * page scroll) belongs to the host page; see apps/studio/src/showcase.
 */
import { createMarquee, type EngineMarquee, type WasmMarqueeStage } from "../../wasm/marquee.js";
import { prepareFonts } from "../engine.ts";
import type { AssetProvider, CardDesign, LightingPresetId, Quality } from "../types.ts";
import { MARQUEE, clamp, mulberry32 } from "./constants.ts";
import { shuffleMarqueeOrder, resolveMarqueePin } from "./designs.ts";
import { computeMarqueeLayout, layoutDiffers, layoutValid, type LayoutInput, type MarqueeLayout } from "./pose.ts";
import { marqueePointerLock, type IntroPhase } from "./shared.ts";
import { createMarqueeStrip, initializeMarqueePreview, publishDriftGate, seekBy, type MarqueeStrip } from "./strip.ts";

export interface MarqueeOptions {
  /** Designs in strip order (design index = logical mod length), before the optional shuffle. */
  designs: readonly CardDesign[];
  /**
   * The cards' asset provider: the name font (`nameFontFamily`) and URL resolution (`resolveUrl`).
   */
  assets: AssetProvider;
  /**
   * Shuffle the designs (Fisher–Yates). Default true. With `seed`, the order is reproducible.
   */
  shuffle?: boolean;
  seed?: number;
  /** Custom random source for the shuffle (overrides `seed`). */
  random?: () => number;
  /** Centre this design and freeze the strip, as a `?card=` link would (index, name, slug or first name). */
  pin?: number | string | null;
  /** Default: "full" for an active instance wider than 720 px, else "performance". */
  quality?: Quality;
  /**
   * The live hero (default true): frontal fill light, 1.25× supersample, intro, drift-gate publishing.
   * `false`: a secondary copy (for example a page's grid tile showing the same strip).
   */
  active?: boolean;
  /** Play the intro fly-in. Default: `active` and motion allowed. */
  intro?: boolean;
  interactive?: boolean;
  /** Animate (drift/time). Default true; forced off by reduced motion, hidden document or offscreen. */
  animate?: boolean;
  /** Override prefers-reduced-motion. */
  reducedMotion?: boolean;
  /** Pause when the container leaves the viewport (IntersectionObserver, rootMargin 200 px). Default true. */
  pauseOffscreen?: boolean;
  /** Fixed device-pixel ratio (else the default rules). */
  pixelRatio?: number;
  /** Fixed layout, or a function of the measured size. Default: measured from the element. */
  layout?: MarqueeLayout | ((input: LayoutInput) => MarqueeLayout);
  /** Band the centre card must fit in (container px), e.g. below a nav and above a headline. */
  layoutBand?: () => { top: number; bottom: number } | null;
  /** Share a strip between instances (hero + tile copy). Default: a fresh strip. */
  strip?: MarqueeStrip;
  /** Element scrolled by vertical mouse drags . Default: document.scrollingElement. */
  scrollElement?: () => Element | null;
  /** Also scroll manually for touch (fixed hero). Default false: touch relies on native pan-y. */
  manualTouchScroll?: boolean;
  /** Kept for compatibility: the engine's canvas can always be read back right after `render()`. */
  preserveDrawingBuffer?: boolean;
  /** Lighting / backdrop preset (`LIGHTING_PRESETS`) on top of the marquee rig. Default "studio" (unchanged). */
  lighting?: LightingPresetId;
  /** Pick the engine's build ("webgpu" or "webgl") instead of the loader's choice. */
  backend?: "webgpu" | "webgl";
  onIntroPhase?(phase: IntroPhase): void;
  /** First card mounted. */
  onReady?(): void;
  onLayout?(layout: MarqueeLayout): void;
  /** The engine moved to its WebGL build (on a fresh canvas, now `handle.canvas`). */
  onFallback?(why: string): void;
}

export interface MarqueeSlotInfo {
  e: number;
  logical: number;
  design: number;
  a: number;
  ready: boolean;
}

export interface MarqueeHandle {
  /** The canvas drawn on (a fall-over to WebGL swaps it). */
  readonly canvas: HTMLCanvasElement;
  /** "webgpu" or "webgl" once the engine started, else null. */
  readonly backend: "webgpu" | "webgl" | null;
  readonly strip: MarqueeStrip;
  /** Final strip order (after shuffle). */
  readonly designs: readonly CardDesign[];
  readonly introPhase: IntroPhase;
  readonly layout: MarqueeLayout;
  slots(): MarqueeSlotInfo[];
  /** Resolves once the engine started and every slot's current design is built. */
  ready(): Promise<void>;
  /** Centre a design and freeze (null: resume). Returns the design index, or −1. */
  pin(key: number | string | null): number;
  /** Seek a design to the centre (like a click without the flip). */
  seekTo(designIndex: number): void;
  setAnimate(on: boolean): void;
  setInteractive(on: boolean): void;
  /** Drop the 1.25× supersample while a scroll morph is scrubbing. */
  setMorphing(on: boolean): void;
  /** Fixed layout (null = measure again). */
  setLayout(layout: MarqueeLayout | null): void;
  setQuality(q: Quality): void;
  /** Switch the lighting / backdrop preset (rebuilds the environment). */
  setLighting(id: LightingPresetId): void;
  /** Synchronous frame at the current strip state (no drift advance). `only` isolates one slot. */
  render(opts?: { only?: number }): void;
  invalidate(): void;
  dispose(): void;
}

const PHASES: readonly IntroPhase[] = ["arrive", "settle", "done"];

/** The engine marquee's operations (`card3d_engine::marquee::op`). */
const OP = {
  SET_DESIGNS: 0,
  SET_STRIP: 1,
  STRIP: 2,
  SET_GATES: 3,
  SET_LAYOUT: 4,
  STEP: 5,
  TAKE_BUILDS: 6,
  INTRO_PHASE: 7,
  FORCE_INTRO_DONE: 8,
  SLOTS: 9,
  PICK: 10,
  BEGIN_DRAG: 11,
  DRAG_MOVE: 12,
  END_DRAG: 15,
  WHEEL: 16,
  SET_QUALITY: 17,
} as const;

/** `MarqueeStage.call` with numbers (booleans as 0 / 1). */
const call = (s: WasmMarqueeStage, op: number, ...args: (number | boolean)[]): Float64Array => s.call(op, Float64Array.from(args, Number));

/** The strip as the engine reads it (`marquee_model::Strip::to_array`). */
function packStrip(s: MarqueeStrip): Float64Array {
  const k = s.seek;
  return Float64Array.of(
    s.offset,
    s.time,
    s.scrubVelocity,
    s.driftVel,
    s.driftPausedUntil,
    +s.dragActive,
    +s.scrubbing,
    s.lastAdvance,
    +k.active,
    k.from,
    k.delta,
    k.startMs,
    k.durationMs,
    +s.focusHeld,
    +s.previewPaused,
    s.driftGate,
  );
}

function unpackStrip(v: ArrayLike<number>, s: MarqueeStrip): void {
  if (v.length < 16) return;
  s.offset = v[0]!;
  s.time = v[1]!;
  s.scrubVelocity = v[2]!;
  s.driftVel = v[3]!;
  s.driftPausedUntil = v[4]!;
  s.dragActive = v[5] !== 0;
  s.scrubbing = v[6] !== 0;
  s.lastAdvance = v[7]!;
  s.seek = { active: v[8] !== 0, from: v[9]!, delta: v[10]!, startMs: v[11]!, durationMs: v[12]! };
  s.focusHeld = v[13] !== 0;
  s.previewPaused = v[14] !== 0;
  s.driftGate = v[15]!;
}

const mq = (q: string) => (typeof matchMedia === "function" ? matchMedia(q) : null);

export function mountMarquee(container: HTMLElement, opts: MarqueeOptions): MarqueeHandle {
  const active = opts.active ?? true;
  const strip = opts.strip ?? createMarqueeStrip();
  const reducedMq = mq("(prefers-reduced-motion: reduce)");
  const coarseMq = mq("(pointer: coarse)");
  const reduced = () => opts.reducedMotion ?? reducedMq?.matches ?? false;

  // ── designs ───────────────────────────────────────────────────────────────
  const random = opts.random ?? (opts.seed !== undefined ? mulberry32(opts.seed) : Math.random);
  const designs: CardDesign[] = opts.shuffle === false ? opts.designs.slice() : shuffleMarqueeOrder(opts.designs, random);

  // ── DOM ───────────────────────────────────────────────────────────────────
  if (typeof getComputedStyle === "function" && getComputedStyle(container).position === "static") container.style.position = "relative";
  let canvas = document.createElement("canvas");
  canvas.className = "card-marquee__canvas";
  Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block", pointerEvents: "auto" });
  canvas.style.setProperty("touch-action", "var(--marquee-touch-action, pan-y pinch-zoom)");
  container.appendChild(canvas);

  const cssSize = () => ({ w: container.clientWidth || 1, h: container.clientHeight || 1 });
  const isMobile = () => cssSize().w <= MARQUEE.MOBILE_BREAKPOINT_PX;
  const autoQuality = (): Quality => (active && !isMobile() ? "full" : "performance");
  let quality: Quality = opts.quality ?? autoQuality();
  let lighting: string = opts.lighting ?? "studio";
  let morphing = false;
  const pixelRatio = () => {
    if (opts.pixelRatio !== undefined) return opts.pixelRatio;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    if (!active) return clamp(dpr, 1, 1.25);
    return isMobile() || morphing ? Math.min(dpr, 2) : Math.min(1.25 * dpr, 2);
  };

  // ── state ─────────────────────────────────────────────────────────────────
  let disposed = false;
  let userAnimate = opts.animate ?? true;
  let userInteractive = opts.interactive ?? true;
  let docVisible = typeof document === "undefined" || document.visibilityState !== "hidden";
  let onscreen = true;
  const motionAllowed = () => !reduced();
  const animating = () => userAnimate && motionAllowed() && docVisible && onscreen;
  const interactive = () => userInteractive && docVisible && onscreen;

  const playIntro = (opts.intro ?? active) && motionAllowed() && userAnimate;
  let introPhase: IntroPhase = playIntro ? "arrive" : "done";
  let anyMounted = false;
  const setIntroPhase = (p: IntroPhase) => {
    if (introPhase === p) return;
    introPhase = p;
    container.dataset.intro = p;
    opts.onIntroPhase?.(p);
  };
  container.dataset.intro = introPhase;
  if (active) publishDriftGate(strip, playIntro ? 0 : 1);

  // pin
  const pinIndex = resolveMarqueePin(designs, opts.pin);
  if (pinIndex >= 0) initializeMarqueePreview(strip, pinIndex);

  // ── layout ────────────────────────────────────────────────────────────────
  let fixedLayout: MarqueeLayout | null = opts.layout && typeof opts.layout === "object" ? { ...opts.layout } : null;
  let layout: MarqueeLayout = fixedLayout ?? computeLayout();
  function computeLayout(): MarqueeLayout {
    const { w, h } = cssSize();
    const input: LayoutInput = { width: w, height: h, band: opts.layoutBand?.() ?? null, previewPaused: strip.previewPaused };
    return typeof opts.layout === "function" ? opts.layout(input) : computeMarqueeLayout(input);
  }
  const relayout = () => {
    const next = fixedLayout ?? computeLayout();
    if (layoutValid(next) && layoutDiffers(next, layout)) {
      layout = next;
      opts.onLayout?.(layout);
    }
  };

  // ── the engine ────────────────────────────────────────────────────────────
  let engine: EngineMarquee | null = null;
  /** Replays the page's state into a (new) stage: designs, lighting, quality, a finished intro. */
  const replay = (s: WasmMarqueeStage, restarted: boolean) => {
    call(s, OP.SET_DESIGNS, designs.length);
    if (restarted) {
      s.setLighting(lighting);
      call(s, OP.SET_QUALITY, quality === "full");
      call(s, OP.FORCE_INTRO_DONE);
    }
    sizeKey = "";
  };
  const started: Promise<EngineMarquee | null> = createMarquee(canvas, {
    force: opts.backend,
    resolveUrl: (src) => opts.assets.resolveUrl(src),
    // The provider's name font.
    assets: { nameFontFamily: opts.assets.nameFontFamily },
    stage: { active, quality, lighting, intro: introPhase !== "done", reducedMotion: reduced() },
    onCanvas: (next) => {
      moveListeners(canvas, next);
      canvas = next;
    },
    onRestart: (s) => {
      generation++;
      replay(s, true);
      invalidate();
    },
    onFallback: (why) => opts.onFallback?.(why),
    onContextLost: () => invalidate(),
  }).then(
    (m) => {
      if (disposed) {
        m.dispose();
        return null;
      }
      engine = m;
      canvas = m.canvas;
      if (m.stage) replay(m.stage, false);
      // The intro may have been ended while the engine started (hidden, off screen, animation off).
      if (introPhase === "done" && m.stage) call(m.stage, OP.FORCE_INTRO_DONE);
      invalidate();
      return m;
    },
    (err) => {
      console.error("[card3d] marquee: the card engine failed to start", err);
      return null;
    },
  );

  /** Runs `f` on the engine with the page's strip and gates handed over and the strip read back. */
  const withStage = <T>(f: (s: WasmMarqueeStage) => T, fallback: T): T => {
    if (!engine) return fallback;
    return engine.guard((s) => {
      s.call(OP.SET_STRIP, packStrip(strip));
      call(s, OP.SET_GATES, animating(), interactive());
      const out = f(s);
      unpackStrip(call(s, OP.STRIP), strip);
      return out;
    }, fallback);
  };

  // ── cards ─────────────────────────────────────────────────────────────────
  /** The newest build per slot, and the stage generation (a fall-over or restored context starts a new stage). */
  const tokens = new Map<number, number>();
  let generation = 0;
  const pending = new Map<number, Promise<void>>();
  const startBuilds = (s: WasmMarqueeStage) => {
    const b = call(s, OP.TAKE_BUILDS);
    for (let i = 0; i + 2 < b.length; i += 3) {
      const [slot, index, token] = [b[i]!, b[i + 1]!, b[i + 2]!];
      tokens.set(slot, token);
      const design = designs[index];
      if (!design) continue;
      const m = engine;
      const gen = generation;
      const job = (async () => {
        try {
          const fontFamily = await prepareFonts(design, opts.assets);
          if (tokens.get(slot) !== token || gen !== generation || disposed || !m || m !== engine) return;
          if (await m.buildSlot(slot, token, JSON.stringify(design), { fontFamily })) {
            if (!anyMounted) {
              anyMounted = true;
              opts.onReady?.();
            }
            invalidate();
          }
        } catch (err) {
          console.error(`[card3d] marquee: building "${design.cardholderName}" failed`, err);
        }
      })();
      pending.set(slot, job);
    }
  };

  // ── size ──────────────────────────────────────────────────────────────────
  let sizeKey = "";
  let aspect = 1;
  function resize(): void {
    const { w, h } = cssSize();
    const pr = pixelRatio();
    const key = `${w}x${h}@${pr}`;
    if (key === sizeKey) return;
    sizeKey = key;
    // As three's `setSize(w, h, false)` at the pixel ratio.
    const cw = Math.max(1, Math.floor(w * pr));
    const ch = Math.max(1, Math.floor(h * pr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    engine?.guard((s) => s.resize(cw, ch), undefined);
    aspect = w / h;
    relayout();
    if (opts.quality === undefined) {
      const q = autoQuality();
      if (q !== quality) setQuality(q);
    }
    container.dataset.mobile = String(isMobile());
  }

  function setQuality(q: Quality): void {
    if (q === quality || disposed) return;
    quality = q;
    engine?.guard((s) => call(s, OP.SET_QUALITY, q === "full"), undefined);
    invalidate();
  }

  // ── frame ─────────────────────────────────────────────────────────────────
  let raf = 0;
  let tweening = false;

  function step(now: number, advance: boolean, only?: number): void {
    resize();
    const flags = withStage((s) => {
      call(s, OP.SET_LAYOUT, layout.rowYFrac, layout.xFrac, layout.centerHeightFrac, layout.cardSpacing);
      const f = call(s, OP.STEP, now, advance, aspect, only ?? -1)[0] ?? 0;
      if (f & 2) setIntroPhase(PHASES[call(s, OP.INTRO_PHASE)[0] ?? 2] ?? "done");
      if (f & 4) startBuilds(s);
      return f;
    }, 0);
    tweening = (flags & 1) !== 0;
    engine?.render();
  }

  const needsLoop = () => animating() || tweening || drag.active;
  function loop(): void {
    raf = 0;
    if (disposed) return;
    step(performance.now(), true);
    if (needsLoop() && !raf) raf = requestAnimationFrame(loop);
  }
  function invalidate(): void {
    if (!raf && !disposed) raf = requestAnimationFrame(loop);
  }

  // ── pointer ──────────────────────────────────────────────────
  const drag = { active: false, id: -1, pointerType: "mouse" };
  const owner = {};

  const setScrubCursor = (on: boolean) => {
    document.body.classList.toggle("card-marquee-scrubbing", on);
    canvas.style.cursor = on ? "grabbing" : "";
  };

  function onPointerDown(e: PointerEvent): void {
    if (!interactive() || drag.active || !engine) return;
    const r = canvas.getBoundingClientRect();
    const logical = withStage((s) => call(s, OP.PICK, e.clientX - r.left, e.clientY - r.top, r.width || 1, r.height || 1)[0] ?? Number.NaN, Number.NaN);
    if (Number.isNaN(logical) && !(e.button === 0 || e.pointerType !== "mouse")) return;
    if (!marqueePointerLock.claim(owner, e.pointerId)) return;
    const now = performance.now();
    withStage((s) => call(s, OP.BEGIN_DRAG, e.pointerId, logical, e.pointerType === "touch", coarseMq?.matches ?? false, e.clientX, e.clientY, now), undefined);
    Object.assign(drag, { active: true, id: e.pointerId, pointerType: e.pointerType });
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    invalidate();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag.active || e.pointerId !== drag.id) return;
    const now = performance.now();
    const [dy = Number.NaN, scrubbing = 0] = withStage((s) => call(s, OP.DRAG_MOVE, e.pointerId, e.clientX, e.clientY, now), new Float64Array(0));
    if (scrubbing === 1) setScrubCursor(true);
    if (!Number.isNaN(dy) && (drag.pointerType !== "touch" || opts.manualTouchScroll)) {
      const scroller = opts.scrollElement?.() ?? document.scrollingElement;
      if (scroller) scroller.scrollTop -= dy;
    }
    invalidate();
  }

  function finishDrag(e: PointerEvent | null, cancelled: boolean): void {
    if (!drag.active || (e && e.pointerId !== drag.id)) return;
    const id = drag.id;
    const mine = marqueePointerLock.release(owner, id);
    drag.active = false;
    setScrubCursor(false);
    try {
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    } catch {
      /* ignore */
    }
    withStage((s) => call(s, OP.END_DRAG, mine, cancelled, performance.now()), undefined);
    invalidate();
  }

  function onWheel(e: WheelEvent): void {
    if (!interactive() || marqueePointerLock.held() || e.ctrlKey) return;
    const kx = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientWidth : 1;
    const ky = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
    if (withStage((s) => call(s, OP.WHEEL, e.deltaX * kx, e.deltaY * ky, performance.now())[0] === 1, false)) {
      e.preventDefault();
      invalidate();
    }
  }

  const onUp = (e: PointerEvent) => finishDrag(e, false);
  const onCancel = (e: PointerEvent) => finishDrag(e, true);
  const onLost = (e: PointerEvent) => finishDrag(e, true);
  const onBlur = () => finishDrag(null, true);
  const onVisibility = () => {
    docVisible = document.visibilityState !== "hidden";
    if (!docVisible) {
      finishDrag(null, true);
      forceIntroDone();
    }
    invalidate();
  };
  function forceIntroDone(): void {
    if (introPhase === "done") return;
    setIntroPhase("done");
    if (active) publishDriftGate(strip, 1);
    withStage((s) => call(s, OP.FORCE_INTRO_DONE), undefined);
  }
  const listen = (c: HTMLCanvasElement) => {
    c.addEventListener("pointerdown", onPointerDown);
    c.addEventListener("lostpointercapture", onLost);
    c.addEventListener("wheel", onWheel, { passive: false });
  };
  const unlisten = (c: HTMLCanvasElement) => {
    c.removeEventListener("pointerdown", onPointerDown);
    c.removeEventListener("lostpointercapture", onLost);
    c.removeEventListener("wheel", onWheel);
  };
  function moveListeners(from: HTMLCanvasElement, to: HTMLCanvasElement): void {
    unlisten(from);
    listen(to);
    sizeKey = "";
  }
  listen(canvas);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);
  const onReducedChange = () => {
    if (reduced()) forceIntroDone();
    invalidate();
  };
  reducedMq?.addEventListener?.("change", onReducedChange);

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => invalidate()) : null;
  ro?.observe(container);
  const onWindowResize = () => invalidate();
  window.addEventListener("resize", onWindowResize);
  let io: IntersectionObserver | null = null;
  if ((opts.pauseOffscreen ?? true) && typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver(
      (entries) => {
        const was = onscreen;
        onscreen = entries.some((en) => en.isIntersecting);
        if (!onscreen) {
          finishDrag(null, true);
          forceIntroDone();
        }
        if (onscreen !== was) invalidate();
      },
      { rootMargin: "200px" },
    );
    io.observe(container);
  }

  invalidate();

  const N = designs.length;
  return {
    get canvas() {
      return canvas;
    },
    get backend() {
      return engine?.backend ?? null;
    },
    strip,
    designs,
    get introPhase() {
      return introPhase;
    },
    get layout() {
      return layout;
    },
    slots() {
      const v = withStage((s) => call(s, OP.SLOTS), new Float64Array(0));
      const out: MarqueeSlotInfo[] = [];
      for (let i = 0; i + 4 < v.length; i += 5) out.push({ e: v[i]!, logical: v[i + 1]!, design: v[i + 2]!, a: v[i + 3]!, ready: v[i + 4] === 1 });
      return out;
    },
    async ready() {
      await started;
      for (;;) {
        if (disposed || !engine) return;
        // Sync the slots (without advancing the strip): every slot's current design is asked for.
        withStage((s) => {
          call(s, OP.STEP, performance.now(), false, aspect, -1);
          startBuilds(s);
        }, undefined);
        const before = [...pending.values()];
        await Promise.all(before);
        const after = [...pending.values()];
        if (disposed || (after.length === before.length && after.every((p, i) => p === before[i]))) return;
      }
    },
    pin(key) {
      if (key === null) {
        strip.previewPaused = false;
        invalidate();
        return -1;
      }
      const i = resolveMarqueePin(designs, key);
      if (i >= 0) {
        initializeMarqueePreview(strip, i);
        relayout();
        invalidate();
      }
      return i;
    },
    seekTo(designIndex) {
      if (!N) return;
      // nearest logical index showing this design
      const base = Math.round((strip.offset - designIndex) / N) * N + designIndex;
      const d = base - strip.offset;
      if (animating()) seekBy(strip, d, performance.now());
      else strip.offset += d;
      invalidate();
    },
    setAnimate(on) {
      userAnimate = on;
      if (!on) forceIntroDone();
      invalidate();
    },
    setInteractive(on) {
      userInteractive = on;
      if (!on) finishDrag(null, true);
    },
    setLighting(id) {
      if (id === lighting || disposed) return;
      lighting = id;
      engine?.guard((s) => s.setLighting(id), undefined);
      invalidate();
    },
    setMorphing(on) {
      if (morphing === on) return;
      morphing = on;
      invalidate();
    },
    setLayout(l) {
      fixedLayout = l ? { ...l } : null;
      relayout();
      invalidate();
    },
    setQuality,
    render(o) {
      if (disposed) return;
      step(performance.now(), false, o?.only);
    },
    invalidate,
    dispose() {
      if (disposed) return;
      finishDrag(null, true);
      disposed = true;
      cancelAnimationFrame(raf);
      unlisten(canvas);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onWindowResize);
      document.removeEventListener("visibilitychange", onVisibility);
      reducedMq?.removeEventListener?.("change", onReducedChange);
      ro?.disconnect();
      io?.disconnect();
      if (active) publishDriftGate(strip, 1);
      const m = engine;
      engine = null;
      if (m) {
        const webgl = m.backend === "webgl" ? m.canvas : null;
        m.dispose();
        webgl?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
      }
      canvas.remove();
      delete container.dataset.intro;
      delete container.dataset.mobile;
    },
  };
}
