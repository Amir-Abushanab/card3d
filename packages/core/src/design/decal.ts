/**
 * Sticker picture editing (PowerPoint style): crop, flip, recolour (tint), corrections (brightness,
 * contrast, saturation) and opacity on a `Decal`. Pure: validation, copies and the maths the engine's
 * sticker shader and Card Studio share. Every field is optional; a decal without
 * them renders exactly as before.
 */
import type { Decal, DecalAdjust, DecalCrop, DecalTint } from "../types.ts";

/** Ranges of the picture fields. */
export const DECAL_LIMITS = {
  /** Smallest crop side, a share of the image. */
  minCrop: 0.02,
  adjust: { min: -1, max: 1 },
  opacity: { min: 0, max: 1 },
  /** The placed picture's width / height. */
  aspect: { min: 0.01, max: 100 },
} as const;

/** The PowerPoint "Color" gallery: recolour presets (`null` = Original). */
export const DECAL_TINT_PRESETS: readonly { id: string; label: string; tint: DecalTint | null }[] = [
  { id: "original", label: "Original", tint: null },
  { id: "grayscale", label: "Grayscale", tint: { color: "#808080", amount: 1 } },
  { id: "sepia", label: "Sepia", tint: { color: "#a2804f", amount: 1 } },
  { id: "washout", label: "Washout", tint: { color: "#ffffff", amount: 0.7 } },
  { id: "blue", label: "Blue", tint: { color: "#3b6fd4", amount: 1 } },
  { id: "teal", label: "Teal", tint: { color: "#1d9a8a", amount: 1 } },
  { id: "gold", label: "Gold", tint: { color: "#c9972c", amount: 1 } },
  { id: "rose", label: "Rose", tint: { color: "#cf4f7c", amount: 1 } },
  { id: "violet", label: "Violet", tint: { color: "#7a52c7", amount: 1 } },
];

const HEX = /^#[0-9a-f]{6}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round = (v: number, k = 1e4) => Math.round(v * k) / k;

/** A crop from untrusted input: inside the image, each side ≥ `minCrop`. Null for none or the whole image. */
export function sanitizeDecalCrop(v: unknown): DecalCrop | null {
  if (!isObj(v) || !isNum(v.x) || !isNum(v.y) || !isNum(v.w) || !isNum(v.h)) return null;
  const m = DECAL_LIMITS.minCrop;
  const w = round(clamp(v.w, m, 1));
  const h = round(clamp(v.h, m, 1));
  const x = round(clamp(v.x, 0, 1 - w));
  const y = round(clamp(v.y, 0, 1 - h));
  return isFullCrop({ x, y, w, h }) ? null : { x, y, w, h };
}

export const isFullCrop = (c: DecalCrop | null | undefined): boolean =>
  !c || (Math.abs(c.x) < 1e-4 && Math.abs(c.y) < 1e-4 && Math.abs(c.w - 1) < 1e-4 && Math.abs(c.h - 1) < 1e-4);

export function sanitizeDecalTint(v: unknown): DecalTint | null {
  if (!isObj(v) || typeof v.color !== "string" || !HEX.test(v.color)) return null;
  const amount = isNum(v.amount) ? round(clamp(v.amount, 0, 1), 1e3) : 1;
  return amount > 0 ? { color: v.color.toLowerCase(), amount } : null;
}

