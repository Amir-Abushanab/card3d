/**
 * The branding's layout and rasters (the engine builds the planes: crates/card3d-engine/src/branding.rs): the front
 * layout, the logo canvases, the chip and contactless rectangles, the text lines' placement and the
 * print mark's description. Production exports (`@card3d/core/print`) and the engine page read these.
 */
import type { AssetProvider, CardLogo, CardTextLine, LogoPosition, MarkFinish } from "../types.ts";
import { clamp } from "../materials/math.ts";
import { CARD_H, CARD_W, CHIP_CENTER, CHIP_SIZE, MM_PER_UNIT } from "../geometry/constants.ts";
import type { CardFrame } from "../geometry/frame.ts";
import { cornerInset } from "../geometry/shape-frame.ts";
import { ISO_7811_AREAS, ISO_NUMBER_CENTRELINE_MM, isoFrame, isoPoint, isoRect } from "../geometry/iso.ts";
import { CONTACTLESS_ASPECT, CONTACTLESS_SCALE } from "./contactless.ts";
import { createCanvas } from "../geometry/canvas.ts";
import { GENERIC_MARK } from "./generic-mark.ts";
import { LAYER } from "./layers.ts";
import { LOGO_LIMITS, LOGO_POSITIONS, LOGO_SCALE_RANGE, USER_LOGO_RASTER } from "./logo-limits.ts";
export { LOGO_LIMITS, LOGO_SCALE_RANGE };
/** @archive the local three.js archive (.archive/three-engine) imports them */
export { LOGO_POSITIONS, USER_LOGO_RASTER };

/** Branding layout inputs, fractions of W or H. */
export interface FrontLayout {
  logoLeft: number;
  logoTop: number;
  logoHeight: number;
  nameFontHeight: number;
  nameBottom: number;
}

const DEFAULT_FRONT_LAYOUT: Readonly<FrontLayout> = Object.freeze({
  logoLeft: 0.06,
  logoTop: 0.075,
  logoHeight: 0.1,
  nameFontHeight: 0.05,
  nameBottom: 0.09,
});

/** Logo raster size and plane aspect (256 × 224 ⇒ 56/49). */
const LOGO_CANVAS = { width: 256, height: 224 } as const;

/** Derived branding layout . */
export interface BrandingLayout {
  /** World height of one text line box. */
  E: number;
  /** Side margin. */
  M: number;
  /** maxWidthLines / maxHeightLines for the rasteriser. */
  T: number;
  I: number;
  logo: { width: number; height: number; left: number; top: number };
  textBottom: number;
  /** Branding plane |z|: J + 0.013. */
  z: number;
  /** Shaped card (`geometry.frame`): print size, chip, corner insets. Absent on the standard card. */
  frame?: CardFrame;
  /** Left edge of the name block (= `logo.left` on the standard card). */
  nameLeft?: number;
  /** Right edge of the bio / right-hand text (= W/2 − M on the standard card). */
  textRight?: number;
  /** Shaped card: how far the top corner blocks moved in (diagonally) to clear the corner radius. */
  cornerTop?: number;
  /**
   * Landscape ID-1 frame: ISO/IEC 7811-1 embossing area 1, the number line (card units: its left and
   * right ends and the characters' centreline `y`, ±`h` / 2). The first bottom-left text line goes here.
   */
  numberLine?: { left: number; right: number; y: number; h: number };
}

export function brandingLayout(layout: Partial<FrontLayout> | undefined, bodyDepth: number, frame?: CardFrame): BrandingLayout {
  const l = { ...DEFAULT_FRONT_LAYOUT, ...layout };
  const c = (v: number) => clamp(v, 0, 0.45);
  if (frame) return shapedBrandingLayout(l, bodyDepth, frame);
  const E = CARD_H * l.nameFontHeight;
  const M = CARD_W * c(l.logoLeft);
  const Lh = CARD_H * l.logoHeight;
  return {
    E,
    M,
    T: (CARD_W - 2 * M) / E,
    I: (CARD_H - CARD_H * c(l.nameBottom) - CARD_H * c(l.logoTop)) / E,
    logo: {
      width: (LOGO_CANVAS.width / LOGO_CANVAS.height) * Lh,
      height: Lh,
      left: -CARD_W / 2 + CARD_W * l.logoLeft,
      top: CARD_H / 2 - CARD_H * l.logoTop,
    },
    textBottom: -CARD_H / 2 + CARD_H * l.nameBottom,
    z: bodyDepth / 2 + LAYER.branding.z,
  };
}

