/**
 * The card stage on the Rust engine (crates/): `createEngineStage`. The engine
 * (WebGPU, else its WebGL 2 build; wasm/loader.js picks and falls over) draws the card, frames the
 * camera and runs the interaction; this module is the page side: the frame loop, canvas sizing and
 * pixel ratio, adaptive resolution, input listeners, accessibility attributes, fonts and pausing.
 *
 * The engine draws every design except custom face shader layers in GLSL (from the three.js engine's
 * era, which `engineDraws` reports): it skips those layers and draws the rest of the card.
 */
import { createCard, preloadEngine, type EngineCard, type EnginePrintJob, type WasmCardStage } from "../wasm/loader.js";
import { AdaptiveResolution, type AdaptiveResolutionChange } from "./scene/adaptive-resolution.ts";
import { DEFAULT_CARD_FONT, getCardFont, loadCardFont, loadDesignFont, textLineFamilies } from "./fonts.ts";
import { QUALITY_PRESETS } from "./quality.ts";
import { environmentUrl } from "./scene/marketing/environment-files.ts";
// Framing and camera paths for pages that frame the card themselves (exports).
export { cardFrameSize } from "./geometry/shape-frame.ts";
export { stagingView, type StagingView } from "./scene/staging-view.ts";
export * from "./scene/camera-paths.ts";
import type { AssetProvider, CardDesign, Quality } from "./types.ts";

export type EngineFit = "studio" | "contain";

/**
 * What the engine takes from an asset provider (`AssetProvider`): the name font and URL resolution.
 * A whole provider fits.
 */
export type EngineAssets = Pick<AssetProvider, "nameFontFamily"> & Partial<Pick<AssetProvider, "resolveUrl">>;

/** The provider's part the engine itself reads (`createCard`'s `assets`). */
const engineAssets = (a: EngineAssets) => ({ nameFontFamily: a.nameFontFamily });

export interface EngineStageOptions {
  /** Default "performance". */
  quality?: Quality;
  fit?: EngineFit;
  /** Drag / click and keyboard flip. Default true. */
  interactive?: boolean;
  /** The one-shot intro on the first card (once per page). Default = `interactive`. */
  intro?: boolean;
  /** Element that receives pointer and keyboard input and the accessibility attributes. Default: the canvas. */
  element?: HTMLElement;
  /** Accessible name (`aria-label`, followed by "; showing front|back"). */
  label?: string;
  fitToViewport?: boolean;
  /** Degrees. */
  defaultRotation?: { x: number; y: number };
  /** Fixed device-pixel ratio; otherwise the device's, clamped to the quality tier's range. */
  pixelRatio?: number;
  /**
   * Schedule frames itself. Default true. False for capture: nothing draws until `render()`.
   */
  autoRender?: boolean;
  /** Lower the pixel ratio while frames run over budget (rAF intervals). */
  adaptiveResolution?: boolean | { frameBudgetMs?: number; minPixelRatio?: number; step?: number };
  /** Pick a build ("webgpu" or "webgl") instead of the loader's choice. */
  backend?: "webgpu" | "webgl";
  /**
   * The asset provider (a whole `AssetProvider` fits): its name font for designs without their own
   * (default: the catalog's Inter) and URL resolution.
   */
  assets?: EngineAssets;
  /** Resolves a design's `src`s (default: the provider's `resolveUrl`, else as given). */
  resolveUrl?(src: string): string;
  onRotationChange?(rot: { x: number; y: number }): void;
  onFlippedChange?(flipped: boolean): void;
  /** The pixel ratio changed (adaptive resolution); `frameMs`: the median frame interval that lowered or raised it. */
  onPixelRatioChange?(change: { ratio: number; previous: number; full: number; reason: "down" | "up" | "reset"; frameMs?: number }): void;
  /** The engine moved to its WebGL build on a fresh canvas (now `stage.canvas`). */
  onCanvas?(canvas: HTMLCanvasElement): void;
  onFallback?(why: string): void;
  /** The WebGL build lost its context (GPU reset, too many contexts); drawing stops until it is restored. */
  onContextLost?(): void;
  /** The context came back and the card was rebuilt, in the same pose. */
  onContextRestored?(): void;
}

/** What an AR export makes (`EngineStage.exportAr`, `OffscreenStage.exportAr`). */
export interface ArExportOptions {
  /** "glb" (Scene Viewer, glTF viewers) or "usdz" (AR Quick Look). */
  format: "glb" | "usdz";
  /** Longest side of each baked map, px. Default 2048. */
  size?: number;
  /** Stand the card upright instead of lying face up. Default false. */
  upright?: boolean;
}

/**
 * The AR model of `design` on `card`'s GPU (the engine's `ar` part, crates/card3d-engine/src/ar.rs;
 * the page side, wasm/ar.js, loads on first use): the card baked into a real-scale model (ISO ID-1,
 * metres, Y up, lying face up), as GLB or USDZ.
 */
