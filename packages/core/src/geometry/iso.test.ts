/**
 * The public card's layout against the card standards: the ISO/IEC 7816-2 contact zones, the name and
 * number lines in ISO/IEC 7811-1's embossing areas, user logos clear of the chip, and the cutouts clear
 * of the contacts, the antenna and the embossing areas. (The three.js engine's checks of its built chip
 * geometry and the glass card's antenna are in the local archive, .archive/three-engine/.)
 */
import { describe, expect, it } from "vitest";
import { MM_PER_UNIT, ISO_ID1_MM, BODY_SCALE, CORNER_RADIUS_RANGE } from "./constants.ts";
import {
  ISO_7811_AREAS,
  ISO_7816_CONTACTS,
  ISO_CHIP_PLATE_MM,
  ISO_CONTACT_AREA,
  ISO_NUMBER_CENTRELINE_MM,
  isoAntennaBand,
  insideRounded,
  isoMm,
  type MmRect,
} from "./iso.ts";
import { frameForShape, NOTCH_MAX_CORNER_RADIUS, slotPlacement, windowPlacement } from "./shape-frame.ts";
import type { CardFrame } from "./frame.ts";
import { brandingLayout, chipRect, contactlessRect, layoutTextLines, userLogoRect } from "../card/branding-layout.ts";

const DEPTH = 7 * BODY_SCALE;

