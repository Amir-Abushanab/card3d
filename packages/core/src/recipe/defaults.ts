/**
 * Studio defaults and recipe normalisation.
 *
 * Invariant: `normalizeRecipe` never changes which foil a recipe renders. Every studio default equals the
 * engine's own `??` default except `matchHoloSides` (inferred, see below) and `color` (see
 * `normalizeRecipe`).
 */
import { isMaterialPreset } from "../materials/presets.ts";
import { isSurfaceTexture } from "../materials/surface-modes.ts";
import { FOIL_TEXTURES, HOLO_STYLES, type Recipe } from "../types.ts";

export * from "./controls.ts";

/** The default recipe. */
export const DEFAULT_RECIPE: Readonly<Recipe> = Object.freeze({
  material: "silver",
  pattern: "none",
  texture: "none",
  color: "#d9d6cc",
  grain: 30,
  polish: 58,
  relief: 72,
  spectrum: 0,
  abstraction: 100,
  matchHoloSides: true,
  frontHolo: false,
  holoStyle: "vmax",
  foilTexture: "etched",
  foilIntensity: 78,
  holoGlare: 68,
  holoMotion: true,
  foilScale: 100,
  foilCoverage: "cover",
  backHolo: false,
  backHoloStyle: "vmax",
  backFoilTexture: "etched",
  backFoilIntensity: 78,
  backHoloGlare: 68,
  backHoloMotion: true,
  backFoilScale: 100,
  backFoilCoverage: "cover",
});

/** `HERO_BLACK_RECIPE`: the default in black nickel. */
export const HERO_BLACK_RECIPE: Readonly<Recipe> = Object.freeze({
  ...DEFAULT_RECIPE,
  material: "nickel",
  color: "#151715",
  spectrum: 0,
});

/** The back-side foil keys whose mere presence decides `matchHoloSides`. */
export const BACK_HOLO_KEYS = [
  "backHolo",
  "backHoloStyle",
  "backFoilTexture",
  "backFoilIntensity",
  "backHoloGlare",
  "backHoloMotion",
  "backFoilScale",
  "backFoilCoverage",
] as const satisfies readonly (keyof Recipe)[];

/** True when the recipe has any back-foil key as an own property, whatever its value. */
export function hasBackHoloKeys(recipe: object): boolean {
  return BACK_HOLO_KEYS.some((key) => Object.hasOwn(recipe, key));
}

/** A recipe as found in the wild: any subset of fields, possibly null, possibly mistyped. */
export type RecipeInput = { [K in keyof Recipe]?: Recipe[K] | null } | Record<string, unknown>;

/**
 * Fills a partial or imported recipe to a complete `Recipe` with studio defaults.
 *
 * - Missing/null values take the default. Mistyped values (non-finite numbers, unknown enum strings)
 *   also take the default, so an unknown enum never reaches the engine.
 * - Numbers are kept as given, not clamped or rounded: the engine clamps where it reads them, and the
 *   surface-texture cache key uses the raw value.
 * - Booleans use JavaScript truthiness: `holoMotion`/`backHoloMotion` are true unless exactly
 *   `false`; the others are `Boolean(value)`.
 * - `matchHoloSides` missing → `!hasBackHoloKeys(input)`, the raw mapping's own fallback,
 *   not the studio's `true`. That makes `recipeToMaterialConfig(normalizeRecipe(r))` equal
 *   `partialRecipeToMaterialConfig(r)` for the holo sides.
 * - `color` missing → the studio's `#d9d6cc`. The engine would instead fall back to the preset colour
 *   colour. Recipes normally carry a colour, so this only matters for hand-written input.
 */
export function normalizeRecipe(input?: RecipeInput | null): Recipe {
  const r = (input ?? {}) as Record<string, unknown>;
  const d = DEFAULT_RECIPE;
  return {
    material: isMaterialPreset(r.material) ? r.material : d.material,
    pattern: r.pattern === "none" || r.pattern === "orbit" ? r.pattern : d.pattern,
    texture: isSurfaceTexture(r.texture) ? r.texture : d.texture,
    color: typeof r.color === "string" && r.color.trim() !== "" ? r.color : d.color,
    grain: num(r.grain, d.grain),
    polish: num(r.polish, d.polish),
    relief: num(r.relief, d.relief),
    spectrum: num(r.spectrum, d.spectrum),
    abstraction: num(r.abstraction, d.abstraction),
    matchHoloSides: r.matchHoloSides == null ? !hasBackHoloKeys(r) : Boolean(r.matchHoloSides),
    frontHolo: flag(r.frontHolo, d.frontHolo),
    holoStyle: oneOf(r.holoStyle, HOLO_STYLES, d.holoStyle),
    foilTexture: oneOf(r.foilTexture, FOIL_TEXTURES, d.foilTexture),
    foilIntensity: num(r.foilIntensity, d.foilIntensity),
    holoGlare: num(r.holoGlare, d.holoGlare),
    holoMotion: r.holoMotion !== false,
    foilScale: num(r.foilScale, d.foilScale),
    foilCoverage: oneOf(r.foilCoverage, ["cover", "tile"] as const, d.foilCoverage),
    backHolo: flag(r.backHolo, d.backHolo),
    backHoloStyle: oneOf(r.backHoloStyle, HOLO_STYLES, d.backHoloStyle),
    backFoilTexture: oneOf(r.backFoilTexture, FOIL_TEXTURES, d.backFoilTexture),
    backFoilIntensity: num(r.backFoilIntensity, d.backFoilIntensity),
    backHoloGlare: num(r.backHoloGlare, d.backHoloGlare),
    backHoloMotion: r.backHoloMotion !== false,
    backFoilScale: num(r.backFoilScale, d.backFoilScale),
    backFoilCoverage: oneOf(r.backFoilCoverage, ["cover", "tile"] as const, d.backFoilCoverage),
  };
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return value == null ? fallback : Boolean(value);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return (options as readonly unknown[]).includes(value) ? (value as T) : fallback;
}
