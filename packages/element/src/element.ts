/**
 * `<metal-card>`: a 3D metal card from @card3d/core as a custom element (docs: packages/element/README.md),
 * drawn by the card engine (`createEngineStage`: WebGPU, else its WebGL 2 build).
 */
import { arSupport, lightingBackdropCss, loadCustomFont, openQuickLook, sceneViewerUrl, type CardDesign } from "@card3d/core/model";
import { createEngineStage, type EngineStage } from "@card3d/core/engine";
import {
  accessibleLabel,
  parseAutoRotate,
  parseBool,
  parseFit,
  parseInteraction,
  parseQuality,
  resolveDesign,
  type DesignSources,
  type Interaction,
} from "./attributes.ts";
import { contextPool, type PoolMember } from "./pool.ts";

/** Attributes that change the design (re-resolved together, debounced). */
const DESIGN_ATTRIBUTES = [
  "design",
  "share",
  "src",
  "preset",
  "material",
  "texture",
  "pattern",
  "color",
  "name",
  "bio",
  "font",
  "font-url",
  "lighting",
  "environment",
  "floor",
] as const;
const OBSERVED = [...DESIGN_ATTRIBUTES, "interaction", "auto-rotate", "quality", "fit", "lazy", "paused", "label", "backdrop", "ar", "ar-src"] as const;

/** Drag sensitivity of the turntable (degrees per element width), as the stage's own drag. */
const YAW_PER_WIDTH = 220;
const FLIP_MS = 620;
/** Auto-rotation waits this long after the last interaction. */
const RESUME_AFTER_MS = 1500;
const DRAG_SLOP_PX = 6;
const CLICK_MS = 800;

const STYLE = `
:host { display: inline-block; position: relative; width: 360px; max-width: 100%; aspect-ratio: 8 / 5; vertical-align: top; contain: layout paint; -webkit-tap-highlight-color: transparent; }
:host([hidden]) { display: none; }
:host(:focus-visible) { outline: 2px solid Highlight; outline: 2px solid -webkit-focus-ring-color; outline-offset: 2px; }
.bg, canvas, .still { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.bg { border-radius: inherit; }
.still { pointer-events: none; }
.ar { position: absolute; z-index: 2; right: 10px; bottom: 10px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px 6px 9px; border: 0; border-radius: 999px; font: 600 12px/1.2 system-ui, -apple-system, sans-serif; color: #111; background: rgba(255, 255, 255, 0.86); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); cursor: pointer; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
.ar[hidden] { display: none; }
.ar:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
.ar[aria-busy="true"] { opacity: 0.7; cursor: progress; }
.ar svg { width: 15px; height: 15px; }
`;

const AR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z"/><path d="M4 7.4 12 12l8-4.6M12 12v9.2"/></svg>`;

const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const expoOut = (k: number) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k));

// SSR-safe base (wave3d's pattern): `class extends HTMLElement` evaluates HTMLElement at import time,
// which throws under Node. The element is never instantiated there (register() is guarded).
const ElementBase: typeof HTMLElement =
  typeof HTMLElement !== "undefined" ? HTMLElement : (function MetalCardElementBase() {} as unknown as typeof HTMLElement);

/**
 * The design's custom face shader layers in GLSL (from the three.js engine's era): the engine draws
 * WGSL only, so it skips them and draws the rest of the card. Their indexes in `design.shaders`.
 */
const glslLayers = (design: CardDesign): number[] =>
  (design.shaders ?? []).flatMap((l, i) => (l.id === "custom" && l.language !== "wgsl" && l.enabled !== false ? [i] : []));

export interface MetalCardReadyDetail {
  design: CardDesign;
  stage: EngineStage;
}

/**
 * `<metal-card>`. Design: `design` (JSON), `share` (a Card Studio share link / `#d=` hash / token),
 * `src` (URL of a design JSON), `preset`, plus `material`, `texture`, `pattern`, `color`, `name`,
 * `bio`, `font` (an id, `google:<Family>[@weight]`, or with `font-url` a web font file's family),
 * `lighting` over it; or the `design` property. Behaviour: `interaction` (drag |
 * turntable | none), `auto-rotate` (deg/s), `quality`, `fit` (contain | studio), `lazy`, `paused`, `label`, `backdrop`.
 * Events: `metal-card-ready` (detail { design, stage }) whenever a design is on screen,
 * `metal-card-error` (detail { message }) when an input can't be used.
 */
