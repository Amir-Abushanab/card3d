import type { Quality } from "./types.ts";

/** Per-tier rendering budget. */
export interface QualityPreset {
  /** Device-pixel-ratio range [min, max] for a standalone canvas. */
  dpr: [number, number];
  /** Cube resolution of the studio environment map. */
  environmentResolution: number;
  /**
   * Side length N of both generated surface DataTextures, for every texture mode, not only brushed
   *. Generators work in texel units, so halving N doubles every feature's world size.
   */
  brushedTextureSize: number;
  /** Cap on the material `anisotropy` of the body/face and chip; the inlay overlay is uncapped. */
  bodyAnisotropy: number;
}

/** `full`: the desktop tier. */
export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  performance: { dpr: [1, 1.25], environmentResolution: 128, brushedTextureSize: 256, bodyAnisotropy: 0.48 },
  full: { dpr: [1, 2], environmentResolution: 256, brushedTextureSize: 512, bodyAnisotropy: 0.68 },
};