/**
 * The layout of an ID-1 frame (the public card and every shape): the standard layout's absolute sizes
 * (in CARD_W / CARD_H units: the card is the same physical size turned or not) measured
 * from the frame's edges, with every corner block moved in just enough to clear the corner radius.
 * Landscape, the name and number lines follow ISO/IEC 7811-1's embossing areas (`ISO_7811_AREAS`): the
 * name starts where area 2 starts and keeps within it (its line box between the area's bottom and
 * top, so the baseline is inside), and area 1 takes the number line. Portrait cards aren't embossed
 * (the areas would run sideways): their print keeps the margins.
 */
function shapedBrandingLayout(l: FrontLayout, bodyDepth: number, frame: CardFrame): BrandingLayout {
  const c = (v: number) => clamp(v, 0, 0.45);
  const W = frame.width;
  const H = frame.height;
  const E = CARD_H * l.nameFontHeight;
  const M = CARD_W * c(l.logoLeft);
  const Lh = CARD_H * l.logoHeight;
  const top = CARD_H * c(l.logoTop);
  let bottom = CARD_H * c(l.nameBottom);
  // Corner blocks (mark, name, bio) move in diagonally just enough to clear the corner radius.
  const insetTop = cornerInset(frame, M, top);
  let insetBottom = cornerInset(frame, M, bottom);
  let nameLeft = -W / 2 + M + insetBottom;
  let nameRight = W / 2 - M - insetBottom;
  let numberLine: BrandingLayout["numberLine"];
  if (!frame.portrait) {
    const name = isoRect(ISO_7811_AREAS.name);
    const num = isoRect(ISO_7811_AREAS.number);
    // The name's line box (≈ 1.13 E with the raster's padding) between area 2's bottom and top.
    const lo = name.y - name.h / 2 + H / 2;
    bottom = clamp(bottom, lo, Math.max(lo, lo + name.h - 1.13 * E));
    insetBottom = cornerInset(frame, M, bottom);
    nameLeft = Math.max(nameLeft, name.x - name.w / 2);
    nameRight = Math.min(nameRight, name.x + name.w / 2);
    numberLine = { left: num.x - num.w / 2, right: Math.min(num.x + num.w / 2, W / 2 - M), y: isoPoint(0, ISO_NUMBER_CENTRELINE_MM).y, h: num.h };
  }
  return {
    E,
    M,
    T: (nameRight - nameLeft) / E,
    I: (H - bottom - top - insetTop - insetBottom) / E,
    logo: { width: (LOGO_CANVAS.width / LOGO_CANVAS.height) * Lh, height: Lh, left: -W / 2 + M + insetTop, top: H / 2 - top - insetTop },
    textBottom: -H / 2 + bottom + insetBottom,
    z: bodyDepth / 2 + LAYER.branding.z,
    frame,
    nameLeft,
    textRight: W / 2 - M - insetBottom,
    cornerTop: insetTop,
    ...(numberLine ? { numberLine } : {}),
  };
}

/** The public build's corner mark (`GENERIC_MARK`), used when a provider supplies none. */
export const GENERIC_BRAND_MARK = GENERIC_MARK;

/**
 * Logo raster: 256 × 224 canvas, mark scaled to the canvas width (or height, if the
 * mark is taller) and translated by its x origin, filled white (non-zero). A mark whose path
 * doesn't start at the origin passes its start as `originX` alongside `path`/`viewBox`.
 */
export function drawLogoCanvas(mark: AssetProvider["brandMark"]): HTMLCanvasElement | OffscreenCanvas | null {
  const m = (mark ?? GENERIC_BRAND_MARK) as NonNullable<AssetProvider["brandMark"]> & { originX?: number; originY?: number };
  const canvas = createCanvas(LOGO_CANVAS.width, LOGO_CANVAS.height);
  const ctx = canvas?.getContext("2d") as CanvasRenderingContext2D | null | undefined;
  if (!canvas || !ctx || typeof Path2D === "undefined") return null;
  const [vw, vh] = m.viewBox;
  const k = Math.min(LOGO_CANVAS.width / vw, LOGO_CANVAS.height / vh);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(k, k);
  ctx.translate(-(m.originX ?? 0), -(m.originY ?? 0));
  ctx.fillStyle = "#ffffff";
  ctx.fill(new Path2D(m.path));
  return canvas;
}

// ── user logos (CardDesign.logo) ────────────────────────────────────────────

export type LogoImage = CanvasImageSource & { width: number; height: number };