export class MetalCardElement extends ElementBase implements PoolMember {
  static get observedAttributes(): string[] {
    return [...OBSERVED];
  }

  /** Most cards with a live WebGL context at once, page-wide (default 12). See README "Many cards". */
  static get maxContexts(): number {
    return contextPool.limit;
  }
  static set maxContexts(n: number) {
    if (Number.isFinite(n) && n >= 1) contextPool.limit = Math.floor(n);
  }
  /** Cards holding a WebGL context right now. */
  static get liveContexts(): number {
    return contextPool.size;
  }

  #shadow: ShadowRoot | null = null;
  #bg: HTMLDivElement | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #still: HTMLCanvasElement | null = null;
  #stage: EngineStage | null = null;
  /** A disposed engine stage whose GPU context isn't gone yet (it was still starting). */
  #releasing: Promise<void> | null = null;
  #design: CardDesign | null = null;
  #designProp: unknown = undefined;
  #resolving = 0;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #ready = false;

  #observing = false;
  #io: IntersectionObserver | null = null;
  #ro: ResizeObserver | null = null;
  #mq: MediaQueryList | null = null;
  #visible = false;
  #hiddenSince = 0;
  #waiting = false;
  /** Interaction state carried across a park (the context released while off screen). */
  #saved: { rot: { x: number; y: number }; flipped: boolean } | null = null;

  // turntable / auto-rotate (the stage's card slot, independent of the drag interaction)
  #yaw = 0;
  #velocity = 0;
  #flip: { from: number; to: number; t0: number } | null = null;
  #holdUntil = 0;
  #frame = 0;
  #last = 0;
  #drag: { id: number; x: number; y: number; yaw: number; t: number; lastX: number; lastT: number; moved: boolean } | null = null;
  #cleanup: (() => void)[] = [];
  #arButton: HTMLButtonElement | null = null;
  /** The USDZ made for the design on screen (Quick Look), kept while that design is shown. */
  #usdz: { design: CardDesign; url: Promise<string> } | null = null;

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * The design on screen (resolved from the attributes, null until resolved). Setting it takes any
   * design object Card Studio can open, or its JSON; it wins over the `design` / `share` / `src` /
   * `preset` attributes, and the convenience attributes still apply over it.
   */
  get design(): CardDesign | null {
    return this.#design;
  }
  set design(value: unknown) {
    // A string is design JSON (frameworks that set properties pass the attribute's string here).
    if (typeof value === "string") {
      try {
        value = value.trim() ? JSON.parse(value) : undefined;
      } catch {
        // resolveDesign reports it
      }
    }
    this.#designProp = value ?? undefined;
    this.#scheduleDesign(0);
  }

  /** Camera framing (the `fit` attribute): "contain" (default) fills the element; "studio" is Card Studio's camera. */
  get fit(): "contain" | "studio" {
    return parseFit(this.getAttribute("fit"));
  }
  set fit(value: "contain" | "studio") {
    this.setAttribute("fit", value === "studio" ? "studio" : "contain");
  }

  /** The live stage (null while the card has no GPU context: not yet visible, parked, or disconnected). */
  get stage(): EngineStage | null {
    return this.#stage;
  }

  /** True once a design is on screen (until the next design change or the context is released). */
  get ready(): boolean {
    return this.#ready;
  }

