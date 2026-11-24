/**
 * The parts of the engine a design needs (wasm/loader.js `engineParts`): the page downloads them with
 * the main module, so they should be the ones crates/card3d-engine/src/card.rs builds the design with.
 */
import { describe, expect, it } from "vitest";
import { engineParts } from "../wasm/loader.js";
import { ensureDesign } from "./design/design.ts";
import { CARD_PRESETS, presetExtras, presetRecipe } from "./presets.ts";

describe("engineParts", () => {
  it("names nothing for a plain card", () => {
    expect(engineParts(ensureDesign({ recipe: { material: "silver" } }))).toEqual([]);
  });

  it("names each feature's part", () => {
    const design = ensureDesign({
      recipe: { material: "silver", frontHolo: true, foilIntensity: 60 },
      shape: { orientation: "portrait" },
      edge: { finish: "metal" },
      shaders: [{ id: "liquid-metal", side: "front" }],
      decals: [{ src: "data:image/png;base64,AAAA" }],
      addons: { shine: true, vines: {} },
      scene: { floor: {} },
    });
    expect(engineParts(design).sort()).toEqual(["edge", "faces", "holo", "liquid_metal", "scene", "shape", "shine", "stickers", "vines"]);
  });

  it("gives a glass card its slab and none of the metal body's parts", () => {
    const parts = engineParts(ensureDesign({ recipe: { material: "glass", frontHolo: true, foilIntensity: 60 }, shape: { orientation: "portrait" } }));
    expect(parts).toContain("glass");
    expect(parts).not.toContain("shape");
    expect(parts).not.toContain("holo");
  });

  it("leaves out disabled face shaders and off add-ons", () => {
    const design = ensureDesign({ recipe: { material: "silver" }, shaders: [{ id: "halftone", enabled: false }], addons: { shine: false } });
    expect(engineParts(design)).toEqual([]);
  });

  it("names a preset's face shaders and add-ons", () => {
    const parts = (id: string) => {
      const p = CARD_PRESETS.find((c) => c.id === id)!;
      return engineParts(ensureDesign({ ...presetExtras(p), recipe: presetRecipe(p) }));
    };
    expect(parts("liquid-mark")).toEqual(expect.arrayContaining(["faces", "liquid_metal"]));
    expect(parts("silver-vines")).toContain("vines");
    expect(parts("gold-shine")).toContain("shine");
  });
});
