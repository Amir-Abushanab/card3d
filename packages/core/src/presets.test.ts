import { describe, expect, it } from "vitest";
import { CARD_PRESETS, CARD_PRESET_CATEGORIES, presetExtras } from "./presets.ts";
import { getShaderDefinition } from "./shaders/registry.ts";
import { resolveShaderParams } from "./shaders/param-values.ts";
import { ADDON_IDS } from "./addons/ids.ts";
import { EFFECT_PARAMS, coerceEffectParam } from "./effects/params.ts";

describe("presets", () => {
  it("have unique ids and known categories", () => {
    const ids = CARD_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cats = new Set(CARD_PRESET_CATEGORIES.map((c) => c.id));
    for (const p of CARD_PRESETS) expect(cats.has(p.category)).toBe(true);
  });

  it("effects presets reference valid shaders, targets, params and add-ons", () => {
    const fx = CARD_PRESETS.filter((p) => p.extras);
    expect(fx.length).toBeGreaterThanOrEqual(10);
    for (const p of fx) {
      expect(p.category).toBe("effects");
      const x = p.extras!;
      for (const layer of x.shaders ?? []) {
        const def = getShaderDefinition(layer.id);
        expect(def, `${p.id}: ${layer.id}`).toBeDefined();
        expect(def!.targets).toContain(layer.target);
        const resolved = resolveShaderParams(def!, layer.params);
        for (const [k, v] of Object.entries(layer.params ?? {})) expect(resolved[k], `${p.id}.${k}`).toEqual(v);
      }
      for (const [id, values] of Object.entries(x.addons ?? {})) {
        expect(ADDON_IDS).toContain(id);
        for (const [k, v] of Object.entries(values ?? {})) {
          const spec = (EFFECT_PARAMS[id as keyof typeof EFFECT_PARAMS] as readonly { key: string }[]).find((s) => s.key === k);
          expect(spec, `${p.id}: add-on param ${k}`).toBeDefined();
          expect(coerceEffectParam(spec as never, v)).toEqual(v);
        }
      }
    }
  });

  it("presetExtras returns a deep copy", () => {
    const p = CARD_PRESETS.find((x) => x.extras?.shaders)!;
    const a = presetExtras(p);
    a.shaders![0].side = "back";
    expect(p.extras!.shaders![0].side).not.toBe("back");
    expect(presetExtras(CARD_PRESETS[0])).toEqual({});
  });
});
