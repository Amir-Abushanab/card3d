/**
 * Control metadata for the studio panel: enum options, numeric ranges and labels for every recipe
 * field, plus each material's name, note and 2D swatch.
 */
import {
  FOIL_TEXTURES,
  HOLO_STYLES,
  type FoilCoverage,
  type FoilTexture,
  type HoloStyle,
  type MaterialPreset,
  type Recipe,
  type SurfacePattern,
  type SurfaceTexture,
} from "../types.ts";

export interface Option<T extends string> {
  value: T;
  label: string;
}

/** A material's 2D swatch colours. UI only; the 3D engine never reads them. */
export interface MaterialSwatch {
  deep: string;
  mid: string;
  light: string;
  flare: string;
  ink: string;
}

export interface RecipeMaterial {
  id: MaterialPreset;
  name: string;
  note: string;
  swatch: MaterialSwatch;
}

/** The materials in the panel's order. */
export const RECIPE_MATERIALS: readonly RecipeMaterial[] = [
  {
    id: "silver",
    name: "Brushed silver",
    note: "Neutral stainless with a bright edge",
    swatch: { deep: "#555d61", mid: "#aeb5b8", light: "#e4e9e9", flare: "#ffffff", ink: "#171918" },
  },
  {
    id: "nickel",
    name: "Black nickel",
    note: "Cold black with a mirror edge",
    swatch: { deep: "#050606", mid: "#242725", light: "#868b84", flare: "#edf0e8", ink: "#f2f3ec" },
  },
  {
    id: "titanium",
    name: "Graphite",
    note: "Pencil-dark and finely brushed",
    swatch: { deep: "#0b0d0c", mid: "#2b2f2c", light: "#676c66", flare: "#cdd1c8", ink: "#f0f1e8" },
  },
  {
    id: "brass",
    name: "Obsidian",
    note: "Warm black with a glassy face",
    swatch: { deep: "#080706", mid: "#28231f", light: "#6f6459", flare: "#e3d7c8", ink: "#f2eee8" },
  },
  {
    id: "oxide",
    name: "Anodized black",
    note: "Blue-black with an oxide shift",
    swatch: { deep: "#040708", mid: "#172326", light: "#52666a", flare: "#c8dcda", ink: "#eff3ee" },
  },
  {
    id: "carbon",
    name: "Matte",
    note: "Soft-touch dark matte",
    swatch: { deep: "#111312", mid: "#242725", light: "#555a54", flare: "#c4c8c0", ink: "#f0f0e8" },
  },
  {
    id: "glass",
    name: "Clear glass",
    note: "Transparent with a refractive edge",
    swatch: { deep: "#5a7a84", mid: "#a8c8d2", light: "#e4f2f6", flare: "#ffffff", ink: "#171918" },
  },
];

export const MATERIAL_OPTIONS: readonly Option<MaterialPreset>[] = RECIPE_MATERIALS.map((m) => ({
  value: m.id,
  label: m.name,
}));

/**
 * The recipe order, `linen` included.
 */
export const TEXTURE_OPTIONS: readonly Option<SurfaceTexture>[] = [
  { value: "none", label: "None" },
  { value: "brushed", label: "Brushed" },
  { value: "guilloche", label: "Guilloché" },
  { value: "crosshatch", label: "Crosshatch" },
  { value: "hammered", label: "Hammered" },
  { value: "sandblasted", label: "Sandblasted" },
  { value: "pinpoint", label: "Pinpoint" },
  { value: "linen", label: "Linen" },
  { value: "carbon-fiber", label: "Carbon fiber" },
];

/** Only `orbit` is read by the engine. */
export const PATTERN_OPTIONS: readonly Option<SurfacePattern>[] = [
  { value: "none", label: "None" },
  { value: "orbit", label: "Orbit" },
];

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Index order matters: it is the shader's `uStyle`. */
export const HOLO_STYLE_OPTIONS: readonly Option<HoloStyle>[] = HOLO_STYLES.map((v) => ({
  value: v,
  label: v === "vmax" ? "VMAX" : v === "vstar" ? "VSTAR" : titleCase(v),
}));