async function exportAr(card: EngineCard, design: CardDesign, fontFamily: string | undefined, o: ArExportOptions): Promise<Uint8Array> {
  const { arModel } = await import("../wasm/ar.js");
  return arModel(card, JSON.stringify(design), { fontFamily, format: o.format, size: o.size, upright: o.upright });
}

export interface EngineInteraction {
  /** Degrees. */
  readonly rot: { x: number; y: number };
  readonly flipped: boolean;
  /** Turns the card to `rot` (degrees) without events; a flip in progress goes on. */
  setRotation(rot: { x: number; y: number }): void;
  toggleFlip(): void;
  setFlipped(flipped: boolean): void;
  reset(): void;
  setActive(active: boolean): void;
  /** Puts the card at a pose at once (degrees), without events (a parked card resuming). */
  restore(rot: { x: number; y: number }, flipped: boolean): void;
  /** The accessible name (followed by "; showing front|back"). */
  setLabel(label: string): void;
}

/** A face shader error: a line of the layer's own code (0: not tied to a line) and the message. */
export interface EngineShaderError {
  line: number;
  message: string;
}

/**
 * Where the card and the camera are for the current canvas (`EngineStage.view`), for pages that draw
 * over the card (Card Studio's sticker handles). Matrices are column-major (`m[col * 4 + row]`).
 */
export interface EngineView {
  /** The card's world transform: the slot (rotation, lift) times the interaction's pose. */
  model: Float64Array;
  /** The camera's view matrix (world → camera; the camera looks down its −z). */
  view: Float64Array;
  /** The camera's position, world space. */
  eye: [number, number, number];
  /** Vertical field of view, degrees. */
  fov: number;
  /** The canvas's width / height. */
  aspect: number;
  /** The interaction's pose alone (without the slot), as a unit quaternion. */
  quaternion: { x: number; y: number; z: number; w: number };
}

/**
 * A sticker shown where the page puts it, without rebuilding the card (`EngineStage.setSticker`): its
 * quad's centre and size in the card's plane (card units), its rotation (degrees, clockwise on its face)
 * and its picture edits.
 */
export interface EngineStickerPose {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  crop?: { x: number; y: number; w: number; h: number };
  flip?: { h?: boolean; v?: boolean };
  opacity?: number;
  /** Tint colour (0..1 each) and amount. */
  tint?: { rgb: [number, number, number]; amount: number };
  adjust?: { brightness?: number; contrast?: number; saturation?: number };
}

export interface EngineStage {
  /** "webgpu" or "webgl" once the first design started the engine, else null. */
  readonly backend: "webgpu" | "webgl" | null;
  /** The canvas drawn on (a fall-over to WebGL swaps it). */
  readonly canvas: HTMLCanvasElement;
  setDesign(design: CardDesign): Promise<void>;
  /** Radians, Euler XYZ, applied to the card slot (independent of the interaction). */
  setRotation(euler: [number, number, number]): void;
  setLift(y: number): void;
  /**
   * Orbits the camera around its framing target (degrees; `distance` multiplies the framing distance),
   * on top of the fit and any staging view; null returns to the plain camera. Camera paths use it.
   */
  setCameraOrbit(orbit: { azimuth: number; elevation: number; distance: number } | null): void;
  /**
   * Places the camera `z` card units from its framing target: the page frames the card itself (Card
   * Studio fits it to the stage with a margin); null returns to the stage's own framing. A staged scene
   * and a camera orbit multiply it.
   */
  setCameraDistance(z: number | null): void;
  /** True while the card animates by itself (live shaders, add-ons) or the interaction moves it. */
  readonly animated: boolean;
  /** Where the card and the camera are now; null before the first card. */
  view(): EngineView | null;
  /**
   * Shows sticker `decal` (its index in `CardDesign.decals`) at `pose` without rebuilding the card (the
   * next `setDesign` shows the design's own again). Returns the sticker's plane (`z`, card space) and its
   * picture's aspect (width / height), or null when the card doesn't show that sticker; without `pose`
   * only reads them.
   */
  setSticker(decal: number, pose?: EngineStickerPose): { z: number; aspect: number } | null;
  /**
   * Checks custom WGSL face shader code (`language: "wgsl"`) on this stage's GPU without building a card:
   * its annotation and compile errors (lines of `code`). Empty before the first card.
   */
  checkShader(code: string): Promise<EngineShaderError[]>;
  /** Draws the current state now. */
  render(): void;
  /** Schedules one frame (coalesced). */
  invalidate(): void;
  setQuality(quality: Quality): Promise<void>;
  setFit(fit: EngineFit): void;
  readonly fit: EngineFit;
  setPaused(paused: boolean): void;
  readonly paused: boolean;
  /** True between a lost WebGL context and the card's rebuild. */
  readonly contextLost: boolean;
  readonly pixelRatio: number;
  flip(): void;
  reset(): void;
  readonly interaction: EngineInteraction | null;
  /**
   * Face shader layers of the current design that couldn't be built (custom WGSL that doesn't parse
   * or compile): `index` in `CardDesign.shaders`, and the errors' lines in the layer's own code.
   */
  shaderErrors(): Array<{ index: number; side: "front" | "back"; errors: Array<{ line: number; message: string }> }>;
  /**
   * The AR model (GLB or USDZ) of the design on screen, built on this stage's GPU: real scale (ISO
   * ID-1, metres, Y up), its faces baked into textures. Rejects before the first design.
   */
  exportAr(o: ArExportOptions): Promise<Uint8Array>;
  dispose(): void;
  /**
   * Settles once the stage's GPU context is gone after `dispose()` (at once, unless the engine was
   * still starting: its context goes when the start finishes).
   */
  readonly released: Promise<void>;
}

