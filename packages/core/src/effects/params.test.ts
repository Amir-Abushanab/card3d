import { describe, expect, it } from "vitest";
import {
  EFFECT_CATALOG,
  EFFECT_PARAMS,
  coerceEffectParam,
  defaultEffectParams,
  hsvShift,
  isDefaultParam,
  normalizeHexColor,
  resolveEffectParams,
  type EffectId,
  type EffectParamSpec,
} from "./params.ts";

const IDS = Object.keys(EFFECT_PARAMS) as EffectId[];

describe("effect param specs", () => {
  it("every spec is well formed", () => {
    for (const id of IDS) {
      const specs = EFFECT_PARAMS[id] as readonly EffectParamSpec[];
      expect(new Set(specs.map((s) => s.key)).size).toBe(specs.length);
      for (const s of specs) {
        expect(s.label.length).toBeGreaterThan(0);
        // the default is a valid value of its own spec
        expect(coerceEffectParam(s, s.default)).toEqual(s.default);
        if (s.type === "float" || s.type === "int") {
          expect(s.min).toBeLessThanOrEqual(s.default as number);
          expect(s.max).toBeGreaterThanOrEqual(s.default as number);
        }
        if (s.type === "select") expect(s.options!.some((o) => o.value === s.default)).toBe(true);
        if (s.type === "color") expect(normalizeHexColor(s.default)).toBe(s.default);
      }
    }
  });

  it("catalog covers every id with matching params", () => {
    for (const id of IDS) {
      expect(EFFECT_CATALOG[id].id).toBe(id);
      expect(EFFECT_CATALOG[id].params).toBe(EFFECT_PARAMS[id]);
    }
    expect(EFFECT_CATALOG.shine.kind).toBe("addon");
    expect(EFFECT_CATALOG.vines.kind).toBe("addon");
  });

  it("standard-look defaults", () => {
    expect(defaultEffectParams("shine")).toEqual({ tone: "gold", intensity: 1 });
    expect(defaultEffectParams("vines")).toEqual({ cycle: true, density: 1, leafColor: "#6b9e45" });
  });

  it("resolve: defaults, coercion, clamping, rejection", () => {
    expect(resolveEffectParams("vines", null)).toEqual({ cycle: true, density: 1, leafColor: "#6b9e45", time: undefined });
    const p = resolveEffectParams("vines", { density: 7.6, leafColor: "#F00", cycle: "yes", bogus: 1 });
    expect(p.density).toBe(1);
    expect(resolveEffectParams("vines", { density: -1 }).density).toBe(0.1);
    expect(p.leafColor).toBe("#ff0000");
    expect(p.cycle).toBe(true);
    expect("bogus" in p).toBe(false);
    expect(resolveEffectParams("shine", { intensity: 0.5 }).intensity).toBe(0.5);
    expect(resolveEffectParams("shine", { tone: "neon" }).tone).toBe("gold");
    expect(resolveEffectParams("vines", { time: 12 }).time).toBe(12);
  });

  it("isDefaultParam compares colours case-insensitively", () => {
    expect(isDefaultParam("vines", "leafColor", "#6B9E45")).toBe(true);
    expect(isDefaultParam("shine", "intensity", 1)).toBe(true);
    expect(isDefaultParam("shine", "intensity", 0.9)).toBe(false);
  });

  it("hsvShift is the identity at the base colour", () => {
    expect(hsvShift("#6b9e45", "#6b9e45")).toEqual([0, 1, 1]);
    const [dh] = hsvShift("#ff0000", "#00ff00");
    expect(dh).toBeCloseTo(1 / 3);
  });
});
