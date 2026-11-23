import { describe, expect, it } from "vitest";
import { LIGHTING_PRESETS, getLightingPreset, isStudioLighting, lightingBackdropCss } from "./lighting-presets.ts";
import { STUDIO_LIGHTS, TONE_MAPPING_EXPOSURE } from "./light-values.ts";

describe("lighting presets", () => {
  it("cover the six looks with unique ids; unknown ids are the studio", () => {
    expect(LIGHTING_PRESETS.map((p) => p.id)).toEqual(["studio", "dramatic", "warm", "cool", "dark", "light"]);
    expect(getLightingPreset("nope").id).toBe("studio");
    expect(getLightingPreset(null).id).toBe("studio");
    expect(isStudioLighting(undefined)).toBe(true);
    expect(isStudioLighting("warm")).toBe(false);
  });

  it("studio is the identity: the rig's own values and no environment look", () => {
    const s = getLightingPreset("studio");
    expect(s.env).toEqual({});
    expect(s.envIntensity).toBe(1);
    expect(s.envRotationY).toBe(0);
    expect(s.exposure).toBe(TONE_MAPPING_EXPOSURE);
    expect(s.ambient).toEqual(STUDIO_LIGHTS.ambient);
    expect(s.key.intensity).toBe(STUDIO_LIGHTS.key.intensity);
    expect(s.key.position).toEqual([...STUDIO_LIGHTS.key.position]);
    expect(s.frontFill).toBe(1);
  });

  it("the dark-backdrop presets carry rim panels; studio and light don't", () => {
    for (const p of LIGHTING_PRESETS) expect(!!p.env.rim, p.id).toBe(p.backdrop.dark && p.id !== "studio");
  });

  it("every preset but studio grades an HDRI environment; studio leaves it as loaded", () => {
    expect(getLightingPreset("studio").hdri).toBeUndefined();
    for (const p of LIGHTING_PRESETS.filter((x) => x.id !== "studio")) expect(p.hdri, p.id).toBeDefined();
    const g = (id: string) => getLightingPreset(id).hdri!;
    // Dark is darker everywhere, light brighter; dramatic lifts the key over a darker room.
    for (const k of ["key", "fill", "base"] as const) {
      expect(g("dark")[k]!, `dark ${k}`).toBeLessThan(1);
      expect(g("light")[k]!, `light ${k}`).toBeGreaterThan(1);
    }
    expect(g("dramatic").key!).toBeGreaterThan(1);
    expect(g("dramatic").base!).toBeLessThan(0.5);
    // Warm and cool tint by the rig's own colours (the look's keyTint / fillTint).
    for (const id of ["warm", "cool"]) expect(getLightingPreset(id).env.keyTint, id).toBeTruthy();
  });

  it("backdrops are CSS gradients; only the light preset is a light backdrop", () => {
    for (const p of LIGHTING_PRESETS) expect(lightingBackdropCss(p.id)).toMatch(/^radial-gradient\(/);
    expect(LIGHTING_PRESETS.filter((p) => !p.backdrop.dark).map((p) => p.id)).toEqual(["light"]);
  });
});
