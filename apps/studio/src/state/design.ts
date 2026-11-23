/**
 * The studio document is a plain `CardDesign` (packages/core/src/types.ts). This module creates,
 * clones, normalises and inspects designs; it never touches the renderer. Defaults, copies,
 * validation of untrusted input and the inline-upload helpers live in @card3d/core (`design/`), so
 * the embeds read a design exactly like the studio; they are re-exported here.
 */
import {
  cloneDesign,
  defaultDesign as coreDefaultDesign,
  presetExtras,
  presetRecipe,
  stripEmbeddedMedia,
  type CardDesign,
  type CardPreset,
} from "@card3d/core/model";

export { DEFAULT_PRESET_ID, cloneDesign, ensureDesign, sanitizeLogo, isEmbeddedMedia, countEmbeddedMedia, stripEmbeddedMedia } from "@card3d/core/model";

/** The environment a new studio design is lit by: the Softbox HDRI (the engine's own default is the
 * built-in studio rig, which embeds keep so they load no HDRI unless asked). */
const STUDIO_DEFAULT_ENVIRONMENT = "softbox";

/** A new studio design: the core default, staged in the Softbox environment. */
export function defaultDesign(): CardDesign {
  return { ...coreDefaultDesign(), scene: { environment: STUDIO_DEFAULT_ENVIRONMENT } };
}

/**
 * Apply a preset to a design, keeping identity, artwork, stickers and the name layout. Presets are
 * "start from" looks: the finish is replaced and every add-on, face shader and material / branding
 * override is cleared, then the preset's own extras (effects category) are applied.
 */
export function withPreset(d: CardDesign, preset: CardPreset): CardDesign {
  const next = cloneDesign(d);
  next.recipe = presetRecipe(preset);
  delete next.materialOverride;
  delete next.brandingOverride;
  delete next.addons;
  delete next.shaders;
  Object.assign(next, presetExtras(preset));
  return next;
}

/** Cheap structural fingerprint: long strings are summarised so data URLs are never re-serialised. */
export function fingerprint(d: CardDesign): string {
  return JSON.stringify(d, (_k, v) => (typeof v === "string" && v.length > 256 ? `§${v.length}:${v.slice(0, 48)}…${v.slice(-96)}` : v));
}

/** The recipe document ("spec" export / recipe import format). */
export function toRecipeSpec(d: CardDesign): Record<string, unknown> {
  const { design } = stripEmbeddedMedia(d);
  return {
    recipe: { ...design.recipe },
    cardholderName: design.cardholderName,
    cardholderBio: design.cardholderBio,
    decals: design.decals,
    surfaceTreatments: design.surfaceTreatments,
  };
}
