/**
 * The maths of on-card sticker editing, in the sticker's own frame (card units, x right, y up, centred
 * on the sticker): placement, resizing from a handle and the crop rectangle of crop mode. Pure, so it
 * is unit tested; sticker-editor.ts turns pointers into frame coordinates and back.
 */
import { decalVisibleAspect, sanitizeDecalCrop, type Decal, type DecalCrop } from "@card3d/core/model";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const DEG = 180 / Math.PI;

export interface Size {
  width: number;
  height: number;
}

/** A rectangle in a sticker frame: x0 < x1, y0 < y1 (y up). */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The planar placement of the planar algorithm (centre clamped so the rotated box stays on the card), cropped quad. */
export function placement(d: Decal, size: Size) {
  const { width: CW, height: CH } = size;
  const width = CW * (d.width / 100) * (d.scale ?? 1);
  const height = width / decalVisibleAspect(d.aspect || 1, d.crop);
  const theta = -(d.rotation ?? 0) / DEG;
  const c = Math.abs(Math.cos(theta));
  const s = Math.abs(Math.sin(theta));
  const hx = (((width / 2) * c + (height / 2) * s) / CW) * 100;
  const hy = (((width / 2) * s + (height / 2) * c) / CH) * 100;
  const px = hx >= 50 ? 50 : clamp(d.x, hx, 100 - hx);
  const py = hy >= 50 ? 50 : clamp(d.y, hy, 100 - hy);
  return { width, height, theta, px, py, x: (px / 100 - 0.5) * CW, y: (0.5 - py / 100) * CH };
}

export interface ResizeOptions {
  /** Keep the aspect ratio (corners always do; Shift on an edge). */
  keep: boolean;
  /** Resize about the centre (Alt) instead of the opposite side. */
  fromCenter: boolean;
  /** Smallest side, card units. */
  min: number;
}

/**
 * Drag handle (hx, hy) ∈ {−1, 0, 1}² of a w × h box to pointer `p` (frame coordinates at the gesture's
 * start). Returns the new size and how far the centre moves (frame coordinates): the opposite side or
 * corner stays put.
 */
export function resizeBox(
  w: number,
  h: number,
  hx: number,
  hy: number,
  p: { x: number; y: number },
  o: ResizeOptions,
): { w: number; h: number; dx: number; dy: number } {
  let W = w;
  let H = h;
  if (hx) W = o.fromCenter ? 2 * Math.abs(p.x) : hx * p.x + w / 2;
  if (hy) H = o.fromCenter ? 2 * Math.abs(p.y) : hy * p.y + h / 2;
  if (o.keep) {
    let s: number;
    if (hx && hy) {
      // Project the pointer on the diagonal through the anchor (or the centre).
      const kx = hx * w;
      const ky = hy * h;
      const vx = o.fromCenter ? 2 * p.x : p.x + (hx * w) / 2;
      const vy = o.fromCenter ? 2 * p.y : p.y + (hy * h) / 2;
      s = (vx * kx + vy * ky) / (kx * kx + ky * ky);
    } else s = hx ? W / w : H / h;
    s = Math.max(s, o.min / Math.min(w, h));
    W = w * s;
    H = h * s;
  } else {
    W = Math.max(o.min, W);
    H = Math.max(o.min, H);
  }
  if (o.fromCenter) return { w: W, h: H, dx: 0, dy: 0 };
  return { w: W, h: H, dx: hx ? (hx * (W - w)) / 2 : 0, dy: hy ? (hy * (H - h)) / 2 : 0 };
}

/** Crop mode's state, in the frame of the whole picture (centred on it). */
export interface CropFrame {
  /** The whole picture's size, card units. */
  w: number;
  h: number;
  /** The crop rectangle (what stays visible). */
  rect: Rect;
  /** −1 where the picture is mirrored. */
  fx: 1 | -1;
  fy: 1 | -1;
}

/**
 * Enter crop mode: the whole picture around a sticker shown `vw` × `vh` (its visible, cropped size).
 * `offset` is where the crop's centre sits in the picture's frame: the picture's centre is the
 * sticker's centre minus it.
 */
export function cropFrame(d: Pick<Decal, "crop" | "flip">, vw: number, vh: number): CropFrame & { offset: { x: number; y: number } } {
  const c = d.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const w = vw / c.w;
  const h = vh / c.h;
  const fx = d.flip?.h ? -1 : 1;
  const fy = d.flip?.v ? -1 : 1;
  const ox = (c.x + c.w / 2 - 0.5) * w * fx;
  const oy = (0.5 - (c.y + c.h / 2)) * h * fy;
  return { w, h, fx, fy, offset: { x: ox, y: oy }, rect: { x0: ox - vw / 2, x1: ox + vw / 2, y0: oy - vh / 2, y1: oy + vh / 2 } };
}

/** The crop rectangle → the decal's normalized source crop (null: the whole picture). */
export function cropToSource(f: CropFrame): DecalCrop | null {
  const us = [f.rect.x0, f.rect.x1].map((x) => x / (f.w * f.fx) + 0.5).sort((a, b) => a - b);
  const vs = [f.rect.y0, f.rect.y1].map((y) => 0.5 - y / (f.h * f.fy)).sort((a, b) => a - b);
  return sanitizeDecalCrop({ x: us[0], y: vs[0], w: us[1] - us[0], h: vs[1] - vs[0] });
}

