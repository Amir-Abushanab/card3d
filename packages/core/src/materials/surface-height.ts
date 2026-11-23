/**
 * Height fields h(x, y) for the patterned surface modes. Coordinates are texel units
 * (column, row) and may be −1 or N at the borders: the texel loop takes central differences without
 * wrapping, so these must be continuous formulas, never lookups into a tiled buffer.
 */
import type { SurfacePattern } from "../types.ts";
import { cellHash as H, ridge } from "./math.ts";

/** Texture modes that go through the height-field branch of the texel loop. */
export type PatternedMode = "guilloche" | "crosshatch" | "hammered" | "sandblasted" | "pinpoint" | "linen" | "carbon-fiber";

type HeightFn = (x: number, y: number) => number;

/**
 * Builds the height function for a mode. `s` = clamped grain/100, `N` = texture size (only guilloche
 * uses it, for its centre). Anything unrecognised falls through to guilloche;
 * callers reject unknown textures before getting here.
 * @archive the local three.js archive (.archive/three-engine) imports it
 */
export function createHeightFn(mode: PatternedMode, s: number, N: number, pattern: SurfacePattern): HeightFn {
  switch (mode) {
    case "crosshatch": {
      // Two families of ±45° grooves, spacing P along x±y.
      const P = 26 - 8 * s;
      return (x, y) => 0.72 * ridge(x + y, P, 1.2) + 0.72 * ridge(x - y, P, 1.2);
    }
    case "pinpoint":
      return pinpointHeight(s);
    case "hammered":
      return hammeredHeight(s);
    case "sandblasted":
      // Two octaves of blocky value noise, independent of grain.
      return (x, y) => (H(Math.floor(0.72 * x), Math.floor(0.72 * y)) - 0.5) * 0.72 + (H(Math.floor(2.35 * x) + 17, Math.floor(2.35 * y) - 9) - 0.5) * 0.34;
    case "linen": {
      const P = 7.5 - 2.2 * s;
      return (x, y) => (0.54 * Math.sin((Math.PI * x) / P) + 0.46 * Math.sin((Math.PI * y) / P)) * (0.66 + 0.18 * Math.sin((Math.PI * (x + y)) / (2 * P)));
    }
    case "carbon-fiber": {
      const P = 12 - 3 * s;
      return (x, y) =>
        0.58 * Math.sin((Math.PI * (x + y)) / P) + 0.24 * Math.sin((Math.PI * (x - y)) / P) + 0.18 * Math.sin((Math.PI * (x + 0.34 * y)) / (2 * P));
    }
    // "guilloche", and anything else.
    default: {
      // Concentric grooves around the texture centre; full amplitude only with the orbit pattern
      //.
      const Pg = (2 * Math.PI) / (0.78 + 0.38 * s);
      const amp = pattern === "orbit" ? 1 : 0.72;
      const c = N / 2;
      return (x, y) => ridge(Math.hypot(x - c, y - c), Pg, 0.82) * amp;
    }
  }
}

/** Jittered Gaussian dimples on a P-grid; deepest of the 9 neighbouring cells. */
function pinpointHeight(s: number): HeightFn {
  const P = 23 - 7 * s;
  const r = 2.4 + 0.9 * s;
  const r2 = r * r;
  return (x, y) => {
    const i = Math.floor(x / P);
    const j = Math.floor(y / P);
    let best = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ci = i + di;
        const cj = j + dj;
        const cx = (ci + 0.5 + (H(ci, cj) - 0.5) * 0.34) * P;
        const cy = (cj + 0.5 + (H(ci + 31, cj - 19) - 0.5) * 0.34) * P;
        const ddx = x - cx;
        const ddy = y - cy;
        const g = Math.exp(-(ddx * ddx + ddy * ddy) / r2);
        if (g > best) best = g;
      }
    }
    return -best;
  };
}

/**
 * Worley-style dents of random depth. Visit order (dj outer, di inner) and the
 * strict `<` matter: they decide which cell's depth weight wins on exact distance ties.
 */
function hammeredHeight(s: number): HeightFn {
  const P = 30 - 10 * s;
  const radius = 0.58 * P;
  return (x, y) => {
    const i = Math.floor(x / P);
    const j = Math.floor(y / P);
    let dmin = Infinity;
    let wt = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ci = i + di;
        const cj = j + dj;
        const fx = (ci + 0.18 + 0.64 * H(ci, cj)) * P;
        const fy = (cj + 0.18 + 0.64 * H(ci + 47, cj - 23)) * P;
        const d = Math.hypot(x - fx, y - fy);
        if (d < dmin) {
          dmin = d;
          wt = 0.72 + 0.38 * H(ci - 11, cj + 29);
        }
      }
    }
    return -Math.sin((Math.max(0, 1 - dmin / radius) * Math.PI) / 2) * wt;
  };
}