const overlaps = (a: MmRect, b: MmRect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const bounds = (pts: Array<{ x: number; y: number }>): MmRect => ({
  x0: Math.min(...pts.map((p) => p.x)),
  x1: Math.max(...pts.map((p) => p.x)),
  y0: Math.min(...pts.map((p) => p.y)),
  y1: Math.max(...pts.map((p) => p.y)),
});

describe("ISO/IEC 7816-2 contacts", () => {
  it("names the ISO numbers: C1–C4 down the left column, C5–C8 down the right, 2.0 × 1.7 mm zones", () => {
    expect(ISO_7816_CONTACTS.map((r) => [r.x0, r.x1, r.y0, r.y1])).toEqual([
      [10.25, 12.25, 19.23, 20.93],
      [10.25, 12.25, 21.77, 23.47],
      [10.25, 12.25, 24.31, 26.01],
      [10.25, 12.25, 26.85, 28.55],
      [17.87, 19.87, 19.23, 20.93],
      [17.87, 19.87, 21.77, 23.47],
      [17.87, 19.87, 24.31, 26.01],
      [17.87, 19.87, 26.85, 28.55],
    ]);
    for (const r of ISO_7816_CONTACTS) {
      expect(r.x1 - r.x0).toBeCloseTo(2.0, 9);
      expect(r.y1 - r.y0).toBeCloseTo(1.7, 9);
      // Front, left half.
      expect(r.x1).toBeLessThan(ISO_ID1_MM.width / 2);
    }
  });
});

describe("ISO/IEC 7811-1 embossing areas (landscape print)", () => {
  const f = frameForShape({ cornerRadius: CORNER_RADIUS_RANGE.iso, portrait: false, cutouts: [] });
  const L = brandingLayout(undefined, DEPTH, f);
  const fromBottom = (y: number) => ISO_ID1_MM.height - isoMm(0, y).y;

  it("puts the name's line box, so its baseline, inside area 2", () => {
    // The name raster: E · (lineH + 12 px) / lineH tall (≈ 1.13 E), baseline (descent + 6 px) up.
    const box = { bottom: fromBottom(L.textBottom), top: fromBottom(L.textBottom + 1.13 * L.E) };
    const area = { bottom: ISO_ID1_MM.height - ISO_7811_AREAS.name.y1, top: ISO_ID1_MM.height - ISO_7811_AREAS.name.y0 };
    expect(area.bottom).toBeCloseTo(2.54, 9);
    expect(area.top).toBeCloseTo(14.53, 9);
    expect(box.bottom).toBeGreaterThanOrEqual(area.bottom);
    expect(box.top).toBeLessThanOrEqual(area.top);
    // A baseline anywhere in the box's lower half (descenders and padding below it) is inside too.
    const baseline = box.bottom + 0.3 * (box.top - box.bottom);
    expect(baseline).toBeGreaterThan(area.bottom);
    expect(baseline).toBeLessThan(area.top);
    // From area 2's left end (first character centreline 7.65 mm, half a 2.54 pitch before it), and
    // wrapped within it.
    expect(isoMm(L.nameLeft!, 0).x).toBeCloseTo(7.65 - 1.27, 6);
    expect(isoMm(L.nameLeft! + L.T * L.E, 0).x).toBeLessThanOrEqual(ISO_7811_AREAS.name.x1 + 1e-6);
    // An override can't push it out of the area either.
    for (const nameBottom of [0, 0.4]) {
      const o = brandingLayout({ nameBottom }, DEPTH, f);
      expect(fromBottom(o.textBottom)).toBeGreaterThanOrEqual(area.bottom - 1e-9);
      expect(fromBottom(o.textBottom + 1.13 * o.E)).toBeLessThanOrEqual(area.top + 1e-9);
    }
  });

  it("puts the first bottom-left line on the number line (area 1) and the rest above the name", () => {
    const box = (o = {}) => ({ aspect: 8, heightInLineBoxes: 1.13, size: 0.9, ...o });
    const nameTop = L.textBottom + 1.13 * L.E;
    const [num, second, bio] = layoutTextLines([box(), box({ size: 0.6 }), box({ withName: true })], L, { nameTop, obstacles: [chipRect(f)] });
    // Capitals (≈ 0.4 of the box down) on area 1's centreline, 21.42 mm above the bottom edge.
    const capCentre = isoMm(0, num!.y + num!.h / 2 - 0.4 * num!.h).y;
    expect(Math.abs(capCentre - ISO_NUMBER_CENTRELINE_MM)).toBeLessThan(0.12);
    const n: MmRect = {
      x0: isoMm(num!.x - num!.w / 2, 0).x,
      x1: isoMm(num!.x + num!.w / 2, 0).x,
      y0: isoMm(0, num!.y + num!.h / 2).y,
      y1: isoMm(0, num!.y - num!.h / 2).y,
    };
    expect(n.x0).toBeCloseTo(ISO_7811_AREAS.number.x0, 6);
    expect(n.x1).toBeLessThanOrEqual(ISO_7811_AREAS.number.x1 + 1e-6);
    expect(n.y0).toBeGreaterThan(ISO_CHIP_PLATE_MM.y1); // below the chip
    // The second line stacks above the name, the clear card's bio (`withName`) never takes the number line.
    expect(second!.y - second!.h / 2).toBeGreaterThan(nameTop);
    expect(second!.y).toBeLessThan(num!.y);
    expect(bio!.y).toBeLessThan(second!.y);
  });

  it("keeps the corner mark, chip and contactless mark clear of both areas", () => {
    const mm = (r: { x: number; y: number; w: number; h: number }): MmRect => ({
      x0: isoMm(r.x - r.w / 2, 0).x,
      x1: isoMm(r.x + r.w / 2, 0).x,
      y0: isoMm(0, r.y + r.h / 2).y,
      y1: isoMm(0, r.y - r.h / 2).y,
    });
    const logo = mm({ x: L.logo.left + L.logo.width / 2, y: L.logo.top - L.logo.height / 2, w: L.logo.width, h: L.logo.height });
    for (const r of [logo, mm(chipRect(f)), mm(contactlessRect(f)), mm(contactlessRect(f, 1.2))])
      for (const area of [ISO_7811_AREAS.number, ISO_7811_AREAS.name]) expect(overlaps(r, area)).toBe(false);
    // The chip rect is the plate.
    const c = mm(chipRect(f));
    expect(c.x0).toBeCloseTo(ISO_CHIP_PLATE_MM.x0, 6);
    expect(c.y1).toBeCloseTo(ISO_CHIP_PLATE_MM.y1, 6);
  });
});

describe("user logos on an ID-1 frame", () => {
  it("shrink to keep clear of the ISO chip and the contactless mark, landscape and portrait", () => {
    for (const portrait of [false, true]) {
      const f = frameForShape({ cornerRadius: CORNER_RADIUS_RANGE.iso, portrait, cutouts: [] });
      const L = brandingLayout(undefined, DEPTH, f);
      const obstacles = [chipRect(f), contactlessRect(f)];
      for (const position of ["corner", "top-right", "center", "bottom-right"] as const)
        for (const scale of [0.4, 1, 2, 3])
          for (const aspect of [0.2, 1, 4, 8]) {
            const r = userLogoRect({ path: "M0 0H1V1Z", viewBox: [1, 1], position, scale }, aspect, L, obstacles);
            for (const b of obstacles) {
              const hit = Math.abs(r.x - b.x) < (r.w + b.w) / 2 && Math.abs(r.y - b.y) < (r.h + b.h) / 2;
              expect(hit, `${portrait ? "portrait" : "landscape"} ${position} ×${scale} aspect ${aspect}`).toBe(false);
            }
            expect(r.w / r.h).toBeCloseTo(aspect, 6);
          }
    }
  });
});

/** The keep-out zones of a cutout, mm on the landscape card. */
const KEEP_OUT: Array<[string, MmRect]> = [
  ["contacts", ISO_CONTACT_AREA],
  ["chip plate", ISO_CHIP_PLATE_MM],
  ["embossing area 1", ISO_7811_AREAS.number],
  ["embossing area 2", ISO_7811_AREAS.name],
];
const band = isoAntennaBand();
/** A shape (its mm bounding box) is clear of the antenna when it lies wholly inside or wholly outside the band. */
const clearOfAntenna = (r: MmRect) =>
  [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x0, r.y1],
    [r.x1, r.y1],
  ].every(([x, y]) => insideRounded(band.inner, band.innerRadius, x!, y!)) || !overlaps(r, band.outer);

