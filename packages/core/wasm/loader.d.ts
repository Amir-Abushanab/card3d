// Types for loader.js: the Rust engine (crates/card3d-web) on a canvas, WebGPU with the WebGL 2 fallback.

/** The engine's stage options (`card3d_engine::stage::StageOptions`). */
export interface EngineStageOptions {
  quality?: "performance" | "full";
  fit?: "studio" | "contain";
  interactive?: boolean;
  intro?: boolean;
  reducedMotion?: boolean;
  fitToViewport?: boolean;
  /** Degrees. */
  defaultRotation?: { x: number; y: number };
}

/**
 * A card's `CardStage` (crates/card3d-web/src/lib.rs) as the page sees it (`cardStage`: the binding's
 * numeric `call` by name). Pointer coordinates are CSS pixels; times are ms.
 */
export interface WasmCardStage {
  /** Builds a design on this stage's GPU as a `BUILD` kind; `a`, `b` the kind's numbers. */
  build(kind: number, design: string, images?: Map<string, ImageData | Uint8Array | string>, fontFamily?: string, a?: number, b?: number): Promise<unknown>;
  /** Checks on the GPU's work (readbacks arrive on a poll on the WebGL build). */
  poll(): void;
  /** `images`: the design's images by src (`full:` + src at full size), and a scene's environment by `env:` + its id or URL (pixels, or a `.hdr` file's bytes). */
  setDesign(design: string, images?: Map<string, ImageData | Uint8Array | string>, fontFamily?: string): Promise<boolean>;
  setQuality(quality: string): void;
  setFit(fit: string): void;
  resize(width: number, height: number): void;
  /** Bit flags: 1 keep drawing, 2 rotation changed, 4 flipped changed. */
  advance(now: number): number;
  render(): void;
  setRotation(x: number, y: number, z: number): void;
  setLift(y: number): void;
  /** Orbits the camera around its framing target: degrees, and a multiplier on the framing distance; (0, 0, 1) is none. */
  setCameraOrbit(azimuth: number, elevation: number, distance: number): void;
  /** Places the camera `z` from its target (the page frames the card itself); not finite or ≤ 0: the stage's own distance. */
  setCameraDistance(z: number): void;
  /** The page's pointer in the canvas's normalised device coordinates (y up; beyond ±1 outside it), NaN once it left the page (face shader layers that follow it keep drawing by themselves). */
  setPointer(x: number, y: number): void;
  /** A wheel event on the page (`deltaX`, `deltaY`): liquid metal stirs. */
  wheel(dx: number, dy: number): void;
  hasCard(): boolean;
  /** JSON: [{ index, side, errors: [{ line, message }] }] (face shader layers that couldn't be built). */
  shaderErrors(): string;
  /** Checks custom WGSL face shader code on this GPU without building a card: its errors as `shaderErrors` gives them. */
  checkShader(code: string): Promise<string>;
  /**
   * The card's and the camera's placement for the current canvas: the card's world transform (16,
   * column-major), the camera's view matrix (16), its eye (3), its vertical field of view (degrees) and
   * the interaction root's quaternion (x, y, z, w). Empty before the first card.
   */
  view(): Float64Array;
  /**
   * Sticker `decal` placed and edited without a rebuild: [x, y, width, height (card units), rotation
   * (degrees), crop x, y, w, h, flip h, flip v, opacity, tint r, g, b (0..1), tint amount, brightness,
   * contrast, saturation], or nothing to leave it. Returns [z, the picture's aspect]; empty when the card
   * doesn't show it.
   */
  sticker(decal: number, values?: ArrayLike<number>): Float64Array;
  setStickerFrame(decal: number, frame: ImageData): boolean;
  pointerDown(id: number, x: number, y: number, width: number, height: number, now: number): boolean;
  pointerMove(id: number, x: number, y: number, now: number): boolean;
  pointerUp(id: number, x: number, y: number, now: number): void;
  pointerCancel(id: number): void;
  doubleClick(): void;
  key(key: string, now: number): boolean;
  toggleFlip(now: number): void;
  setFlipped(flipped: boolean, now: number): void;
  reset(): void;
  /** Degrees; at once, without events. */
  restorePose(x: number, y: number, flipped: boolean): void;
  /** The interaction's rotation (degrees), without events; a flip in progress goes on. */
  setInteractionRotation(x: number, y: number): void;
  setActive(active: boolean, now: number): void;
  setVisible(visible: boolean): void;
  setReducedMotion(reduced: boolean): void;
  flipped(): boolean;
  rotationX(): number;
  rotationY(): number;
  introState(): string | undefined;
  failure(): string | undefined;
  simulateDeviceLoss(): void;
  free(): void;
}

/** One item of a print job (`PrintJob::items`, crates/card3d-engine/src/print.rs). */
export interface EnginePrintItem {
  i: number;
  /** 0 other, 1 body, 2 face, 3 artwork, 4 foil, 5 chip, 6 chip mask, 7 glass, 8 mark, 9 sticker, 10 overlay, 11 add-on. */
  role: number;
  /** Marks: 1 logo, 2 name, 3 bio, 4 text line, 5 contactless; faces: 1 = the back. */
  kind: number;
  /** A text line's number, a sticker's decal index. */
  n: number;
  /** 0 default, 1 embossed, 2 engraved, 3 etched. */
  finish: number;
  /** 0 front, 1 back. */
  side: number;
  pos: [number, number, number];
  axis: [number, number, number];
  plane: [number, number];
  pad: [number, number];
  image: [number, number];
  uv: [number, number];
  map: boolean;
  custom: boolean;
}

