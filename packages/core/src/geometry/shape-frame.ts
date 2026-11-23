import type { CardCutout, CardShape } from "../types.ts";
import { clamp } from "../materials/math.ts";
import { BODY_SCALE, CARD_H, CARD_W, CORNER_RADIUS_RANGE, ID1_BODY_NATIVE, MM_PER_UNIT } from "./constants.ts";
import { ISO_CUTOUTS, isoFrame, isoPoint } from "./iso.ts";
import type { CardFrame } from "./frame.ts";

/**
 * Card shapes (`CardDesign.shape`): corner radius (within ISO/IEC 7810 ID-1, 2.88–3.48 mm; the
 * geometry itself handles sharp to pill), portrait orientation and
 * cutouts (a lanyard slot, a corner notch, a round window), built procedurally with the standard
 * card's extrusion profile (flat caps, a 2-unit quarter-round bevel, straight walls) on
 * every contour, holes included, so a cutout is a see-through hole with its own bevelled wall. The
 * body is the ID-1 one (`ID1_BODY_NATIVE`: 85.60 × 53.98 × 0.70 mm), whatever the provider.
 *
 * A design whose shape is the standard card (`resolveShape` → null) never comes here: it keeps the
 * provider's geometry (the glTF model, or `buildProceduralCardGeometry`) byte for byte.
 *
 * Layout: a shaped set carries a `CardFrame` (`isoFrame`, as the public standard card does) — the
 * print area (3.37 × 2.125 landscape, 2.125 × 3.37 portrait), the chip at its ISO/IEC 7816-2 place on
 * the body and its turn, the corner radius and the cutouts — which the branding, chip, stickers and
 * face shaders read instead of the default landscape constants.
 *
 * The cutouts are beyond ISO/IEC 7810 (an ID-1 card has no holes): a design feature, each placed clear
 * of the ISO contacts and plate, the clear card's antenna band and both ISO/IEC 7811-1 embossing areas
 * (`ISO_CUTOUTS`; `iso.test.ts` checks every radius and both orientations).
 */

/** The standard card's corner radius as a fraction of the pill radius: ISO/IEC 7810's 3.18 mm (≈ 0.118). */
export const DEFAULT_CORNER_RADIUS = CORNER_RADIUS_RANGE.iso;
export const CARD_CUTOUTS: readonly CardCutout[] = ["lanyard", "notch", "window"];
/** @archive the local three.js archive (.archive/three-engine) imports it */
export { CORNER_RADIUS_RANGE };
/** A design's corner radius limited to ISO/IEC 7810 ID-1 (`CORNER_RADIUS_RANGE`, 2.88–3.48 mm). */
export const clampCornerRadius = (r: number): number => clamp(r, CORNER_RADIUS_RANGE.min, CORNER_RADIUS_RANGE.max);

export interface ResolvedShape {
  /** Fraction of the pill radius, 0..1. */
  cornerRadius: number;
  portrait: boolean;
  /** Sorted, unique. */
  cutouts: CardCutout[];
}

/** The shape to build, or null when it is the standard card (keep the provider's geometry). */
export function resolveShape(shape: CardShape | null | undefined): ResolvedShape | null {
  if (!shape || typeof shape !== "object") return null;
  const r = typeof shape.cornerRadius === "number" && Number.isFinite(shape.cornerRadius) ? clampCornerRadius(shape.cornerRadius) : DEFAULT_CORNER_RADIUS;
  const portrait = shape.orientation === "portrait";
  // The notch replaces the top-right corner; every clamped radius lies within its reach (`notchFits`).
  const cutouts = CARD_CUTOUTS.filter((c) => Array.isArray(shape.cutouts) && shape.cutouts.includes(c));
  // Within 5e-4 (0.01 mm) of the standard radius, as `sanitizeShape` rounds it.
  if (!portrait && !cutouts.length && Math.abs(r - DEFAULT_CORNER_RADIUS) < 5e-4) return null;
  return { cornerRadius: r, portrait, cutouts };
}

/** @archive the local three.js archive (.archive/three-engine) imports it */
export const shapeKey = (s: ResolvedShape): string => `${s.cornerRadius.toFixed(4)}|${s.portrait ? "p" : "l"}|${s.cutouts.join(",")}`;

// ── outline description ───────────────────────────────────────────────────────

