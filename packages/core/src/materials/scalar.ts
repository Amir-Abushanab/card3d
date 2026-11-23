/**
 * Scalar PBR parameters from a material config: the polish curves, shaped by the preset
 * modifiers, with any `MaterialOverride` key winning over the computed value.
 */
import type { MaterialConfig, MaterialOverride } from "../types.ts";
import { clamp } from "./math.ts";
import { isMaterialPreset, PRESET_FALLBACK_COLORS, PRESET_MODIFIERS } from "./presets.ts";

export interface ResolvedMaterial {
  color: string;
  metalness: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  transmission: number;
  thickness: number;
  ior: number;
}

/** Engine default polish when the config has none. */
const DEFAULT_POLISH = 58;

/** Glass whitening target and amount, applied in linear space. */
const GLASS_TINT = "#f7fcfd";
const GLASS_TINT_AMOUNT = 0.82;

/**
 * Accepts a full `MaterialConfig` or a raw one whose fields may be missing (see
 * `partialRecipeToMaterialConfig`); missing fields take the engine defaults.
 */
export type MaterialConfigInput = Partial<MaterialConfig>;

/**
 * A falsy config returns `override` unchanged (possibly undefined), letting each
 * consumer's own defaults apply. Throws on an unknown preset.
 */
export function resolveMaterial(config: MaterialConfigInput, override?: MaterialOverride): ResolvedMaterial;
export function resolveMaterial(config?: MaterialConfigInput | null, override?: MaterialOverride): ResolvedMaterial | MaterialOverride | undefined;
export function resolveMaterial(config?: MaterialConfigInput | null, override?: MaterialOverride): ResolvedMaterial | MaterialOverride | undefined {
  if (!config) return override;
  const o = override ?? {};
  const preset = config.preset ?? "silver";
  if (!isMaterialPreset(preset)) throw new Error(`card3d: unknown material preset "${String(preset)}"`);
  const p = PRESET_MODIFIERS[preset];
  const a = clamp((config.polish ?? DEFAULT_POLISH) / 100, 0, 1);
  const shine = Math.pow(a, 1.7);
  const baseColor = o.color ?? config.color ?? PRESET_FALLBACK_COLORS[preset];

  if (preset === "glass") {
    return {
      color: o.color ?? whitenGlass(baseColor),
      metalness: o.metalness ?? 0,
      roughness: o.roughness ?? clamp(0.28 - 0.24 * shine + p.roughnessBias, 0.02, 0.18),
      clearcoat: o.clearcoat ?? 1,
      clearcoatRoughness: o.clearcoatRoughness ?? 0.02 + 0.12 * (1 - a),
      transmission: o.transmission ?? 1,
      thickness: o.thickness ?? 0.42 + 0.28 * a,
      ior: o.ior ?? 1.5,
    };
  }
  return {
    color: baseColor,
    metalness: o.metalness ?? p.metalness,
    roughness: o.roughness ?? clamp(0.64 - 0.56 * shine + p.roughnessBias, 0.04, 0.88),
    clearcoat: o.clearcoat ?? (0.015 + 0.055 * a) * p.clearcoat,
    clearcoatRoughness: o.clearcoatRoughness ?? 0.52 - 0.34 * a,
    transmission: o.transmission ?? 0,
    thickness: o.thickness ?? 0,
    ior: o.ior ?? 1.5,
  };
}

/** sRGB ↔ linear as three's `ColorManagement` converts them (its constants, bit for bit). */
const srgbToLinear = (c: number) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));
const linearToSrgb = (c: number) => (c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055);

/** A `#rgb` / `#rrggbb` colour in linear values, as `new THREE.Color(css)` holds it (anything else: white, as three leaves it). */
function linearRgb(css: string): [number, number, number] {
  const m = /^#([A-Fa-f\d]+)$/.exec(css.trim());
  const hex = m?.[1] ?? "";
  let rgb: number[];
  if (hex.length === 3) rgb = [...hex].map((c) => parseInt(c, 16) / 15);
  else if (hex.length === 6) rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  else return [1, 1, 1];
  return rgb.map(srgbToLinear) as [number, number, number];
}

/**
 * Glass body colour: lerp toward near-white by 0.82 in the linear working space (sRGB string → linear,
 * lerp, → sRGB hex), exactly as three's `Color.lerp` and `getHexString` do it.
 */
export function whitenGlass(color: string): string {
  const a = linearRgb(color);
  const b = linearRgb(GLASS_TINT);
  const byte = (i: number) => Math.round(Math.min(255, Math.max(0, linearToSrgb(a[i] + (b[i] - a[i]) * GLASS_TINT_AMOUNT) * 255)));
  return `#${("000000" + (byte(0) * 65536 + byte(1) * 256 + byte(2)).toString(16)).slice(-6)}`;
}