/** The built-in face shaders the engine draws (`face_library.rs`; liquid metal comes with its runtime). */
export const ENGINE_FACE_SHADERS: ReadonlySet<string> = new Set([
  "oil-slick",
  "gradient-mesh",
  "foil-flakes",
  "halftone",
  "scanlines",
  "caustics",
  "lens",
  "thermal",
  "vinyl",
  "wood",
  "liquid-metal",
]);

/** Whether the engine draws a face shader layer: an engine built-in, or custom WGSL. */
const engineDrawsLayer = (l: unknown): boolean => {
  const layer = l as { id?: unknown; language?: unknown; enabled?: unknown } | null;
  if (!layer || layer.enabled === false) return true;
  return layer.id === "custom" ? layer.language === "wgsl" : ENGINE_FACE_SHADERS.has(String(layer.id));
};

/** The add-ons the engine draws (`design.addons`; all of them). */
export const ENGINE_ADDONS: ReadonlySet<string> = new Set(["shine", "vines"]);

/**
 * Whether the engine draws all of `design`: false when it has a custom face shader layer in GLSL (the
 * engine skips that layer and draws the rest) or names an add-on the engine doesn't know.
 */
export function engineDraws(design: CardDesign): boolean {
  const d = design as CardDesign & Record<string, unknown>;
  const shaders = Array.isArray(d.shaders) ? d.shaders : [];
  return !(
    !shaders.every(engineDrawsLayer) ||
    (d.addons != null && typeof d.addons === "object" && Object.entries(d.addons).some(([id, v]) => v != null && v !== false && !ENGINE_ADDONS.has(id)))
  );
}

/**
 * A compile message as the user should read it: naga's (the WebGL build) start with the module's name
 * and carry a source diagram with the assembled module's own line numbers; the line that matters is
 * the error's own line in the user's code, which the engine reports separately.
 */
export const cleanShaderMessage = (m: string): string =>
  m
    .trim()
    .replace(/^Shader '[^']*' (?:parsing|validation) error:\s*/, "")
    .split(/\n|\s*┌─/)[0]
    .trim() || m;

/** The engine's skipped-layer JSON, its messages cleaned. */
function shaderLayerErrors(json: string | undefined): Array<{ index: number; side: "front" | "back"; errors: EngineShaderError[] }> {
  try {
    const list = JSON.parse(json ?? "[]") as Array<{ index: number; side: "front" | "back"; errors: EngineShaderError[] }>;
    return list.map((l) => ({ ...l, errors: l.errors.map((e) => ({ line: e.line, message: cleanShaderMessage(e.message) })) }));
  } catch {
    return [];
  }
}

/**
 * Frees an engine card at once: its stage and GPU device, and on the WebGL build the context too (it
 * counts against the browser's per-page limit until lost; a canvas whose context was lost can't get
 * another, so a new stage needs a fresh canvas).
 */
function release(c: EngineCard): void {
  const webgl = c.backend === "webgl" ? c.canvas : null;
  c.dispose();
  webgl?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
}

/**
 * Whether a design has a layer that follows the page's pointer and wheel: liquid metal that reacts to
 * motion (`motion`, default on). Only then does a stage listen on the window.
 */
const followsPointer = (design: CardDesign | null): boolean =>
  (Array.isArray(design?.shaders) ? design.shaders : []).some((l) => l?.id === "liquid-metal" && l.enabled !== false && l.params?.motion !== false);

