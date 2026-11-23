/**
 * Shared data model for @card3d/core. Every module and every implementation agent builds against
 * these types; change them deliberately.
 */

/** Metal presets. `glass` switches the body to the transmission path. */
export type MaterialPreset = "silver" | "nickel" | "titanium" | "brass" | "oxide" | "carbon" | "glass";

export type SurfaceTexture = "none" | "brushed" | "guilloche" | "crosshatch" | "hammered" | "sandblasted" | "pinpoint" | "linen" | "carbon-fiber";

export type SurfacePattern = "none" | "orbit";

export const HOLO_STYLES = [
  "common",
  "uncommon",
  "rare",
  "holo",
  "reverse",
  "cosmos",
  "radiant",
  "amazing",
  "rainbow",
  "shiny",
  "gallery",
  "ultra",
  "vmax",
  "vstar",
  "gold",
] as const;
export type HoloStyle = (typeof HOLO_STYLES)[number];

export const FOIL_TEXTURES = ["etched", "sparkle", "microdot"] as const;
export type FoilTexture = (typeof FOIL_TEXTURES)[number];
export type FoilCoverage = "cover" | "tile";

/**
 * The authoring recipe. Numbers are 0–100
 * integers in the UI; the engine divides by 100 and clamps. Every field is optional on input;
 * `normalizeRecipe` fills studio defaults.
 */
export interface Recipe {
  material: MaterialPreset;
  pattern: SurfacePattern;
  texture: SurfaceTexture;
  color: string;
  grain: number;
  polish: number;
  relief: number;
  spectrum: number;
  /** Kept for round-tripping recipes; has no rendering effect. */
  abstraction: number;
  matchHoloSides: boolean;
  /** "Holo on" for the front. */
  frontHolo: boolean;
  holoStyle: HoloStyle;
  foilTexture: FoilTexture;
  foilIntensity: number;
  holoGlare: number;
  holoMotion: boolean;
  foilScale: number;
  foilCoverage: FoilCoverage;
  backHolo: boolean;
  backHoloStyle: HoloStyle;
  backFoilTexture: FoilTexture;
  backFoilIntensity: number;
  backHoloGlare: number;
  backHoloMotion: boolean;
  backFoilScale: number;
  backFoilCoverage: FoilCoverage;
}

/** One side's foil, after recipe mapping. */
export interface HoloConfig {
  style: HoloStyle;
  texture: FoilTexture;
  intensity: number; // 0–100
  glare: number; // 0–100
  responsive: boolean;
  scale: number; // percent, engine clamps /100 to [0.25, 4]
  coverage: FoilCoverage;
}

/** Engine-facing material description. */
export interface MaterialConfig {
  preset: MaterialPreset;
  color: string;
  polish: number;
  grain: number;
  relief: number;
  spectrum: number;
  pattern: SurfacePattern;
  texture: SurfaceTexture;
  holo: HoloConfig | null;
  backHolo: HoloConfig | null;
}

/** Scalar PBR overrides applied on top of the preset math. */
export interface MaterialOverride {
  color?: string;
  metalness?: number;
  roughness?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  transmission?: number;
  thickness?: number;
  ior?: number;
}

/** Branding (logo/name/bio) overrides . */
export interface BrandingOverride extends MaterialOverride {
  brandingClearcoat?: number;
}

export type Side = "front" | "back";
export type SurfaceTreatment = "inlay" | "printed";

/**
 * A sticker. x/y/width are percentages of the card face; rotation in degrees.
 * `width` (× `scale`) is the visible (cropped) width; `aspect` is the whole picture's width / height
 * as placed (the image's own unless stretched). The picture fields (crop, flip, tint, adjust,
 * opacity) are optional and leave the sticker exactly as before when absent.
 */
export interface Decal {
  id: string;
  side: Side;
  src: string;
  aspect: number;
  x: number;
  y: number;
  width: number;
  rotation: number;
  scale: number;
  /** The visible part of the image, 0–1 of its width / height from the top left. Absent: all of it. */
  crop?: DecalCrop;
  /** Mirror the picture (h: left ↔ right, v: top ↔ bottom). */
  flip?: { h?: boolean; v?: boolean };
  /** Recolour (PowerPoint "Color"): the image's luminance mapped black → `color` → white, mixed in by `amount`. */
  tint?: DecalTint;
  /** Picture corrections, each −1–1 (0 = unchanged). */
  adjust?: DecalAdjust;
  /** 0–1; default 1. */
  opacity?: number;
}

