import { describe, expect, test } from "vitest";
import { HOLO_STYLES, type Recipe } from "../types.ts";
import {
  DEFAULT_RECIPE,
  RECIPE_MATERIALS,
  HERO_BLACK_RECIPE,
  HOLO_STYLE_OPTIONS,
  MATERIAL_OPTIONS,
  RECIPE_CONTROLS,
  TEXTURE_OPTIONS,
  hasBackHoloKeys,
  normalizeRecipe,
} from "./defaults.ts";

describe("DEFAULT_RECIPE", () => {
  test("exact values", () => {
    expect(DEFAULT_RECIPE).toEqual({
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
    expect(Object.isFrozen(DEFAULT_RECIPE)).toBe(true);
  });

  test("HERO_BLACK_RECIPE is the default in black nickel", () => {
    expect(HERO_BLACK_RECIPE).toEqual({ ...DEFAULT_RECIPE, material: "nickel", color: "#151715", spectrum: 0 });
  });
});

describe("normalizeRecipe", () => {
  test("empty input → studio defaults", () => {
    expect(normalizeRecipe()).toEqual(DEFAULT_RECIPE);
    expect(normalizeRecipe({})).toEqual(DEFAULT_RECIPE);
    expect(normalizeRecipe(null)).not.toBe(DEFAULT_RECIPE);
  });

  test("keeps valid values as given (no clamping or rounding)", () => {
    const r = normalizeRecipe({ material: "oxide", texture: "linen", grain: 12.5, polish: 140, foilScale: 400, color: "#ABCDEF" });
    expect(r).toMatchObject({ material: "oxide", texture: "linen", grain: 12.5, polish: 140, foilScale: 400, color: "#ABCDEF" });
  });

  test("null and mistyped values fall back to defaults", () => {
    const r = normalizeRecipe({
      material: "unobtainium",
      texture: "wood",
      pattern: "fault",
      color: "",
      grain: Number.NaN,
      polish: "58",
      holoStyle: "mega",
      foilCoverage: "edge",
      relief: null,
    } as Record<string, unknown>);
    expect(r).toMatchObject({
      material: "silver",
      texture: "none",
      pattern: "none",
      color: "#d9d6cc",
      grain: 30,
      polish: 58,
      holoStyle: "vmax",
      foilCoverage: "cover",
      relief: 72,
    });
  });

  test("booleans follow JavaScript truthiness", () => {
    expect(normalizeRecipe({ holoMotion: null }).holoMotion).toBe(true);
    expect(normalizeRecipe({ holoMotion: 0 } as Record<string, unknown>).holoMotion).toBe(true);
    expect(normalizeRecipe({ holoMotion: false }).holoMotion).toBe(false);
    expect(normalizeRecipe({ backHoloMotion: false }).backHoloMotion).toBe(false);
    expect(normalizeRecipe({ frontHolo: 1 } as Record<string, unknown>).frontHolo).toBe(true);
    expect(normalizeRecipe({ frontHolo: null }).frontHolo).toBe(false);
  });

  test("matchHoloSides missing → inferred from back-key presence", () => {
    expect(normalizeRecipe({ frontHolo: true }).matchHoloSides).toBe(true);
    expect(normalizeRecipe({ frontHolo: true, backFoilScale: 50 }).matchHoloSides).toBe(false);
    // Presence counts, whatever the value.
    expect(normalizeRecipe({ backHolo: undefined }).matchHoloSides).toBe(false);
    expect(normalizeRecipe({ backHolo: true, matchHoloSides: true }).matchHoloSides).toBe(true);
    expect(normalizeRecipe({ matchHoloSides: null, backHoloGlare: 3 }).matchHoloSides).toBe(false);
  });

  test("is idempotent", () => {
    const once = normalizeRecipe({ frontHolo: true, backHoloStyle: "gold", texture: "pinpoint" });
    expect(normalizeRecipe(once)).toEqual(once);
  });

  test("hasBackHoloKeys checks own properties only", () => {
    expect(hasBackHoloKeys({})).toBe(false);
    expect(hasBackHoloKeys({ backFoilCoverage: "tile" })).toBe(true);
    expect(hasBackHoloKeys(Object.create({ backHolo: true }))).toBe(false);
  });
});

describe("control metadata", () => {
  test("recipe materials: names and swatches", () => {
    expect(RECIPE_MATERIALS.map((m) => [m.id, m.name])).toEqual([
      ["silver", "Brushed silver"],
      ["nickel", "Black nickel"],
      ["titanium", "Graphite"],
      ["brass", "Obsidian"],
      ["oxide", "Anodized black"],
      ["carbon", "Matte"],
      ["glass", "Clear glass"],
    ]);
    expect(RECIPE_MATERIALS[5]!.swatch).toEqual({ deep: "#111312", mid: "#242725", light: "#555a54", flare: "#c4c8c0", ink: "#f0f0e8" });
    expect(MATERIAL_OPTIONS[0]).toEqual({ value: "silver", label: "Brushed silver" });
  });

  test("holo style options keep the shader index order", () => {
    expect(HOLO_STYLE_OPTIONS.map((o) => o.value)).toEqual([...HOLO_STYLES]);
  });

  test("every texture is selectable, including linen", () => {
    expect(TEXTURE_OPTIONS.map((o) => o.value)).toContain("linen");
    expect(TEXTURE_OPTIONS).toHaveLength(9);
  });

  test("a control for every recipe field, and every default is in range / in its options", () => {
    const keys = Object.keys(DEFAULT_RECIPE) as (keyof Recipe)[];
    expect(Object.keys(RECIPE_CONTROLS).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      const control = RECIPE_CONTROLS[key];
      const value = DEFAULT_RECIPE[key];
      if (control.kind === "range") {
        expect(value).toBeGreaterThanOrEqual(control.range.min);
        expect(value).toBeLessThanOrEqual(control.range.max);
      } else if (control.kind === "enum") {
        expect(control.options.map((o) => o.value)).toContain(value);
      } else if (control.kind === "boolean") {
        expect(typeof value).toBe("boolean");
      }
    }
    expect(RECIPE_CONTROLS.foilScale).toMatchObject({ kind: "range", range: { min: 25, max: 400 } });
  });
});
