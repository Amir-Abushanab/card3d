/**
 * Field-by-field documentation of the design model, for model-facing descriptions (`describeDesignSpace`).
 *
 * Every table is typed against the real interfaces with `-?` mapped types, so adding a field to
 * `CardDesign` (or to one of its nested objects) without documenting it here fails `tsc`, and
 * describe.test.ts checks every documented key reaches the generated text. Option lists are NOT
 * written here: the generator reads them from the catalogs (presets, materials, shaders, lighting…).
 */
import type {
  CardAddons,
  CardContactless,
  CardDesign,
  CardEdge,
  CardFinishes,
  CardFloor,
  CardLogo,
  CardScene,
  CardShape,
  CardTextLine,
  Decal,
  DecalAdjust,
  DecalCrop,
  DecalTint,
  FaceShader,
  FoilTexture,
  HoloStyle,
  MaterialOverride,
  BrandingOverride,
  Recipe,
  SurfaceTexture,
} from "../types.ts";

export interface FieldDoc {
  /** Short type / range, e.g. `"#rrggbb"`, `0–100`, `see "Lighting"`. */
  type: string;
  doc: string;
  /** Leave the field out when describing a finish (needs uploads, licensed assets, or is internal). */
  avoid?: boolean;
}

/** Every key of `T`, required, documented. */
export type FieldTable<T> = { [K in keyof T]-?: FieldDoc };

export const DESIGN_FIELDS: FieldTable<CardDesign> = {
  recipe: { type: 'Recipe (see "recipe")', doc: "The finish: metal, colour, surface texture and holo foil. Fields left out take their defaults." },
  cardholderName: {
    type: "string",
    doc: 'The embossed name (upper-cased on the card). Keep the user\'s own if they have one; otherwise a neutral placeholder such as "Ada Lovelace".',
  },
  cardholderBio: { type: "string", doc: 'A small second line under the name (e.g. "Member since 1843"); "" for none. Line breaks allowed.' },
  decals: { type: "Decal[]", doc: "Stickers. They need uploaded images: always write []", avoid: true },
  surfaceSources: { type: "{ front?, back? } image URLs", doc: "Face artwork images (uploads). Always write {}", avoid: true },
  surfaceTreatments: { type: '{ front?, back? } "inlay" | "printed"', doc: "How artwork is applied. Always write {}", avoid: true },
  materialOverride: {
    type: "MaterialOverride (see below)",
    doc: "Optional per-field PBR overrides on top of the recipe's material maths. Prefer recipe fields; use this only for a look the recipe can't reach (e.g. a deeper clearcoat).",
  },
  brandingOverride: {
    type: "BrandingOverride (see below)",
    doc: 'Optional material of the raised branding (name, bio, logo) with the default "default" finish.',
  },
  frontLayout: {
    type: "{ nameFontHeight?: 0.02–0.12, nameBottom?: 0.02–0.4 }",
    doc: "Name size and distance from the bottom edge, in card heights. On a landscape card the name stays inside ISO/IEC 7811-1's name area (nameBottom ≈ 0.05–0.21 at the default size). Usually leave out.",
  },
  shaders: {
    type: "FaceShader[] (≤ MAX_SHADER_LAYERS)",
    doc: 'Face shader layers in order (see "Face shaders"): built-ins by id, or your own WGSL with id "custom".',
  },
  addons: { type: "{ shine?, vines? }", doc: 'Add-on rigs that work on any card (see "Add-ons").' },
  font: {
    type: 'font id | { source: "google", family, weight? } | null',
    doc: 'Name/bio typeface (see "Fonts"). Leave out for the default. Or any Google Fonts family by its exact name (letters, digits, spaces; weight 100–900, default 700), e.g. { "source": "google", "family": "Fraunces" }; it loads from fonts.googleapis.com and falls back to the default offline. (Fonts from a URL or an uploaded file, source "url" / "upload", are the user\'s own: don\'t invent them.)',
  },
  logo: { type: "CardLogo | null", doc: 'A user logo replacing the corner mark: one SVG path (see "logo"). Leave out unless the description asks for a mark.' },
  lighting: { type: "lighting id | null", doc: 'Scene lighting and backdrop preset (see "Lighting"). Leave out for the neutral studio.' },
  finish: { type: 'CardFinishes (see "finish")', doc: "How name, bio and logo are cut into or raised out of the metal." },
  edge: { type: 'CardEdge (see "edge")', doc: "Side-wall colour / finish and an optional polished chamfer." },
  shape: { type: 'CardShape (see "shape")', doc: "Corner radius, portrait orientation, cutouts." },
  contactless: { type: "true | CardContactless", doc: 'Adds a contactless mark beside the chip (see "contactless").' },
  textLines: { type: "CardTextLine[] (≤ 3)", doc: 'Extra text lines (card number, validity, a title), rendered like the name (see "textLines").' },
  scene: { type: 'CardScene (see "scene")', doc: "Product-shot staging: HDRI environment, backdrop, reflective floor. Leave out for the studio look." },
};

