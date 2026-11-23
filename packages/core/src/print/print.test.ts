/**
 * Production export geometry (`@card3d/core/print`): the dieline's trim, ISO/IEC 7810 corners, cutouts
 * and keep-outs against `geometry/iso.ts`, mm ↔ px registration at 600 and 1200 dpi, and the bleed fill.
 */
import { describe, expect, it } from "vitest";
import { ISO_ID1_MM } from "../geometry/constants.ts";
import { ISO_14443_CLASS1, ISO_7811_AREAS, ISO_CHIP_PLATE, ISO_CHIP_PLATE_MM, ISO_CONTACT_AREA, isoMm } from "../geometry/iso.ts";
import { slotPlacement, windowPlacement, frameForShape, resolveShape } from "../geometry/shape-frame.ts";
import { defaultDesign } from "../design/design.ts";
import type { CardDesign } from "../types.ts";
import { cardDieline, contourPoints, dielineSvg, inContour, inKeepOut, ISO_7811_6_STRIPE, type DielineContour } from "./dieline.ts";
import { MM_PER_INCH, mmToPx, printLayout, pxToMm, rasterBoxMm } from "./layout.ts";
import { bakeLayout, fillUncovered, printTrimMm, runBake, type BakeChoice, type BakeItem, type BakeRenderer } from "./bake.ts";

const OPTS = { bleedMm: 2, safeMm: 3 };
const close = (a: number, b: number, tol = 0.01) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const design = (patch: Partial<CardDesign> = {}): CardDesign => ({ ...defaultDesign(), ...patch });