/** Intros already played on this page (one per page). */
let introPlayed = false;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const cardTextFont = (family: string) => (/[,"']/.test(family) ? `700 100px ${family}, Arial, sans-serif` : `700 100px "${family}", Arial, sans-serif`);

/**
 * Loads what a design's text draws with (its card font, text-line fonts, a custom font); returns the
 * custom font's family, if it has one (the engine's `fontFamily`). The marquee's cards use it too.
 */
export async function prepareFonts(design: CardDesign, assets: EngineAssets): Promise<string | undefined> {
  const family = await loadDesignFont(design, assets);
  await Promise.all([
    loadCardFont(family, cardTextFont(family), `${design.cardholderName ?? ""}${design.cardholderBio ?? ""}`),
    ...textLineFamilies(design, family).map(({ line, family: f }) => loadCardFont(f, cardTextFont(f), line.text)),
  ]);
  return design.font && typeof design.font === "object" ? family : undefined;
}

export function createEngineStage(canvas: HTMLCanvasElement, opts: EngineStageOptions = {}): EngineStage {
  let quality: Quality = opts.quality ?? "performance";
  let fit: EngineFit = opts.fit ?? "studio";
  const interactive = opts.interactive ?? true;
  const autoRender = opts.autoRender ?? true;
  const element = opts.element ?? canvas;
  const assets: EngineAssets = { nameFontFamily: getCardFont(DEFAULT_CARD_FONT)!.family, ...opts.assets };
  const resolveUrl = opts.resolveUrl ?? opts.assets?.resolveUrl;
  if (resolveUrl) assets.resolveUrl = resolveUrl;
  let label = opts.label ?? "Metal card";
  /** The page's camera distance (`setCameraDistance`), NaN: the stage's own. */
  let cameraDistance = NaN;

  let card: EngineCard | null = null;
  let starting: Promise<EngineCard> | null = null;
  let disposed = false;
  let paused = false;
  let frame = 0;
  let animating = false;
  let lastTick = -1;
  let markReleased!: () => void;
  const released = new Promise<void>((r) => (markReleased = r));
  // The engine downloads while the first design's fonts and images load.
  preloadEngine(opts.backend);

  // ── pixel ratio ───────────────────────────────────────────────────────────
  const fullRatio = () => {
    if (opts.pixelRatio !== undefined) return opts.pixelRatio;
    const [lo, hi] = QUALITY_PRESETS[quality].dpr;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    return Math.min(hi, Math.max(lo, dpr));
  };
  let ratio = fullRatio();
  const setRatio = (next: number, reason: "down" | "up" | "reset", frameMs?: number) => {
    if (Math.abs(next - ratio) < 1e-6) return;
    const previous = ratio;
    ratio = next;
    opts.onPixelRatioChange?.({ ratio, previous, full: fullRatio(), reason, ...(frameMs !== undefined ? { frameMs } : {}) });
    invalidate();
  };
  const adaptiveOpts = opts.adaptiveResolution === true ? {} : opts.adaptiveResolution || null;
  let adaptive: AdaptiveResolution | null = null;
  const controller = () =>
    (adaptive ??= new AdaptiveResolution({
      max: fullRatio(),
      min: Math.min(fullRatio(), adaptiveOpts?.minPixelRatio ?? Math.max(1, QUALITY_PRESETS[quality].dpr[0])),
      step: adaptiveOpts?.step ?? 0.25,
      budgetMs: adaptiveOpts?.frameBudgetMs ?? 20,
      predictive: false,
    }));
  const resetAdaptive = () => {
    lastTick = -1;
    adaptive?.reset({ max: fullRatio(), min: Math.min(fullRatio(), Math.max(1, QUALITY_PRESETS[quality].dpr[0])) });
    setRatio(fullRatio(), "reset");
  };

  /** Keeps the drawing buffer at the canvas's CSS size × the ratio. */
  const resize = () => {
    const c = card?.canvas ?? canvas;
    const w = Math.max(1, Math.round((c.clientWidth || c.width || 1) * ratio));
    const h = Math.max(1, Math.round((c.clientHeight || c.height || 1) * ratio));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    card?.resize(w, h);
  };
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => invalidate()) : null;
  ro?.observe(canvas);

  // ── frame loop: on demand, and every frame while the interaction animates ──
  const draw = (now: number) => {
    if (!card || disposed) return;
    const flags = card.advance(now);
    animating = (flags & 1) !== 0;
    const s = card.stage;
    if (s && flags & 2) opts.onRotationChange?.({ x: s.rotationX(), y: s.rotationY() });
    if (s && flags & 4) opts.onFlippedChange?.(s.flipped());
    // A drag turns the card every frame: the attributes change only with a flip or the intro.
    if (flags & 4 || (flags & 2 && interactive && s && s.introState() !== element.dataset.intro)) updateA11y();
    resize();
    card.render();
  };
  const tick = (now: number) => {
    frame = 0;
    if (disposed || paused) return;
    if (adaptiveOpts && animating && lastTick >= 0) {
      const dt = now - lastTick;
      if (dt > 0 && dt < 250) {
        const c: AdaptiveResolutionChange | null = controller().sample(dt, now / 1000);
        if (c) setRatio(c.ratio, c.direction, c.frameMs);
      }
    }
    lastTick = animating ? now : -1;
    draw(now);
    if (animating) frame = requestAnimationFrame(tick);
    else if (adaptiveOpts && ratio !== fullRatio()) resetAdaptive();
  };
  function invalidate() {
    if (!frame && !disposed && !paused && autoRender) frame = requestAnimationFrame(tick);
  }

  // ── engine start (with the first design) ───────────────────────────────────
  const start = async (json: string, fontFamily: string | undefined): Promise<EngineCard> => {
    const intro = (opts.intro ?? interactive) && !introPlayed && !reducedMotion();
    const c = await createCard(canvas, json, {
      force: opts.backend,
      resolveUrl,
      // A scene's environment: the catalog's files (fetched only for designs with one), or a URL.
      environmentUrl: (env) => environmentUrl(env, resolveUrl),
      assets: engineAssets(assets),
      fontFamily,
      stage: { quality, fit, interactive, intro, reducedMotion: reducedMotion(), fitToViewport: opts.fitToViewport, defaultRotation: opts.defaultRotation },
      onCanvas: (next) => {
        ro?.unobserve(canvas);
        canvas = next;
        ro?.observe(canvas);
        opts.onCanvas?.(next);
      },
      onFallback: (why) => {
        opts.onFallback?.(why);
        invalidate();
      },
      onContextLost: () => opts.onContextLost?.(),
      onStickerFrame: () => invalidate(),
      onContextRestored: () => {
        opts.onContextRestored?.();
        updateA11y();
        invalidate();
      },
    });
    if (intro) introPlayed = true;
    return c;
  };

  // ── input (the engine decides what each event does) ──────────────
  const stage = (): WasmCardStage | null => (interactive ? (card?.stage ?? null) : null);
  const cleanup: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
    element.addEventListener(type, fn as EventListener);
    cleanup.push(() => element.removeEventListener(type, fn as EventListener));
  };
  let dragId: number | null = null;
  const endDrag = () => {
    if (dragId !== null && element.hasPointerCapture?.(dragId)) element.releasePointerCapture(dragId);
    dragId = null;
  };
  if (interactive) {
    element.style.touchAction = "none";
    on("pointerdown", (e) => {
      const s = stage();
      if (!s || e.button !== 0) return;
      const r = element.getBoundingClientRect();
      if (s.pointerDown(e.pointerId, e.clientX, e.clientY, r.width || 1, r.height || 1, performance.now())) {
        dragId = e.pointerId;
        element.setPointerCapture?.(e.pointerId);
        invalidate();
      }
    });
    on("pointermove", (e) => {
      if (stage()?.pointerMove(e.pointerId, e.clientX, e.clientY, performance.now())) {
        e.preventDefault();
        invalidate();
      }
    });
    on("pointerup", (e) => {
      stage()?.pointerUp(e.pointerId, e.clientX, e.clientY, performance.now());
      if (e.pointerId === dragId) endDrag();
      invalidate();
    });
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== dragId) return;
      stage()?.pointerCancel(e.pointerId);
      endDrag();
      invalidate();
    };
    on("pointercancel", cancel);
    on("lostpointercapture", cancel);
    on("dblclick", () => {
      stage()?.doubleClick();
      invalidate();
    });
    on("keydown", (e) => {
      if (stage()?.key(e.key, performance.now())) {
        e.preventDefault();
        invalidate();
      }
    });
  }
  // The page's pointer for face shader layers that follow it (live liquid metal reads its speed and
  // keeps drawing by itself), interactive or not, as the three.js engine listened on the window: the
  // last position, cleared when it leaves. Only while the design has such a layer and the stage runs.
  let followingPointer = false;
  const move = (e: PointerEvent) => {
    const s = card?.stage;
    if (!s) return;
    const r = (card?.canvas ?? canvas).getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    s.setPointer(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  const leave = () => card?.stage?.setPointer(NaN, NaN);
  const out = (e: PointerEvent) => {
    if (!e.relatedTarget) leave();
  };
  // Scrolling stirs liquid metal (its driver listens to the window's wheel, as three's does).
  const wheel = (e: WheelEvent) => card?.stage?.wheel?.(e.deltaX, e.deltaY);
  const syncPointer = () => {
    const want = typeof window !== "undefined" && !disposed && !paused && followsPointer(design);
    if (want === followingPointer) return;
    followingPointer = want;
    if (want) {
      window.addEventListener("pointermove", move, { passive: true });
      window.addEventListener("pointerdown", move, { passive: true });
      window.addEventListener("pointerout", out);
      window.addEventListener("blur", leave);
      window.addEventListener("wheel", wheel, { passive: true });
    } else {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", move);
      window.removeEventListener("pointerout", out);
      window.removeEventListener("blur", leave);
      window.removeEventListener("wheel", wheel);
      leave();
    }
  };
  const onVisibility = () => {
    const visible = document.visibilityState !== "hidden";
    card?.stage?.setVisible(visible);
    if (!visible) endDrag();
    invalidate();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    cleanup.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  const motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const onMotion = () => card?.stage?.setReducedMotion(reducedMotion());
  motion?.addEventListener?.("change", onMotion);
  cleanup.push(() => motion?.removeEventListener?.("change", onMotion));

  /** Sets an attribute only when it changes (no mutation, no style or accessibility tree work). */
  const attr = (name: string, value: string) => {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  function updateA11y() {
    const s = card?.stage;
    if (!interactive || !s) return;
    const flipped = s.flipped();
    attr("role", "button");
    attr("tabindex", "0");
    attr("aria-pressed", String(flipped));
    attr("aria-label", `${label}; showing ${flipped ? "back" : "front"}`);
    attr("data-face", flipped ? "back" : "front");
    const intro = s.introState();
    if (intro) attr("data-intro", intro);
  }

  // ── designs ───────────────────────────────────────────────────────────────
  let design: CardDesign | null = null;
  let token = 0;
  async function setDesign(next: CardDesign): Promise<void> {
    const mine = ++token;
    design = next;
    const fontFamily = await prepareFonts(next, assets);
    if (mine !== token || disposed) return;
    const json = JSON.stringify(next);
    if (!card) {
      starting ??= start(json, fontFamily).finally(() => (starting = null));
      const c = await starting;
      if (disposed) return; // dispose() releases it
      card = c;
      if (!Number.isNaN(cameraDistance)) c.setCameraDistance(cameraDistance);
      if (paused) c.setPaused(true);
      if (mine !== token) return void (await setDesign(design!));
    } else {
      await card.setDesign(json, { fontFamily });
      if (mine !== token || disposed) return;
    }
    resetAdaptive();
    updateA11y();
    syncPointer();
    invalidate();
  }

  const interaction: EngineInteraction = {
    get rot() {
      const s = card?.stage;
      return { x: s?.rotationX() ?? 0, y: s?.rotationY() ?? 0 };
    },
    get flipped() {
      return card?.stage?.flipped() ?? false;
    },
    setRotation(rot) {
      card?.stage?.setInteractionRotation(rot.x, rot.y);
      invalidate();
    },
    toggleFlip() {
      card?.stage?.toggleFlip(performance.now());
      invalidate();
    },
    setFlipped(flipped) {
      card?.stage?.setFlipped(flipped, performance.now());
      invalidate();
    },
    reset() {
      card?.stage?.reset();
      updateA11y();
      invalidate();
    },
    setActive(active) {
      card?.stage?.setActive(active, performance.now());
      invalidate();
    },
    restore(rot, flipped) {
      card?.stage?.restorePose(rot.x, rot.y, flipped);
      updateA11y();
      invalidate();
    },
    setLabel(next) {
      label = next;
      updateA11y();
    },
  };

  return {
    get backend() {
      return card?.backend ?? null;
    },
    get canvas() {
      return card?.canvas ?? canvas;
    },
    setDesign,
    setRotation(euler) {
      card?.setRotation(euler[0], euler[1], euler[2]);
      invalidate();
    },
    setLift(y) {
      card?.setLift(y);
      invalidate();
    },
    setCameraOrbit(orbit) {
      card?.setCameraOrbit(orbit?.azimuth ?? 0, orbit?.elevation ?? 0, orbit?.distance ?? 1);
      invalidate();
    },
    setCameraDistance(z) {
      cameraDistance = z != null && z > 0 && Number.isFinite(z) ? z : NaN;
      card?.setCameraDistance(cameraDistance);
      invalidate();
    },
    get animated() {
      return animating;
    },
    view() {
      const s = card?.stage;
      const v = s?.view();
      if (!v || v.length < 40) return null;
      const c = card!.canvas;
      return {
        model: v.slice(0, 16),
        view: v.slice(16, 32),
        eye: [v[32], v[33], v[34]],
        fov: v[35],
        aspect: (c.width || 1) / (c.height || 1),
        quaternion: { x: v[36], y: v[37], z: v[38], w: v[39] },
      };
    },
    setSticker(decal, pose) {
      const s = card?.stage;
      if (!s) return null;
      let values: number[] | undefined;
      if (pose) {
        const crop = pose.crop ?? { x: 0, y: 0, w: 1, h: 1 };
        const tint = pose.tint && pose.tint.amount > 0 ? [...pose.tint.rgb, pose.tint.amount] : [0, 0, 0, 0];
        const a = pose.adjust ?? {};
        values = [
          pose.x,
          pose.y,
          pose.width,
          pose.height,
          pose.rotation,
          crop.x,
          crop.y,
          crop.w,
          crop.h,
          pose.flip?.h ? 1 : 0,
          pose.flip?.v ? 1 : 0,
          pose.opacity ?? 1,
          ...tint,
          a.brightness ?? 0,
          a.contrast ?? 0,
          a.saturation ?? 0,
        ];
        invalidate();
      }
      const r = s.sticker(decal, values);
      return r.length >= 2 ? { z: r[0], aspect: r[1] } : null;
    },
    async checkShader(code) {
      const s = card?.stage;
      if (!s) return [];
      try {
        return shaderLayerErrors(await s.checkShader(code)).flatMap((l) => l.errors);
      } catch (e) {
        // A chunk that couldn't be downloaded: say so rather than pass the code.
        return [{ line: 0, message: `couldn't check the shader: ${(e as Error)?.message ?? e}` }];
      }
    },
    render() {
      draw(performance.now());
    },
    invalidate,
    async setQuality(q) {
      if (q === quality) return;
      quality = q;
      card?.stage?.setQuality(q);
      resetAdaptive();
      adaptive = null;
      if (design) await setDesign(design);
    },
    setFit(f) {
      fit = f;
      card?.stage?.setFit(f);
      invalidate();
    },
    get fit() {
      return fit;
    },
    setPaused(p) {
      if (p === paused) return;
      paused = p;
      card?.setPaused(p);
      syncPointer();
      if (p) {
        cancelAnimationFrame(frame);
        frame = 0;
        lastTick = -1;
      } else invalidate();
    },
    get paused() {
      return paused;
    },
    get contextLost() {
      return card?.contextLost ?? false;
    },
    get pixelRatio() {
      return ratio;
    },
    flip() {
      interaction.toggleFlip();
    },
    reset() {
      interaction.reset();
    },
    get interaction() {
      return interactive && card ? interaction : null;
    },
    shaderErrors() {
      return shaderLayerErrors(card?.stage?.shaderErrors());
    },
    async exportAr(o) {
      const d = design;
      if (!card || !d) throw new Error("no design to export yet");
      return exportAr(card, d, await prepareFonts(d, assets), o);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      ro?.disconnect();
      endDrag();
      syncPointer();
      for (const f of cleanup.splice(0)) f();
      const pending = starting;
      if (card) {
        release(card);
        card = null;
        markReleased();
      } else if (pending) pending.then(release, () => {}).finally(markReleased);
      else markReleased();
    },
    released,
  };
}

// ── offscreen frames (exports, thumbnails) ──────────────────────────────────────

export interface OffscreenStageOptions {
  /** Default "full". */
  quality?: Quality;
  /** Pick a build ("webgpu" or "webgl") instead of the loader's choice. */
  backend?: "webgpu" | "webgl";
  /** The asset provider (as `EngineStageOptions.assets`). */
  assets?: EngineAssets;
  /** Resolves a design's `src`s (default: the provider's `resolveUrl`, else as given). */
  resolveUrl?(src: string): string;
}

/** A unit quaternion (x, y, z, w): three's `Quaternion` fits. */
export interface CardQuaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface OffscreenFrameOptions {
  /** Output size, px. */
  width: number;
  height: number;
  /** The card's orientation; identity when omitted. */
  quaternion?: CardQuaternion;
  /**
   * The camera's distance from its target, card units (the page frames the card itself); default the
   * stage's own framing. A staged scene and a camera orbit multiply it as they do the stage's own.
   */
  cameraDistance?: number;
  /** Camera orbit around the framing target (camera paths); none: the camera on its axis. */
  orbit?: { azimuth: number; elevation: number; distance: number } | null;
  /** Raise the card (camera paths' hover), card units. */
  lift?: number;
  /**
   * Seconds the card's clocks advance before this frame (video: 1/fps). Default 0: the stage never
   * runs a clock of its own, so stills are deterministic. Steps longer than 1/30 s are split.
   */
  dt?: number;
}

/**
 * The engine drawing frames on demand, off screen: exports and thumbnails. Its clocks advance only by
 * the `dt` each frame asks for, so the same calls give the same frames.
 */
export interface OffscreenStage {
  /** "webgpu" or "webgl" once the first design started the engine, else null. */
  readonly backend: "webgpu" | "webgl" | null;
  setDesign(design: CardDesign): Promise<void>;
  /** The current card animates by itself (live shaders, add-ons). */
  readonly animated: boolean;
  /** True between a lost WebGL context and the card's rebuild: frames fail meanwhile. */
  readonly contextLost: boolean;
  /** Runs the card's clocks forward without drawing (in steps of at most 0.2 s). */
  advance(seconds: number): void;
  /**
   * Draws a frame and returns it on a 2D canvas the stage reuses (copy it before the next frame), its
   * alpha as the card drew it over transparent (a glass card and a staged scene are opaque).
   */
  frame(o: OffscreenFrameOptions): HTMLCanvasElement;
  /** `frame`'s pixels (straight alpha). */
  frameImageData(o: OffscreenFrameOptions): ImageData;
  /** `frame` encoded (`type`, default PNG; `quality` for JPEG / WebP). */
  frameBlob(o: OffscreenFrameOptions, type?: string, quality?: number): Promise<Blob>;
  /** Builds a design for a print bake on this stage's GPU (`bakePrint`, `@card3d/core/print`). */
  printJob(design: CardDesign): Promise<EnginePrintJob>;
  /** The AR model (GLB or USDZ) of `design`, built on this stage's GPU (as `EngineStage.exportAr`). */
  exportAr(design: CardDesign, o: ArExportOptions): Promise<Uint8Array>;
  /** As `EngineStage.shaderErrors`. */
  shaderErrors(): Array<{ index: number; side: "front" | "back"; errors: Array<{ line: number; message: string }> }>;
  dispose(): void;
}

/** Face-shader layers step at most 1/30 s per update; longer steps are split. */
const MAX_STEP = 1 / 30;

/** A quaternion as Euler XYZ angles (radians; three's `Euler.setFromQuaternion(q, "XYZ")`). */
export function quaternionToEuler(q: CardQuaternion): [number, number, number] {
  const { x, y, z, w } = q;
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - z * w);
  const m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.min(1, Math.max(-1, m13)));
  if (Math.abs(m13) < 0.9999999) return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)];
  return [Math.atan2(m32, m22), ey, 0];
}