/** A normalized source rect (0–1, top-left origin) of a sticker image. */
export interface DecalCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DecalTint {
  /** `#rrggbb`. Mid-grey (#808080) at amount 1 is grayscale. */
  color: string;
  /** 0–1. */
  amount: number;
}

export interface DecalAdjust {
  brightness?: number;
  contrast?: number;
  saturation?: number;
}

/** A complete card: what the studio edits, what presets store and what the renderer consumes. */
export interface CardDesign {
  recipe: Recipe;
  cardholderName: string;
  cardholderBio: string;
  decals: Decal[];
  surfaceSources: Partial<Record<Side, string>>;
  surfaceTreatments: Partial<Record<Side, SurfaceTreatment>>;
  materialOverride?: MaterialOverride;
  brandingOverride?: BrandingOverride;
  /** Name placement override, e.g. { nameFontHeight: 0.048, nameBottom: 0.11 }. */
  frontLayout?: { nameFontHeight?: number; nameBottom?: number };
  /** Face shader layers, applied in order (built-in library or user GLSL). See `src/shaders/`. */
  shaders?: FaceShader[];
  /** Add-on rigs that work on any card. */
  addons?: CardAddons;
  /**
   * Name/bio font (and the text lines that don't pick their own): an id from `CARD_FONTS`
   * (self-hosted OFL faces), or a `CardCustomFont` (a Google Fonts family, a web font URL or an
   * uploaded file). Absent: the asset provider's `nameFontFamily` (the public provider's is
   * `DEFAULT_CARD_FONT`; a local pack's its own face). A custom font that can't be loaded
   * falls back to that family too.
   */
  font?: string | CardCustomFont | null;
  /** The user's own mark, replacing the provider's corner mark (`brandMark`). See `CardLogo`. */
  logo?: CardLogo | null;
  /**
   * Scene lighting + backdrop preset (`LIGHTING_PRESETS`) for hosts that show one card
   * (the stage applies it in `setDesign`). Absent: the stage's own `lightingPreset` ("studio").
   */
  lighting?: LightingPresetId | null;
  /**
   * How the cardholder name (and the extra text lines), the bio and the logo / corner mark are
   * finished into the metal (`MarkFinish`). Absent fields: "default" (today's raised branding finish).
   */
  finish?: CardFinishes | null;
  /** Side-wall colour and finish, plus an optional polished chamfer. Absent: the body metal. */
  edge?: CardEdge | null;
  /** Corner radius, orientation and cutouts (procedural geometry). Absent: the standard ISO card. */
  shape?: CardShape | null;
  /** A contactless-payment-style mark (four nested arcs) beside the chip. Absent: none. */
  contactless?: CardContactless | null;
  /** Up to three extra free text lines (card number, validity, a title), rendered like the name. */
  textLines?: CardTextLine[] | null;
  /**
   * Product-shot staging for hosts that show one card (`createEngineStage`): an HDRI environment, a
   * backdrop and a reflective floor (`scene/marketing/`, loaded on first use). Absent: exactly
   * today's stage (the studio environment, a transparent canvas).
   */
  scene?: CardScene | null;
}

/** What stands behind the card (`CardScene.backdrop`). */
export type SceneBackdrop = "none" | "sweep" | "gradient" | "environment";

/**
 * Staging for product shots. Every field is optional; an empty scene changes nothing.
 * - `environment`: "studio" (default: the built-in studio light rig and its lighting preset), a `SCENE_ENVIRONMENTS`
 *   id (self-hosted CC0 HDRIs), or the URL of an equirectangular `.hdr` or gain-mapped `.webp`.
 * - `backdrop`: "none" (default: the canvas stays transparent), "sweep" (a seamless cyclorama under a
 *   soft light pool), "gradient" (a radial gradient), "environment" (the HDRI itself, blurred like a
 *   shallow depth of field).
 * - `floor`: a reflective floor with a soft contact shadow, both fading out with distance. It keeps
 *   its alpha, so a transparent export carries the reflection and shadow.
 */
export interface CardScene {
  environment?: string;
  /** Multiplier on the environment's light, 0.25–3. Default 1. */
  environmentIntensity?: number;
  /** Turns the environment about the vertical axis, degrees (0–360). Default 0. */
  environmentRotation?: number;
  backdrop?: SceneBackdrop;
  /** Sweep / gradient colour, "#rrggbb". Default: the lighting preset's backdrop colours. */
  backdropColor?: string;
  /** Blur of the "environment" backdrop, 0 (sharp) – 1. Default 0.45. */
  backdropBlur?: number;
  floor?: CardFloor | null;
}