/** A usable logo (path or raster), else null. */
export function validLogo(logo: CardLogo | null | undefined): CardLogo | null {
  if (!logo) return null;
  const vb = logo.viewBox;
  if (typeof logo.path === "string" && logo.path.trim() && Array.isArray(vb) && vb[0] > 0 && vb[1] > 0) return logo;
  if (typeof logo.src === "string" && logo.src) return logo;
  return null;
}

/**
 * The logo raster: white glyph on transparent (alpha = shape), `USER_LOGO_RASTER` px tall. Paths are
 * filled (their fill rule) into the viewBox; images are drawn and their alpha kept, colour discarded.
 */
export function drawUserLogoCanvas(logo: CardLogo, image: LogoImage | null): { canvas: HTMLCanvasElement | OffscreenCanvas; aspect: number } | null {
  const [amin, amax] = LOGO_LIMITS.aspect;
  const usePath = !!logo.path && !!logo.viewBox;
  const natural = usePath ? logo.viewBox![0] / logo.viewBox![1] : image ? image.width / Math.max(1, image.height) : 0;
  if (!(natural > 0)) return null;
  const aspect = clamp(natural, amin, amax);
  let H = USER_LOGO_RASTER;
  let W = Math.round(H * aspect);
  if (W > 2048) {
    H = Math.round((H * 2048) / W);
    W = 2048;
  }
  const canvas = createCanvas(W, H);
  const ctx = canvas?.getContext("2d") as CanvasRenderingContext2D | null | undefined;
  if (!canvas || !ctx) return null;
  ctx.clearRect(0, 0, W, H);
  if (usePath) {
    if (typeof Path2D === "undefined") return null;
    const [vw, vh] = logo.viewBox!;
    const k = Math.min(W / vw, H / vh);
    ctx.translate((W - vw * k) / 2, (H - vh * k) / 2);
    ctx.scale(k, k);
    ctx.translate(-(logo.origin?.[0] ?? 0), -(logo.origin?.[1] ?? 0));
    ctx.fillStyle = "#ffffff";
    ctx.fill(new Path2D(logo.path!), logo.fillRule === "evenodd" ? "evenodd" : "nonzero");
  } else if (image) {
    // Fit (letterboxed when the aspect was clamped), then keep only the alpha, filled white.
    const k = Math.min(W / image.width, H / image.height);
    const dw = image.width * k;
    const dh = image.height * k;
    ctx.drawImage(image, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  } else return null;
  return { canvas, aspect };
}

/**
 * World-space rectangle (centre x/y, size w/h) of a user logo on the front face. Sizes start from the
 * corner mark's height × `scale`, then shrink to stay clear of the chip and the name line.
 */
export function userLogoRect(
  logo: CardLogo,
  aspect: number,
  L: BrandingLayout,
  obstacles: readonly Rect[] = L.frame ? [chipRect(L.frame)] : [],
): { x: number; y: number; w: number; h: number } {
  const position: LogoPosition = LOGO_POSITIONS.includes(logo.position as LogoPosition) ? (logo.position as LogoPosition) : "corner";
  const scale = clamp(typeof logo.scale === "number" && Number.isFinite(logo.scale) ? logo.scale : 1, LOGO_SCALE_RANGE.min, LOGO_SCALE_RANGE.max);
  const limits: Record<LogoPosition, { w: number; h: number }> = {
    // Top band (above the chip, which starts 0.475 H down) and the bottom-right corner (below it).
    corner: { w: 0.6 * CARD_W, h: 0.36 * CARD_H },
    "top-right": { w: 0.5 * CARD_W, h: 0.36 * CARD_H },
    center: { w: 0.46 * CARD_W, h: 0.5 * CARD_H },
    "bottom-right": { w: 0.42 * CARD_W, h: 0.2 * CARD_H },
  };
  let h = L.logo.height * scale;
  let w = h * aspect;
  const lim = { ...limits[position] };
  const F = L.frame;
  if (F) {
    // Shaped card: the same physical limits, never wider than the print area between the margins.
    lim.w = Math.min(lim.w, F.width - 2 * (L.M + (L.cornerTop ?? 0)));
    lim.h = Math.min(lim.h, F.portrait ? 0.3 * F.height : lim.h);
  }
  const k = Math.min(1, lim.w / w, lim.h / h);
  w *= k;
  h *= k;
  const left = L.logo.left;
  const right = -left;
  // Shaped cards: the right-hand corners clear the corner radius at their own heights.
  const rightTop = F ? F.width / 2 - L.M - (L.cornerTop ?? 0) : right;
  const rightBottom = F ? (L.textRight ?? right) : right;
  const top = L.logo.top;
  const place = (w: number, h: number): Rect => {
    switch (position) {
      case "top-right":
        return { x: rightTop - w / 2, y: top - h / 2, w, h };
      case "center":
        return { x: 0, y: 0, w, h };
      case "bottom-right":
        return { x: rightBottom - w / 2, y: L.textBottom + h / 2, w, h };
      default:
        return { x: left + w / 2, y: top - h / 2, w, h };
    }
  };
  // An ID-1 frame's chip (and contactless mark) can sit where a large logo reaches: shrink it, about
  // its anchor, until it clears them by 0.06 (the default layout's limits already keep it clear).
  const pad = 0.06;
  const hits = (r: Rect) => obstacles.some((b) => Math.abs(r.x - b.x) < (r.w + b.w) / 2 + pad && Math.abs(r.y - b.y) < (r.h + b.h) / 2 + pad);
  if (!hits(place(w, h))) return place(w, h);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (hits(place(w * m, h * m))) hi = m;
    else lo = m;
  }
  return place(w * lo, h * lo);
}

