// The catalogs the Rust design validator (crates/card3d-engine/src/validate/) reads, taken from the
// TypeScript that defines them, so the two validators can't drift apart: material, texture, foil, font,
// lighting, shader and effect ids, parameter tables, ranges, and the field lists `lintDesign` checks
// keys against. Written as crates/card3d-engine/src/validate/catalog.json.
//
//   node crates/card3d-tools/validate-catalog.ts          # write it
//   node crates/card3d-tools/validate-catalog.ts --check  # fail when it is stale (validate-compare.ts runs this)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_RECIPE, RECIPE_CONTROLS } from "../../packages/core/src/recipe/defaults.ts";
import { PRESET_MODIFIERS } from "../../packages/core/src/materials/presets.ts";
import { FOIL_TEXTURES, HOLO_STYLES } from "../../packages/core/src/types.ts";
import { CARD_FONTS } from "../../packages/core/src/fonts.ts";
import { LIGHTING_PRESETS } from "../../packages/core/src/scene/lighting-presets.ts";
import { LOGO_LIMITS, LOGO_POSITIONS, LOGO_SCALE_RANGE } from "../../packages/core/src/card/logo-limits.ts";
import { BUILTIN_SHADERS } from "../../packages/core/src/shaders/registry.ts";
import { COMMON_GLOBALS, COMMON_UNIFORMS } from "../../packages/core/src/shaders/prelude.ts";
import { EFFECT_PARAMS } from "../../packages/core/src/effects/params.ts";
import { ADDON_IDS } from "../../packages/core/src/addons/ids.ts";
import { CORNER_RADIUS_RANGE } from "../../packages/core/src/geometry/constants.ts";
import { CONTACTLESS_SCALE } from "../../packages/core/src/card/contactless.ts";
import { DECAL_LIMITS } from "../../packages/core/src/design/decal.ts";
import { DEFAULT_NAME } from "../../packages/core/src/design/design.ts";
import * as F from "../../packages/core/src/describe/fields.ts";

const KNOWN_TEXTURES = (RECIPE_CONTROLS.texture as { options: { value: string }[] }).options.map((o) => o.value);

export function catalog(): unknown {
  const keys = (t: object) => Object.keys(t);
  return {
    defaultName: DEFAULT_NAME,
    defaultRecipe: DEFAULT_RECIPE,
    materials: Object.keys(PRESET_MODIFIERS),
    textures: KNOWN_TEXTURES,
    holoStyles: HOLO_STYLES,
    foilTextures: FOIL_TEXTURES,
    recipeControls: Object.entries(RECIPE_CONTROLS).map(([key, c]) => ({
      key,
      kind: c.kind,
      ...("options" in c && c.options ? { options: c.options.map((o: { value: string }) => o.value) } : {}),
      ...("range" in c && c.range ? { min: c.range.min, max: c.range.max } : {}),
    })),
    fonts: CARD_FONTS.map((f) => f.id),
    lighting: LIGHTING_PRESETS.map((l) => l.id),
    logo: {
      positions: LOGO_POSITIONS,
      scaleMin: LOGO_SCALE_RANGE.min,
      scaleMax: LOGO_SCALE_RANGE.max,
      pathChars: LOGO_LIMITS.pathChars,
      srcChars: LOGO_LIMITS.srcChars,
    },
    shaders: BUILTIN_SHADERS.map((s) => ({
      id: s.id,
      targets: s.targets,
      defaultTarget: s.defaultTarget,
      params: s.params.map((p) => ({ key: p.key, type: p.type, ...(p.options?.length ? { options: p.options.map((o) => o.value) } : {}) })),
    })),
    prelude: [...COMMON_UNIFORMS, ...COMMON_GLOBALS],
    effects: Object.entries(EFFECT_PARAMS).map(([id, specs]) => ({
      id,
      params: (specs as readonly { key: string; type: string; min?: number; max?: number; options?: readonly { value: string }[] }[]).map((p) => ({
        key: p.key,
        type: p.type,
        ...(p.min !== undefined ? { min: p.min } : {}),
        ...(p.max !== undefined ? { max: p.max } : {}),
        ...(p.options ? { options: p.options.map((o) => o.value) } : {}),
      })),
    })),
    addons: ADDON_IDS,
    cornerRadius: CORNER_RADIUS_RANGE,
    contactlessScale: { min: CONTACTLESS_SCALE.min, max: CONTACTLESS_SCALE.max },
    decal: { minCrop: DECAL_LIMITS.minCrop, aspectMin: DECAL_LIMITS.aspect.min, aspectMax: DECAL_LIMITS.aspect.max },
    fields: {
      design: keys(F.DESIGN_FIELDS),
      materialOverride: keys(F.MATERIAL_OVERRIDE_FIELDS),
      brandingOverride: keys(F.BRANDING_OVERRIDE_FIELDS),
      finish: keys(F.FINISH_FIELDS),
      edge: keys(F.EDGE_FIELDS),
      shape: keys(F.SHAPE_FIELDS),
      contactless: keys(F.CONTACTLESS_FIELDS),
      textLine: keys(F.TEXT_LINE_FIELDS),
      logo: keys(F.LOGO_FIELDS),
      scene: keys(F.SCENE_FIELDS),
      floor: keys(F.FLOOR_FIELDS),
      layer: keys(F.LAYER_FIELDS),
      addon: keys(F.ADDON_FIELDS),
    },
  };
}

export const CATALOG_PATH = resolve(import.meta.dirname, "../card3d-engine/src/validate/catalog.json");
export const catalogText = () => `${JSON.stringify(catalog(), null, 1)}\n`;

if (import.meta.main) {
  const text = catalogText();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(CATALOG_PATH, "utf8");
    } catch {
      /* missing */
    }
    if (current !== text) {
      console.error(`${CATALOG_PATH} is stale: run node crates/card3d-tools/validate-catalog.ts`);
      process.exit(1);
    }
    console.log("catalog.json is current");
  } else {
    writeFileSync(CATALOG_PATH, text);
    console.log(`wrote ${CATALOG_PATH}`);
  }
}