export interface CardFloor {
  /** 0 (matte: shadow only) – 1 (mirror). Default 0.45. */
  reflectivity?: number;
  /** Contact shadow strength, 0–1. Default 0.6. */
  shadow?: number;
  /** Blur of the reflection, 0 (sharp mirror) – 1 (frosted). Default 0.35. */
  blur?: number;
}

/**
 * How a mark is cut into or raised out of the metal (normal maps from the rasterised mask):
 * - `default`: the branding finish, a shiny print with a faint bump;
 * - `embossed`: raised in the body metal with rounded shoulders;
 * - `engraved`: cut in, a darker floor and a lit inner wall (debossed);
 * - `etched`: laser-etched, frosted and lighter with almost no relief.
 */
export type MarkFinish = "default" | "embossed" | "engraved" | "etched";

export interface CardFinishes {
  /** Cardholder name and the extra text lines. */
  name?: MarkFinish;
  bio?: MarkFinish;
  /** The user logo, or the corner mark when there is none. */
  logo?: MarkFinish;
}

/**
 * The card's side wall (`edge`): `metal` = polished metal tinted `color`; `anodized` = dyed oxide in
 * `color` with a faint interference shimmer; `match` = the face's colour (its artwork's edge colour
 * when it has artwork, else the body). `chamfer` adds a polished, diamond-cut highlight on the bevel.
 */
export interface CardEdge {
  finish?: "metal" | "anodized" | "match";
  /** "#rrggbb" for metal / anodized. */
  color?: string;
  chamfer?: boolean;
}

export type CardCutout = "lanyard" | "notch" | "window";

export interface CardShape {
  /**
   * Corner radius as a fraction of half the short side (× 26.99 = mm), clamped to ISO/IEC 7810 ID-1:
   * 0.107–0.129 (2.88–3.48 mm). Default ≈ 0.118 (3.18 mm, the ISO nominal).
   */
  cornerRadius?: number;
  /**
   * Default "landscape". Portrait stands the card up (the body turned a quarter turn clockwise): the
   * chip stays at its ISO/IEC 7816-2 place on the body, so it sits near the top, turned with it; the
   * print is laid out upright around it.
   */
  orientation?: "landscape" | "portrait";
  /**
   * See-through holes with their own walls: a lanyard slot by the left short edge, a top-right corner
   * notch, a round window above the number line. Not ISO (an ID-1 card has no holes); each keeps clear
   * of the chip contacts, the clear card's antenna and the ISO/IEC 7811-1 number and name areas.
   */
  cutouts?: CardCutout[];
}

export interface CardContactless {
  /** Default "embossed". */
  finish?: MarkFinish;
  /** Height relative to the chip plate's, 0.4–1.2 (≥ 4.5 mm, EMVCo's minimum). Default 0.78 (8.9 mm). */
  scale?: number;
}

export type TextLinePlacement = "bottom-left" | "bottom-right" | "center" | "top";

/** Where a `CardCustomFont` comes from. */
export type CustomFontSource = "google" | "url" | "upload";

/**
 * A font from outside the catalog (`CardDesign.font`, see `custom-font.ts`). Whatever the source, the
 * face is registered under a card3d-only family name, so `family` is a label and never reaches CSS.
 * - `google`: a Google Fonts family by name (letters, digits, spaces), fetched from
 *   fonts.googleapis.com (CSS2 API) when a card uses it, at `weight`.
 * - `url`: a web font file (woff2 / woff / ttf / otf): an https URL or a same-origin path.
 * - `upload`: the file itself as a `data:font/…;base64,` URL (≤ `CUSTOM_FONT_LIMITS.uploadBytes`).
 *   Share links leave `src` out (like uploaded artwork); the family stays so the recipient can be
 *   told which font is missing.
 */
export interface CardCustomFont {
  source: CustomFontSource;
  family: string;
  /** Google Fonts weight, 100–900 in hundreds. Default 700 (the weight names are drawn at). */
  weight?: number;
  /** `url`: the file's URL; `upload`: its data URL (absent once stripped for a link). */
  src?: string;
}

/** An extra line of text, rasterised like the name (upper-cased, the card's emboss finish). */
export interface CardTextLine {
  text: string;
  /** A `CARD_FONTS` id; absent: the design's font. */
  font?: string;
  /** Height relative to the name's, 0.4–2. Default 0.8. */
  size?: number;
  /** Letter spacing in em, −0.05–0.6. Default 0. */
  tracking?: number;
  /** Default by placement: left (bottom-left), right (bottom-right, top), centre (center). */
  align?: "left" | "center" | "right";
  /**
   * Default "bottom-left" (stacked above the name). On a landscape ID-1 card (the public card) the
   * first bottom-left line goes on the number line instead (ISO/IEC 7811-1 area 1, below the chip).
   */
  placement?: TextLinePlacement;
}