export interface EnginePrintJob {
  readonly backend: "webgpu" | "webgl";
  items(): EnginePrintItem[];
  maxSize(): number;
  /** A side's full-resolution artwork (straight alpha, sRGB). */
  setArtwork(back: boolean, image: ImageData): void;
  /**
   * Renders a pass: [side (0 front, 1 back), target (0 colour, 1 mask), width, height, half width,
   * half height, then a choice and a value per item]. Resolves to RGBA rows top first (empty: failed).
   */
  render(spec: Float32Array): Promise<Uint8Array>;
  free(): void;
}

export interface EngineCard {
  readonly backend: "webgpu" | "webgl";
  readonly canvas: HTMLCanvasElement;
  /** The current stage; null while switching builds. Read it each time: a fall-over replaces it. */
  readonly stage: WasmCardStage | null;
  /** Settles once the design's animated stickers have shown their first frame (or given up). */
  readonly stickersReady: Promise<void>;
  /** True between a lost WebGL context and the card's rebuild (the WebGL build). */
  readonly contextLost: boolean;
  setDesign(json: string, opts?: { fontFamily?: string }): Promise<boolean>;
  resize(width: number, height: number): void;
  setRotation(x: number, y: number, z: number): void;
  setLift(y: number): void;
  /** Degrees, and a multiplier on the framing distance (camera paths). */
  setCameraOrbit(azimuth: number, elevation: number, distance: number): void;
  /** Places the camera `z` from its target (the page frames the card itself); NaN: the stage's own distance. */
  setCameraDistance(z: number): void;
  /** Builds a design for a print bake on this card's GPU (the engine's `print` part). */
  printJob(json: string, opts?: { fontFamily?: string }): Promise<EnginePrintJob>;
  /** Builds a design on this card's GPU as a `BUILD` kind (with the design's images); `a`, `b` the kind's numbers. */
  build(kind: number, json: string, opts?: { fontFamily?: string }, a?: number, b?: number): Promise<unknown>;
  advance(now: number): number;
  render(): void;
  /** Holds the animated stickers on their current frame (a paused or hidden card), or lets them go on. */
  setPaused(paused: boolean): void;
  simulateDeviceLoss(): void;
  dispose(): void;
}

export interface CreateCardOptions {
  force?: "webgpu" | "webgl";
  /** The canvas was swapped (WebGL fall-over): move listeners and sizing to it. */
  onCanvas?(canvas: HTMLCanvasElement): void;
  /** The WebGL card is ready after a fall-over: draw a frame. */
  onFallback?(why: string): void;
  /** The WebGL build's context was lost; the card is rebuilt when the browser restores it. */
  onContextLost?(): void;
  /** The card was rebuilt after a lost context: draw a frame. */
  onContextRestored?(): void;
  /** An animated sticker has a new frame: draw a frame. */
  onStickerFrame?(): void;
  resolveUrl?(src: string): string;
  /** The URL a scene's environment (a catalog id, or a URL) loads from, or a promise of it; null: none. Default: `.hdr` / `.webp` URLs only. */
  environmentUrl?(env: string): string | null | Promise<string | null>;
  /** The asset provider's name font and licensed assets (`AssetProvider`), loaded with the design. */
  assets?: EngineAssets | null;
  fontFamily?: string;
  stage?: EngineStageOptions;
}

export function createCard(canvas: HTMLCanvasElement, design: string, options?: CreateCardOptions): Promise<EngineCard>;
/** `CardStage.call` operations (crates/card3d-web/src/lib.rs). */
export const OP: Readonly<Record<string, number>>;
/** `CardStage.build` kinds. */
export const BUILD: { readonly DESIGN: 0; readonly SLOT: 1; readonly PRINT: 2; readonly AR: 3; readonly CHECK: 4 };
/** The page's view of a wasm `CardStage`. */
export function cardStage(raw: unknown): WasmCardStage;
/** What the engine takes from an asset provider (`AssetProvider`): its name font. */
export interface EngineAssets {
  nameFontFamily?: string;
}
export function loadDesignImages(
  design: unknown,
  resolveUrl?: (src: string) => string,
  environmentUrl?: ((env: string) => string | null | Promise<string | null>) | null,
  assets?: EngineAssets | null,
): Promise<Map<string, ImageData | Uint8Array | string>>;
export function loadEngine(backend: "webgpu" | "webgl"): Promise<unknown>;
/**
 * Starts downloading the build a card will most likely start on (and asking for a WebGPU adapter), so
 * it doesn't wait for a design's fonts and images; returns that build. `createCard` calls it too.
 */
export function preloadEngine(force?: "webgpu" | "webgl"): "webgpu" | "webgl";
/** Whether an earlier load showed WebGPU to be unsafe here (a failure this week, or a start that crashed the tab). */
export function webgpuDistrusted(): boolean;
/**
 * Sets the "starting" mark for a WebGPU start on this page and holds it until `release(failed)` (the
 * start confirmed or disposed; `true`: WebGPU failed, the mark becomes "failed").
 */
export function holdWebgpuStart(): (failed?: boolean) => void;