describe("cutouts stay clear of the contacts, the antenna and the embossing areas", () => {
  for (const portrait of [false, true])
    for (const radius of [CORNER_RADIUS_RANGE.min, CORNER_RADIUS_RANGE.iso, CORNER_RADIUS_RANGE.max])
      it(`${portrait ? "portrait" : "landscape"}, ${((radius * ISO_ID1_MM.height) / 2).toFixed(2)} mm corners`, () => {
        const f: CardFrame = frameForShape({ cornerRadius: radius, portrait, cutouts: ["lanyard", "notch", "window"] });
        const toMm = (x0: number, y0: number, x1: number, y1: number) => bounds([isoMm(x0, y0, portrait), isoMm(x1, y1, portrait)]);
        const s = slotPlacement(f);
        const sw = s.vertical ? s.width : s.length;
        const sh = s.vertical ? s.length : s.width;
        const slot = toMm(s.x - sw / 2, s.y - sh / 2, s.x + sw / 2, s.y + sh / 2);
        const w = windowPlacement(f);
        const win = toMm(w.x - w.radius, w.y - w.radius, w.x + w.radius, w.y + w.radius);
        // The notch: a quarter disc reaching NOTCH_REACH from the frame's top-right corner.
        const reach = (NOTCH_MAX_CORNER_RADIUS * (ISO_ID1_MM.height / 2)) / MM_PER_UNIT; // card units
        const corner = { x: f.bodyWidth / 2, y: f.bodyHeight / 2 };
        const notch = toMm(corner.x - reach, corner.y - reach, corner.x, corner.y);
        for (const [what, r] of [
          ["lanyard slot", slot],
          ["window", win],
          ["notch", notch],
        ] as const) {
          for (const [zone, z] of KEEP_OUT) expect(overlaps(r, z), `${what} overlaps the ${zone}`).toBe(false);
          expect(clearOfAntenna(r), `${what} crosses the antenna`).toBe(true);
          // Inside the card.
          expect(r.x0).toBeGreaterThan(-1e-6);
          expect(r.y0).toBeGreaterThan(-1e-6);
          expect(r.x1).toBeLessThan(ISO_ID1_MM.width + 1e-6);
          expect(r.y1).toBeLessThan(ISO_ID1_MM.height + 1e-6);
        }
      });
});
