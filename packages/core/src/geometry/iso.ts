import { CARD_H, CARD_W, ID1_BODY_NATIVE, ISO_ID1_MM, MM_PER_UNIT } from "./constants.ts";
import type { CardCutout } from "../types.ts";
import type { CardFrame } from "./frame.ts";

/**
 * The card standards the public card follows, in millimetres measured on the front of a landscape
 * ID-1 card from its left and top edges (ISO/IEC 7816-2's reference edges), and the mapping onto a
 * card frame. Each number below names its source.
 *
 * - ISO/IEC 7816-2: the C1–C8 contact zones (each at least 2.0 × 1.7 mm), on the front, left half.
 * - ISO/IEC 7816-1: a contact's surface at most 0.05 mm above (1998; ±0.10 in 2011) and 0.10 mm
 *   below the card's surface.
 * - ISO/IEC 7811-1: the embossing areas (area 1, the identification number line; area 2, name and
 *   address).
 * - ISO/IEC 14443-1: the Class 1 antenna zone, between an 81 × 49 mm and a 64 × 34 mm rectangle.
 *
 * Only the public card (the procedural ID-1 body and every shaped body, i.e. any set with a
 * `CardFrame`) uses this. A local pack's glTF card keeps its own layout (`CHIP_LAYOUT`).
 */

/** An axis-aligned rectangle in mm: x from the left edge, y from the top edge (y grows downwards). */
export interface MmRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const rect = (x0: number, x1: number, y0: number, y1: number): MmRect => ({ x0, x1, y0, y1 });
const COLS = [rect(10.25, 12.25, 0, 0), rect(17.87, 19.87, 0, 0)] as const;
const ROWS: ReadonlyArray<readonly [number, number]> = [
  [19.23, 20.93],
  [21.77, 23.47],
  [24.31, 26.01],
  [26.85, 28.55],
];

/**
 * ISO/IEC 7816-2 contact zones C1–C8 (index 0 = C1): C1–C4 down the left column, C5–C8 down the
 * right one, row by row (C1 / C5 top, C4 / C8 bottom). A real contact covers at least its zone.
 */
export const ISO_7816_CONTACTS: readonly MmRect[] = [0, 1].flatMap((c) => ROWS.map(([y0, y1]) => rect(COLS[c]!.x0, COLS[c]!.x1, y0, y1)));

/** The rectangle every contact zone lies in (10.25–19.87 × 19.23–28.55 mm). */
export const ISO_CONTACT_AREA: MmRect = rect(10.25, 19.87, 19.23, 28.55);

/** ISO/IEC 7816-1: how far the contacts' surface may stand above the card's (2011: 0.10; 1998: 0.05). @archive the local three.js archive imports it */
export const ISO_CONTACT_HEIGHT_MM = 0.1;

/**
 * The public chip module's contact plate, mm: an eight-contact module's etched contact area (NXP
 * SOT658-1: 12.6 along the card's long side × 11.4, punched 13.0 × 11.8; Atmel M2 the same), centred
 * on the ISO contact area, with ~R1.5 corners and the 0.15 mm minimum isolation gap between pads. The
 * pads are split around the ISO zones: row separators halfway between the rows, a centre pad (the die
 * carrier) between the columns, the top and bottom pads reaching over it, split down the middle.
 */
export const ISO_CHIP_PLATE = {
  width: 12.6,
  height: 11.4,
  cornerRadius: 1.5,
  gap: 0.15,
  /** Centre pad: clearance from each contact column, and its top / bottom edges (mm from the top edge). */
  centre: { side: 0.55, top: 20.35, bottom: 27.43 },
  /**
   * How far the plate's top lies above the face, mm. ISO/IEC 7816-1:1998 allows +0.05 / −0.10, the
   * 2011 edition ±0.10: 0.05 satisfies both.
   */
  protrusion: 0.05,
} as const;

/** Plate centre on the card, mm: the centre of the contact area. */
const ISO_CHIP_CENTRE_MM = {
  x: (ISO_CONTACT_AREA.x0 + ISO_CONTACT_AREA.x1) / 2,
  y: (ISO_CONTACT_AREA.y0 + ISO_CONTACT_AREA.y1) / 2,
} as const;

