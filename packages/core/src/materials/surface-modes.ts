/**
 * Texture-mode resolution and the per-mode constants: which mode a
 * (grain, relief, texture) triple renders as, and each mode's normal gain, roughness byte formula,
 * repeat, material anisotropy and normalScale.
 */
import type { SurfaceTexture } from "../types.ts";
import type { PatternedMode } from "./surface-height.ts";

/** @ported the Rust port (material.rs) cites it */
export type SurfaceMode = "none" | "brushed" | PatternedMode;

const KNOWN_TEXTURES: ReadonlySet<string> = new Set<SurfaceTexture>([
  "none",
  "brushed",
  "guilloche",
  "crosshatch",
  "hammered",
  "sandblasted",
  "pinpoint",
  "linen",
  "carbon-fiber",
]);

/** True for every `SurfaceTexture` value. */
export function isSurfaceTexture(value: unknown): value is SurfaceTexture {
  return typeof value === "string" && KNOWN_TEXTURES.has(value);
}

/**
 * `texture: "none"` with any grain or relief above 0.001 renders as brushed metal; only
 * grain = relief = 0 gives a flat finish. `s`, `l` are the clamped 0..1 grain and relief.
 * @ported the Rust port (material.rs) cites it
 */
export function resolveSurfaceMode(texture: SurfaceTexture, s: number, l: number): SurfaceMode {
  const patterned = texture !== "none" && texture !== "brushed";
  if (patterned) return texture;
  const brushed = texture === "brushed" || s > 0.001 || l > 0.001;
  return brushed ? "brushed" : "none";
}

/** Normal-map gain `k` and the unclamped roughness byte for a patterned mode . */
interface PatternedShading {
  gain: number;
  /** `e` = height at the texel, `mu` = texel noise in [−0.5, 0.5). Clamped to [196, 254] by the caller. */
  roughness(e: number, mu: number): number;
}

/** @archive the local three.js archive (.archive/three-engine) imports it */
export function patternedShading(mode: PatternedMode, l: number): PatternedShading {
  switch (mode) {
    case "guilloche":
      return { gain: 36 + 24 * l, roughness: (e, mu) => 238 + 6 * Math.abs(e) + mu };
    case "sandblasted":
      // Signed e, not |e| .
      return { gain: 18 + 26 * l, roughness: (e, mu) => 242 + 9 * e + 4 * mu };
    case "linen":
      return { gain: 25 + 38 * l, roughness: (e, mu) => 232 + 14 * Math.abs(e) + 2 * mu };
    case "carbon-fiber":
      return { gain: 25 + 38 * l, roughness: (e, mu) => 218 + 18 * Math.abs(e) + 2 * mu };
    case "crosshatch":
    case "pinpoint":
    case "hammered": {
      const contrast = 13 + 12 * l;
      return { gain: 48 + 52 * l, roughness: (e, mu) => 228 + Math.abs(e) * contrast + 2 * mu };
    }
  }
}

/** How the generated maps are applied. @ported the Rust port (material.rs) cites it */
export interface SurfaceModeLayout {
  repeat: [number, number];
  /** Material `anisotropy` before the quality cap. */
  anisotropy: number;
  anisotropyRotation: number;
  normalScale: [number, number];
}

/** @ported the Rust port (material.rs) cites it */
export function surfaceModeLayout(mode: SurfaceMode, s: number, l: number): SurfaceModeLayout {
  const same = (k: number): [number, number] => [k, k];
  switch (mode) {
    case "none":
      return { repeat: [1, 1], anisotropy: 0.12, anisotropyRotation: 0, normalScale: [0, 0] };
    case "brushed":
      return {
        repeat: [1.5, 7],
        anisotropy: 1,
        anisotropyRotation: Math.PI / 2,
        normalScale: [0.01 + 0.055 * s, 0.025 + 0.17 * l],
      };
    case "hammered":
      return { repeat: same(2.15), anisotropy: 0.03, anisotropyRotation: 0, normalScale: same(0.22 + 0.22 * l) };
    case "sandblasted":
      return { repeat: same(3.4), anisotropy: 0.01, anisotropyRotation: 0, normalScale: same(0.08 + 0.12 * l) };
    case "linen":
      return { repeat: same(3.1), anisotropy: 0.16, anisotropyRotation: Math.PI / 2, normalScale: same(0.13 + 0.18 * l) };
    case "carbon-fiber":
      return { repeat: same(2.35), anisotropy: 0.28, anisotropyRotation: Math.PI / 4, normalScale: same(0.16 + 0.2 * l) };
    case "crosshatch":
      return { repeat: same(2.6), anisotropy: 0.08, anisotropyRotation: Math.PI / 4, normalScale: same(0.24 + 0.16 * l) };
    case "pinpoint":
      return { repeat: same(2.4), anisotropy: 0.02, anisotropyRotation: 0, normalScale: same(0.28 + 0.18 * l) };
    case "guilloche":
      return { repeat: same(1), anisotropy: 0.06, anisotropyRotation: 0, normalScale: same(0.1 + 0.06 * l) };
  }
}
