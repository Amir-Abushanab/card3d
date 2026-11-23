import { describe, expect, test } from "vitest";
import type { MaterialConfig, MaterialPreset } from "../types.ts";
import { PRESET_FALLBACK_COLORS } from "./presets.ts";
import { resolveMaterial, whitenGlass } from "./scalar.ts";

const silver = (polish?: number): Partial<MaterialConfig> => ({ preset: "silver", color: "#d9d6cc", polish });

describe("resolveMaterial", () => {
  test("live reference values: silver, polish 50", () => {
    const r = resolveMaterial(silver(50));
    expect(r.roughness).toBe(0.4676397821317117);
    // The form (0.015 + 0.055·a)·cc evaluates to 0.042499999999999996 in doubles, 1 ulp below
    // 0.0425 (a lerp-shaped expression would give 0.0425 exactly). Visually irrelevant; pinned as is.
    expect(Math.abs(r.clearcoat - 0.0425)).toBeLessThanOrEqual(Number.EPSILON * 0.0425);
    expect(r.clearcoatRoughness).toBe(0.35);
  });

  // [polish, roughness, clearcoat, clearcoatRoughness], silver.
  const WORKED: [number, number, number, number][] = [
    [0, 0.64, 0.015, 0.52],
    [58, 0.4182, 0.0469, 0.3228],
    [70, 0.3346, 0.0535, 0.282],
    [100, 0.08, 0.07, 0.18],
  ];
  for (const [polish, roughness, cc, ccr] of WORKED) {
    test(`worked table: silver polish ${polish}`, () => {
      const r = resolveMaterial(silver(polish));
      expect(r.roughness).toBeCloseTo(roughness, 4);
      expect(r.clearcoat).toBeCloseTo(cc, 4);
      expect(r.clearcoatRoughness).toBeCloseTo(ccr, 4);
      expect(r).toMatchObject({ color: "#d9d6cc", metalness: 1, transmission: 0, thickness: 0, ior: 1.5 });
    });
  }

  // Rows covering every metal preset: [preset, polish, roughness, cc, ccr].
  const PRESET_ROWS: [MaterialPreset, number, number, number, number][] = [
    ["carbon", 100, 0.23, 0.021, 0.18],
    ["oxide", 0, 0.73, 0.0081, 0.52],
    ["titanium", 58, 0.4682, 0.0338, 0.3228],
    ["nickel", 29, 0.5317, 0.0387, 0.4214],
    ["brass", 64, 0.3628, 0.0562, 0.3024],
    ["oxide", 38, 0.6219, 0.0194, 0.3908],
  ];
  for (const [preset, polish, roughness, cc, ccr] of PRESET_ROWS) {
    test(`preset ${preset} polish ${polish}`, () => {
      const r = resolveMaterial({ preset, color: "#ffffff", polish });
      expect(r.roughness).toBeCloseTo(roughness, 4);
      expect(r.clearcoat).toBeCloseTo(cc, 4);
      expect(r.clearcoatRoughness).toBeCloseTo(ccr, 4);
    });
  }

  test("defaults: preset silver, polish 58, colour from the preset table", () => {
    const r = resolveMaterial({});
    expect(r.roughness).toBeCloseTo(0.4182, 4);
    expect(r.color).toBe(PRESET_FALLBACK_COLORS.silver);
    expect(resolveMaterial({ preset: "nickel" }).color).toBe("#303431");
  });

  test("polish is clamped to [0, 100]", () => {
    expect(resolveMaterial(silver(150))).toEqual(resolveMaterial(silver(100)));
    expect(resolveMaterial(silver(-20))).toEqual(resolveMaterial(silver(0)));
  });

  test("roughness clamps to [0.04, 0.88] for metals", () => {
    // nickel polish 100: 0.64 − 0.56 − 0.04 = 0.04
    expect(resolveMaterial({ preset: "nickel", polish: 100 }).roughness).toBeCloseTo(0.04, 12);
    // carbon polish 0: 0.64 + 0.15 = 0.79 (inside the clamp)
    expect(resolveMaterial({ preset: "carbon", polish: 0 }).roughness).toBeCloseTo(0.79, 12);
  });

  test("override keys win; others still computed (a full PBR override)", () => {
    const override = { roughness: 0.034, clearcoat: 0.34, clearcoatRoughness: 0.05 };
    const r = resolveMaterial(silver(58), override);
    expect(r).toMatchObject({ ...override, color: "#d9d6cc", metalness: 1, transmission: 0, ior: 1.5 });
    expect(resolveMaterial(silver(58), { color: "#123456" }).color).toBe("#123456");
  });

  test("falsy config returns the override unchanged", () => {
    const override = { roughness: 0.2 };
    expect(resolveMaterial(null, override)).toBe(override);
    expect(resolveMaterial(undefined)).toBeUndefined();
  });

  test("unknown preset throws", () => {
    expect(() => resolveMaterial({ preset: "gold" as MaterialPreset })).toThrow(/unknown material preset/);
  });
});

describe("glass preset", () => {
  test("transmission path scalars", () => {
    const a = 0.58;
    const r = resolveMaterial({ preset: "glass", color: "#c5dde4", polish: 58 });
    expect(r.metalness).toBe(0);
    expect(r.roughness).toBeCloseTo(Math.min(0.18, Math.max(0.02, 0.28 - 0.24 * a ** 1.7 - 0.12)), 12);
    expect(r.clearcoat).toBe(1);
    expect(r.clearcoatRoughness).toBeCloseTo(0.02 + 0.12 * (1 - a), 12);
    expect(r.transmission).toBe(1);
    expect(r.thickness).toBeCloseTo(0.42 + 0.28 * a, 12);
    expect(r.ior).toBe(1.5);
  });

  test("glass roughness clamps to [0.02, 0.18]", () => {
    expect(resolveMaterial({ preset: "glass", polish: 0 }).roughness).toBeCloseTo(0.16, 12);
    expect(resolveMaterial({ preset: "glass", polish: 100 }).roughness).toBe(0.02);
  });

  // sRGB <-> linear transfer (IEC 61966-2-1) written out with three r180's constants (it uses the
  // 0.41666 exponent), to check the lerp happens in linear space without calling THREE.Color.
  const toLinear = (c: number) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));
  const toSrgb = (c: number) => (c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055);
  function expectedGlass(hex: string): string {
    const target = [0xf7, 0xfc, 0xfd];
    const out = [1, 3, 5].map((i, k) => {
      const lin = toLinear(parseInt(hex.slice(i, i + 2), 16) / 255);
      const mixed = lin + (toLinear(target[k]! / 255) - lin) * 0.82;
      return Math.round(Math.min(255, Math.max(0, toSrgb(mixed) * 255)));
    });
    return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  for (const color of ["#c5dde4", "#000000", "#3700ff", "#e4f222"]) {
    test(`colour ${color} is whitened in linear space`, () => {
      const expected = expectedGlass(color);
      expect(resolveMaterial({ preset: "glass", color }).color).toBe(expected);
      expect(whitenGlass(color)).toBe(expected);
    });
  }

  test("black whitens to a light grey, not the sRGB-space midpoint", () => {
    // sRGB-space lerp would give 0.82 × 0xf7 ≈ 0xcb; the linear lerp is lighter.
    const r = parseInt(whitenGlass("#000000").slice(1, 3), 16);
    expect(r).toBeGreaterThan(0xcb);
  });

  test("an override colour is used as-is", () => {
    expect(resolveMaterial({ preset: "glass", color: "#c5dde4" }, { color: "#ff0000" }).color).toBe("#ff0000");
  });
});
