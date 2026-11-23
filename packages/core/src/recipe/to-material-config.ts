/**
 * Recipe → engine material config.
 *
 * Two entry points share one implementation:
 * - `recipeToMaterialConfig(recipe: Recipe)`: what the engine uses. `CardDesign.recipe` is a normalised
 *   `Recipe`, which always carries the back-foil keys, so `matchHoloSides` alone decides the back side.
 *   `normalizeRecipe` infers a missing `matchHoloSides` the way the raw path does, so this agrees with
 *   the raw path for every recipe (colour fallback aside, see `normalizeRecipe`).
 * - `partialRecipeToMaterialConfig(raw)`: the mapping on an un-normalised recipe
 *   (own-property `hasBackKeys`, `??` defaults, values copied unvalidated, missing scalars left
 *   undefined for `resolveMaterial`/`getSurfaceTextures` to default). For tooling and imports.
 */
import type { HoloConfig, MaterialConfig, Recipe } from "../types.ts";
import { hasBackHoloKeys } from "./defaults.ts";

/** A material config whose recipe-copied fields may be missing (raw recipes). */
export type PartialMaterialConfig = { [K in keyof MaterialConfig]: MaterialConfig[K] | undefined };

/** Holo defaults applied by the mapping itself. Equal to the studio defaults. */
const HOLO_MAPPING_DEFAULTS = {
  style: "vmax",
  texture: "etched",
  intensity: 78,
  glare: 68,
  scale: 100,
  coverage: "cover",
} as const satisfies Partial<HoloConfig>;

type RawRecipe = { [K in keyof Recipe]?: Recipe[K] | null };

/** The mapping on a complete recipe. Engine entry point. */
export function recipeToMaterialConfig(recipe: Recipe): MaterialConfig {
  return partialRecipeToMaterialConfig(recipe) as MaterialConfig;
}

/** The same mapping on a raw recipe, missing keys left to the defaults (see module comment). */
export function partialRecipeToMaterialConfig(recipe: RawRecipe): PartialMaterialConfig {
  const holo = recipe.frontHolo ? holoSide(recipe, "front") : null;
  const match = recipe.matchHoloSides ?? !hasBackHoloKeys(recipe);
  const backHolo = match ? holo : recipe.backHolo ? holoSide(recipe, "back") : null;
  // `abstraction` is deliberately dropped: it has no rendering effect.
  return {
    preset: recipe.material ?? undefined,
    color: recipe.color ?? undefined,
    polish: recipe.polish ?? undefined,
    grain: recipe.grain ?? undefined,
    relief: recipe.relief ?? undefined,
    spectrum: recipe.spectrum ?? undefined,
    pattern: recipe.pattern ?? undefined,
    texture: recipe.texture ?? undefined,
    holo,
    backHolo,
  };
}

/** One side's foil from the front or `back*` fields. */
function holoSide(r: RawRecipe, side: "front" | "back"): HoloConfig {
  const d = HOLO_MAPPING_DEFAULTS;
  if (side === "front") {
    return {
      style: r.holoStyle ?? d.style,
      texture: r.foilTexture ?? d.texture,
      intensity: r.foilIntensity ?? d.intensity,
      glare: r.holoGlare ?? d.glare,
      responsive: r.holoMotion !== false,
      scale: r.foilScale ?? d.scale,
      coverage: r.foilCoverage ?? d.coverage,
    };
  }
  return {
    style: r.backHoloStyle ?? d.style,
    texture: r.backFoilTexture ?? d.texture,
    intensity: r.backFoilIntensity ?? d.intensity,
    glare: r.backHoloGlare ?? d.glare,
    responsive: r.backHoloMotion !== false,
    scale: r.backFoilScale ?? d.scale,
    coverage: r.backFoilCoverage ?? d.coverage,
  };
}