/** A circular arc of a contour: material on the left of travel. `concave`: material outside the circle. */
interface Arc {
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
  concave: boolean;
}
/** Contour sample with its outward normal (away from the material), native units. @archive the local three.js archive imports it */
export interface Sample {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

/** @archive the local three.js archive (.archive/three-engine) imports it */
export const A = BODY_SCALE;
/** Card-unit dimensions of the shaped cutouts. */
const CUT = {
  slot: { length: 0.62, width: 0.11 },
  notch: { radius: 0.3, fillet: 0.05 },
  window: { radius: 0.26 },
} as const;

/** How far along each edge (card units) the notch, with its fillets, reaches from the corner. */
const NOTCH_REACH = Math.sqrt(CUT.notch.radius ** 2 + 2 * CUT.notch.radius * CUT.notch.fillet);
/**
 * Largest corner radius (fraction of the pill radius) a notch can replace cleanly: the rounded corner
 * must lie within the notch's reach, so both edges run straight into the notch's fillets (≈ 0.33,
 * about 9 mm: far above `CORNER_RADIUS_RANGE.max`, so a design's notch always fits; the geometry,
 * which takes any radius, needs it).
 */
export const NOTCH_MAX_CORNER_RADIUS = NOTCH_REACH / A / (ID1_BODY_NATIVE.height / 2);
export const notchFits = (cornerRadius: number): boolean => cornerRadius <= NOTCH_MAX_CORNER_RADIUS + 1e-9;

/** @archive the local three.js archive (.archive/three-engine) imports it */
export function sampleArcs(arcs: Arc[], segPerRad: number): Sample[] {
  const out: Sample[] = [];
  for (const a of arcs) {
    const sweep = Math.abs(a.a1 - a.a0);
    const n = a.r < 1e-6 ? 1 : Math.max(2, Math.ceil(sweep * segPerRad * Math.sqrt(Math.max(a.r, 8) / 40)));
    for (let k = 0; k <= n; k++) {
      const t = a.a0 + ((a.a1 - a.a0) * k) / n;
      const c = Math.cos(t);
      const s = Math.sin(t);
      out.push({ x: a.cx + a.r * c, y: a.cy + a.r * s, nx: a.concave ? -c : c, ny: a.concave ? -s : s });
    }
  }
  // Drop coincident neighbours (arcs meeting without a straight run, e.g. pill ends).
  const dedup: Sample[] = [];
  for (const p of out) {
    const q = dedup[dedup.length - 1];
    if (q && Math.hypot(p.x - q.x, p.y - q.y) < 1e-6) continue;
    dedup.push(p);
  }
  const first = dedup[0];
  const last = dedup[dedup.length - 1];
  if (first && last && dedup.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) dedup.pop();
  return dedup;
}

/** Native outline of the outer edge (CCW from the bottom-right corner). @archive the local three.js archive imports it */
export function outerArcs(w: number, h: number, r: number, notch: boolean): Arc[] {
  const hx = w / 2;
  const hy = h / 2;
  const arcs: Arc[] = [{ cx: hx - r, cy: -hy + r, r, a0: -Math.PI / 2, a1: 0, concave: false }];
  if (notch) {
    // Top-right corner: a quarter-round bite (centre on the corner) with small convex fillets.
    const rn = CUT.notch.radius / A;
    const f = CUT.notch.fillet / A;
    const s = Math.sqrt(rn * rn + 2 * rn * f);
    const v = Math.atan2(s, f); // fillet 1 end normal: towards the corner
    const u = Math.atan2(f, s); // fillet 2 start normal
    arcs.push(
      { cx: hx - f, cy: hy - s, r: f, a0: 0, a1: v, concave: false },
      { cx: hx, cy: hy, r: rn, a0: Math.atan2(-s, -f) + 2 * Math.PI, a1: Math.atan2(-f, -s) + 2 * Math.PI, concave: true },
      { cx: hx - s, cy: hy - f, r: f, a0: u, a1: Math.PI / 2, concave: false },
    );
  } else {
    arcs.push({ cx: hx - r, cy: hy - r, r, a0: 0, a1: Math.PI / 2, concave: false });
  }
  arcs.push(
    { cx: -hx + r, cy: hy - r, r, a0: Math.PI / 2, a1: Math.PI, concave: false },
    { cx: -hx + r, cy: -hy + r, r, a0: Math.PI, a1: (3 * Math.PI) / 2, concave: false },
  );
  return arcs;
}

/** Hole outlines (traversed clockwise: material on the left), native units. @archive the local three.js archive imports it */
export function holeArcs(s: ResolvedShape, frame: CardFrame): Arc[][] {
  const holes: Arc[][] = [];
  for (const c of s.cutouts) {
    if (c === "lanyard") {
      const { x, y, length, width, vertical } = slotPlacement(frame);
      const hl = (length - width) / 2 / A;
      const rr = width / 2 / A;
      const X = x / A;
      const Y = y / A;
      if (vertical)
        holes.push([
          { cx: X, cy: Y + hl, r: rr, a0: Math.PI, a1: 0, concave: true },
          { cx: X, cy: Y - hl, r: rr, a0: 0, a1: -Math.PI, concave: true },
        ]);
      else
        holes.push([
          { cx: X + hl, cy: Y, r: rr, a0: Math.PI / 2, a1: -Math.PI / 2, concave: true },
          { cx: X - hl, cy: Y, r: rr, a0: -Math.PI / 2, a1: (-3 * Math.PI) / 2, concave: true },
        ]);
    } else if (c === "window") {
      const { x, y, radius } = windowPlacement(frame);
      holes.push([{ cx: x / A, cy: y / A, r: radius / A, a0: Math.PI, a1: -Math.PI, concave: true }]);
    }
  }
  return holes;
}

/**
 * The lanyard slot: by the left short edge, centred on the card's height (portrait: the same place on
 * the body, so by the top edge), clear of the antenna band, the chip and the embossing areas
 * (`ISO_CUTOUTS`).
 */
export function slotPlacement(frame: CardFrame): { x: number; y: number; length: number; width: number; vertical: boolean } {
  const { length, width } = CUT.slot;
  const c = isoPoint(ISO_CUTOUTS.slot.left + (width * MM_PER_UNIT) / 2, ISO_CUTOUTS.slot.centreY, frame.portrait);
  return { x: c.x, y: c.y, length, width, vertical: !frame.portrait };
}

/**
 * The round window: centred on the card's width, between the antenna's top run and embossing area 1
 * (`ISO_CUTOUTS`); portrait, the same place on the body.
 */
export function windowPlacement(frame: CardFrame): { x: number; y: number; radius: number } {
  const c = isoPoint(ISO_CUTOUTS.window.x, ISO_CUTOUTS.window.y, frame.portrait);
  return { x: c.x, y: c.y, radius: CUT.window.radius };
}

// ── frame (layout) ────────────────────────────────────────────────────────────

/**
 * The shape's frame (`isoFrame`): the ID-1 body, landscape or portrait, its corner radius, the chip
 * where ISO/IEC 7816-2 puts it on the body (portrait: the body turned a quarter turn clockwise, so
 * the chip sits near the top and turns with it) and the cutouts.
 */
export function frameForShape(s: ResolvedShape): CardFrame {
  const pill = Math.min(ID1_BODY_NATIVE.width, ID1_BODY_NATIVE.height) / 2;
  const rNative = Math.max(ID1_BODY_NATIVE.bevel + 0.5, s.cornerRadius * pill);
  return isoFrame(s.portrait, rNative * A, s.cutouts);
}

/**
 * How far a corner block must move in *diagonally* (the same distance in from the side and from the
 * top/bottom edge) so that its outer corner, `dx` in from the side and `dy` in from the top or bottom,
 * lies inside the rounded corner with `pad` to spare. The least displacement that clears the arc, so a
 * block keeps to its corner (moving only sideways would shove it towards the middle on a pill). 0 when
 * the corner is already clear, or without a frame.
 */
export function cornerInset(frame: CardFrame | undefined, dx: number, dy: number, pad = 0.04): number {
  if (!frame) return 0;
  const r = frame.cornerRadius;
  const a = r - dx;
  const b = r - dy;
  if (a <= 0 || b <= 0) return 0;
  const R = Math.max(0, r - pad);
  if (a * a + b * b <= R * R) return 0;
  // (a − u)² + (b − u)² = R²  →  the smaller root.
  const disc = 2 * R * R - (a - b) * (a - b);
  return disc >= 0 ? (a + b - Math.sqrt(disc)) / 2 : Math.max(a, b) - R;
}

/**
 * One arc of a shape's contour, card units (centred, y up), from angle `a0` to `a1` (radians; `a1 > a0`
 * runs counter-clockwise). Consecutive arcs are joined by straight runs; `concave`: the material lies
 * outside the circle (a hole, the notch's bite).
 */
export interface ShapeArc {
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
  concave: boolean;
}

/**
 * The exact contours of a shape as arcs, card units: the outline (counter-clockwise from the
 * bottom-right corner) and each hole (clockwise). Production dielines draw these as true arcs.
 */
export function shapeContours(s: ResolvedShape): { outer: ShapeArc[]; holes: ShapeArc[][] } {
  const frame = frameForShape(s);
  const scale = (a: Arc): ShapeArc => ({ cx: a.cx * A, cy: a.cy * A, r: a.r * A, a0: a.a0, a1: a.a1, concave: a.concave });
  return {
    outer: outerArcs(frame.bodyWidth / A, frame.bodyHeight / A, frame.cornerRadius / A, s.cutouts.includes("notch")).map(scale),
    holes: holeArcs(s, frame).map((hole) => hole.map(scale)),
  };
}

/** The outer outline of a shape, card units, counter-clockwise (tests, previews). */
export function shapeOutline(s: ResolvedShape): Array<{ x: number; y: number }> {
  const frame = frameForShape(s);
  const pts = sampleArcs(outerArcs(frame.bodyWidth / A, frame.bodyHeight / A, frame.cornerRadius / A, s.cutouts.includes("notch")), 12 / (Math.PI / 2));
  return pts.map((p) => ({ x: p.x * A, y: p.y * A }));
}

/** The print area of a design's card, card units: 3.37 × 2.125, or 2.125 × 3.37 portrait (stickers, framing). */
export function cardFrameSize(design: { shape?: CardShape | null; recipe?: { material?: string }; materialOverride?: { transmission?: number } | null }): {
  width: number;
  height: number;
  portrait: boolean;
} {
  // As `buildMetalCard`: shapes apply to metal bodies only (not glass).
  const glass = design.recipe?.material === "glass" || (design.materialOverride?.transmission ?? 0) > 0.5;
  const portrait = !glass && design.shape?.orientation === "portrait";
  return portrait ? { width: CARD_H, height: CARD_W, portrait } : { width: CARD_W, height: CARD_H, portrait };
}