const bounds = (f: Pick<CropFrame, "w" | "h">): Rect => ({ x0: -f.w / 2, x1: f.w / 2, y0: -f.h / 2, y1: f.h / 2 });

/**
 * Drag crop handle (hx, hy) to pointer `p` (picture frame): the rectangle stays inside the picture,
 * each side ≥ `min`; `ratio` (visible width / height) keeps its proportions, anchored at the opposite
 * corner (a corner) or centred across (an edge).
 */
export function cropDrag(
  start: Rect,
  f: Pick<CropFrame, "w" | "h">,
  hx: number,
  hy: number,
  p: { x: number; y: number },
  ratio: number | null,
  min: number,
): Rect {
  const B = bounds(f);
  const r = { ...start };
  if (hx < 0) r.x0 = clamp(p.x, B.x0, r.x1 - min);
  if (hx > 0) r.x1 = clamp(p.x, r.x0 + min, B.x1);
  if (hy < 0) r.y0 = clamp(p.y, B.y0, r.y1 - min);
  if (hy > 0) r.y1 = clamp(p.y, r.y0 + min, B.y1);
  if (!ratio) return r;
  let w = r.x1 - r.x0;
  let h = r.y1 - r.y0;
  if (hx && hy) {
    const ax = hx < 0 ? r.x1 : r.x0;
    const ay = hy < 0 ? r.y1 : r.y0;
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
    const maxW = hx > 0 ? B.x1 - ax : ax - B.x0;
    const maxH = hy > 0 ? B.y1 - ay : ay - B.y0;
    if (w > maxW) [w, h] = [maxW, maxW / ratio];
    if (h > maxH) [w, h] = [maxH * ratio, maxH];
    return hx > 0 ? { ...edgesY(r, hy, ay, h), x0: ax, x1: ax + w } : { ...edgesY(r, hy, ay, h), x0: ax - w, x1: ax };
  }
  if (hx) {
    // Width from the pointer, height follows about the centre line.
    const cy = (start.y0 + start.y1) / 2;
    h = w / ratio;
    if (h > f.h) [h, w] = [f.h, f.h * ratio];
    const y0 = clamp(cy - h / 2, B.y0, B.y1 - h);
    const x = hx > 0 ? { x0: r.x0, x1: r.x0 + w } : { x0: r.x1 - w, x1: r.x1 };
    return { ...x, y0, y1: y0 + h };
  }
  const cx = (start.x0 + start.x1) / 2;
  w = h * ratio;
  if (w > f.w) [w, h] = [f.w, f.w / ratio];
  const x0 = clamp(cx - w / 2, B.x0, B.x1 - w);
  const y = hy > 0 ? { y0: r.y0, y1: r.y0 + h } : { y0: r.y1 - h, y1: r.y1 };
  return { ...y, x0, x1: x0 + w };
}

const edgesY = (_r: Rect, hy: number, ay: number, h: number) => (hy > 0 ? { y0: ay, y1: ay + h } : { y0: ay - h, y1: ay });

/**
 * Move the picture under a fixed crop by `d` (picture frame axes): the crop stays on the card, so in
 * the picture's frame it moves by −d, kept inside the picture. Returns the move actually made.
 */
export function cropPan(start: Rect, f: Pick<CropFrame, "w" | "h">, d: { x: number; y: number }): { rect: Rect; dx: number; dy: number } {
  const B = bounds(f);
  const dx = clamp(d.x, start.x1 - B.x1, start.x0 - B.x0);
  const dy = clamp(d.y, start.y1 - B.y1, start.y0 - B.y0);
  return { dx, dy, rect: { x0: start.x0 - dx, x1: start.x1 - dx, y0: start.y0 - dy, y1: start.y1 - dy } };
}

/** An aspect preset: the largest rectangle of `ratio` inside the picture, centred where the crop is. */
export function cropFit(rect: Rect, f: Pick<CropFrame, "w" | "h">, ratio: number): Rect {
  const B = bounds(f);
  const w = Math.min(f.w, f.h * ratio);
  const h = w / ratio;
  const cx = clamp((rect.x0 + rect.x1) / 2, B.x0 + w / 2, B.x1 - w / 2);
  const cy = clamp((rect.y0 + rect.y1) / 2, B.y0 + h / 2, B.y1 - h / 2);
  return { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
}

/** The crop aspect presets of crop mode (`null`: free; "original": the whole picture's proportions). */
export const CROP_ASPECTS = [
  { id: "free", label: "Free", ratio: null },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "original", label: "Original", ratio: "original" },
] as const;
export type CropAspectId = (typeof CROP_ASPECTS)[number]["id"];

/** The ratio of a preset for the current crop: 4:3 / 16:9 follow its orientation (3:4 when it is taller). */
export function aspectRatio(id: CropAspectId, f: Pick<CropFrame, "w" | "h" | "rect">): number | null {
  const a = CROP_ASPECTS.find((x) => x.id === id)!;
  if (a.ratio === null) return null;
  if (a.ratio === "original") return f.w / f.h;
  const tall = f.rect.y1 - f.rect.y0 > f.rect.x1 - f.rect.x0;
  return tall && a.ratio !== 1 ? 1 / a.ratio : a.ratio;
}