  /** Turn the card over. */
  flip(): void {
    if (this.#stage?.interaction) this.#stage.interaction.toggleFlip();
    else this.#flipTurntable();
  }

  /** Back to the front, facing the viewer. */
  reset(): void {
    this.#stage?.interaction?.reset();
    this.#flip = null;
    this.#velocity = 0;
    this.#yaw = 0;
    this.#stage?.setRotation([0, 0, 0]);
  }

  // ── PoolMember ─────────────────────────────────────────────────────────────

  get visible(): boolean {
    return this.#visible;
  }
  get hiddenSince(): number {
    return this.#hiddenSince;
  }

  /** The pool needs this card's context: keep the last frame as a still and release it. */
  park(): void | Promise<void> {
    const stage = this.#stage;
    if (!stage) return this.#destroyStage();
    const i = stage.interaction;
    this.#saved = i ? { rot: { ...i.rot }, flipped: i.flipped } : null;
    this.#keepStill(stage);
    return this.#destroyStage();
  }

  grant(): void {
    this.#waiting = false;
    if (this.isConnected && !this.#stage) this.#start();
    else contextPool.release(this);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  connectedCallback(): void {
    this.#ensureShadow();
    if (!this.#observing) this.#observe();
    this.#updateLabel();
    if (!this.#design) this.#scheduleDesign(0);
    this.#maybeStart();
  }

  disconnectedCallback(): void {
    // A move within the document disconnects and reconnects in the same task: keep everything then.
    queueMicrotask(() => {
      if (!this.isConnected) this.#teardown();
    });
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (old === value) return;
    if ((DESIGN_ATTRIBUTES as readonly string[]).includes(name)) {
      this.#scheduleDesign(30);
      return;
    }
    switch (name) {
      case "interaction":
        this.#ready = false;
        if (this.#stage) {
          contextPool.release(this, this.#destroyStage());
        }
        this.#yaw = 0;
        this.#maybeStart();
        break;
      case "quality":
        void this.#stage?.setQuality(parseQuality(value));
        break;
      case "fit":
        this.#stage?.setFit(parseFit(value));
        break;
      case "paused":
        this.#syncPaused();
        break;
      case "lazy":
        this.#maybeStart();
        break;
      case "label":
        this.#updateLabel();
        break;
      case "backdrop":
        this.#updateBackdrop();
        break;
      case "auto-rotate":
        this.#kick();
        break;
      case "ar":
      case "ar-src":
        this.#updateAr();
        break;
    }
  }

  // ── setup / teardown ───────────────────────────────────────────────────────

  #ensureShadow(): void {
    if (this.#shadow) return;
    this.#shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.#bg = document.createElement("div");
    this.#bg.className = "bg";
    this.#bg.setAttribute("part", "backdrop");
    this.#shadow.append(style, this.#bg);
    this.#updateAr();
  }

  // ── AR (the `ar` attribute; the exporters load on first use) ──────────────

  /**
   * Show the AR button where AR is available: iOS / iPadOS (Quick Look; the USDZ is made in the page,
   * or `ios-src`) and Android with `ar-src` (Scene Viewer needs a hosted GLB). Hidden elsewhere.
   */
  #updateAr(): void {
    if (!this.#shadow) return;
    const want = this.hasAttribute("ar") && parseBool(this.getAttribute("ar"), true);
    const support = want ? arSupport() : { quickLook: false, sceneViewer: false };
    const usable = support.quickLook || (support.sceneViewer && !!this.getAttribute("ar-src")?.trim());
    if (!usable) {
      if (this.#arButton) this.#arButton.hidden = true;
      return;
    }
    if (!this.#arButton) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ar";
      b.setAttribute("part", "ar-button");
      b.innerHTML = `${AR_ICON}<span>View in AR</span>`;
      // Start making the model as the finger lands, so it is ready by the click (Quick Look must open
      // within the tap's user activation).
      b.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (arSupport().quickLook) void this.#usdzUrl()?.catch(() => {});
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.viewInAr();
      });
      b.addEventListener("keydown", (e) => e.stopPropagation());
      this.#arButton = b;
      this.#shadow.append(b);
    }
    this.#arButton.hidden = false;
  }

  /** The USDZ of the design on screen (made once per design on the stage's GPU; the engine's AR part loads on first use). */
  #usdzUrl(): Promise<string> | null {
    const stage = this.#stage;
    const design = this.#design;
    if (!stage || !design) return null;
    if (this.#usdz?.design === design) return this.#usdz.url;
    this.#releaseUsdz();
    const bytes = stage.exportAr({ format: "usdz" }).then((b) => new Uint8Array(b));
    const url = bytes.then((b) => URL.createObjectURL(new Blob([b], { type: "model/vnd.usdz+zip" })));
    this.#usdz = { design, url };
    return url;
  }

  #releaseUsdz(): void {
    const old = this.#usdz;
    this.#usdz = null;
    void old?.url.then(
      (u) => URL.revokeObjectURL(u),
      () => {},
    );
  }

  /**
   * Open the card in AR: Quick Look on iOS / iPadOS (`ios-src`, or a USDZ made from the card on screen),
   * Scene Viewer on Android (`ar-src`, a hosted GLB). Call from a user gesture. Resolves false when this
   * device has no AR viewer for the card.
   */
  async viewInAr(): Promise<boolean> {
    const support = arSupport();
    const b = this.#arButton;
    if (support.quickLook) {
      const iosSrc = this.getAttribute("ios-src")?.trim();
      try {
        b?.setAttribute("aria-busy", "true");
        const url = iosSrc || (await this.#usdzUrl());
        if (!url) return false;
        openQuickLook(url);
        this.dispatchEvent(new CustomEvent("metal-card-ar", { detail: { viewer: "quick-look", url } }));
        return true;
      } catch (err) {
        const message = `AR export failed: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`<metal-card>: ${message}`);
        this.dispatchEvent(new CustomEvent("metal-card-error", { detail: { message } }));
        return false;
      } finally {
        b?.removeAttribute("aria-busy");
      }
    }
    const glb = this.getAttribute("ar-src")?.trim();
    if (support.sceneViewer && glb) {
      const url = sceneViewerUrl(new URL(glb, location.href).href, { title: this.#design?.cardholderName || "Card" });
      this.dispatchEvent(new CustomEvent("metal-card-ar", { detail: { viewer: "scene-viewer", url } }));
      location.href = url;
      return true;
    }
    return false;
  }

  #observe(): void {
    this.#observing = true;
    if (typeof IntersectionObserver !== "undefined") {
      // Start a little before the card scrolls in; pause once it is fully out.
      this.#io = new IntersectionObserver((entries) => this.#setVisible(entries[entries.length - 1].isIntersecting), { rootMargin: "200px" });
      this.#io.observe(this);
    } else this.#visible = true;
    if (typeof ResizeObserver !== "undefined") {
      this.#ro = new ResizeObserver(() => this.#maybeStart());
      this.#ro.observe(this);
    }
    if (typeof matchMedia === "function") {
      this.#mq = matchMedia("(prefers-reduced-motion: reduce)");
      this.#mq.addEventListener("change", this.#onMotionPreference);
    }
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      this.addEventListener(type, fn as EventListener);
      this.#cleanup.push(() => this.removeEventListener(type, fn as EventListener));
    };
    on("pointerdown", (e) => this.#onPointerDown(e));
    on("pointermove", (e) => this.#onPointerMove(e));
    on("pointerup", (e) => this.#onPointerUp(e));
    on("pointercancel", () => this.#endDrag());
    on("keydown", (e) => this.#onKey(e));
    const onVisibility = () => this.#syncPaused();
    document.addEventListener("visibilitychange", onVisibility);
    this.#cleanup.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }

  #teardown(): void {
    clearTimeout(this.#debounce);
    this.#resolving++;
    this.#observing = false;
    this.#io?.disconnect();
    this.#ro?.disconnect();
    this.#mq?.removeEventListener("change", this.#onMotionPreference);
    this.#io = this.#ro = this.#mq = null;
    for (const fn of this.#cleanup.splice(0)) fn();
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    if (this.#waiting) contextPool.cancel(this);
    this.#waiting = false;
    if (this.#stage) {
      contextPool.release(this, this.#destroyStage());
    }
    this.#still?.remove();
    this.#still = null;
    this.#visible = false;
    this.#saved = null;
    this.#releaseUsdz();
  }

  #onMotionPreference = () => this.#kick();

  #setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    if (!visible) {
      this.#hiddenSince = performance.now();
      this.#syncPaused();
      contextPool.rebalance();
    } else {
      this.#syncPaused();
      this.#maybeStart();
    }
  }

  #lazy(): boolean {
    return parseBool(this.getAttribute("lazy"), true);
  }

  #interaction(): Interaction {
    return parseInteraction(this.getAttribute("interaction"));
  }

  #maybeStart(): void {
    if (this.#stage || this.#waiting || !this.isConnected || !this.#shadow) return;
    if (this.#lazy() && !this.#visible) return;
    if (!this.clientWidth || !this.clientHeight) return;
    if (contextPool.request(this)) this.#start();
    else this.#waiting = true;
  }

  #start(): void {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("part", "canvas");
    canvas.setAttribute("aria-hidden", "true");
    // Under the still (if any), which is removed once the new card has drawn.
    if (this.#still) this.#shadow!.insertBefore(canvas, this.#still);
    else this.#shadow!.append(canvas);
    this.#canvas = canvas;
    this.#stage = createEngineStage(canvas, {
      quality: parseQuality(this.getAttribute("quality")),
      fit: parseFit(this.getAttribute("fit")),
      interactive: this.#interaction() === "drag",
      intro: false,
      element: this,
      label: accessibleLabel(this.getAttribute("label"), this.#design),
      // A fall-over to the WebGL build draws on a fresh canvas.
      onCanvas: (next) => {
        next.setAttribute("part", "canvas");
        next.setAttribute("aria-hidden", "true");
        this.#canvas = next;
      },
    });
    this.#started();
  }

  #started(): void {
    this.#syncPaused();
    this.#applyInteractionMode();
    if (this.#design) void this.#show(this.#design);
  }

  /** Disposes the stage; a promise when its context goes only later (an engine still starting). */
  #destroyStage(): Promise<void> | undefined {
    const stage = this.#stage;
    if (!stage) return this.#releasing ?? undefined;
    this.#stage = null;
    this.#ready = false;
    // The stage frees its context in dispose (it counts against the browser's per-page limit until
    // then); a canvas whose context was lost can't get a new one, so the next start makes a fresh one.
    stage.dispose();
    this.#canvas?.remove();
    this.#canvas = null;
    const released = stage.released;
    this.#releasing = released;
    void released.finally(() => {
      if (this.#releasing === released) this.#releasing = null;
    });
    return released;
  }

  /** Copy the stage's current frame into a 2D canvas that stays on screen while it has no context. */
  #keepStill(stage: EngineStage): void {
    const src = this.#canvas;
    if (!src || !src.width || !src.height) return;
    const still = this.#still ?? document.createElement("canvas");
    still.className = "still";
    still.setAttribute("aria-hidden", "true");
    still.width = src.width;
    still.height = src.height;
    stage.render(); // the drawing buffer is only readable in the task that drew it
    const ctx = still.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, still.width, still.height);
    ctx.drawImage(src, 0, 0);
    if (!still.isConnected) this.#shadow!.append(still);
    this.#still = still;
  }

  // ── design ─────────────────────────────────────────────────────────────────

  #sources(): DesignSources {
    const a = (n: string) => this.getAttribute(n);
    return {
      design: this.#designProp,
      designJson: a("design"),
      share: a("share"),
      src: a("src"),
      preset: a("preset"),
      material: a("material"),
      texture: a("texture"),
      pattern: a("pattern"),
      color: a("color"),
      name: a("name"),
      bio: a("bio"),
      font: a("font"),
      fontUrl: a("font-url"),
      lighting: a("lighting"),
      environment: a("environment"),
      floor: a("floor"),
    };
  }

  #scheduleDesign(ms: number): void {
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => void this.#resolveDesign(), ms);
  }

  async #resolveDesign(): Promise<void> {
    const mine = ++this.#resolving;
    const { design, warnings } = await resolveDesign(this.#sources());
    if (mine !== this.#resolving) return;
    for (const message of warnings) {
      console.warn(`<metal-card>: ${message}`);
      this.dispatchEvent(new CustomEvent("metal-card-error", { detail: { message } }));
    }
    this.#design = design;
    this.#updateLabel();
    this.#updateBackdrop();
    if (this.#stage) await this.#show(design);
  }

  async #show(design: CardDesign): Promise<void> {
    const stage = this.#stage;
    if (!stage) return;
    this.#ready = false;
    await stage.setDesign(design);
    if (stage !== this.#stage || design !== this.#design) return;
    this.#reportFont(design);
    this.#reportGlsl(design);
    const i = stage.interaction;
    if (i && this.#saved) i.restore(this.#saved.rot, this.#saved.flipped);
    this.#saved = null;
    stage.setRotation([0, (this.#yaw * Math.PI) / 180, 0]);
    this.#updateLabel();
    this.#kick();
    // The stage draws on its next frame; drop the still after that frame.
    requestAnimationFrame(() => {
      if (stage !== this.#stage) return;
      if (stage.paused) stage.render();
      this.#still?.remove();
      this.#still = null;
      this.#ready = true;
      this.dispatchEvent(new CustomEvent<MetalCardReadyDetail>("metal-card-ready", { detail: { design, stage } }));
    });
  }

  /** The design this card last reported GLSL layers for (once per design, not per context). */
  #glslReported: CardDesign | null = null;

  /** Custom GLSL face layers, which the engine skips (it draws WGSL): say so once per design. */
  #reportGlsl(design: CardDesign): void {
    const skipped = glslLayers(design);
    if (!skipped.length || this.#glslReported === design) return;
    this.#glslReported = design;
    const n = skipped.length;
    const message = `face shader layer${n > 1 ? "s" : ""} ${skipped.join(", ")}: custom GLSL, which the card engine doesn't run (it runs WGSL); ${n > 1 ? "they are" : "it is"} skipped and the rest of the card is drawn`;
    console.warn(`<metal-card>: ${message}`);
    this.dispatchEvent(new CustomEvent("metal-card-error", { detail: { message } }));
  }

  /** A custom font that couldn't be loaded (the card shows the default font): say so once per design. */
  #reportFont(design: CardDesign): void {
    const font = design.font;
    if (!font || typeof font !== "object") return;
    void loadCustomFont(font).then((r) => {
      if (r.ok || design !== this.#design) return;
      this.dispatchEvent(
        new CustomEvent("metal-card-error", { detail: { message: `font "${font.family}" (${font.source}): ${r.error}; showing the default font` } }),
      );
    });
  }

  #updateLabel(): void {
    const label = accessibleLabel(this.getAttribute("label"), this.#design);
    const i = this.#stage?.interaction;
    if (i) {
      // The drag interaction owns role / tabindex / aria-label ("…; showing front").
      this.removeAttribute("aria-roledescription");
      i.setLabel(label);
      return;
    }
    if (this.#interaction() === "turntable") {
      this.setAttribute("role", "button");
      if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
      this.setAttribute("aria-roledescription", "3D card");
      this.setAttribute("aria-label", `${label}; drag or use the arrow keys to turn it, Enter to flip`);
    } else {
      this.removeAttribute("aria-roledescription");
      this.setAttribute("role", this.#interaction() === "none" ? "img" : "button");
      this.setAttribute("aria-label", label);
    }
  }

  #updateBackdrop(): void {
    if (!this.#bg) return;
    this.#bg.style.background =
      this.hasAttribute("backdrop") && parseBool(this.getAttribute("backdrop"), true) ? lightingBackdropCss(this.#design?.lighting) : "";
  }

  // ── motion: pause, auto-rotate, turntable ─────────────────────────────────

  #shouldPause(): boolean {
    return parseBool(this.getAttribute("paused"), false) || !this.#visible || (typeof document !== "undefined" && document.hidden);
  }

  #syncPaused(): void {
    this.#stage?.setPaused(this.#shouldPause());
    this.#kick();
  }

  #applyInteractionMode(): void {
    const mode = this.#interaction();
    // Turntable: vertical scrolling still works over the card; none: nothing to capture.
    if (mode === "turntable") this.style.touchAction = "pan-y";
    else if (mode === "none") {
      this.style.touchAction = "";
      this.removeAttribute("tabindex");
    }
    this.#updateLabel();
  }

  #autoRotateSpeed(): number {
    return prefersReducedMotion() ? 0 : parseAutoRotate(this.getAttribute("auto-rotate"));
  }

  /** (Re)start the motion loop when something needs it. */
  #kick(): void {
    if (this.#frame || !this.#stage || this.#stage.paused) return;
    if (!this.#autoRotateSpeed() && !this.#flip && !this.#velocity) return;
    this.#last = performance.now();
    this.#frame = requestAnimationFrame(this.#tick);
  }

  #tick = (now: number): void => {
    this.#frame = 0;
    const stage = this.#stage;
    if (!stage || stage.paused) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.#last) / 1000));
    this.#last = now;
    const speed = this.#autoRotateSpeed();
    let active = false;
    if (this.#flip) {
      const k = Math.min(1, (performance.now() - this.#flip.t0) / FLIP_MS);
      this.#yaw = this.#flip.from + (this.#flip.to - this.#flip.from) * expoOut(k);
      if (k >= 1) this.#flip = null;
      active = true;
    } else if (this.#drag) {
      active = true;
    } else if (this.#velocity) {
      this.#yaw += this.#velocity * dt;
      this.#velocity *= Math.exp(-4 * dt);
      if (Math.abs(this.#velocity) < 2) this.#velocity = 0;
      active = true;
    } else if (speed && performance.now() >= this.#holdUntil) {
      this.#yaw = (this.#yaw + speed * dt) % 360;
      active = true;
    } else if (speed) active = true; // holding after an interaction
    stage.setRotation([0, (this.#yaw * Math.PI) / 180, 0]);
    if (active) this.#frame = requestAnimationFrame(this.#tick);
  };

  #hold(): void {
    this.#holdUntil = performance.now() + RESUME_AFTER_MS;
  }

  #flipTurntable(): void {
    if (!this.#stage) return;
    this.#velocity = 0;
    const from = this.#yaw;
    // To the nearest face-on yaw half a turn away.
    const to = Math.round((from + 180) / 180) * 180;
    this.#hold();
    if (prefersReducedMotion()) {
      this.#yaw = to;
      this.#stage.setRotation([0, (to * Math.PI) / 180, 0]);
      return;
    }
    this.#flip = { from, to, t0: performance.now() };
    this.#kick();
  }

  #onPointerDown(e: PointerEvent): void {
    this.#holdUntil = Infinity; // any interaction holds the auto-rotation
    if (this.#interaction() !== "turntable" || e.button !== 0 || !this.#stage) return;
    this.setPointerCapture?.(e.pointerId);
    const t = performance.now();
    this.#flip = null;
    this.#velocity = 0;
    this.#drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: this.#yaw, t, lastX: e.clientX, lastT: t, moved: false };
    this.#kick();
  }

  #onPointerMove(e: PointerEvent): void {
    const d = this.#drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.hypot(dx, e.clientY - d.y) < DRAG_SLOP_PX) return;
    d.moved = true;
    const t = performance.now();
    const w = this.clientWidth || 1;
    const yaw = d.yaw + (dx / w) * YAW_PER_WIDTH;
    const dtm = (t - d.lastT) / 1000;
    if (dtm > 0) this.#velocity = 0.6 * this.#velocity + 0.4 * ((((e.clientX - d.lastX) / w) * YAW_PER_WIDTH) / dtm);
    d.lastX = e.clientX;
    d.lastT = t;
    this.#yaw = yaw;
    this.#stage?.setRotation([0, (yaw * Math.PI) / 180, 0]);
  }

  #onPointerUp(e: PointerEvent): void {
    const d = this.#drag;
    this.#hold();
    if (!d || e.pointerId !== d.id) return;
    this.#endDrag();
    if (!d.moved && performance.now() - d.t <= CLICK_MS) {
      this.#velocity = 0;
      this.#flipTurntable();
    } else if (prefersReducedMotion() || performance.now() - d.lastT > 80) this.#velocity = 0;
    this.#kick();
  }

  #endDrag(): void {
    const d = this.#drag;
    this.#drag = null;
    this.#hold();
    if (d && this.hasPointerCapture?.(d.id)) this.releasePointerCapture(d.id);
  }

  #onKey(e: KeyboardEvent): void {
    if (this.#interaction() !== "turntable" || !this.#stage) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      this.#flip = null;
      this.#velocity = 0;
      this.#yaw += e.key === "ArrowRight" ? 15 : -15;
      this.#hold();
      this.#stage.setRotation([0, (this.#yaw * Math.PI) / 180, 0]);
      this.#kick();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.#flipTurntable();
    } else if (e.key === "Home" || e.key === "Escape") {
      e.preventDefault();
      this.reset();
    }
  }
}

/** Define the element (idempotent; a no-op outside the browser). */
export function register(tag = "metal-card"): void {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (!customElements.get(tag)) customElements.define(tag, MetalCardElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "metal-card": MetalCardElement;
  }
}