export const FOIL_TEXTURE_OPTIONS: readonly Option<FoilTexture>[] = FOIL_TEXTURES.map((v) => ({
  value: v,
  label: titleCase(v),
}));

export const FOIL_COVERAGE_OPTIONS: readonly Option<FoilCoverage>[] = [
  { value: "cover", label: "Cover" },
  { value: "tile", label: "Tile" },
];

export interface RangeSpec {
  min: number;
  max: number;
  step: number;
}

/**
 * Integer UI ranges. The engine divides by 100 and clamps, except foil scale, whose
 * `/100` is clamped to [0.25, 4], hence 25–400.
 */
export const PERCENT_RANGE: RangeSpec = { min: 0, max: 100, step: 1 };
export const FOIL_SCALE_RANGE: RangeSpec = { min: 25, max: 400, step: 1 };

export type ControlGroup = "material" | "holo" | "backHolo";

export type RecipeControl =
  | { kind: "enum"; label: string; group: ControlGroup; options: readonly Option<string>[] }
  | { kind: "range"; label: string; group: ControlGroup; range: RangeSpec }
  | { kind: "boolean"; label: string; group: ControlGroup }
  | { kind: "color"; label: string; group: ControlGroup };

const style = (group: ControlGroup): RecipeControl => ({ kind: "enum", label: "Style", group, options: HOLO_STYLE_OPTIONS });
const foil = (group: ControlGroup): RecipeControl => ({ kind: "enum", label: "Foil texture", group, options: FOIL_TEXTURE_OPTIONS });
const percent = (label: string, group: ControlGroup): RecipeControl => ({ kind: "range", label, group, range: PERCENT_RANGE });
const toggle = (label: string, group: ControlGroup): RecipeControl => ({ kind: "boolean", label, group });
const scale = (group: ControlGroup): RecipeControl => ({ kind: "range", label: "Scale %", group, range: FOIL_SCALE_RANGE });
const coverage = (group: ControlGroup): RecipeControl => ({ kind: "enum", label: "Coverage", group, options: FOIL_COVERAGE_OPTIONS });

/** One entry per `Recipe` field, for building a panel generically. */
export const RECIPE_CONTROLS: Readonly<Record<keyof Recipe, RecipeControl>> = {
  material: { kind: "enum", label: "Material", group: "material", options: MATERIAL_OPTIONS },
  color: { kind: "color", label: "Color", group: "material" },
  texture: { kind: "enum", label: "Texture", group: "material", options: TEXTURE_OPTIONS },
  pattern: { kind: "enum", label: "Pattern", group: "material", options: PATTERN_OPTIONS },
  grain: percent("Grain", "material"),
  polish: percent("Polish", "material"),
  relief: percent("Relief", "material"),
  spectrum: percent("Spectrum", "material"),
  abstraction: percent("Abstraction (no effect)", "material"),
  frontHolo: toggle("Holo (front)", "holo"),
  matchHoloSides: toggle("Match sides", "holo"),
  holoStyle: style("holo"),
  foilTexture: foil("holo"),
  foilIntensity: percent("Intensity", "holo"),
  holoGlare: percent("Glare", "holo"),
  holoMotion: toggle("Responds to motion", "holo"),
  foilScale: scale("holo"),
  foilCoverage: coverage("holo"),
  backHolo: toggle("Holo (back)", "backHolo"),
  backHoloStyle: style("backHolo"),
  backFoilTexture: foil("backHolo"),
  backFoilIntensity: percent("Intensity", "backHolo"),
  backHoloGlare: percent("Glare", "backHolo"),
  backHoloMotion: toggle("Responds to motion", "backHolo"),
  backFoilScale: scale("backHolo"),
  backFoilCoverage: coverage("backHolo"),
};