/** `userData` key of a branding plane's `PrintMark` (production exports read it; rendering never does). */
export const PRINT_MARK_KEY = "printMark";

/** What a branding plane is made of: its finish and the glyph mask it was built from. */
export interface PrintMark {
  finish: MarkFinish;
  /** White-on-transparent glyph raster (alpha = shape); null when the plane has no finish source. */
  source: HTMLCanvasElement | OffscreenCanvas | null;
  /** Padding of the plane around the glyph raster on each side, as a fraction of the raster's size. */
  padX: number;
  padY: number;
}

/** Size of the bio on a clear card's front, × the name's line box (like an extra text line). @archive the local three.js archive imports it */
export const CLEAR_BIO_SIZE = 0.8;

/** A centred rectangle, card units. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_LINE_SIZE = 0.8;
/**
 * Where a text raster's capitals are centred, as a fraction of its box from the top: 6 px padding
 * plus half the ascent of "H" (≈ 0.78 of the 'Hg' line height) over the line height plus 12 px.
 */
const NUMBER_CAP_CENTRE = (6 + 0.39 * 94) / (94 + 12);
/** @archive the local three.js archive (.archive/three-engine) imports it */
export const TEXT_LINE_LIMITS = { size: [0.4, 2] as const, tracking: [-0.05, 0.6] as const, maxLines: 3, maxChars: 48 };

/** Where the chip sits (centre and size as drawn), for layout. */
export function chipRect(frame: CardFrame | undefined): Rect {
  const c = frame?.chip ?? { x: CHIP_CENTER.x, y: CHIP_CENTER.y, rotation: 0, width: CHIP_SIZE.width, height: CHIP_SIZE.height };
  const turned = Math.abs(Math.sin(c.rotation)) > 0.5;
  return { x: c.x, y: c.y, w: turned ? c.height : c.width, h: turned ? c.width : c.height };
}

/**
 * The contactless mark: beside the chip, centred on it, as tall as `scale` × the chip, 0.07 (1.8 mm)
 * from it. The standard (frame-less) card puts it on the side towards the card's centre (left of its
 * right-hand chip); an ID-1 frame's chip (ISO, left half; near the top, portrait) has it on its right, the side
 * the mark opens to, and (landscape) stays out of embossing area 1 below it, so at most ≈ the plate's
 * height.
 */
export function contactlessRect(frame: CardFrame | undefined, scale: number = CONTACTLESS_SCALE.default): Rect {
  const chip = chipRect(frame);
  let h = chip.h * clamp(scale, CONTACTLESS_SCALE.min, CONTACTLESS_SCALE.max);
  // Landscape ID-1: centred on the chip, it stops short of embossing area 1 (the number line) below.
  if (frame && !frame.portrait) h = Math.min(h, 2 * (chip.y - isoPoint(0, ISO_7811_AREAS.number.y0 - 0.3).y));
  const w = h * CONTACTLESS_ASPECT;
  const gap = 0.07;
  const left = !frame && chip.x > 0;
  const x = left ? chip.x - chip.w / 2 - gap - w / 2 : chip.x + chip.w / 2 + gap + w / 2;
  return { x, y: chip.y, w, h };
}

/** The contactless mark's printed height in mm on an ID-1 card at `scale` (after the number-line cap). */
export function contactlessHeightMm(scale: number = CONTACTLESS_SCALE.default, portrait = false): number {
  return contactlessRect(isoFrame(portrait, 0, []), scale).h * MM_PER_UNIT;
}