export const RECIPE_DOCS: FieldTable<Recipe> = {
  material: {
    type: "material id",
    doc: 'The metal family. It shapes roughness, clearcoat and reflections but NOT the hue: `color` sets the hue for every material. "glass" is a clear refractive slab.',
  },
  pattern: {
    type: '"none" | "orbit"',
    doc: '"orbit" lays the texture out in concentric orbits (classic guilloché rosettes); only noticeable with a patterned texture.',
  },
  texture: {
    type: "texture id",
    doc: 'Surface texture (normal + roughness map). These are fine, physical micro-textures: at whole-card size most read as a sheen or soft pattern, the detail shows close up. NOTE: "none" with grain or relief above 0 still renders brushed; set grain 0 AND relief 0 for a flat, clean metal.',
  },
  color: {
    type: '"#rrggbb"',
    doc: "Base colour of the metal (the hue). Rose gold ≈ #e3b3a0, yellow gold ≈ #e2c27a, bronze ≈ #a8754a, copper ≈ #c7774f, gunmetal ≈ #3d3e3c, black ≈ #151715.",
  },
  grain: {
    type: "0–100",
    doc: 'Brushed-streak / texture noise strength: 0 smooth, 30 default, 80+ strong. Even at 100, `brushed` hairlines are only visible close up; for brushing that must read on the whole card, add a brushed-streak skin layer (see "Examples").',
  },
  polish: { type: "0–100", doc: "Gloss: 0 satin/matte (rough, soft reflections), 58 default, 100 mirror." },
  relief: { type: "0–100", doc: "Depth of the texture's relief (normal-map strength): 0 flat, 72 default, 100 deep." },
  spectrum: {
    type: "0–100",
    doc: "Iridescence: a thin-film hue shift with viewing angle (oil-slick / anodised rainbow tint on the metal itself). 0 none, 20–40 a hint, 100 strong.",
  },
  abstraction: { type: "0–100", doc: "Kept for compatibility; no visual effect. Leave out." },
  matchHoloSides: { type: "boolean", doc: "true: the back foil mirrors the front foil (and the back* fields are ignored)." },
  frontHolo: { type: "boolean", doc: "Holographic foil on the front (an additive layer over the metal)." },
  holoStyle: { type: "holo style id", doc: 'Foil colour/pattern (see "Holo foil styles").' },
  foilTexture: { type: "foil texture id", doc: 'Foil micro-texture (see "Foil textures").' },
  foilIntensity: { type: "0–100", doc: "Foil strength: 15–35 faint, 50 clear, 78 default, 100 loud." },
  holoGlare: { type: "0–100", doc: "Specular glare on the foil." },
  holoMotion: { type: "boolean", doc: "The foil shifts as the card tilts (default true)." },
  foilScale: { type: "25–400 (%)", doc: "Foil pattern scale." },
  foilCoverage: { type: '"cover" | "tile"', doc: "One field over the face, or a 4×4 tiled pattern." },
  backHolo: { type: "boolean", doc: "Foil on the back (only when matchHoloSides is false)." },
  backHoloStyle: { type: "holo style id", doc: "Back foil style (matchHoloSides false)." },
  backFoilTexture: { type: "foil texture id", doc: "Back foil texture (matchHoloSides false)." },
  backFoilIntensity: { type: "0–100", doc: "Back foil strength (matchHoloSides false)." },
  backHoloGlare: { type: "0–100", doc: "Back foil glare (matchHoloSides false)." },
  backHoloMotion: { type: "boolean", doc: "Back foil follows motion (matchHoloSides false)." },
  backFoilScale: { type: "25–400 (%)", doc: "Back foil scale (matchHoloSides false)." },
  backFoilCoverage: { type: '"cover" | "tile"', doc: "Back foil coverage (matchHoloSides false)." },
};

