/**
 * Designs as documents: the default design, copies, and `ensureDesign`, which turns anything a user
 * can paste, load or embed into a complete `CardDesign`. Card Studio, share links and the embeds
 * (`<metal-card>`, `<MetalCard>`) all go through it, so a design reads the same everywhere. Pure:
 * never touches the renderer.
 */
import { CARD_FONTS } from "../fonts.ts";
import { isFontDataUrl, sanitizeCustomFont } from "../custom-font.ts";
import { LIGHTING_PRESETS } from "../scene/lighting-presets.ts";
import { LOGO_LIMITS, LOGO_POSITIONS, LOGO_SCALE_RANGE } from "../card/logo-limits.ts";
import { normalizeRecipe } from "../recipe/defaults.ts";
import { getPreset, presetRecipe } from "../presets.ts";
import type { CardDesign, CardLogo, Decal, LogoPosition, Side, SurfaceTreatment } from "../types.ts";
import {
  cloneAddons,
  cloneLayer,
  cloneScene,
  cloneTextLines,
  isObj,
  sanitizeAddons,
  sanitizeContactless,
  sanitizeEdge,
  sanitizeFinish,
  sanitizeLayout,
  sanitizeOverride,
  sanitizeScene,
  sanitizeShape,
  sanitizeShaders,
  sanitizeTextLines,
} from "./sanitize.ts";
import { DECAL_LIMITS, cloneDecal, sanitizeDecalPicture } from "./decal.ts";

export const DEFAULT_NAME = "Ada Lovelace";
export const DEFAULT_BIO = "Member since 1843";
/** The finish a new design starts from (Card Studio opens on it): orbit guilloché silver with a pearly shimmer. */
export const DEFAULT_PRESET_ID = "pearl-guilloche";

export function defaultDesign(): CardDesign {
  return {
    recipe: presetRecipe(getPreset(DEFAULT_PRESET_ID)!),
    cardholderName: DEFAULT_NAME,
    cardholderBio: DEFAULT_BIO,
    decals: [],
    surfaceSources: {},
    surfaceTreatments: {},
  };
}

/**
 * Copy a design. Nested objects are copied; strings (including multi-MB data URLs) are shared by
 * reference, which is safe because they are immutable and only ever reassigned.
 */
export function cloneDesign(d: CardDesign): CardDesign {
  const out: CardDesign = {
    ...d,
    recipe: { ...d.recipe },
    decals: d.decals.map(cloneDecal),
    surfaceSources: { ...d.surfaceSources },
    surfaceTreatments: { ...d.surfaceTreatments },
  };
  if (d.materialOverride) out.materialOverride = { ...d.materialOverride };
  if (d.brandingOverride) out.brandingOverride = { ...d.brandingOverride };
  if (d.frontLayout) out.frontLayout = { ...d.frontLayout };
  if (d.addons) out.addons = cloneAddons(d.addons);
  if (d.shaders) out.shaders = d.shaders.map(cloneLayer);
  if (d.logo) out.logo = cloneLogo(d.logo);
  if (d.font && typeof d.font === "object") out.font = { ...d.font };
  if (d.finish) out.finish = { ...d.finish };
  if (d.edge) out.edge = { ...d.edge };
  if (d.shape) out.shape = { ...d.shape, ...(d.shape.cutouts ? { cutouts: [...d.shape.cutouts] } : {}) };
  if (d.contactless) out.contactless = { ...d.contactless };
  if (d.textLines) out.textLines = cloneTextLines(d.textLines);
  if (d.scene) out.scene = cloneScene(d.scene);
  return out;
}

const cloneLogo = (l: CardLogo): CardLogo => ({
  ...l,
  ...(l.viewBox ? { viewBox: [...l.viewBox] as [number, number] } : {}),
  ...(l.origin ? { origin: [...l.origin] as [number, number] } : {}),
});

