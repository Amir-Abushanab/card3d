import { describe, expect, test } from "vitest";
import type { HoloConfig, Recipe } from "../types.ts";
import { DEFAULT_RECIPE, normalizeRecipe } from "./defaults.ts";
import { partialRecipeToMaterialConfig, recipeToMaterialConfig } from "./to-material-config.ts";

const DEFAULT_HOLO: HoloConfig = {
  style: "vmax",
  texture: "etched",
  intensity: 78,
  glare: 68,
  responsive: true,
  scale: 100,
  coverage: "cover",
};

describe("recipeToMaterialConfig", () => {
  test("copies the material fields and drops abstraction", () => {
    const cfg = recipeToMaterialConfig({
      ...DEFAULT_RECIPE,
      material: "brass",
      color: "#e39a4a",
      polish: 64,
      grain: 42,
      pattern: "orbit",
      texture: "guilloche",
      spectrum: 7,
    });
    expect(cfg).toEqual({
      preset: "brass",
      color: "#e39a4a",
      polish: 64,
      grain: 42,
      relief: 72,
      spectrum: 7,
      pattern: "orbit",
      texture: "guilloche",
      holo: null,
      backHolo: null,
    });
    expect("abstraction" in cfg).toBe(false);
  });

  test("raw variant leaves missing scalars undefined for the engine defaults", () => {
    const cfg = partialRecipeToMaterialConfig({ material: "silver", color: "#fff", grain: 10 });
    expect(cfg).toMatchObject({ preset: "silver", grain: 10, relief: undefined, texture: undefined, polish: undefined });
  });
});

describe("holo mapping", () => {
  const front = {
    frontHolo: true,
    holoStyle: "cosmos",
    foilTexture: "sparkle",
    foilIntensity: 100,
    holoGlare: 0,
    holoMotion: false,
    foilScale: 25,
    foilCoverage: "tile",
  } as const;
  const frontHolo: HoloConfig = { style: "cosmos", texture: "sparkle", intensity: 100, glare: 0, responsive: false, scale: 25, coverage: "tile" };

  test("holo off → no foil on either side when matched", () => {
    const cfg = partialRecipeToMaterialConfig({ frontHolo: false, matchHoloSides: true, backHolo: true });
    expect(cfg.holo).toBeNull();
    expect(cfg.backHolo).toBeNull();
  });

  test("front fields with defaults", () => {
    expect(partialRecipeToMaterialConfig({ frontHolo: true }).holo).toEqual(DEFAULT_HOLO);
    expect(partialRecipeToMaterialConfig(front).holo).toEqual(frontHolo);
    expect(partialRecipeToMaterialConfig({ frontHolo: true, holoMotion: null }).holo!.responsive).toBe(true);
  });

  test("no back keys → back matches front", () => {
    expect(partialRecipeToMaterialConfig(front).backHolo).toEqual(frontHolo);
  });

  test("any back key present and matchHoloSides missing → independent back", () => {
    expect(partialRecipeToMaterialConfig({ ...front, backFoilScale: 50 }).backHolo).toBeNull();
    expect(partialRecipeToMaterialConfig({ ...front, backHolo: true }).backHolo).toEqual(DEFAULT_HOLO);
    expect(partialRecipeToMaterialConfig({ ...front, backHolo: true, backHoloStyle: "gold", backHoloMotion: false }).backHolo).toEqual({
      ...DEFAULT_HOLO,
      style: "gold",
      responsive: false,
    });
  });

  test("explicit matchHoloSides wins over back-key presence", () => {
    expect(partialRecipeToMaterialConfig({ ...front, matchHoloSides: true, backHolo: false }).backHolo).toEqual(frontHolo);
    expect(partialRecipeToMaterialConfig({ ...front, matchHoloSides: false }).backHolo).toBeNull();
    expect(partialRecipeToMaterialConfig({ ...front, matchHoloSides: false, backHolo: true }).backHolo).toEqual(DEFAULT_HOLO);
  });

  test("back-only foil when the front is off", () => {
    const cfg = partialRecipeToMaterialConfig({ frontHolo: false, matchHoloSides: false, backHolo: true, backHoloStyle: "rainbow" });
    expect(cfg.holo).toBeNull();
    expect(cfg.backHolo).toEqual({ ...DEFAULT_HOLO, style: "rainbow" });
  });

  test("normalised and raw paths agree on the foil for partial recipes", () => {
    const partials: Partial<Recipe>[] = [
      {},
      { frontHolo: true },
      { frontHolo: true, backFoilIntensity: 20 },
      { frontHolo: true, backHolo: true, backHoloStyle: "gold" },
      { frontHolo: false, backHolo: true },
      { frontHolo: true, matchHoloSides: false },
      { frontHolo: true, matchHoloSides: true, backHolo: true, backHoloStyle: "gold" },
      { ...front, holoMotion: undefined, backHolo: true, backHoloMotion: false },
    ];
    for (const p of partials) {
      const raw = partialRecipeToMaterialConfig(p);
      const norm = recipeToMaterialConfig(normalizeRecipe(p));
      expect({ holo: norm.holo, backHolo: norm.backHolo }).toEqual({ holo: raw.holo, backHolo: raw.backHolo });
    }
  });
});