export const TEXTURE_DOCS: Record<SurfaceTexture, string> = {
  none: "flat (only when grain = relief = 0; otherwise renders brushed)",
  brushed:
    "very fine parallel hairlines with anisotropic highlights (brushed steel / satin aluminium); at card size it reads as a soft satin sheen, the streaks show only close up",
  guilloche: 'engine-turned wave engraving; with pattern "orbit" the classic rosette',
  crosshatch: "fine engraved cross-hatching",
  hammered: "hand-hammered dimples",
  sandblasted: "fine frosted grit, soft and diffuse",
  pinpoint: "a regular grid of tiny dots",
  linen: "woven-cloth texture",
  "carbon-fiber": "carbon-fibre twill weave",
};

export const HOLO_STYLE_DOCS: Record<HoloStyle, string> = {
  common: "faint neutral grey sheen",
  uncommon: "faint pale green-grey sheen",
  rare: "white sheen",
  holo: "classic diagonal rainbow bands",
  reverse: "silver with a rainbow wash",
  cosmos: "deep blue starfield with sparkles",
  radiant: "rainbow with a fine cross-line grid",
  amazing: "swirling rainbow spill",
  rainbow: "soft pastel rainbow",
  shiny: 'subtle silvery shift with a little colour (good for "faint holo")',
  gallery: "muted rainbow, partly silver",
  ultra: "interference-like rainbow (oil-slick feel)",
  vmax: "bold diagonal ridged rainbow (the default)",
  vstar: "warm pastel, cream to rainbow",
  gold: "warm gold foil",
};

export const FOIL_TEXTURE_DOCS: Record<FoilTexture, string> = {
  etched: "fine diagonal engraved lines",
  sparkle: "scattered flashing glitter cells",
  microdot: "a dense dot screen",
};

export const MATERIAL_OVERRIDE_FIELDS: FieldTable<MaterialOverride> = {
  color: { type: '"#rrggbb"', doc: "Replaces the recipe colour." },
  metalness: { type: "0–1", doc: "1 metal, 0 dielectric (paint/plastic)." },
  roughness: { type: "0–1", doc: "Overrides the polish curve." },
  clearcoat: { type: "0–1", doc: "Lacquer layer amount." },
  clearcoatRoughness: { type: "0–1", doc: "Lacquer roughness." },
  transmission: { type: "0–1", doc: "Glass only." },
  thickness: { type: "0–10", doc: "Glass only." },
  ior: { type: "1–2.5", doc: "Glass only." },
};

export const BRANDING_OVERRIDE_FIELDS: FieldTable<BrandingOverride> = {
  ...MATERIAL_OVERRIDE_FIELDS,
  brandingClearcoat: { type: "0–1", doc: "Clearcoat of the raised branding." },
};

export const FINISH_FIELDS: FieldTable<CardFinishes> = {
  name: { type: "mark finish", doc: "Cardholder name and the extra text lines." },
  bio: { type: "mark finish", doc: "The bio line." },
  logo: { type: "mark finish", doc: "The logo, or the corner mark when there is no logo." },
};

export const MARK_FINISH_DOCS: Record<"default" | "embossed" | "engraved" | "etched", string> = {
  default: "shiny printed branding with a faint bump",
  embossed: "raised in the body metal with rounded shoulders",
  engraved: "cut in: a darker floor and a lit inner wall",
  etched: "laser-etched: frosted, lighter, almost no relief",
};

export const EDGE_FIELDS: FieldTable<CardEdge> = {
  finish: {
    type: '"metal" | "anodized" | "match"',
    doc: "metal: polished metal tinted `color`; anodized: dyed oxide in `color` with a faint shimmer; match: the face's colour.",
  },
  color: { type: '"#rrggbb"', doc: "Edge colour (metal / anodized only)." },
  chamfer: { type: "boolean", doc: "A polished, diamond-cut highlight on the bevel." },
};