/** Distance from (x, y) to the trim's ideal rounded rectangle (0 on it). */
function roundedRectDistance(w: number, h: number, r: number, x: number, y: number): number {
  const qx = Math.abs(x - w / 2) - (w / 2 - r);
  const qy = Math.abs(y - h / 2) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

describe("dieline: trim", () => {
  it("is ISO/IEC 7810 ID-1 with 3.18 mm corners on the standard card, front and back", () => {
    const d = cardDieline(design(), OPTS);
    close(d.width, ISO_ID1_MM.width);
    close(d.height, ISO_ID1_MM.height);
    close(d.cornerRadiusMm, ISO_ID1_MM.cornerRadius.nominal);
    expect(d.orientation).toBe("landscape");
    for (const side of ["front", "back"] as const) {
      const t = d.sides[side].trim;
      close(t.box.x0, 0);
      close(t.box.y0, 0);
      close(t.box.x1, ISO_ID1_MM.width);
      close(t.box.y1, ISO_ID1_MM.height);
      const corners = t.arcs.filter((a) => a.r > 0);
      expect(corners).toHaveLength(4);
      for (const a of corners) close(a.r, 3.18);
      // Every sampled point of the outline lies on the ideal rounded rectangle.
      for (const p of contourPoints(t)) expect(Math.abs(roundedRectDistance(d.width, d.height, 3.18, p.x, p.y))).toBeLessThan(0.005);
      expect(t.path.startsWith("M")).toBe(true);
      expect(t.path.match(/A/g)).toHaveLength(4);
    }
  });

  it("clamps the corner radius to 2.88–3.48 mm and turns a portrait card", () => {
    for (const [r, mm] of [
      [0, 2.88],
      [1, 3.48],
    ] as const)
      close(cardDieline(design({ shape: { cornerRadius: r } }), OPTS).cornerRadiusMm, mm);
    const p = cardDieline(design({ shape: { orientation: "portrait" } }), OPTS);
    expect(p.orientation).toBe("portrait");
    close(p.width, ISO_ID1_MM.height);
    close(p.height, ISO_ID1_MM.width);
    close(p.sides.front.trim.box.x1, ISO_ID1_MM.height);
  });

  it("bleed and safe boxes", () => {
    const d = cardDieline(design(), { bleedMm: 3, safeMm: 4 });
    expect(d.bleed).toEqual({ x0: -3, x1: d.width + 3, y0: -3, y1: d.height + 3 });
    expect(d.safe.rect).toEqual({ x0: 4, x1: d.width - 4, y0: 4, y1: d.height - 4 });
    expect(d.safe.radius).toBe(0);
    expect(cardDieline(design(), { bleedMm: 2, safeMm: 1 }).safe.radius).toBeCloseTo(2.18, 2);
  });

  it("is the shape's procedural outline (same arcs as the body)", () => {
    const d = cardDieline(design({ shape: { cornerRadius: 0.11 } }), OPTS);
    const r = frameForShape(resolveShape({ cornerRadius: 0.11 })!).cornerRadius * (ISO_ID1_MM.width / 3.37);
    for (const p of contourPoints(d.sides.front.trim)) expect(Math.abs(roundedRectDistance(d.width, d.height, r, p.x, p.y))).toBeLessThan(0.005);
  });
});

describe("dieline: cutouts", () => {
  const holeBox = (c: DielineContour) => c.box;
  it("lanyard slot and window at their ISO_CUTOUTS places, mirrored on the back", () => {
    const d = cardDieline(design({ shape: { cutouts: ["lanyard", "window", "notch"] } }), OPTS);
    const frame = frameForShape(resolveShape({ cutouts: ["lanyard", "window", "notch"] })!);
    const slot = slotPlacement(frame);
    const win = windowPlacement(frame);
    const front = d.sides.front.cutouts;
    expect(front.map((c) => c.kind).sort()).toEqual(["lanyard", "window"]);
    const s = holeBox(front.find((c) => c.kind === "lanyard")!);
    const sc = isoMm(slot.x, slot.y);
    close((s.x0 + s.x1) / 2, sc.x);
    close((s.y0 + s.y1) / 2, sc.y);
    close(s.y1 - s.y0, slot.length * (ISO_ID1_MM.width / 3.37));
    close(s.x1 - s.x0, slot.width * (ISO_ID1_MM.width / 3.37));
    const w = holeBox(front.find((c) => c.kind === "window")!);
    const wc = isoMm(win.x, win.y);
    close((w.x0 + w.x1) / 2, wc.x);
    close((w.y0 + w.y1) / 2, wc.y);
    close(w.x1 - w.x0, 2 * win.radius * (ISO_ID1_MM.width / 3.37));
    // Back: seen from the back, mirrored left ↔ right.
    const b = holeBox(d.sides.back.cutouts.find((c) => c.kind === "lanyard")!);
    close(b.x0, d.width - s.x1);
    close(b.y0, s.y0);
    // The notch is part of the trim: the top-right corner (top-left from the back) is cut away.
    expect(d.notch).toBe(true);
    expect(inContour(d.sides.front.trim, d.width - 1, 1)).toBe(false);
    expect(inContour(d.sides.front.trim, 1.5, 1.5)).toBe(true);
    expect(inContour(d.sides.back.trim, 1, 1)).toBe(false);
    // Holes are inside the trim and the point inside a hole is "in" the hole contour.
    expect(
      inContour(
        front.find((c) => c.kind === "window")!,
        wc.x,
        wc.y,
      ),
    ).toBe(true);
  });
});

describe("dieline: keep-outs", () => {
  it("chip plate and contact area at ISO/IEC 7816-2, embossing areas at ISO/IEC 7811-1, the antenna band at 14443-1 Class 1", () => {
    const d = cardDieline(design(), OPTS);
    const k = Object.fromEntries(d.sides.front.keepOuts.map((x) => [x.id, x]));
    expect(k["front-contact-plate"]!.rect).toEqual(expect.objectContaining({}));
    for (const key of ["x0", "x1", "y0", "y1"] as const) {
      close(k["front-contact-plate"]!.rect[key], ISO_CHIP_PLATE_MM[key]);
      close(k["front-contact-area"]!.rect[key], ISO_CONTACT_AREA[key]);
      close(k["front-embossing-number"]!.rect[key], ISO_7811_AREAS.number[key]);
      close(k["front-embossing-name"]!.rect[key], ISO_7811_AREAS.name[key]);
      close(k["front-antenna"]!.rect[key], ISO_14443_CLASS1.outer[key]);
      close(k["front-antenna"]!.inner!.rect[key], ISO_14443_CLASS1.inner[key]);
    }
    expect(k["front-contact-plate"]!.radius).toBe(ISO_CHIP_PLATE.cornerRadius);
    expect(k["front-contact-plate"]!.rule).toBe("block");
    // The plate is centred on the contacts: 15.06, 23.89 from the left / top.
    const p = k["front-contact-plate"]!.rect;
    close((p.x0 + p.x1) / 2, 15.06);
    close((p.y0 + p.y1) / 2, 23.89);
    // The antenna zone is a band: its middle is outside it.
    expect(inKeepOut(k["front-antenna"]!, d.width / 2, d.height / 2)).toBe(false);
    expect(inKeepOut(k["front-antenna"]!, 5, d.height / 2)).toBe(true);
    // No stripe unless asked for; no chip on the back.
    expect(d.sides.back.keepOuts.map((x) => x.kind)).toEqual(["antenna"]);
  });

  it("magnetic stripe (ISO/IEC 7811-6) on the back, the raised-free band on both faces", () => {
    const d = cardDieline(design(), { ...OPTS, magstripe: true });
    const stripe = d.sides.back.keepOuts.find((x) => x.kind === "magstripe")!;
    expect(stripe.rect).toEqual({ x0: 0, x1: ISO_ID1_MM.width, y0: ISO_7811_6_STRIPE.top, y1: ISO_7811_6_STRIPE.bottom3 });
    expect(d.sides.front.keepOuts.some((x) => x.kind === "magstripe")).toBe(false);
    for (const side of ["front", "back"] as const) expect(d.sides[side].keepOuts.find((x) => x.kind === "raised-free")!.rect.y1).toBe(19.05);
  });

  it("signature panel and hologram from a preset, given from the back's top-left (landscape)", () => {
    const sig = { x0: 5, x1: 50, y0: 20, y1: 30 };
    const d = cardDieline(design(), { ...OPTS, signaturePanel: sig, hologram: { x0: 60, x1: 80, y0: 20, y1: 35 } });
    const s = d.sides.back.keepOuts.find((x) => x.kind === "signature-panel")!;
    for (const key of ["x0", "x1", "y0", "y1"] as const) close(s.rect[key], sig[key]);
  });

  it("portrait cards keep the chip at its ISO place on the body (turned)", () => {
    const d = cardDieline(design({ shape: { orientation: "portrait" } }), OPTS);
    const plate = d.sides.front.keepOuts.find((x) => x.kind === "contact-plate")!.rect;
    // Landscape (x, y) from the left / top → portrait: the left edge becomes the top.
    close(plate.y0, ISO_CHIP_PLATE_MM.x0);
    close(plate.y1, ISO_CHIP_PLATE_MM.x1);
    close(plate.x1, ISO_ID1_MM.height - ISO_CHIP_PLATE_MM.y0);
    close(plate.x0, ISO_ID1_MM.height - ISO_CHIP_PLATE_MM.y1);
    expect(d.sides.front.keepOuts.some((x) => x.kind === "embossing-area")).toBe(false);
  });

  it("glass keeps the standard outline", () => {
    const g = cardDieline(design({ recipe: { ...defaultDesign().recipe, material: "glass" }, shape: { orientation: "portrait", cutouts: ["window"] } }), OPTS);
    expect(g.orientation).toBe("landscape");
    expect(g.sides.front.cutouts).toHaveLength(0);
    expect(printTrimMm(design({ shape: { orientation: "portrait" } }))).toEqual({ width: expect.closeTo(53.98, 2), height: expect.closeTo(85.6, 2) });
  });

  it("SVG in mm with the layers vendors look for", () => {
    const d = cardDieline(design({ shape: { cutouts: ["lanyard"] } }), { ...OPTS, magstripe: true });
    const svg = dielineSvg(d, "back");
    expect(svg).toContain('width="89.6mm"');
    expect(svg).toContain('viewBox="-2 -2 89.6 57.98"');
    for (const id of ["CutContour", "bleed", "safe", "keep-outs", "trim", "cutout-lanyard", "back-magstripe"]) expect(svg).toContain(`id="${id}"`);
  });
});

describe("registration (mm ↔ px)", () => {
  for (const dpi of [600, 1200]) {
    it(`${dpi} dpi with 2 mm bleed`, () => {
      const L = printLayout({ width: ISO_ID1_MM.width, height: ISO_ID1_MM.height }, dpi, 2);
      const ppm = dpi / MM_PER_INCH;
      expect(L.pxPerMm).toBeCloseTo(ppm, 10);
      expect(L.width).toBe(Math.round(89.6 * ppm));
      expect(L.height).toBe(Math.round(57.98 * ppm));
      // The trim is centred and exactly trim × dpi pixels.
      close(L.trim.width, 85.6 * ppm, 1e-9);
      close(L.trim.height, 53.98 * ppm, 1e-9);
      close(L.trim.x * 2 + L.trim.width, L.width, 1e-9);
      close(L.trim.y * 2 + L.trim.height, L.height, 1e-9);
      // The bleed is within half a pixel of 2 mm on every side.
      expect(Math.abs(L.trim.x - 2 * ppm)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(L.trim.y - 2 * ppm)).toBeLessThanOrEqual(0.5);
      // Round trips and corners.
      const a = mmToPx(L, 0, 0);
      expect(a).toEqual({ x: L.trim.x, y: L.trim.y });
      const b = mmToPx(L, 85.6, 53.98);
      close(b.x, L.trim.x + L.trim.width, 1e-9);
      close(b.y, L.trim.y + L.trim.height, 1e-9);
      const p = pxToMm(L, ...(Object.values(mmToPx(L, 15.06, 23.89)) as [number, number]));
      close(p.x, 15.06, 1e-9);
      close(p.y, 23.89, 1e-9);
      const box = rasterBoxMm(L);
      close(box.width, L.width / ppm, 1e-9);
      close(box.x, -L.trim.x / ppm, 1e-9);
    });
  }
  it("1200 dpi is twice 600 dpi (to the pixel)", () => {
    const a = printLayout({ width: 85.6, height: 53.98 }, 600, 2);
    const b = printLayout({ width: 85.6, height: 53.98 }, 1200, 2);
    expect(Math.abs(b.width - 2 * a.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.height - 2 * a.height)).toBeLessThanOrEqual(1);
  });
  it("rejects nonsense", () => {
    expect(() => printLayout({ width: 85.6, height: 53.98 }, 0, 2)).toThrow();
    expect(printLayout({ width: 85.6, height: 53.98 }, 300, -1).bleedMm).toBe(0);
  });
});

describe("bleed fill", () => {
  it("fills uncovered pixels from the nearest covered one and composites partial ones in linear light", () => {
    // 4 × 1: [covered red, half-covered (premultiplied in linear light, sRGB-encoded), empty, empty]
    const px = new Uint8Array([255, 0, 0, 255, 0, 128, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0]);
    fillUncovered(px, 4, 1);
    expect(Array.from(px.slice(0, 4))).toEqual([255, 0, 0, 255]);
    // red: 0 + 1 · (1 − 128/255) in linear → 187; green: the stored 128 stays (nothing under it).
    expect(Array.from(px.slice(4, 8))).toEqual([187, 128, 0, 255]);
    expect(Array.from(px.slice(8, 12))).toEqual([255, 0, 0, 255]);
    expect(Array.from(px.slice(12, 16))).toEqual([255, 0, 0, 255]);
  });

  it("extends the artwork straight out of a rounded edge", () => {
    // 6 × 3: covered columns 0–2 (a gradient per row), the rest bleed; the edge at x = 3.
    const w = 6;
    const h = 3;
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < 3; x++) px.set([x * 50, y * 100, 0, 255], (y * w + x) * 4);
    fillUncovered(px, w, h, { x0: 0, y0: 0, x1: 3, y1: 3, r: 0 });
    // Each row continues its own last pixel (no diagonal mixing).
    for (let y = 0; y < h; y++) for (let x = 3; x < w; x++) expect(Array.from(px.slice((y * w + x) * 4, (y * w + x) * 4 + 4))).toEqual([100, y * 100, 0, 255]);
  });
});

