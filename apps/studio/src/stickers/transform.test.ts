import { describe, expect, it } from "vitest";
import type { Decal } from "@card3d/core/model";
import { decalPlacement } from "@card3d/core/editor";
import { aspectRatio, cropDrag, cropFit, cropFrame, cropPan, cropToSource, placement, resizeBox } from "./transform.ts";

const decal: Decal = { id: "s", side: "front", src: "/s.png", aspect: 2, x: 40, y: 45, width: 30, rotation: 10, scale: 1 };
const LANDSCAPE = { width: 3.37, height: 2.125 };
const close = (a: Record<string, number>, b: Record<string, number>, d = 6) => Object.keys(b).forEach((k) => expect(a[k], k).toBeCloseTo(b[k], d));

describe("placement", () => {
  it("matches the renderer's, cropped or not", () => {
    for (const d of [decal, { ...decal, crop: { x: 0.1, y: 0.2, w: 0.4, h: 0.7 } }, { ...decal, side: "back" as const, x: 99 }]) {
      const ours = placement(d, LANDSCAPE);
      const core = decalPlacement(d, undefined, 0, 0.03, LANDSCAPE);
      expect(ours.width).toBeCloseTo(core.width, 12);
      expect(ours.height).toBeCloseTo(core.height, 12);
      expect(ours.x).toBeCloseTo(core.position[0], 12);
      expect(ours.y).toBeCloseTo(core.position[1], 12);
    }
  });
});

describe("resizeBox", () => {
  const o = { keep: false, fromCenter: false, min: 0.1 };
  it("moves one edge and keeps the opposite one", () => {
    // Right edge of a 2 × 1 box dragged to x = 1.5: width 2.5, centre moves right by 0.25.
    close(resizeBox(2, 1, 1, 0, { x: 1.5, y: 0.3 }, o), { w: 2.5, h: 1, dx: 0.25, dy: 0 });
    // Bottom edge dragged up past the top: clamped to the minimum.
    close(resizeBox(2, 1, 0, -1, { x: 0, y: 0.8 }, o), { w: 2, h: 0.1, dx: 0, dy: 0.45 });
  });

  it("corners keep the proportions, anchored at the opposite corner", () => {
    const r = resizeBox(2, 1, 1, 1, { x: 2, y: 1 }, { ...o, keep: true });
    expect(r.w / r.h).toBeCloseTo(2, 12);
    close(r, { w: 3, h: 1.5, dx: 0.5, dy: 0.25 });
    // The opposite corner (−1, −0.5) stays: new centre − half size.
    expect(r.dx - r.w / 2).toBeCloseTo(-1, 12);
    expect(r.dy - r.h / 2).toBeCloseTo(-0.5, 12);
  });

  it("Shift on an edge scales both sides; Alt resizes about the centre", () => {
    close(resizeBox(2, 1, 1, 0, { x: 2, y: 0 }, { ...o, keep: true }), { w: 3, h: 1.5, dx: 0.5, dy: 0 });
    close(resizeBox(2, 1, -1, 0, { x: -1.5, y: 0 }, { ...o, fromCenter: true }), { w: 3, h: 1, dx: 0, dy: 0 });
  });
});

describe("crop mode", () => {
  it("frames the whole picture around the visible part and maps back exactly", () => {
    const crop = { x: 0.2, y: 0.1, w: 0.5, h: 0.6 };
    for (const flip of [undefined, { h: true }, { v: true }, { h: true, v: true }]) {
      const f = cropFrame({ crop, flip }, 1, 0.6);
      expect(f.w).toBeCloseTo(2, 12);
      expect(f.h).toBeCloseTo(1, 12);
      expect(f.rect.x1 - f.rect.x0).toBeCloseTo(1, 12);
      expect(f.rect.y1 - f.rect.y0).toBeCloseTo(0.6, 12);
      close(cropToSource(f)! as unknown as Record<string, number>, crop, 4);
    }
    // Unflipped: the crop's centre (u 0.45, v 0.4) sits left of and above the picture's centre.
    close(cropFrame({ crop }, 1, 0.6).offset, { x: -0.1, y: 0.1 });
    // Mirrored left ↔ right it sits on the other side.
    close(cropFrame({ crop, flip: { h: true } }, 1, 0.6).offset, { x: 0.1, y: 0.1 });
  });

  it("an uncropped sticker's crop is the whole picture (no crop field)", () => {
    const f = cropFrame({}, 1, 0.5);
    expect(cropToSource(f)).toBeNull();
  });

  it("handles stay inside the picture, with and without a ratio", () => {
    const f = { w: 2, h: 1 };
    const start = { x0: -0.5, x1: 0.5, y0: -0.25, y1: 0.25 };
    close(cropDrag(start, f, 1, 0, { x: 5, y: 0 }, null, 0.05) as unknown as Record<string, number>, { x0: -0.5, x1: 1, y0: -0.25, y1: 0.25 });
    close(cropDrag(start, f, -1, 1, { x: -0.9, y: 0.3 }, null, 0.05) as unknown as Record<string, number>, { x0: -0.9, x1: 0.5, y0: -0.25, y1: 0.3 });
    // 1:1 from the top-right corner, anchored at the bottom-left.
    const sq = cropDrag(start, f, 1, 1, { x: 0.6, y: 0.5 }, 1, 0.05);
    expect(sq.x1 - sq.x0).toBeCloseTo(sq.y1 - sq.y0, 12);
    expect(sq.x0).toBeCloseTo(-0.5, 12);
    expect(sq.y0).toBeCloseTo(-0.25, 12);
    expect(sq.y1).toBeLessThanOrEqual(0.5 + 1e-12);
    // An edge with a ratio: the other side follows about its centre line.
    const e = cropDrag(start, f, 1, 0, { x: 0.7, y: 0 }, 2, 0.05);
    close(e as unknown as Record<string, number>, { x0: -0.5, x1: 0.7, y0: -0.3, y1: 0.3 });
  });

  it("panning moves the picture under the crop, never past its edge", () => {
    const f = { w: 2, h: 1 };
    const start = { x0: -0.5, x1: 0.5, y0: -0.25, y1: 0.25 };
    const m = cropPan(start, f, { x: 0.2, y: 0 });
    close(m as unknown as Record<string, number>, { dx: 0.2, dy: 0 });
    close(m.rect as unknown as Record<string, number>, { x0: -0.7, x1: 0.3 });
    const far = cropPan(start, f, { x: 9, y: -9 });
    close(far.rect as unknown as Record<string, number>, { x0: -1, x1: 0, y0: 0, y1: 0.5 });
  });

  it("aspect presets fit the largest rectangle, following the crop's orientation", () => {
    const f = { w: 2, h: 1, rect: { x0: -0.2, x1: 0.2, y0: -0.4, y1: 0.4 } };
    expect(aspectRatio("free", f)).toBeNull();
    expect(aspectRatio("4:3", f)).toBeCloseTo(3 / 4, 12); // taller than wide
    expect(aspectRatio("16:9", { ...f, rect: { x0: -1, x1: 1, y0: -0.1, y1: 0.1 } })).toBeCloseTo(16 / 9, 12);
    expect(aspectRatio("original", f)).toBe(2);
    close(cropFit(f.rect, f, 2) as unknown as Record<string, number>, { x0: -1, x1: 1, y0: -0.5, y1: 0.5 });
    const sq = cropFit({ x0: 0.8, x1: 0.9, y0: 0, y1: 0.1 }, f, 1);
    close(sq as unknown as Record<string, number>, { x0: 0, x1: 1, y0: -0.5, y1: 0.5 });
  });
});