export const SHAPE_FIELDS: FieldTable<CardShape> = {
  cornerRadius: {
    type: "0.107–0.129",
    doc: "Fraction of half the short side (×26.99 = mm), within ISO/IEC 7810 ID-1 (3.18 mm ± 0.30): 0.107 = 2.88 mm (minimum), 0.118 = 3.18 mm (nominal, the default), 0.129 = 3.48 mm (maximum); values outside are clamped.",
  },
  orientation: {
    type: '"landscape" | "portrait"',
    doc: "Portrait stands the card up (a quarter turn clockwise): the chip stays where ISO/IEC 7816-2 puts it on the body, near the top, and the print is laid out upright around it.",
  },
  cutouts: {
    type: "cutout ids[]",
    doc: "See-through holes with their own walls. Not ISO (ISO/IEC 7810 ID-1 cards have no holes): a design feature, placed clear of the chip contacts, the antenna and the number / name areas. lanyard: a slot by the left short edge; notch: the top-right corner; window: a round hole above the number line.",
  },
};

export const CONTACTLESS_FIELDS: FieldTable<CardContactless> = {
  finish: { type: "mark finish", doc: 'Default "embossed".' },
  scale: {
    type: "0.4–1.2",
    doc: "Height relative to the chip plate's (0.4 ≈ 4.6 mm, EMVCo's 4.5 mm minimum; default 0.78 ≈ 8.9 mm). Sits right of the chip, centred on it; on a landscape card it stops short of the number line (≈ 1.0 at most).",
  },
};

export const TEXT_LINE_FIELDS: FieldTable<CardTextLine> = {
  text: { type: "string (≤ 48 chars)", doc: "Upper-cased on the card." },
  font: { type: "font id", doc: "Default: the design's font." },
  size: { type: "0.4–2", doc: "Height relative to the name; default 0.8." },
  tracking: { type: "−0.05–0.6 (em)", doc: "Letter spacing; default 0." },
  align: { type: '"left" | "center" | "right"', doc: "Default follows placement." },
  placement: {
    type: '"bottom-left" | "bottom-right" | "center" | "top"',
    doc: 'Default "bottom-left": on a landscape card the first bottom-left line is the number line (ISO/IEC 7811-1 area 1, just below the chip), the others stack above the name.',
  },
};

export const LOGO_FIELDS: FieldTable<CardLogo> = {
  path: { type: "SVG path data", doc: "One path (M/L/H/V/C/S/Q/T/A/Z commands and numbers only)." },
  viewBox: { type: "[w, h]", doc: "The path's viewBox size (required with path)." },
  origin: { type: "[minX, minY]", doc: "The viewBox origin when not 0,0." },
  fillRule: { type: '"nonzero" | "evenodd"', doc: "Path fill rule." },
  src: { type: "image URL", doc: "Raster mask (uploads). Don't use; write a path instead.", avoid: true },
  aspect: { type: "number", doc: "Aspect of `src` (raster only).", avoid: true },
  position: { type: "logo position", doc: 'Default "corner" (top left).' },
  scale: { type: "0.4–3", doc: "Height relative to the corner mark; default 1." },
};

/** Stickers need uploaded images (designs write `decals: []`), so every field is "leave out". */
export const DECAL_FIELDS: FieldTable<Decal> = {
  id: { type: "string", doc: "Unique per sticker.", avoid: true },
  side: { type: '"front" | "back"', doc: "Which face.", avoid: true },
  src: { type: "image URL", doc: "The sticker image (an upload or a hosted file).", avoid: true },
  aspect: { type: "0.01–100", doc: "The whole picture's width / height as placed (the image's own unless stretched).", avoid: true },
  x: { type: "0–100", doc: "Centre, percent of the card's width from the left.", avoid: true },
  y: { type: "0–100", doc: "Centre, percent of the card's height from the top.", avoid: true },
  width: { type: "percent", doc: "Visible (cropped) width, percent of the card's width (× scale).", avoid: true },
  rotation: { type: "degrees", doc: "Clockwise on the front.", avoid: true },
  scale: { type: "number", doc: "Multiplies width; default 1.", avoid: true },
  crop: { type: "{ x, y, w, h } 0–1", doc: "The visible part of the image from its top left (sides ≥ 0.02); absent = the whole image.", avoid: true },
  flip: { type: "{ h?, v? } booleans", doc: "Mirror left ↔ right / top ↔ bottom.", avoid: true },
  tint: {
    type: '{ color: "#rrggbb", amount: 0–1 }',
    doc: "Recolour: luminance mapped black → color → white, mixed in by amount (#808080 at 1 = grayscale).",
    avoid: true,
  },
  adjust: { type: "{ brightness?, contrast?, saturation? } −1–1", doc: "Picture corrections; 0 = unchanged.", avoid: true },
  opacity: { type: "0–1", doc: "Default 1.", avoid: true },
};

