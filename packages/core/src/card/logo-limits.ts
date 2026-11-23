/** Limits of a design's logo (no three.js: the design model validates with them). */
import type { LogoPosition } from "../types.ts";

export const LOGO_POSITIONS: readonly LogoPosition[] = ["corner", "top-right", "center", "bottom-right"];
export const LOGO_SCALE_RANGE = { min: 0.4, max: 3 } as const;
/** Raster height of a user logo, px (width follows its aspect, ≤ 2048). */
export const USER_LOGO_RASTER = 512;
/** Limits on what a design may carry (share links and autosave): path data and raster mask URL length. */
export const LOGO_LIMITS = { pathChars: 16_000, srcChars: 96_000, aspect: [0.2, 8] as [number, number] } as const;