export interface LineBox {
  /** Raster aspect (w/h) and height in name line boxes (as `CardTextRaster`). */
  aspect: number;
  heightInLineBoxes: number;
  size?: number;
  align?: CardTextLine["align"];
  placement?: CardTextLine["placement"];
  /** Never the number line (the clear card's bio, which belongs with the name). */
  withName?: boolean;
}

/**
 * Pure: where each extra text line goes. Lines sharing a placement stack in reading order —
 * bottom-left directly above the name (`nameTop`), bottom-right up from the name's baseline band,
 * centre around the middle, top down from the mark's top — aligned in their column (default: left,
 * right, centre, right) and kept clear of the chip, the contactless mark and (top) the logo; an
 * over-long line shrinks to fit its column. With an ISO number line (`L.numberLine`, landscape ID-1
 * frames) the first bottom-left line goes on it instead (ISO/IEC 7811-1 area 1, where a card's number
 * goes), its characters centred on the area's centreline, and the rest stack above the name.
 */
export function layoutTextLines(lines: readonly LineBox[], L: BrandingLayout, o: { nameTop: number; obstacles: Rect[] }): Rect[] {
  const F = L.frame;
  const W = F?.width ?? CARD_W;
  const left0 = L.nameLeft ?? L.logo.left;
  const right0 = L.textRight ?? W / 2 - L.M;
  const gap = 0.22 * L.E;
  // oxlint-disable-next-line unicorn/no-new-array -- pre-sized: every line belongs to one group below, which sets its slot
  const out: Rect[] = new Array(lines.length);
  const groups = new Map<string, number[]>();
  const numberAt = L.numberLine ? lines.findIndex((ln) => (ln.placement ?? "bottom-left") === "bottom-left" && !ln.withName) : -1;
  lines.forEach((ln, i) => {
    const p = i === numberAt ? "number" : (ln.placement ?? "bottom-left");
    (groups.get(p) ?? groups.set(p, []).get(p)!).push(i);
  });
  for (const [placement, idx] of groups) {
    const heights = idx.map(
      (i) => L.E * clamp(lines[i]!.size ?? DEFAULT_LINE_SIZE, TEXT_LINE_LIMITS.size[0], TEXT_LINE_LIMITS.size[1]) * lines[i]!.heightInLineBoxes,
    );
    const total = heights.reduce((a, b) => a + b, 0) + gap * (heights.length - 1);
    // Block's vertical extent, then the y of each line (reading order = top to bottom).
    let top: number;
    const num = placement === "number" ? L.numberLine! : null;
    // The number line: the capitals (≈ 0.4 of the raster box down from its top) on the centreline.
    if (num) top = num.y + total * NUMBER_CAP_CENTRE;
    else if (placement === "bottom-left") top = o.nameTop + gap + total;
    else if (placement === "bottom-right") top = L.textBottom + total;
    else if (placement === "center") top = total / 2;
    else top = L.logo.top;
    const bottom = top - total;
    // Column: between the margins, clear of whatever overlaps the block vertically.
    let left = num ? num.left : placement === "top" && F ? -W / 2 + L.M + (L.cornerTop ?? 0) : left0;
    let right = num ? num.right : placement === "top" && F ? W / 2 - L.M - (L.cornerTop ?? 0) : right0;
    const centre = (left + right) / 2;
    for (const ob of o.obstacles) {
      if (ob.y - ob.h / 2 > top || ob.y + ob.h / 2 < bottom) continue;
      if (ob.x - ob.w / 2 > right || ob.x + ob.w / 2 < left) continue;
      if (ob.x >= centre) right = Math.min(right, ob.x - ob.w / 2 - 0.08);
      else left = Math.max(left, ob.x + ob.w / 2 + 0.08);
    }
    const colW = Math.max(0.2, right - left);
    let y = top;
    idx.forEach((i, k) => {
      const ln = lines[i]!;
      let h = heights[k]!;
      let w = h * ln.aspect;
      const fit = Math.min(1, colW / w);
      const yc = y - h / 2;
      y -= h + gap;
      w *= fit;
      h *= fit;
      const align = ln.align ?? (placement === "bottom-left" || num ? "left" : placement === "center" ? "center" : "right");
      const x = align === "left" ? left + w / 2 : align === "right" ? right - w / 2 : (left + right) / 2;
      out[i] = { x, y: yc, w, h };
    });
  }
  return out;
}