/** The plate outline, mm from the card's left / top edges. */
export const ISO_CHIP_PLATE_MM: MmRect = rect(
  ISO_CHIP_CENTRE_MM.x - ISO_CHIP_PLATE.width / 2,
  ISO_CHIP_CENTRE_MM.x + ISO_CHIP_PLATE.width / 2,
  ISO_CHIP_CENTRE_MM.y - ISO_CHIP_PLATE.height / 2,
  ISO_CHIP_CENTRE_MM.y + ISO_CHIP_PLATE.height / 2,
);

/** One conductive pad of the plate: its contact (C1–C8, or 0 for the centre pad) and its pieces. */
interface ChipPad {
  contact: number;
  /** Union of rectangles, mm on the card (the plate's rounded corners trim the outer ones). */
  rects: MmRect[];
}

/**
 * The plate's pads, mm on the card: each of C1–C8 covers its ISO zone with at least half a gap to
 * spare; the centre pad sits between the columns. The gaps are the boundaries between the pieces.
 * @archive the local three.js archive (.archive/three-engine) imports it
 */
export function isoChipPads(): ChipPad[] {
  const P = ISO_CHIP_PLATE_MM;
  const c = ISO_CHIP_PLATE.centre;
  const left = ISO_7816_CONTACTS[0]!.x1 + c.side; // centre pad's left edge
  const right = ISO_7816_CONTACTS[4]!.x0 - c.side;
  const mid = ISO_CHIP_CENTRE_MM.x;
  const sep = [P.y0, ...[0, 1, 2].map((r) => (ROWS[r]![1] + ROWS[r + 1]![0]) / 2), P.y1];
  const pads: ChipPad[] = [];
  for (const side of [0, 1]) {
    const [ox0, ox1] = side === 0 ? [P.x0, left] : [right, P.x1];
    const [sx0, sx1] = side === 0 ? [left, mid] : [mid, right];
    for (let r = 0; r < 4; r++) {
      const rects = [rect(ox0, ox1, sep[r]!, sep[r + 1]!)];
      // The top and bottom pads reach over (under) the centre pad, split down the middle.
      if (r === 0) rects.push(rect(sx0, sx1, P.y0, c.top));
      if (r === 3) rects.push(rect(sx0, sx1, c.bottom, P.y1));
      pads.push({ contact: side * 4 + r + 1, rects });
    }
  }
  pads.push({ contact: 0, rects: [rect(left, right, c.top, c.bottom)] });
  return pads;
}

/**
 * ISO/IEC 7811-1 embossing areas as rectangles, mm from the left / top edges of a landscape card. The
 * standard measures from the bottom edge (the only ID-card standard that does):
 * - area 1, the identification number line: character centreline 21.42 ± 0.12 above the bottom edge,
 *   character tops ≤ 24.03, characters ≤ 4.32 tall; the first character's centreline 10.18 from the
 *   left edge, 19 characters at 3.63 pitch to the last (65.31 further);
 * - area 2, name and address (four lines of 27 characters at 2.54 pitch): from 2.54 (character
 *   bottoms) to 14.53 above the bottom edge; the first character's centreline 7.65 from the left, the
 *   27th 66.04 further.
 * Each rectangle runs from half a pitch before the first character to half a pitch after the last.
 */
export const ISO_7811_AREAS = {
  number: rect(10.18 - 3.63 / 2, 10.18 + 65.31 + 3.63 / 2, ISO_ID1_MM.height - 24.03, ISO_ID1_MM.height - (24.03 - 4.32)),
  name: rect(7.65 - 2.54 / 2, 7.65 + 66.04 + 2.54 / 2, ISO_ID1_MM.height - 14.53, ISO_ID1_MM.height - 2.54),
} as const;
/** Area 1's character centreline, mm from the top edge (21.42 above the bottom edge). */
export const ISO_NUMBER_CENTRELINE_MM = ISO_ID1_MM.height - 21.42;

