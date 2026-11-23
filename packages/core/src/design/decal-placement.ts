/**
 * Sticker placement: the card engine (crates/card3d-engine/src/decals.rs) and Card
 * Studio's sticker editor place stickers the same way.
 */
import type { Decal } from "../types.ts";
import { clamp } from "../materials/math.ts";
import { CARD_H as LANDSCAPE_H, CARD_W as LANDSCAPE_W } from "../geometry/constants.ts";
import { decalZ } from "../card/layers.ts";
import { decalVisibleAspect } from "./decal.ts";

/** Result of the planar placement algorithm `or`. */
export interface DecalPlacement {
  width: number;
  height: number;
  position: [number, number, number];
  /** Euler XYZ. */
  rotation: [number, number, number];
}

/** Largest array index of a decal whose side ≠ "back", else −1 . @archive the local three.js archive imports it */
export function frontDecalMaxIndex(decals: readonly Pick<Decal, "side">[]): number {
  let max = -1;
  decals.forEach((d, i) => {
    if (d.side !== "back") max = i;
  });
  return max;
}

/**
 * Size, rotated-bbox clamp, position and rotation of decal `r` (its index in the
 * whole decal array). `imageAspect` is the texture's w/h when known.
 */
export function decalPlacement(
  d: Pick<Decal, "side" | "x" | "y" | "width" | "rotation" | "crop"> & { aspect?: number | null; scale?: number | null },
  imageAspect: number | undefined,
  r: number,
  bodyDepth: number,
  /** Print frame of a shaped card (portrait: 2.125 × 3.37); default the landscape card. */
  frame?: { width: number; height: number },
): DecalPlacement {
  const CARD_W = frame?.width ?? LANDSCAPE_W;
  const CARD_H = frame?.height ?? LANDSCAPE_H;
  const picture = d.aspect ?? (imageAspect !== undefined && Number.isFinite(imageAspect) ? clamp(imageAspect, 0.2, 5) : 2);
  // A crop shows part of the picture: the quad takes the visible part's aspect (width stays the visible width).
  const aspect = decalVisibleAspect(picture, d.crop);
  const width = CARD_W * (d.width / 100) * (d.scale ?? 1);
  const height = width / aspect;
  const theta = (-(d.rotation ?? 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(theta));
  const s = Math.abs(Math.sin(theta));
  const hx = (((width / 2) * c + (height / 2) * s) / CARD_W) * 100;
  const hy = (((width / 2) * s + (height / 2) * c) / CARD_H) * 100;
  const px = hx >= 50 ? 50 : clamp(d.x, hx, 100 - hx);
  const py = hy >= 50 ? 50 : clamp(d.y, hy, 100 - hy);
  const back = d.side === "back";
  const z = decalZ(bodyDepth, r);
  return {
    width,
    height,
    position: [(px / 100 - 0.5) * CARD_W, (0.5 - py / 100) * CARD_H, back ? -z : z],
    rotation: [0, back ? Math.PI : 0, theta],
  };
}