/**
 * An offscreen stage on the engine (WebGPU, else its WebGL build): no interaction, pixel ratio 1, no
 * frame loop. Each `frame` sizes the drawing buffer to the output, poses the card and the camera, and
 * copies the drawing at once (the engine's canvas keeps no drawing between tasks).
 */
export function createOffscreenStage(opts: OffscreenStageOptions = {}): OffscreenStage {
  const quality = opts.quality ?? "full";
  const assets: EngineAssets = { nameFontFamily: getCardFont(DEFAULT_CARD_FONT)!.family, ...opts.assets };
  const resolveUrl = opts.resolveUrl ?? opts.assets?.resolveUrl;
  if (resolveUrl) assets.resolveUrl = resolveUrl;
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  // A GPU-backed 2D canvas: the copy is a GPU copy, and pixels are read back only when the caller
  // reads them (a thumbnail after a frame or two), not by waiting for the GPU in `frame`.
  const out = document.createElement("canvas");
  const ctx = out.getContext("2d")!;
  let card: EngineCard | null = null;
  let starting: Promise<EngineCard> | null = null;
  let disposed = false;
  let clock = 0;
  let animated = false;
  let token = 0;

  const start = (json: string, fontFamily: string | undefined) =>
    createCard(canvas, json, {
      force: opts.backend,
      resolveUrl,
      environmentUrl: (env) => environmentUrl(env, resolveUrl),
      assets: engineAssets(assets),
      fontFamily,
      stage: { quality, fit: "studio", interactive: false, intro: false, reducedMotion: false },
    });
  const step = (seconds: number) => {
    clock += seconds * 1000;
    animated = ((card?.advance(clock) ?? 0) & 1) !== 0;
  };

  async function setDesign(design: CardDesign): Promise<void> {
    const mine = ++token;
    // The engine downloads while the fonts and images load.
    if (!card && !starting) preloadEngine(opts.backend);
    const fontFamily = await prepareFonts(design, assets);
    if (mine !== token || disposed) return;
    const json = JSON.stringify(design);
    if (!card) {
      starting ??= start(json, fontFamily).finally(() => (starting = null));
      const c = await starting;
      if (disposed) return void release(c);
      card = c;
      if (mine !== token) return;
    } else await card.setDesign(json, { fontFamily });
    await card.stickersReady;
    step(0);
  }

  function frame(o: OffscreenFrameOptions): HTMLCanvasElement {
    if (!card) throw new Error("no design to draw yet");
    // A lost context draws nothing: fail the capture rather than hand back a blank frame.
    if (card.contextLost || !card.stage) throw new Error("the graphics context was lost");
    const w = Math.max(1, Math.round(o.width));
    const h = Math.max(1, Math.round(o.height));
    const c = card.canvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    card.resize(w, h);
    card.setCameraDistance(o.cameraDistance ?? NaN);
    card.setCameraOrbit(o.orbit?.azimuth ?? 0, o.orbit?.elevation ?? 0, o.orbit?.distance ?? 1);
    card.setLift(o.lift ?? 0);
    const [x, y, z] = o.quaternion ? quaternionToEuler(o.quaternion) : [0, 0, 0];
    card.setRotation(x, y, z);
    let dt = Math.max(0, o.dt ?? 0);
    while (dt > MAX_STEP) {
      step(MAX_STEP);
      dt -= MAX_STEP;
    }
    step(dt);
    card.render();
    // The same task: the drawing is gone once the browser presents it.
    out.width = w;
    out.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(card.canvas, 0, 0, w, h);
    return out;
  }

  return {
    get backend() {
      return card?.backend ?? null;
    },
    setDesign,
    get animated() {
      return animated;
    },
    get contextLost() {
      return card?.contextLost ?? false;
    },
    advance(seconds) {
      for (let t = 0; t < seconds; t += 0.2) step(Math.min(0.2, seconds - t));
    },
    frame,
    frameImageData(o) {
      const c = frame(o);
      return ctx.getImageData(0, 0, c.width, c.height);
    },
    frameBlob(o, type = "image/png", q) {
      const c = frame(o);
      return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't encode the frame"))), type, q));
    },
    async printJob(design) {
      if (!card) await setDesign(design);
      if (!card) throw new Error("the card engine didn't start");
      return card.printJob(JSON.stringify(design), { fontFamily: await prepareFonts(design, assets) });
    },
    async exportAr(design, o) {
      if (!card) await setDesign(design);
      if (!card) throw new Error("the card engine didn't start");
      return exportAr(card, design, await prepareFonts(design, assets), o);
    },
    shaderErrors() {
      return shaderLayerErrors(card?.stage?.shaderErrors());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (card) release(card);
      else starting?.then(release, () => {});
      card = null;
    },
  };
}
