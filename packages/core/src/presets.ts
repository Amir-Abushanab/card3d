/**
 * Public finish presets: material, surface and foil values (plus, for the "effects" category, add-on
 * and face-shader fields) — no artwork, stickers, names or bios.
 *
 * Each finish entry is a recipe with a descriptive name. A preset stores only
 * the fields that differ from `DEFAULT_RECIPE`; `presetRecipe()` fills the rest. The "effects" entries
 * are original showcases of the add-ons and face shaders on standard cards.
 */
import { DEFAULT_RECIPE, HERO_BLACK_RECIPE, normalizeRecipe } from "./recipe/defaults.ts";
import type { CardDesign, Recipe } from "./types.ts";

export type CardPresetCategory = "classic" | "colour" | "dark" | "textured" | "holo" | "effects";

/** Design fields beyond the recipe that a preset may set (everything else is left to the host). */
export type CardPresetExtras = Partial<Pick<CardDesign, "addons" | "shaders" | "materialOverride" | "brandingOverride">>;

export interface CardPreset {
  /** Stable kebab-case id (used in URLs and drafts). */
  id: string;
  name: string;
  category: CardPresetCategory;
  /** Fields that differ from `DEFAULT_RECIPE`. */
  recipe: Partial<Recipe>;
  /** Add-ons and face shaders the preset applies on top of the recipe (effects category). */
  extras?: CardPresetExtras;
}

export const CARD_PRESET_CATEGORIES: readonly { id: CardPresetCategory; label: string }[] = [
  { id: "classic", label: "Classic" },
  { id: "colour", label: "Colour" },
  { id: "dark", label: "Dark" },
  { id: "textured", label: "Textured" },
  { id: "holo", label: "Holo" },
  { id: "effects", label: "Effects" },
];

/** Front foil fields with `matchHoloSides`, so the back mirrors the front. */
const holo = (
  holoStyle: Recipe["holoStyle"],
  foilTexture: Recipe["foilTexture"],
  foilIntensity: number,
  holoGlare: number,
  foilScale: number,
  foilCoverage: Recipe["foilCoverage"] = "cover",
): Partial<Recipe> => ({
  matchHoloSides: true,
  frontHolo: true,
  holoStyle,
  foilTexture,
  foilIntensity,
  holoGlare,
  holoMotion: true,
  foilScale,
  foilCoverage,
  backHolo: true,
  backHoloStyle: holoStyle,
  backFoilTexture: foilTexture,
  backFoilIntensity: foilIntensity,
  backHoloGlare: holoGlare,
  backHoloMotion: true,
  backFoilScale: foilScale,
  backFoilCoverage: foilCoverage,
});

/** `material color grain polish relief spectrum` shorthand. */
const m = (
  material: Recipe["material"],
  color: string,
  grain: number,
  polish: number,
  relief: number,
  spectrum: number,
  extra: Partial<Recipe> = {},
): Partial<Recipe> => ({ material, color, grain, polish, relief, spectrum, ...extra });