describe("bake policy (`runBake`)", () => {
  const item = (o: Partial<BakeItem> & Pick<BakeItem, "name" | "role">): BakeItem => ({
    side: "front",
    hasMap: false,
    plane: { width: 1, height: 0.2, padX: 0, padY: 0 },
    image: { width: 0, height: 0 },
    uv: { width: 1, height: 1 },
    position: { x: 0, y: 0, z: 0.02 },
    xAxis: { x: 1, y: 0, z: 0 },
    ...o,
  });
  const items: BakeItem[] = [
    item({ name: "card body", role: "base" }),
    item({ name: "front face", role: "base" }),
    item({ name: "back face", role: "base", side: "back", position: { x: 0, y: 0, z: -0.02 } }),
    item({ name: "front design", role: "artwork" }),
    item({ name: "Holo foil", role: "foil" }),
    item({ name: "chip", role: "chip" }),
    item({ name: "front chip decal depth mask", role: "chip-mask" }),
    item({ name: "face shader overlay 0", role: "overlay" }),
    item({
      name: "sticker decal 2",
      role: "sticker",
      kind: "sticker",
      plane: { width: 0.5, height: 0.4, padX: 0, padY: 0 },
      uv: { width: 0.8, height: 0.9 },
      image: { width: 120, height: 90 },
      position: { x: 0.5, y: 0.2, z: 0.02 },
      xAxis: { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 },
    }),
    item({
      name: "cardholder name",
      role: "mark",
      kind: "name",
      finish: "engraved",
      plane: { width: 1.2, height: 0.24, padX: 0.1, padY: 0.1 },
      image: { width: 600, height: 120 },
      position: { x: -0.8, y: -0.8, z: 0.02 },
    }),
    item({
      name: "cardholder bio",
      role: "mark",
      kind: "bio",
      finish: "default",
      side: "back",
      position: { x: 0.8, y: -0.8, z: -0.02 },
      xAxis: { x: -1, y: 0, z: 0 },
    }),
  ];
  const design = (): CardDesign => ({ ...defaultDesign(), recipe: { ...defaultDesign().recipe, texture: "brushed" } });

  /** A renderer that records each pass's choices and covers the trim (colour) or the marks' box (masks). */
  function recorder(): BakeRenderer & { passes: Array<{ target: string; side: string; picks: Record<string, BakeChoice> }> } {
    const passes: Array<{ target: string; side: string; picks: Record<string, BakeChoice> }> = [];
    return {
      items,
      maxSize: 8192,
      passes,
      setArtwork() {},
      async render(target, side, L, pick) {
        const picks = Object.fromEntries(items.map((i) => [i.name, pick(i)]));
        passes.push({ target, side, picks });
        const px = new Uint8Array(L.width * L.height * 4);
        // A covered square in the middle (colour: opaque grey; masks: value 1 where anything is masked 1).
        const on = target === "color" || Object.values(picks).some((c) => typeof c === "object" && "mask" in c && c.mask === 1);
        for (let y = 100; y < 140; y++) for (let x = 200; x < 260; x++) px.set(on ? [128, 128, 128, 255] : [0, 0, 0, 255], (y * L.width + x) * 4);
        return px;
      },
      dispose() {},
    };
  }

  it("draws each item as three's bake does, in every pass", async () => {
    const r = recorder();
    const out = await runBake(r, design(), { dpi: 300 });
    expect(out.map((s) => s.side)).toEqual(["front", "back"]);
    const front = r.passes.filter((p) => p.side === "front");
    const colour = front.find((p) => p.target === "color")!.picks;
    expect(colour).toEqual({
      "card body": "hide", // the face skin is the print
      "front face": { surface: 0 },
      "back face": { surface: 0 },
      "front design": { albedo: true, artwork: true },
      "Holo foil": "hide",
      chip: "hide",
      "front chip decal depth mask": "keep",
      "face shader overlay 0": "keep",
      "sticker decal 2": { albedo: true },
      "cardholder name": { albedo: true },
      "cardholder bio": "hide", // the other face's
    });
    // Separations of the front: engrave and its fill, foil, relief (no etch, emboss or spot gloss there).
    const masks = front.filter((p) => p.target === "mask");
    const engrave = masks[0]!.picks;
    expect(engrave["cardholder name"]).toEqual({ mask: 1 });
    expect(engrave["sticker decal 2"]).toEqual({ mask: 0 });
    expect(engrave["Holo foil"]).toBe("hide");
    expect(engrave["front chip decal depth mask"]).toBe("keep");
    expect(engrave["chip"]).toBe("hide");
    const relief = masks.find((p) => (p.picks["front face"] as { surface?: number }).surface === 1)!.picks;
    expect(relief["cardholder name"]).toBe("hide");
    expect(Object.keys(out[0]!.masks).sort()).toEqual(["engrave", "fill", "foil", "relief"]);
    // Elements: each alone (stickers then marks, as listed), its placement on the page.
    expect(out[0]!.elements.map((e) => e.id)).toEqual(["sticker decal 2", "cardholder name"]);
    const [sticker, name] = out[0]!.elements;
    const L = bakeLayout(design(), { dpi: 300 });
    expect(sticker!.plane).toEqual({
      widthMm: expect.closeTo(0.5 * (85.6 / 3.37), 6),
      heightMm: expect.closeTo(0.4 * (85.6 / 3.37), 6),
      uvWidth: 0.8,
      uvHeight: 0.9,
      imageWidth: 120,
      imageHeight: 90,
    });
    expect(sticker!.placement.rotation).toBeCloseTo(-Math.PI / 4, 9);
    expect(sticker!.placement.x).toBeCloseTo(0.5 * (85.6 / 3.37) + L.trimMm.width / 2, 9);
    expect(name!.finish).toBe("engraved");
    expect(name!.plane.widthMm).toBeCloseTo((1.2 / 1.2) * (85.6 / 3.37), 6);
    expect(name!.coverage).toEqual({ x: 200, y: 100, width: 60, height: 40, data: expect.any(Uint8Array) });
    expect(name!.boxMm!.x0).toBeCloseTo((200 - L.trim.x) / L.pxPerMm, 9);
    // The back: its bio, seen mirrored.
    const bio = out[1]!.elements[0]!;
    expect(bio.id).toBe("cardholder bio");
    expect(bio.placement.x).toBeCloseTo(L.trimMm.width - (0.8 * (85.6 / 3.37) + L.trimMm.width / 2), 9);
    expect(bio.placement.rotation).toBeCloseTo(0, 9);
    expect(out[0]!.features).toEqual({ foil: true, shaderSkin: false, shaderOverlays: 1, addons: false, effects: false, clear: false });
  });

  it("refuses a raster larger than the GPU renders", async () => {
    const r = { ...recorder(), maxSize: 1024 };
    await expect(runBake(r, design(), { dpi: 600 })).rejects.toThrow(/more than this GPU can render/);
  });
});