/**
 * ISO/IEC 14443-1 Class 1 antenna zone: the antenna encircles a 64 × 34 mm rectangle inside an 81 × 49
 * mm one (R3 corners), both centred on the card. Its band along the bottom (44.0–51.5 mm from the top)
 * lies in embossing area 2, so an embossable card's antenna can't be Class 1: the public clear card's
 * coil keeps clear of both embossing areas instead (`ISO_ANTENNA`).
 */
export const ISO_14443_CLASS1 = {
  outer: rect((ISO_ID1_MM.width - 81) / 2, (ISO_ID1_MM.width + 81) / 2, (ISO_ID1_MM.height - 49) / 2, (ISO_ID1_MM.height + 49) / 2),
  inner: rect((ISO_ID1_MM.width - 64) / 2, (ISO_ID1_MM.width + 64) / 2, (ISO_ID1_MM.height - 34) / 2, (ISO_ID1_MM.height + 34) / 2),
} as const;

/**
 * The clear card's antenna coil (the only one the engine draws), mm: wire centres of the outer turn, its
 * corner radius, revolutions of the spiral (it moves in a pitch each), pitch and wire radius. Real embossable dual-interface cards route the coil
 * around the embossing areas rather than through them: here a loop round the upper card, its top run
 * below the corner mark and the top text lines, its sides 2 mm in from the short edges, and its bottom
 * run in the 5.2 mm between embossing area 1 (number) and area 2 (name), so the chip and the number line
 * lie inside it and the name area below it. Its two ends come off the left run beside the chip.
 */
export const ISO_ANTENNA = {
  outer: rect(2.0, ISO_ID1_MM.width - 2.0, 13.0, 38.3),
  cornerRadius: 4.0,
  turns: 4,
  pitch: 0.61,
  wireRadius: 0.081,
} as const;

/**
 * The band the coil's turns occupy: the outer and inner edges of its wire as rounded rectangles (mm on
 * the card, with their corner radii).
 */
export function isoAntennaBand(): { outer: MmRect; inner: MmRect; outerRadius: number; innerRadius: number } {
  const a = ISO_ANTENNA;
  // The spiral moves in a pitch per revolution; its inner end lies a little past `turns` pitches.
  const d = (a.turns + 0.1) * a.pitch + a.wireRadius;
  return {
    outer: rect(a.outer.x0 - a.wireRadius, a.outer.x1 + a.wireRadius, a.outer.y0 - a.wireRadius, a.outer.y1 + a.wireRadius),
    inner: rect(a.outer.x0 + d, a.outer.x1 - d, a.outer.y0 + d, a.outer.y1 - d),
    outerRadius: a.cornerRadius + a.wireRadius,
    innerRadius: Math.max(0, a.cornerRadius - d),
  };
}

/** Whether (x, y) lies inside the rounded rectangle `r` (corner radius `radius`) by at least `pad` (mm). */
export function insideRounded(r: MmRect, radius: number, x: number, y: number, pad = 0): boolean {
  const cx = Math.min(Math.max(x, r.x0 + radius), r.x1 - radius);
  const cy = Math.min(Math.max(y, r.y0 + radius), r.y1 - radius);
  const qx = Math.abs(x - (r.x0 + r.x1) / 2) - (r.x1 - r.x0) / 2;
  const qy = Math.abs(y - (r.y0 + r.y1) / 2) - (r.y1 - r.y0) / 2;
  if (qx > -pad || qy > -pad) return false;
  return Math.hypot(x - cx, y - cy) <= radius - pad || (x >= r.x0 + radius && x <= r.x1 - radius) || (y >= r.y0 + radius && y <= r.y1 - radius);
}

/**
 * Where the cutouts go, mm on the landscape card (ISO/IEC 7810 has no holes: they are a design
 * feature). Each keeps clear of the ISO contacts and plate, the antenna band and both embossing areas:
 * - the lanyard slot stands by the left short edge, centred on the card's height, just inside the
 *   antenna's left run;
 * - the window is centred on the card's width, between the antenna's top run and embossing area 1
 *   (the number line), right of the chip and the contactless mark;
 * - the corner notch (top-right) is checked in `shape.ts`: it reaches 8.8 mm, above the antenna's top
 *   run and far from the contacts.
 */