const SIDES: readonly Side[] = ["front", "back"];
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const finite = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function toDecal(v: unknown, i: number): Decal | null {
  if (!isObj(v) || typeof v.src !== "string" || !v.src) return null;
  const aspect = finite(v.aspect, 1);
  const d: Decal = {
    id: str(v.id) || `sticker-${i}-${Math.random().toString(36).slice(2, 7)}`,
    side: v.side === "back" ? "back" : "front",
    src: v.src,
    aspect: aspect > 0 ? Math.min(DECAL_LIMITS.aspect.max, Math.max(DECAL_LIMITS.aspect.min, aspect)) : 1,
    x: finite(v.x, 50),
    y: finite(v.y, 50),
    width: finite(v.width, 22),
    rotation: finite(v.rotation, 0),
    scale: finite(v.scale, 1),
  };
  // Picture edits (crop, flip, tint, corrections, opacity): only what changes something.
  return sanitizeDecalPicture(v, d);
}

/**
 * Turn anything a user can paste or load into a complete `CardDesign`:
 * - a full design (`{ recipe, cardholderName, decals, … }`),
 * - a recipe on its own (`{ material, color, grain, … }`),
 * - a wrapper with the recipe under `recipe` plus identity keys (`ownerName`).
 * Unknown ids, out-of-range values and oversized code are dropped or clamped. Throws when there is
 * nothing recognisable.
 */
export function ensureDesign(input: unknown): CardDesign {
  if (!isObj(input)) throw new Error("Expected a JSON object");
  const base = defaultDesign();
  const looksLikeRecipe = ["material", "texture", "grain", "polish", "holoStyle", "frontHolo"].some((k) => k in input);
  const rawRecipe = isObj(input.recipe) ? input.recipe : looksLikeRecipe ? input : null;
  const hasDesignKeys = ["cardholderName", "decals", "surfaceSources", "shaders", "addons"].some((k) => k in input);
  if (!rawRecipe && !hasDesignKeys) throw new Error("No recipe or card design found in that JSON");

  const d: CardDesign = {
    ...base,
    recipe: normalizeRecipe(rawRecipe ?? {}),
    cardholderName: str(input.cardholderName ?? input.ownerName, base.cardholderName),
    cardholderBio: str(input.cardholderBio),
    decals: Array.isArray(input.decals) ? input.decals.map(toDecal).filter((x): x is Decal => x !== null) : [],
    surfaceSources: {},
    surfaceTreatments: {},
  };
  if (isObj(input.surfaceSources)) {
    for (const s of SIDES) if (typeof input.surfaceSources[s] === "string") d.surfaceSources[s] = input.surfaceSources[s] as string;
  }
  if (isObj(input.surfaceTreatments)) {
    for (const s of SIDES) {
      const t = input.surfaceTreatments[s];
      if (t === "inlay" || t === "printed") d.surfaceTreatments[s] = t as SurfaceTreatment;
    }
  }
  const materialOverride = sanitizeOverride<NonNullable<CardDesign["materialOverride"]>>(input.materialOverride);
  if (materialOverride) d.materialOverride = materialOverride;
  const brandingOverride = sanitizeOverride<NonNullable<CardDesign["brandingOverride"]>>(input.brandingOverride, true);
  if (brandingOverride) d.brandingOverride = brandingOverride;
  const frontLayout = sanitizeLayout(input.frontLayout);
  if (frontLayout) d.frontLayout = frontLayout;
  const addons = sanitizeAddons(input.addons);
  if (addons) d.addons = addons;
  const shaders = sanitizeShaders(input.shaders);
  if (shaders) d.shaders = shaders;
  const font = sanitizeFont(input.font);
  if (font) d.font = font;
  const logo = sanitizeLogo(input.logo);
  if (logo) d.logo = logo;
  if (typeof input.lighting === "string" && LIGHTING_PRESETS.some((p) => p.id === input.lighting)) d.lighting = input.lighting as CardDesign["lighting"];
  const finish = sanitizeFinish(input.finish);
  if (finish) d.finish = finish;
  const edge = sanitizeEdge(input.edge);
  if (edge) d.edge = edge;
  const shape = sanitizeShape(input.shape);
  if (shape) d.shape = shape;
  const contactless = sanitizeContactless(input.contactless);
  if (contactless) d.contactless = contactless;
  const textLines = sanitizeTextLines(
    input.textLines,
    CARD_FONTS.map((f) => f.id),
  );
  if (textLines) d.textLines = textLines;
  const scene = sanitizeScene(input.scene);
  if (scene) d.scene = scene;
  return d;
}

