// Types for ar.js: the AR model on the Rust engine.
import type { EngineCard } from "./loader.js";

export interface EngineArOptions {
  fontFamily?: string;
  /** "glb" (Scene Viewer, glTF viewers; default) or "usdz" (AR Quick Look). */
  format?: "glb" | "usdz";
  /** Longest side of each baked map, px. Default 2048. */
  size?: number;
  /** Stand the card upright instead of lying face up. */
  upright?: boolean;
}

export function arModel(card: EngineCard, json: string, options?: EngineArOptions): Promise<Uint8Array>;
