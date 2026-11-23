import { describe, expect, it } from "vitest";
import { brandingLayout, LOGO_SCALE_RANGE, userLogoRect, validLogo } from "./branding-layout.ts";
import { assetsForDesign, createPublicAssets, translateSvgPath } from "../scene/assets.ts";
import { CARD_H, CARD_W, CHIP_LAYOUT } from "../geometry/constants.ts";

const L = brandingLayout(undefined, 0.0274302);
const path = { path: "M0 0H10V10Z", viewBox: [10, 10] as [number, number] };

describe("user logo", () => {
  it("validLogo accepts a path with a viewBox or a raster src, nothing else", () => {
    expect(validLogo(path)).toBe(path);
    expect(validLogo({ src: "data:image/png;base64,AAAA" })).not.toBeNull();
    expect(validLogo({ path: "M0 0" })).toBeNull();
    expect(validLogo({ path: "M0 0", viewBox: [0, 10] })).toBeNull();
    expect(validLogo({})).toBeNull();
    expect(validLogo(null)).toBeNull();
  });

  it("the corner logo at scale 1 is the corner mark's height, left / top aligned with it", () => {
    const r = userLogoRect(path, 1, L);
    expect(r.h).toBeCloseTo(L.logo.height);
    expect(r.w).toBeCloseTo(L.logo.height);
    expect(r.x - r.w / 2).toBeCloseTo(L.logo.left);
    expect(r.y + r.h / 2).toBeCloseTo(L.logo.top);
  });

  it("stays clear of the chip and inside the face at every position and size", () => {
    const chipTop = CARD_H / 2 - CHIP_LAYOUT.top * CARD_H;
    const chipLeft = -CARD_W / 2 + CHIP_LAYOUT.left * CARD_W;
    const chipBottom = chipTop - (CHIP_LAYOUT.width * CARD_W) / CHIP_LAYOUT.aspect;
    for (const position of ["corner", "top-right", "center", "bottom-right"] as const)
      for (const scale of [LOGO_SCALE_RANGE.min, 1, 2, LOGO_SCALE_RANGE.max, 99])
        for (const aspect of [0.2, 1, 4, 8]) {
          const r = userLogoRect({ ...path, position, scale }, aspect, L);
          expect(Math.abs(r.x) + r.w / 2, `${position} ${scale} ${aspect}`).toBeLessThanOrEqual(CARD_W / 2);
          expect(Math.abs(r.y) + r.h / 2).toBeLessThanOrEqual(CARD_H / 2);
          const overlapsChip = r.x + r.w / 2 > chipLeft && r.y - r.h / 2 < chipTop && r.y + r.h / 2 > chipBottom;
          expect(overlapsChip, `${position} ${scale} ${aspect} overlaps the chip`).toBe(false);
          expect(r.w / r.h).toBeCloseTo(aspect);
        }
  });

  it("a path logo becomes the brand mark; others keep the provider's", () => {
    const assets = createPublicAssets();
    expect(assetsForDesign(assets, {})).toBe(assets);
    expect(assetsForDesign(assets, { logo: { src: "x.png" } })).toBe(assets);
    const a = assetsForDesign(assets, { logo: { path: "M5 5h10v10z", viewBox: [10, 10], origin: [5, 5] } });
    expect(a.brandMark).toEqual({ path: "M0 0h10v10z", viewBox: [10, 10] });
    expect(a.resolveUrl("q")).toBe("q");
  });

  it("translateSvgPath shifts a leading relative m (absolute in SVG) but not later relative commands", () => {
    expect(translateSvgPath("m10 10l5 5m1 1", -10, -10)).toBe("m0 0l5 5m1 1");
    expect(translateSvgPath("M10 10L20 20", 1, 2)).toBe("M11 12L21 22");
  });
});