/**
 * `CardDesign.font` from untrusted input: a `CARD_FONTS` id, or a custom font (`sanitizeCustomFont`:
 * `{ source: "google" | "url" | "upload", family, weight?, src? }`, or the `"google:Family@700"`
 * shorthand). Null when unusable.
 */
export function sanitizeFont(v: unknown): CardDesign["font"] {
  if (typeof v === "string" && CARD_FONTS.some((f) => f.id === v)) return v;
  return sanitizeCustomFont(v);
}

const pair = (v: unknown, positive: boolean): [number, number] | null =>
  Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x) && (!positive || x > 0)) ? [v[0], v[1]] : null;

/**
 * A logo from untrusted input (share links, opened files): bounded path data / mask URL (an image
 * data URL or a plain URL), known position, scale clamped. Null when nothing usable is left.
 */
export function sanitizeLogo(v: unknown): CardLogo | null {
  if (!isObj(v)) return null;
  const out: CardLogo = {};
  const viewBox = pair(v.viewBox, true);
  if (typeof v.path === "string" && v.path.trim() && v.path.length <= LOGO_LIMITS.pathChars && viewBox && /^[\sMmLlHhVvCcSsQqTtAaZz0-9eE.,+-]+$/.test(v.path)) {
    out.path = v.path;
    out.viewBox = viewBox;
    const origin = pair(v.origin, false);
    if (origin && (origin[0] || origin[1])) out.origin = origin;
    if (v.fillRule === "evenodd") out.fillRule = "evenodd";
  } else if (typeof v.src === "string" && v.src.length <= LOGO_LIMITS.srcChars && /^(data:image\/(png|webp|jpeg|gif);base64,|https?:|\/)/i.test(v.src)) {
    out.src = v.src;
    if (typeof v.aspect === "number" && Number.isFinite(v.aspect) && v.aspect > 0) out.aspect = v.aspect;
  } else return null;
  if (LOGO_POSITIONS.includes(v.position as LogoPosition) && v.position !== "corner") out.position = v.position as LogoPosition;
  if (typeof v.scale === "number" && Number.isFinite(v.scale)) {
    const s = Math.min(LOGO_SCALE_RANGE.max, Math.max(LOGO_SCALE_RANGE.min, v.scale));
    if (s !== 1) out.scale = Math.round(s * 100) / 100;
  }
  return out;
}

/**
 * Inline uploads (data:/blob: URLs) can't travel in a link. The logo is the exception: it is kept
 * small at upload (a bounded mask PNG, or SVG path data), so links carry it.
 */
export const isEmbeddedMedia = (src: string | undefined): boolean => !!src && /^(data|blob):/i.test(src);

/** The design's uploaded font file, if it has one (`font.source === "upload"` with its data URL). */
export function embeddedFont(d: Pick<CardDesign, "font">): string | null {
  const f = d.font;
  return f && typeof f === "object" && f.source === "upload" && isFontDataUrl(f.src) ? f.src : null;
}

/** Inline uploads: artwork sides, stickers and an uploaded font file. */
export function countEmbeddedMedia(d: CardDesign): number {
  let n = d.decals.filter((x) => isEmbeddedMedia(x.src)).length;
  for (const s of SIDES) if (isEmbeddedMedia(d.surfaceSources[s])) n++;
  if (embeddedFont(d)) n++;
  return n;
}

/**
 * A copy with every inline upload removed: artwork sides cleared, those stickers dropped, and an
 * uploaded font's file left out (its family stays, so the recipient sees which font is missing and
 * can supply it; the card shows the fallback meanwhile).
 */
export function stripEmbeddedMedia(d: CardDesign): { design: CardDesign; stripped: number } {
  const out = cloneDesign(d);
  const stripped = countEmbeddedMedia(d);
  out.decals = out.decals.filter((x) => !isEmbeddedMedia(x.src));
  for (const s of SIDES) {
    if (isEmbeddedMedia(out.surfaceSources[s])) {
      delete out.surfaceSources[s];
      delete out.surfaceTreatments[s];
    }
  }
  if (embeddedFont(out) && out.font && typeof out.font === "object") out.font = { source: "upload", family: out.font.family };
  return { design: out, stripped };
}