export function sanitizeDecalAdjust(v: unknown): DecalAdjust | null {
  if (!isObj(v)) return null;
  const out: DecalAdjust = {};
  for (const k of ["brightness", "contrast", "saturation"] as const) {
    const x = v[k];
    if (isNum(x)) {
      const c = round(clamp(x, DECAL_LIMITS.adjust.min, DECAL_LIMITS.adjust.max), 1e3);
      if (c !== 0) out[k] = c;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The picture fields of a decal from untrusted input, written onto `out` (only the ones that change
 * something: a full crop, no flip, amount 0, zero corrections and opacity 1 are left out).
 */
export function sanitizeDecalPicture(v: Record<string, unknown>, out: Decal): Decal {
  const crop = sanitizeDecalCrop(v.crop);
  if (crop) out.crop = crop;
  if (isObj(v.flip) && (v.flip.h === true || v.flip.v === true))
    out.flip = { ...(v.flip.h === true ? { h: true } : {}), ...(v.flip.v === true ? { v: true } : {}) };
  const tint = sanitizeDecalTint(v.tint);
  if (tint) out.tint = tint;
  const adjust = sanitizeDecalAdjust(v.adjust);
  if (adjust) out.adjust = adjust;
  if (isNum(v.opacity) && v.opacity < 1) out.opacity = round(clamp(v.opacity, 0, 1), 1e3);
  return out;
}

/** Deep copy of a decal (its picture objects too, so edits never reach a history snapshot). */
export function cloneDecal(d: Decal): Decal {
  const out: Decal = { ...d };
  if (d.crop) out.crop = { ...d.crop };
  if (d.flip) out.flip = { ...d.flip };
  if (d.tint) out.tint = { ...d.tint };
  if (d.adjust) out.adjust = { ...d.adjust };
  return out;
}

/** Remove every picture edit (Reset picture): crop, flip, tint, corrections and opacity. */
export function resetDecalPicture(d: Decal): void {
  delete d.crop;
  delete d.flip;
  delete d.tint;
  delete d.adjust;
  delete d.opacity;
}

/** The visible (cropped) quad's width / height for a picture of `aspect` (width / height). */
export function decalVisibleAspect(aspect: number, crop: DecalCrop | null | undefined): number {
  return crop ? (aspect * crop.w) / crop.h : aspect;
}

/**
 * The texture transform that shows `crop` (flipped) on a quad with UVs 0–1, for a texture with
 * three's default `flipY` (v = 0 at the image's bottom): `uv' = offset + uv · repeat`.
 */
export function decalUvTransform(d: Pick<Decal, "crop" | "flip">): { offset: [number, number]; repeat: [number, number] } {
  const c = d.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const h = d.flip?.h === true;
  const v = d.flip?.v === true;
  const bottom = 1 - c.y - c.h;
  return {
    offset: [h ? c.x + c.w : c.x, v ? bottom + c.h : bottom],
    repeat: [h ? -c.w : c.w, v ? -c.h : c.h],
  };
}

/** True when the decal needs the colour patch of the sticker material (a tint or a correction). */
export const decalHasLook = (d: Pick<Decal, "tint" | "adjust">): boolean =>
  !!(d.tint && d.tint.amount > 0) || !!(d.adjust && (d.adjust.brightness || d.adjust.contrast || d.adjust.saturation));

/** `#rrggbb` → sRGB 0–1. */
function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Contrast slider (−1–1) → the factor about mid-grey: −1 flat, 0 unchanged, 1 ×10. */
export const contrastFactor = (c: number): number => (c < 0 ? 1 + c : 1 / (1 - 0.9 * c));

/**
 * The sticker colour pipeline, on one display-space (sRGB, 0–1) colour: brightness (towards white or
 * black), contrast (about mid-grey), saturation (from its luminance), then the tint (luminance mapped
 * black → tint colour → white, mixed in by `amount`). The engine's sticker shader does exactly this
 * per pixel; the studio uses it for preset swatches and tests check it.
 */
export function decalLookRgb(rgb: readonly [number, number, number], d: Pick<Decal, "tint" | "adjust">): [number, number, number] {
  let [r, g, b] = rgb;
  const a = d.adjust ?? {};
  const br = a.brightness ?? 0;
  if (br) {
    const t = br > 0 ? 1 : 0;
    const k = Math.abs(br);
    r += (t - r) * k;
    g += (t - g) * k;
    b += (t - b) * k;
  }
  if (a.contrast) {
    const f = contrastFactor(a.contrast);
    r = (r - 0.5) * f + 0.5;
    g = (g - 0.5) * f + 0.5;
    b = (b - 0.5) * f + 0.5;
  }
  if (a.saturation) {
    const s = 1 + a.saturation;
    const l = luma(r, g, b);
    r = l + (r - l) * s;
    g = l + (g - l) * s;
    b = l + (b - l) * s;
  }
  r = clamp(r, 0, 1);
  g = clamp(g, 0, 1);
  b = clamp(b, 0, 1);
  if (d.tint && d.tint.amount > 0) {
    const [tr, tg, tb] = hexRgb(d.tint.color);
    const l = luma(r, g, b);
    const duo = (t: number) => (l < 0.5 ? t * l * 2 : t + (1 - t) * (l * 2 - 1));
    const k = d.tint.amount;
    r += (duo(tr) - r) * k;
    g += (duo(tg) - g) * k;
    b += (duo(tb) - b) * k;
  }
  return [r, g, b];
}

/** Rec. 709 luma of a display-space colour. */
const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