export const ISO_CUTOUTS = {
  /** The slot's edge nearest the card's left edge (its long axis vertical), and its centre's height. */
  slot: { left: isoAntennaBand().inner.x0 + 0.5, centreY: ISO_ID1_MM.height / 2 },
  /** The window's centre. */
  window: { x: ISO_ID1_MM.width / 2, y: (isoAntennaBand().inner.y0 + ISO_7811_AREAS.number.y0) / 2 },
} as const;

// ── mm ↔ card units ─────────────────────────────────────────────────────────

/**
 * A point given in mm on the landscape card (from its left / top edges) in card units of `frame`
 * (centred; y up). Portrait cards are the same body turned a quarter turn clockwise: its left edge
 * becomes the top, so the chip, which stays where the standard puts it on the body, ends up near the
 * top and the print is laid out upright around it.
 */
export function isoPoint(xMm: number, yMm: number, portrait = false): { x: number; y: number } {
  const x = (xMm - ISO_ID1_MM.width / 2) / MM_PER_UNIT;
  const y = (ISO_ID1_MM.height / 2 - yMm) / MM_PER_UNIT;
  return portrait ? { x: y, y: -x } : { x, y };
}

/** An mm rectangle as a centred card-unit rectangle (`{ x, y, w, h }`) in a landscape or portrait frame. */
export function isoRect(r: MmRect, portrait = false): { x: number; y: number; w: number; h: number } {
  const c = isoPoint((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, portrait);
  const w = (r.x1 - r.x0) / MM_PER_UNIT;
  const h = (r.y1 - r.y0) / MM_PER_UNIT;
  return portrait ? { x: c.x, y: c.y, w: h, h: w } : { x: c.x, y: c.y, w, h };
}

/** A card-unit point of a frame back in mm on the landscape card (from its left / top edges). */
export function isoMm(x: number, y: number, portrait = false): { x: number; y: number } {
  const [lx, ly] = portrait ? [-y, x] : [x, y];
  return { x: ISO_ID1_MM.width / 2 + lx * MM_PER_UNIT, y: ISO_ID1_MM.height / 2 - ly * MM_PER_UNIT };
}

/** The chip in a frame: plate centre, its turn (portrait: a quarter turn clockwise), size and height. */
function isoChipPlacement(portrait: boolean): CardFrame["chip"] {
  const c = isoPoint(ISO_CHIP_CENTRE_MM.x, ISO_CHIP_CENTRE_MM.y, portrait);
  return {
    x: c.x,
    y: c.y,
    rotation: portrait ? -Math.PI / 2 : 0,
    width: ISO_CHIP_PLATE.width / MM_PER_UNIT,
    height: ISO_CHIP_PLATE.height / MM_PER_UNIT,
    top: ISO_CHIP_PLATE.protrusion / MM_PER_UNIT,
  };
}

/** Native body units per card unit (the ID-1 body's 860 native units are `CARD_W`). */
const NATIVE_PER_UNIT = ID1_BODY_NATIVE.width / CARD_W;

/**
 * The frame of an ID-1 card body (`CardFrame`): print area, body, corner radius (card units), the ISO
 * chip and the cutouts. The public standard card has one too, so everything laid out from a frame
 * follows the standards; a local pack's glTF card has none and keeps its own layout.
 */
export function isoFrame(portrait: boolean, cornerRadius: number, cutouts: readonly CardCutout[]): CardFrame {
  const nw = portrait ? ID1_BODY_NATIVE.height : ID1_BODY_NATIVE.width;
  const nh = portrait ? ID1_BODY_NATIVE.width : ID1_BODY_NATIVE.height;
  return {
    width: portrait ? CARD_H : CARD_W,
    height: portrait ? CARD_W : CARD_H,
    bodyWidth: nw / NATIVE_PER_UNIT,
    bodyHeight: nh / NATIVE_PER_UNIT,
    portrait,
    cornerRadius,
    chip: isoChipPlacement(portrait),
    cutouts: [...cutouts],
  };
}
