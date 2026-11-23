/**
 * Shaped outlines across the corner-radius range: symmetric and convex without cutouts (a radius of 1
 * is a true stadium), the notch only where it fits, and the print (mark, name, chip, contactless)
 * inside the outline with a margin at every radius, landscape and portrait.
 */
import { describe, expect, it } from "vitest";
import { brandingLayout, chipRect, contactlessRect } from "../card/branding-layout.ts";
import { BODY_SCALE, CORNER_RADIUS_MM_PER_UNIT, CORNER_RADIUS_RANGE, MM_PER_UNIT } from "./constants.ts";
import {
  DEFAULT_CORNER_RADIUS,
  frameForShape,
  NOTCH_MAX_CORNER_RADIUS,
  notchFits,
  resolveShape,
  shapeOutline,
  slotPlacement,
  windowPlacement,
} from "./shape-frame.ts";
import type { CardFrame } from "./frame.ts";

const RADII = [0, 0.25, 0.5, 0.75, 1];
const DEPTH = 7 * BODY_SCALE;

/** Signed distance from a point to the inside of a rounded-rect frame outline (positive = inside). */
function inside(f: CardFrame, x: number, y: number): number {
  const hx = f.bodyWidth / 2,
    hy = f.bodyHeight / 2,
    r = f.cornerRadius;
  const qx = Math.abs(x) - (hx - r),
    qy = Math.abs(y) - (hy - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return -outside;
}
const corners = (r: { x: number; y: number; w: number; h: number }) =>
  [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ].map(([sx, sy]) => [r.x + (sx! * r.w) / 2, r.y + (sy! * r.h) / 2] as const);

describe("shape outlines across the radius range", () => {
  for (const portrait of [false, true])
    for (const radius of RADII) {
      it(`${portrait ? "portrait" : "landscape"} r=${radius}: symmetric and convex`, () => {
        // The geometry handles sharp to pill; designs are clamped to ISO/IEC 7810's range (below).
        const pts = shapeOutline({ cornerRadius: radius, portrait, cutouts: [] });
        const f = frameForShape({ cornerRadius: radius, portrait, cutouts: [] });
        // Convex: every turn is to the left (CCW), no reflex vertex.
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i]!,
            b = pts[(i + 1) % pts.length]!,
            c = pts[(i + 2) % pts.length]!;
          const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
          expect(cross).toBeGreaterThan(-1e-9);
        }
        // Symmetric about both axes: each point's mirrors are on the outline.
        const near = (x: number, y: number) => pts.some((p) => Math.hypot(p.x - x, p.y - y) < 1e-6);
        for (const p of pts) {
          expect(near(-p.x, p.y)).toBe(true);
          expect(near(p.x, -p.y)).toBe(true);
        }
        // Spans the body exactly, and the long edges stay straight (they reach the full extent along a
        // run, i.e. the corner arcs never meet across the long side).
        const maxX = Math.max(...pts.map((p) => p.x)),
          maxY = Math.max(...pts.map((p) => p.y));
        expect(maxX).toBeCloseTo(f.bodyWidth / 2, 6);
        expect(maxY).toBeCloseTo(f.bodyHeight / 2, 6);
        const long = portrait
          ? pts.filter((p) => Math.abs(Math.abs(p.x) - f.bodyWidth / 2) < 1e-6)
          : pts.filter((p) => Math.abs(Math.abs(p.y) - f.bodyHeight / 2) < 1e-6);
        expect(long.length).toBeGreaterThanOrEqual(4);
        if (radius === 1) {
          // A stadium: both short ends are semicircles of half the short side.
          const r = Math.min(f.bodyWidth, f.bodyHeight) / 2;
          expect(f.cornerRadius).toBeCloseTo(r, 9);
          const c = portrait ? { x: 0, y: f.bodyHeight / 2 - r } : { x: f.bodyWidth / 2 - r, y: 0 };
          const end = pts.filter((p) => (portrait ? p.y > c.y + 1e-6 : p.x > c.x + 1e-6));
          expect(end.length).toBeGreaterThan(10);
          for (const p of end) expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(r, 6);
        }
      });

      it(`${portrait ? "portrait" : "landscape"} r=${radius}: the print stays clear of the curves`, () => {
        const f = frameForShape({ cornerRadius: radius, portrait, cutouts: [] });
        const L = brandingLayout(undefined, DEPTH, f);
        // Name and bio are wrapped to the column between the corner-inset margins (T line boxes);
        // landscape, the name keeps within ISO/IEC 7811-1's area 2 too.
        const col = Math.min(1, L.textRight! - L.nameLeft!);
        expect(L.T * L.E).toBeLessThanOrEqual(L.textRight! - L.nameLeft! + 1e-9);
        if (portrait) expect(L.T * L.E).toBeCloseTo(L.textRight! - L.nameLeft!, 9);
        const boxes = [
          { what: "mark", r: { x: L.logo.left + L.logo.width / 2, y: L.logo.top - L.logo.height / 2, w: L.logo.width * 0.8, h: L.logo.height } },
          { what: "chip", r: chipRect(f) },
          { what: "contactless", r: contactlessRect(f) },
          { what: "name", r: { x: L.nameLeft! + col / 2, y: L.textBottom + L.E / 2, w: col, h: L.E } },
          { what: "bio", r: { x: L.textRight! - col / 2, y: L.textBottom + L.E / 2, w: col, h: L.E } },
        ];
        for (const { what, r } of boxes)
          for (const [x, y] of corners(r)) expect(inside(f, x, y), `${what} at (${x.toFixed(3)}, ${y.toFixed(3)})`).toBeGreaterThan(0.03);
      });

      for (const cut of ["lanyard", "notch", "window"] as const)
        it(`${portrait ? "portrait" : "landscape"} r=${radius} + ${cut}: cutout inside the body`, () => {
          const f = frameForShape({ cornerRadius: radius, portrait, cutouts: cut === "notch" && !notchFits(radius) ? [] : [cut] });
          if (cut === "lanyard") {
            const p = slotPlacement(f);
            const half = { w: p.vertical ? p.width : p.length, h: p.vertical ? p.length : p.width };
            for (const [x, y] of corners({ x: p.x, y: p.y, ...half })) expect(inside(f, x, y)).toBeGreaterThan(0.02);
          }
          if (cut === "window") {
            const w = windowPlacement(f);
            expect(inside(f, w.x, w.y)).toBeGreaterThan(w.radius + 0.1);
          }
        });
    }

  it("keeps the notch only up to the radius it can replace", () => {
    expect(NOTCH_MAX_CORNER_RADIUS).toBeGreaterThan(0.25);
    expect(NOTCH_MAX_CORNER_RADIUS).toBeLessThan(0.5);
    expect(notchFits(0.2)).toBe(true);
    expect(notchFits(0.6)).toBe(false);
    // Every radius a design can have takes the notch.
    expect(notchFits(CORNER_RADIUS_RANGE.max)).toBe(true);
    expect(resolveShape({ cornerRadius: 40 / 270, cutouts: ["notch"] })!.cutouts).toEqual(["notch"]);
  });

  it("clamps a design's corner radius to ISO/IEC 7810 ID-1 (3.18 mm ± 0.30; 3.18 mm is the standard card)", () => {
    expect(CORNER_RADIUS_RANGE.min * CORNER_RADIUS_MM_PER_UNIT).toBeCloseTo(2.88, 6);
    expect(CORNER_RADIUS_RANGE.iso * CORNER_RADIUS_MM_PER_UNIT).toBeCloseTo(3.18, 6);
    expect(CORNER_RADIUS_RANGE.max * CORNER_RADIUS_MM_PER_UNIT).toBeCloseTo(3.48, 6);
    expect(DEFAULT_CORNER_RADIUS).toBe(CORNER_RADIUS_RANGE.iso);
    expect(resolveShape({ cornerRadius: DEFAULT_CORNER_RADIUS })).toBeNull();
    expect(resolveShape({ cornerRadius: 0.118 })).toBeNull(); // the default, rounded to 3 decimals
    // A pill, the former 4 mm default and sharp corners land on the range's ends.
    for (const [r, end] of [
      [1, CORNER_RADIUS_RANGE.max],
      [40 / 270, CORNER_RADIUS_RANGE.max],
      [0, CORNER_RADIUS_RANGE.min],
    ] as const)
      expect(resolveShape({ cornerRadius: r })!.cornerRadius).toBeCloseTo(end, 9);
    expect(resolveShape({ cornerRadius: 0.6, cutouts: ["notch", "window"] })!.cutouts).toEqual(["notch", "window"]);
    // The shaped body's outline radius is the design's, in mm.
    const mm = (r: number) => frameForShape({ cornerRadius: r, portrait: false, cutouts: [] }).cornerRadius * MM_PER_UNIT;
    expect(mm(CORNER_RADIUS_RANGE.min)).toBeCloseTo(2.88, 6);
    expect(mm(CORNER_RADIUS_RANGE.max)).toBeCloseTo(3.48, 6);
    expect(frameForShape({ cornerRadius: 0.12, portrait: true, cutouts: [] }).cornerRadius).toBeCloseTo(
      frameForShape({ cornerRadius: 0.12, portrait: false, cutouts: [] }).cornerRadius,
      12,
    );
  });
});
