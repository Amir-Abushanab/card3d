/**
 * `@card3d/core/editor`: what a design editor needs beyond the model (`@card3d/core/model`): the
 * face-shader library's definitions and the custom-shader parser and starters (WGSL, the language the
 * card engine draws), add-on parameters, material resolution, card geometry and print constants,
 * sticker placement, staging ranges and the public asset provider. Card Studio builds its panel from
 * these and draws on the engine (`@card3d/core`).
 */
// Face shaders: the built-in library (definitions and parameters; the engine draws them in WGSL),
// custom code parsing, the reserved prelude names and the starters.
export type { ShaderDefinition, ShaderParamSpec, ShaderParamType, ShaderParamOption, ShaderTarget, ShaderBlend, ShaderError } from "./shaders/types.ts";
export { BUILTIN_SHADERS, getShaderDefinition, listShaders } from "./shaders/registry.ts";
export { coerceParam, parseShaderColor, resolveShaderParams, uniformName, toHexColor } from "./shaders/param-values.ts";
export { parseCustomShader, customShaderDefinition, type CustomShaderParse, type CustomShaderExample } from "./shaders/custom-parse.ts";
export { WGSL_SHADER_EXAMPLES } from "./shaders/wgsl-examples.ts";
export { COMMON_UNIFORMS, COMMON_GLOBALS } from "./shaders/prelude.ts";
export { WGSL_PRELUDE_NAMES, type WgslPreludeName } from "./shaders/prelude-wgsl.ts";

// Add-on parameters (the editor's controls).
export {
  EFFECT_PARAMS,
  EFFECT_CATALOG,
  resolveEffectParams,
  defaultEffectParams,
  isDefaultParam,
  coerceEffectParam,
  type EffectId,
  type EffectParamSpec,
  type EffectParamType,
  type EffectParamOption,
  type EffectCatalogEntry,
  type ResolvedEffectParams,
} from "./effects/params.ts";

// Recipe → material.
export { recipeToMaterialConfig } from "./recipe/to-material-config.ts";
export { resolveMaterial, whitenGlass, type ResolvedMaterial } from "./materials/scalar.ts";

// Card geometry, shapes, edges and the contactless mark.
export { CARD_W, CARD_H, MM_PER_UNIT, ISO_ID1_MM, CORNER_RADIUS_MM_PER_UNIT, CORNER_RADIUS_RANGE } from "./geometry/constants.ts";
export { cardFrameSize, DEFAULT_CORNER_RADIUS, CARD_CUTOUTS, clampCornerRadius } from "./geometry/shape-frame.ts";
export { ISO_7816_CONTACTS, ISO_CHIP_PLATE, ISO_CHIP_PLATE_MM, ISO_7811_AREAS, ISO_ANTENNA, type MmRect } from "./geometry/iso.ts";
export { EDGE_FINISHES, EDGE_DEFAULT_COLOR, hasEdge, type EdgeFinish } from "./card/edge-finish.ts";
export { CONTACTLESS_SCALE } from "./card/contactless.ts";
export { contactlessHeightMm } from "./card/branding-layout.ts";

// Stickers: placement, as the engine places them.
export { decalPlacement, type DecalPlacement } from "./design/decal-placement.ts";

// Product-shot staging: the scene panel's ranges and defaults.
export { SCENE_ENVIRONMENTS, getSceneEnvironment, type SceneEnvironment } from "./scene/environments.ts";
export { SCENE_BACKDROPS, SCENE_RANGES, SCENE_DEFAULTS, resolveScene, type ResolvedScene } from "./scene/staging-view.ts";

// The public asset provider (procedural card, generic mark, Inter).
export { createPublicAssets, PUBLIC_FONT_FAMILY, GENERIC_MARK } from "./scene/public-assets.ts";