/** Built-in lighting / backdrop presets (`scene/lighting-presets.ts`). */
export type LightingPresetId = "studio" | "dramatic" | "warm" | "cool" | "dark" | "light";

/** Where a `CardLogo` sits on the front face. "corner" is the corner mark's place (top left). */
export type LogoPosition = "corner" | "top-right" | "center" | "bottom-right";

/**
 * A user logo, embossed like the corner mark (white glyph = raised, the branding finish). Either a
 * single SVG path (`path` + `viewBox`, crisp at any size) or a raster mask (`src`: an image whose
 * alpha is the shape, e.g. a PNG data URL). `path` wins when both are set.
 */
export interface CardLogo {
  /** SVG path data. */
  path?: string;
  /** The path's viewBox size [w, h]. */
  viewBox?: [number, number];
  /** The viewBox's min-x / min-y (the path is drawn translated by minus this). */
  origin?: [number, number];
  fillRule?: "nonzero" | "evenodd";
  /** Raster mask URL (resolved through the asset provider); alpha is the shape, colour is ignored. */
  src?: string;
  /** Width / height of `src` (the path's comes from `viewBox`). */
  aspect?: number;
  /** Default "corner". */
  position?: LogoPosition;
  /** Height relative to the corner mark (1 = the same height), 0.4–3. Default 1. */
  scale?: number;
}

/** A shader parameter value: number, boolean, colour ("#rrggbb") or vector. */
export type ShaderParamValue = number | boolean | string | [number, number] | [number, number, number];

/**
 * One shader layer on a card face.
 *
 * - `target: "skin"`: the shader renders into a texture that replaces the face's colour (the metal
 *   lighting, clearcoat, holo and branding still apply on top), like a printed/anodised finish.
 * - `target: "overlay"`: the shader is drawn on a plane just above the face, blended with `blend`;
 *   it gets view/tilt uniforms, so it can be view-dependent (glints, mirrors, parallax).
 */
export interface FaceShader {
  /** Built-in shader id (`BUILTIN_SHADERS`) or "custom". */
  id: string;
  side: "front" | "back" | "both";
  target: "skin" | "overlay";
  blend?: "normal" | "add" | "multiply" | "screen";
  /** 0..1, default 1. */
  opacity?: number;
  /** Values for the shader's declared params; missing ones take their defaults. */
  params?: Record<string, ShaderParamValue>;
  /** Source when `id === "custom"`: WGSL with `language: "wgsl"` (see `src/shaders/custom-parse.ts`). */
  code?: string;
  /**
   * The custom code's language. "wgsl" draws on the card engine (the contract is in
   * crates/card3d-engine/src/face_custom.rs); absent or "glsl" is the three.js engine's GLSL, which the
   * card engine skips (the layer reports an error; the rest of the card draws).
   */
  language?: "glsl" | "wgsl";
  /** Run the clock (default true; never under prefers-reduced-motion). */
  animated?: boolean;
  /** Freeze the clock at this time (s); used for stills and parity. */
  time?: number;
  /** Disabled layers are kept in the design but not rendered. */
  enabled?: boolean;
}

export interface CardAddons {
  /** Additive light rig drifting over the face. */
  shine?: { tone?: "gold" | "ice"; intensity?: number; time?: number } | null;
  /** Procedural vines that grow over the card. */
  vines?: { cycle?: boolean; density?: number; leafColor?: string; time?: number } | null;
}

export type Quality = "full" | "performance";

/**
 * Where brand-specific and licensed assets come from. The public build supplies neutral defaults
 * (procedural card geometry, a generic mark, an open font). A local-only asset pack
 * (.reference/pack, gitignored) can supply its own model, mark and font.
 */
export interface AssetProvider {
  /** Optional GLTF card model (body "Shape 0" + chip "Shape 1"); procedural geometry when absent. */
  cardModelUrl?: string;
  /** SVG path data for the corner mark and its viewBox [w, h]; a generic mark when absent. */
  brandMark?: { path: string; viewBox: [number, number] };
  /** CSS font family used for the cardholder name/bio rasteriser, already loaded by the host. */
  nameFontFamily: string;
  /** Resolves a design's asset reference (decal src, surface source) to a fetchable URL. */
  resolveUrl(src: string): string;
}
