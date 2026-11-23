/**
 * `@card3d/core/model`: the design model without the renderer: types, defaults, presets, validation of
 * untrusted designs, share tokens, fonts, lighting presets and AR viewer support. For code that only
 * reads, checks or writes designs (a server validating uploads, a design tool's state) and never loads
 * the card engine. Everything here is also exported from `@card3d/core`.
 */
export * from "./types.ts";
export { QUALITY_PRESETS, type QualityPreset } from "./quality.ts";
export * from "./recipe/defaults.ts";
export * from "./design/index.ts";
export {
  CARD_PRESETS,
  CARD_PRESET_CATEGORIES,
  presetRecipe,
  presetExtras,
  getPreset,
  type CardPreset,
  type CardPresetCategory,
  type CardPresetExtras,
} from "./presets.ts";
export {
  LIGHTING_PRESETS,
  DEFAULT_LIGHTING,
  getLightingPreset,
  isStudioLighting,
  lightingBackdropCss,
  paintLightingBackdrop,
  type LightingPreset,
  type LightingBackdrop,
  type EnvironmentLook,
  type EnvironmentGrade,
} from "./scene/lighting-presets.ts";
export {
  CARD_FONTS,
  DEFAULT_CARD_FONT,
  getCardFont,
  registerCardFonts,
  loadCardFont,
  designFontFamily,
  loadDesignFont,
  CUSTOM_FONT_TIMEOUT_MS,
  type CardFont,
  type CardFontFile,
} from "./fonts.ts";
export {
  CUSTOM_FONT_LIMITS,
  CUSTOM_FONT_SOURCES,
  CUSTOM_FONT_WEIGHT,
  sanitizeCustomFont,
  sanitizeGoogleFamily,
  sanitizeFontLabel,
  sanitizeFontUrl,
  isFontDataUrl,
  isCustomFont,
  isMissingUpload,
  familyFromFileName,
  parseGoogleFontSpec,
  googleFontSpec,
  googleFontsCssUrl,
  loadCustomFont,
  loadedCustomFontFamily,
  type CustomFontStatus,
} from "./custom-font.ts";
export { LOGO_POSITIONS, LOGO_SCALE_RANGE, LOGO_LIMITS, USER_LOGO_RASTER } from "./card/logo-limits.ts";
export { ADDON_IDS, type AddonId } from "./addons/ids.ts";
export { arSupport, sceneViewerUrl, openQuickLook, type ArSupport, type SceneViewerOptions } from "./ar/support.ts";
