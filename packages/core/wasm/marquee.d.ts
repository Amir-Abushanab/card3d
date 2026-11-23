// Types for marquee.js: the marquee on the Rust engine (crates/card3d-web/src/lib.rs), started like a card.

/**
 * The marquee's stage (a `CardStage` made for the marquee, crates/card3d-web/src/lib.rs): many cards in one canvas. Its operations go
 * through `call(op, args)` (`card3d_engine::marquee::op`; packages/core/src/marquee/mount.ts names them).
 */
export interface WasmMarqueeStage {
  call(op: number, args: Float64Array): Float64Array;
  buildSlot(slot: number, token: number, design: string, images?: Map<string, ImageData | Uint8Array | string>, fontFamily?: string): Promise<boolean>;
  resize(width: number, height: number): void;
  render(): void;
  setLighting(id: string): void;
  failure(): string | undefined;
  simulateDeviceLoss(): void;
  free(): void;
}

export interface MarqueeStageOptions {
  active?: boolean;
  quality?: "performance" | "full";
  lighting?: string;
  /** Play the intro fly-in. */
  intro?: boolean;
  reducedMotion?: boolean;
}

export interface EngineMarquee {
  readonly backend: "webgpu" | "webgl";
  readonly canvas: HTMLCanvasElement;
  /** The current stage; null while switching builds or after a lost context. */
  readonly stage: WasmMarqueeStage | null;
  buildSlot(slot: number, token: number, json: string, opts?: { fontFamily?: string }): Promise<boolean>;
  /** Runs `f` on the stage (a WebGPU panic moves the marquee to WebGL); `fallback` without a stage. */
  guard<T>(f: (stage: WasmMarqueeStage) => T, fallback: T): T;
  render(): void;
  simulateDeviceLoss(): void;
  dispose(): void;
}

export interface CreateMarqueeOptions {
  force?: "webgpu" | "webgl";
  stage?: MarqueeStageOptions;
  /** The canvas was swapped (WebGL fall-over): move listeners and sizing to it. */
  onCanvas?(canvas: HTMLCanvasElement): void;
  /** A new, empty stage replaced the old one (fall-over, restored context): replay the state, rebuild the cards. */
  onRestart?(stage: WasmMarqueeStage): void;
  onFallback?(why: string): void;
  onContextLost?(): void;
  resolveUrl?(src: string): string;
  /** The asset provider's name font, loaded with each card's design. */
  assets?: import("./loader.js").EngineAssets | null;
}

export function createMarquee(canvas: HTMLCanvasElement, options?: CreateMarqueeOptions): Promise<EngineMarquee>;