export const DECAL_CROP_FIELDS: FieldTable<DecalCrop> = {
  x: { type: "0–1", doc: "Left edge." },
  y: { type: "0–1", doc: "Top edge." },
  w: { type: "0.02–1", doc: "Width." },
  h: { type: "0.02–1", doc: "Height." },
};

export const DECAL_TINT_FIELDS: FieldTable<DecalTint> = {
  color: { type: '"#rrggbb"', doc: "The colour mid-tones map to." },
  amount: { type: "0–1", doc: "How much of the recolour shows." },
};

export const DECAL_ADJUST_FIELDS: FieldTable<DecalAdjust> = {
  brightness: { type: "−1–1", doc: "Towards white (+) or black (−)." },
  contrast: { type: "−1–1", doc: "−1 flat grey, +1 ×10 about mid-grey." },
  saturation: { type: "−1–1", doc: "−1 grey, +1 doubled." },
};

export const SCENE_FIELDS: FieldTable<CardScene> = {
  environment: { type: '"studio" | environment id', doc: 'Lighting environment (an HDRI); "studio" = the default built-in studio light rig (no HDRI).' },
  environmentIntensity: { type: "0.25–3", doc: "Multiplier on the environment light; default 1." },
  environmentRotation: { type: "0–360 (°)", doc: "Turns the environment about the vertical axis." },
  backdrop: { type: "backdrop id", doc: "What stands behind the card." },
  backdropColor: { type: '"#rrggbb"', doc: "Sweep / gradient colour." },
  backdropBlur: { type: "0–1", doc: 'Blur of the "environment" backdrop; default 0.45.' },
  floor: { type: "true | CardFloor", doc: "A reflective floor with a contact shadow." },
};

export const FLOOR_FIELDS: FieldTable<CardFloor> = {
  reflectivity: { type: "0–1", doc: "0 matte (shadow only) – 1 mirror; default 0.45." },
  shadow: { type: "0–1", doc: "Contact shadow strength; default 0.6." },
  blur: { type: "0–1", doc: "Blur of the reflection; default 0.35." },
};

export const LAYER_FIELDS: FieldTable<FaceShader> = {
  id: { type: 'built-in id | "custom"', doc: "Which shader." },
  side: { type: '"front" | "back" | "both"', doc: "Which face(s)." },
  target: {
    type: '"skin" | "overlay"',
    doc: "skin: replaces the face colour under the metal lighting (a printed/anodised look); overlay: a layer blended over the face, can be view-dependent.",
  },
  blend: { type: '"normal" | "add" | "multiply" | "screen"', doc: "Overlay blend (default: the shader's own, else normal)." },
  opacity: { type: "0–1", doc: "Layer opacity; default 1." },
  params: { type: "{ key: value }", doc: "Built-ins: param keys from the tables below. Custom: the annotated uniform names (e.g. uSpeed)." },
  code: { type: "WGSL string", doc: 'id "custom" only (see "Custom shaders").' },
  language: { type: '"wgsl"', doc: 'id "custom" only: always "wgsl" (the card engine runs WGSL; GLSL layers, absent or "glsl", are skipped).' },
  animated: { type: "boolean", doc: "false freezes an animated shader's clock." },
  time: { type: "seconds", doc: "Freezes the clock at this time. Leave out.", avoid: true },
  enabled: { type: "boolean", doc: "false keeps the layer but hides it. Leave out.", avoid: true },
};

export const ADDON_FIELDS: FieldTable<CardAddons> = {
  shine: { type: "{ tone?, intensity? } | null", doc: "Drifting additive lights and a glint." },
  vines: { type: "{ cycle?, density?, leafColor?, time? } | null", doc: "Ivy growing over the card." },
};