export const CARD_PRESETS: readonly CardPreset[] = [
  // ── classic silver ─────────────────────────────────────────────────────────
  {
    id: "pearl-guilloche",
    name: "Pearl Guilloché",
    category: "classic",
    recipe: m("silver", "#dcd8ce", 50, 60, 70, 30, { texture: "guilloche", pattern: "orbit" }),
  },
  { id: "studio-silver", name: "Studio Silver", category: "classic", recipe: {} },
  { id: "clean-silver", name: "Clean Silver", category: "classic", recipe: m("silver", "#d9d6cc", 0, 58, 0, 0) },
  { id: "satin-silver", name: "Satin Silver", category: "classic", recipe: m("silver", "#d9d6cc", 0, 10, 0, 0) },
  { id: "pearl-silver", name: "Pearl Silver", category: "classic", recipe: m("silver", "#d9d6cc", 0, 71, 17, 26) },
  { id: "matte-pearl", name: "Matte Pearl", category: "classic", recipe: m("silver", "#d9d6cc", 40, 10, 18, 17) },
  { id: "bright-white", name: "Bright White Silver", category: "classic", recipe: m("silver", "#ffffff", 0, 58, 0, 22) },
  { id: "frosted-white", name: "Frosted White", category: "classic", recipe: m("silver", "#ffffff", 0, 9, 0, 0) },
  { id: "sand-silver", name: "Sand Silver", category: "classic", recipe: m("silver", "#dfc9aa", 0, 58, 0, 0) },
  { id: "champagne-silver", name: "Champagne Silver", category: "classic", recipe: m("silver", "#cda874", 0, 58, 0, 48) },
  { id: "stone-silver", name: "Stone Silver", category: "classic", recipe: m("silver", "#898b83", 0, 58, 0, 0) },
  { id: "smoked-silver", name: "Smoked Silver", category: "classic", recipe: m("silver", "#000000", 0, 58, 0, 17) },
  { id: "gunmetal-grain", name: "Gunmetal Grain", category: "classic", recipe: m("silver", "#3d3e3c", 100, 100, 100, 20) },

  // ── colour ────────────────────────────────────────────────────────────────
  { id: "glacier-spectrum", name: "Glacier Spectrum", category: "colour", recipe: m("silver", "#b8f1ff", 30, 58, 72, 100) },
  { id: "seafoam-prism", name: "Seafoam Prism", category: "colour", recipe: m("silver", "#c1d2d2", 0, 40, 0, 100) },
  { id: "sky-spectrum", name: "Sky Spectrum", category: "colour", recipe: m("silver", "#5cc9ff", 0, 65, 0, 100) },
  { id: "cornflower-mirror", name: "Cornflower Mirror", category: "colour", recipe: m("silver", "#7abfff", 0, 78, 0, 33) },
  { id: "cyan-silver", name: "Cyan Silver", category: "colour", recipe: m("silver", "#00aaff", 0, 58, 0, 0) },
  { id: "electric-blue", name: "Electric Blue Spectrum", category: "colour", recipe: m("silver", "#2495ff", 80, 58, 0, 80) },
  { id: "steel-blue-relief", name: "Steel Blue Relief", category: "colour", recipe: m("silver", "#8da6bb", 24, 44, 100, 0) },
  { id: "slate-blue", name: "Slate Blue", category: "colour", recipe: m("silver", "#476585", 0, 52, 29, 9) },
  { id: "violet-grain", name: "Violet Grain", category: "colour", recipe: m("silver", "#654fb5", 99, 22, 100, 11) },
  { id: "bubblegum-silver", name: "Bubblegum Silver", category: "colour", recipe: m("silver", "#ff9eed", 0, 58, 0, 26) },
  { id: "magenta-silver", name: "Magenta Silver", category: "colour", recipe: m("silver", "#ec008c", 0, 58, 0, 0) },
  { id: "lacquer-red", name: "Lacquer Red", category: "colour", recipe: m("silver", "#c80e0e", 0, 58, 0, 36) },
  { id: "lime-satin", name: "Lime Satin", category: "colour", recipe: m("silver", "#e4f222", 42, 40, 72, 0) },
  { id: "lime-relief", name: "Lime Relief", category: "colour", recipe: m("silver", "#e4f222", 0, 51, 100, 0) },
  { id: "acid-lime-matte", name: "Acid Lime Matte", category: "colour", recipe: m("silver", "#e4f222", 100, 3, 100, 0) },
  { id: "stone-spectrum", name: "Stone Spectrum Grain", category: "colour", recipe: m("silver", "#898b83", 100, 60, 0, 100) },

  // ── dark metals ───────────────────────────────────────────────────────────
  { id: "hero-black", name: "Hero Black Nickel", category: "dark", recipe: { ...diff(HERO_BLACK_RECIPE) } },
  { id: "graphite-shimmer", name: "Graphite Shimmer", category: "dark", recipe: m("titanium", "#d9d6cc", 0, 58, 0, 59) },
  { id: "polished-graphite", name: "Polished Graphite", category: "dark", recipe: m("titanium", "#d9d6cc", 0, 67, 0, 27) },
  { id: "obsidian-sky", name: "Obsidian Sky", category: "dark", recipe: m("brass", "#75caff", 30, 58, 72, 0) },
  { id: "obsidian-orchid", name: "Obsidian Orchid", category: "dark", recipe: m("brass", "#ab3f84", 0, 49, 100, 100) },
  { id: "obsidian-aurora", name: "Obsidian Aurora", category: "dark", recipe: m("brass", "#d9d6cc", 29, 72, 3, 95) },
  { id: "obsidian-smoke", name: "Obsidian Smoke Spectrum", category: "dark", recipe: m("brass", "#7c797b", 0, 58, 0, 77) },
  { id: "anodized-prism", name: "Anodized Prism Satin", category: "dark", recipe: m("oxide", "#ffffff", 100, 0, 0, 100) },
  { id: "aubergine-matte", name: "Aubergine Matte", category: "dark", recipe: m("carbon", "#150B0F", 56, 100, 100, 0) },
  { id: "matte-spectrum-stone", name: "Matte Spectrum Stone", category: "dark", recipe: m("carbon", "#898b83", 100, 82, 100, 100) },

  // ── textured ──────────────────────────────────────────────────────────────
  {
    id: "brass-orbit-guilloche",
    name: "Brass Orbit Guilloché",
    category: "textured",
    recipe: m("brass", "#e39a4a", 42, 64, 72, 48, { texture: "guilloche", pattern: "orbit" }),
  },
  {
    id: "aqua-orbit-guilloche",
    name: "Aqua Orbit Guilloché",
    category: "textured",
    recipe: m("silver", "#85f1ff", 15, 46, 1, 100, { texture: "guilloche", pattern: "orbit" }),
  },
  {
    id: "lime-orbit-guilloche",
    name: "Lime Orbit Guilloché",
    category: "textured",
    recipe: m("silver", "#e4f222", 55, 44, 73, 0, { texture: "guilloche", pattern: "orbit" }),
  },
  {
    id: "silver-orbit-guilloche",
    name: "Silver Orbit Guilloché",
    category: "textured",
    recipe: m("silver", "#d9d6cc", 58, 44, 74, 0, { texture: "guilloche", pattern: "orbit" }),
  },
  { id: "hammered-black-nickel", name: "Hammered Black Nickel", category: "textured", recipe: m("nickel", "#ffffff", 9, 38, 66, 0, { texture: "hammered" }) },
  { id: "crosshatch-steel", name: "Crosshatch Steel Blue", category: "textured", recipe: m("nickel", "#7293a1", 33, 29, 75, 38, { texture: "crosshatch" }) },
  { id: "white-crosshatch", name: "White Crosshatch", category: "textured", recipe: m("silver", "#ffffff", 50, 46, 58, 0, { texture: "crosshatch" }) },
  { id: "bright-crosshatch", name: "Bright Crosshatch", category: "textured", recipe: m("silver", "#ffffff", 95, 80, 58, 0, { texture: "crosshatch" }) },
  { id: "stone-crosshatch", name: "Stone Crosshatch", category: "textured", recipe: m("silver", "#898b83", 50, 46, 58, 0, { texture: "crosshatch" }) },
  { id: "pinpoint-silver", name: "Pinpoint Silver", category: "textured", recipe: m("silver", "#d9d6cc", 20, 62, 64, 0, { texture: "pinpoint" }) },
  { id: "pinpoint-oxide", name: "Pinpoint Oxide", category: "textured", recipe: m("oxide", "#898b83", 64, 38, 68, 58, { texture: "pinpoint" }) },
  { id: "brushed-tangerine", name: "Brushed Tangerine", category: "textured", recipe: m("silver", "#e65f2e", 48, 68, 38, 0, { texture: "brushed" }) },
  { id: "brushed-blush", name: "Brushed Blush", category: "textured", recipe: m("silver", "#fad1ff", 48, 68, 38, 0, { texture: "brushed" }) },
  { id: "brushed-ice-spectrum", name: "Brushed Ice Spectrum", category: "textured", recipe: m("silver", "#a8cfe0", 5, 100, 94, 72, { texture: "brushed" }) },
  { id: "sandblasted-stone", name: "Sandblasted Stone", category: "textured", recipe: m("silver", "#c9c5bc", 30, 12, 20, 0, { texture: "sandblasted" }) },
  { id: "sandblasted-lime", name: "Sandblasted Lime", category: "textured", recipe: m("silver", "#e4f222", 88, 16, 44, 0, { texture: "sandblasted" }) },

  // ── holo ──────────────────────────────────────────────────────────────────
  {
    id: "cosmos-sparkle",
    name: "Cosmos Sparkle Silver",
    category: "holo",
    recipe: { ...m("silver", "#d9d6cc", 100, 70, 0, 0), ...holo("cosmos", "sparkle", 100, 0, 25) },
  },
  {
    id: "amazing-coral",
    name: "Brushed Coral Amazing Foil",
    category: "holo",
    recipe: { ...m("silver", "#e66b4c", 48, 68, 38, 0, { texture: "brushed" }), ...holo("amazing", "microdot", 53, 45, 100) },
  },
  {
    id: "shiny-lime-tile",
    name: "Lime Shiny Tiled Foil",
    category: "holo",
    recipe: { ...m("silver", "#e4f222", 0, 58, 0, 63), ...holo("shiny", "sparkle", 49, 37, 117, "tile") },
  },

  // ── add-ons and face shaders ─────────────────────────────────────────────
  {
    id: "thermal-skin",
    name: "Thermal Skin",
    category: "effects",
    recipe: m("silver", "#3d3e3c", 0, 58, 0, 0),
    extras: { shaders: [{ id: "thermal", side: "both", target: "skin" }] },
  },
  {
    id: "liquid-mark",
    name: "Liquid Metal Mark",
    category: "effects",
    recipe: { ...diff(HERO_BLACK_RECIPE) },
    extras: { shaders: [{ id: "liquid-metal", side: "front", target: "overlay", params: { mask: 1 } }] },
  },
  {
    id: "caustic-pool",
    name: "Caustic Pool Tiles",
    category: "effects",
    recipe: m("silver", "#ffffff", 0, 58, 0, 0),
    extras: { shaders: [{ id: "caustics", side: "front", target: "skin" }] },
  },
  {
    id: "oil-slick-black",
    name: "Oil Slick Black",
    category: "effects",
    recipe: m("silver", "#000000", 0, 58, 0, 17),
    extras: { shaders: [{ id: "oil-slick", side: "both", target: "overlay", blend: "screen", params: { strength: 0.55 } }] },
  },
  {
    id: "vinyl",
    name: "Vinyl Record",
    category: "effects",
    recipe: m("silver", "#000000", 0, 58, 0, 0),
    extras: { shaders: [{ id: "vinyl", side: "front", target: "skin" }] },
  },
  {
    id: "walnut",
    name: "Walnut Veneer",
    category: "effects",
    recipe: m("silver", "#d9d6cc", 0, 18, 0, 0),
    extras: { shaders: [{ id: "wood", side: "both", target: "skin" }] },
  },
  {
    id: "foil-flakes",
    name: "Foil Flakes Gunmetal",
    category: "effects",
    recipe: m("silver", "#3d3e3c", 0, 58, 0, 20),
    extras: { shaders: [{ id: "foil-flakes", side: "both", target: "overlay", blend: "add" }] },
  },
  {
    id: "sunset-mesh",
    name: "Sunset Mesh Gradient",
    category: "effects",
    recipe: m("silver", "#d9d6cc", 0, 58, 0, 0),
    extras: { shaders: [{ id: "gradient-mesh", side: "both", target: "skin" }] },
  },
  { id: "silver-vines", name: "Vines on Silver", category: "effects", recipe: m("silver", "#d9d6cc", 0, 58, 0, 0), extras: { addons: { vines: {} } } },
  { id: "gold-shine", name: "Gold Shine", category: "effects", recipe: m("silver", "#cda874", 0, 58, 0, 48), extras: { addons: { shine: { tone: "gold" } } } },
];

/** A deep copy of the preset's extras (empty when it has none). */
export function presetExtras(preset: CardPreset): CardPresetExtras {
  return preset.extras ? structuredClone(preset.extras) : {};
}

/** The preset's complete recipe (`DEFAULT_RECIPE` + its fields, normalised). */
export function presetRecipe(preset: CardPreset): Recipe {
  return normalizeRecipe({ ...DEFAULT_RECIPE, ...preset.recipe });
}

export function getPreset(id: string): CardPreset | undefined {
  return CARD_PRESETS.find((p) => p.id === id);
}

/** Fields of `recipe` that differ from `DEFAULT_RECIPE`. */
function diff(recipe: Readonly<Recipe>): Partial<Recipe> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(recipe) as (keyof Recipe)[]) {
    if (recipe[k] !== DEFAULT_RECIPE[k]) out[k] = recipe[k];
  }
  return out as Partial<Recipe>;
}
