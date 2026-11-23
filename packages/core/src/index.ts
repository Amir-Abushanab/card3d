/**
 * @card3d/core public API: the card engine's stage
 * (`createEngineStage`, `createOffscreenStage`: the Rust engine on WebGPU, else its WebGL 2 build,
 * crates/) and the design model it draws (`./model.ts`: types, defaults, presets, validation, share
 * tokens, fonts, lighting presets, AR viewer support), plus the scene environments' catalog and the
 * public asset provider.
 *
 * Subpaths: `@card3d/core/model` (the model alone, without the engine's loader), `/engine` (the stage
 * alone), `/editor` (a design editor's catalogs and parsers), `/describe`, `/print`, `/marquee`,
 * `/standalone` (the CDN bundle).
 */
export * from "./model.ts";
export * from "./engine.ts";
export { SCENE_ENVIRONMENTS, getSceneEnvironment, type SceneEnvironment } from "./scene/environments.ts";
// The public asset provider (procedural card, generic mark, Inter): what `mountMarquee` and custom hosts pass as `assets`.
export { createPublicAssets, PUBLIC_FONT_FAMILY, GENERIC_MARK } from "./scene/public-assets.ts";
