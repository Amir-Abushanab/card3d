/**
 * The production dieline of a card (pure, mm): the trim outline with its ISO/IEC 7810 corners, the
 * cutouts, the bleed and safe-zone boxes and the keep-out areas, for each side as seen from that side
 * (the back is mirrored: its left is the front's right). Coordinates are mm from the trim's top-left
 * corner, y down, the frame every file of a print package shares (`layout.ts`).
 *
 * Keep-outs come from the standards (`geometry/iso.ts`):
 * - the ISO/IEC 7816-2 contact area and the module's contact plate (front);
 * - ISO/IEC 7811-1 embossing areas 1 and 2 (front, landscape; personalisation zones, informational);
 * - ISO/IEC 14443-1 Class 1 antenna zone (the band between 81 × 49 and 64 × 34 mm, both faces);
 * - optionally the ISO/IEC 7811-6 magnetic stripe band on the back (5.54–15.95 mm from the top edge,
 *   the 3-track minimum), with its rule of no raised areas within 19.05 mm of the top on either face;
 * - a signature panel and a hologram area on the back, only where a vendor preset gives them (no
 *   standard sets them).
 */
import type { CardCutout, CardDesign, Side } from "../types.ts";
import { ISO_ID1_MM, MM_PER_UNIT } from "../geometry/constants.ts";
import { DEFAULT_CORNER_RADIUS, resolveShape, shapeContours, frameForShape, type ResolvedShape, type ShapeArc } from "../geometry/shape-frame.ts";
import { ISO_14443_CLASS1, ISO_7811_AREAS, ISO_CHIP_PLATE, ISO_CHIP_PLATE_MM, ISO_CONTACT_AREA, isoRect, type MmRect } from "../geometry/iso.ts";

/** ISO/IEC 7811-6 (2008) magnetic stripe on the back, mm from the top edge (landscape). */
export const ISO_7811_6_STRIPE = {
  /** The stripe's upper edge lies at most this far from the top edge. */
  top: 5.54,
  /** Its lower edge at least this far: 11.89 for two tracks, 15.95 for three. */
  bottom2: 11.89,
  bottom3: 15.95,
  /** No raised areas (embossing) within this distance of the top edge, on either face. */
  raisedFree: 19.05,
} as const;

export type KeepOutKind =
  | "contact-plate"
  | "contact-area"
  | "embossing-area"
  | "antenna"
  | "magstripe"
  | "raised-free"
  | "signature-panel"
  | "hologram"
  | "network-mark";

/**
 * What an element overlapping the area means: `block` (nothing may be printed or raised there),
 * `avoid` (the vendor's process covers it: a warning), `info` (a zone to know about).
 */
export type KeepOutRule = "block" | "avoid" | "info";

export interface KeepOut {
  id: string;
  kind: KeepOutKind;
  side: Side;
  label: string;
  rule: KeepOutRule;
  /** The area, mm in the side's own view (from its top-left corner). */
  rect: MmRect;
  /** Corner radius, mm. */
  radius: number;
  /** A band: the area is `rect` minus this inner rounded rectangle (the antenna zone). */
  inner?: { rect: MmRect; radius: number };
  /** Where the numbers come from. */
  source: string;
  /** How far placed elements must stay from it, mm (0: only the area itself). */
  clearance: number;
}

/** A contour arc in mm (y down): from → to around (cx, cy) with SVG's arc flags. */
export interface DielineArc {
  cx: number;
  cy: number;
  r: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** SVG sweep flag (1 = clockwise on the page). */
  sweep: 0 | 1;
  large: 0 | 1;
}

export interface DielineContour {
  kind: "trim" | CardCutout;
  /** Arcs in order; consecutive arcs are joined by straight lines, the last back to the first. */
  arcs: DielineArc[];
  /** SVG path data (mm). */
  path: string;
  /** Bounding box, mm. */
  box: MmRect;
}

export interface DielineSide {
  side: Side;
  trim: DielineContour;
  /** Cutouts (holes) in the card, and the notch as part of the trim (`notch: true`). */
  cutouts: DielineContour[];
  keepOuts: KeepOut[];
}

export interface DielineOptions {
  bleedMm: number;
  safeMm: number;
  /** Draw the ISO/IEC 7811-6 magnetic stripe band on the back (and its raised-free zone). Default false. */
  magstripe?: boolean;
  /** Tracks the stripe is sized for: its lower edge at 11.89 (2) or 15.95 mm (3, default) from the top. */
  magstripeTracks?: 2 | 3;
  /** Clearance of placed elements from the chip module, mm. Default 0. */
  chipClearanceMm?: number;
  /** Clearance from the signature panel, hologram and stripe, mm. Default 0. */
  panelClearanceMm?: number;
  /** A reserved area for the network brand mark (payment programs), mm on the front (landscape). */
  networkMark?: MmRect | null;
  /** A signature panel on the back, mm from the back's top-left (landscape). None by default. */
  signaturePanel?: MmRect | null;
  /** A hologram area on the back, mm from the back's top-left (landscape). None by default. */
  hologram?: MmRect | null;
  /** Personalisation zones (embossing areas): payment programs only. Default true. */
  embossingAreas?: boolean;
  /** Where the signature panel / hologram numbers come from (shown with them). */
  source?: string;
}

export interface CardDieline {
  /** Trim size, mm (as seen on the front: landscape 85.60 × 53.98, portrait 53.98 × 85.60). */
  width: number;
  height: number;
  orientation: "landscape" | "portrait";
  cornerRadiusMm: number;
  bleedMm: number;
  safeMm: number;
  /** The safe area (inside the trim by `safeMm`), mm, and its corner radius. */
  safe: { rect: MmRect; radius: number };
  /** The bleed edge, mm (outside the trim by `bleedMm`). */
  bleed: MmRect;
  notch: boolean;
  sides: Record<Side, DielineSide>;
}

/** The shape a design's card is built with (shapes apply to metal cards only, as `buildMetalCard`). */
export function printShape(design: Pick<CardDesign, "shape" | "recipe" | "materialOverride">): ResolvedShape {
  const glass = design.recipe?.material === "glass" || (design.materialOverride?.transmission ?? 0) > 0.5;
  const s = !glass ? resolveShape(design.shape) : null;
  return s ?? { cornerRadius: DEFAULT_CORNER_RADIUS, portrait: false, cutouts: [] };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const fmt = (v: number) => {
  const s = r3(v)
    .toFixed(3)
    .replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

/** Card units (centred, y up) → mm in a side's view. */
function toMm(width: number, height: number, mirror: boolean) {
  return (x: number, y: number) => {
    const mx = x * MM_PER_UNIT + width / 2;
    return { x: mirror ? width - mx : mx, y: height / 2 - y * MM_PER_UNIT };
  };
}

function contour(kind: DielineContour["kind"], arcs: ShapeArc[], map: (x: number, y: number) => { x: number; y: number }, mirror: boolean): DielineContour {
  const out: DielineArc[] = [];
  for (const a of arcs) {
    // SVG can't draw a full circle in one arc: split anything near a half turn or more.
    const sweep = a.a1 - a.a0;
    const parts = Math.abs(sweep) > Math.PI - 1e-6 ? 2 : 1;
    for (let k = 0; k < parts; k++) {
      const t0 = a.a0 + (sweep * k) / parts;
      const t1 = a.a0 + (sweep * (k + 1)) / parts;
      const from = map(a.cx + a.r * Math.cos(t0), a.cy + a.r * Math.sin(t0));
      const to = map(a.cx + a.r * Math.cos(t1), a.cy + a.r * Math.sin(t1));
      const c = map(a.cx, a.cy);
      // Counter-clockwise in card units (y up) is counter-clockwise on the page too (SVG sweep 0: the
      // y flip turns the angles round, and SVG's positive direction is clockwise); mirroring flips it.
      const ccw = t1 > t0;
      out.push({ cx: c.x, cy: c.y, r: a.r * MM_PER_UNIT, from, to, sweep: (ccw === mirror ? 1 : 0) as 0 | 1, large: Math.abs(t1 - t0) > Math.PI ? 1 : 0 });
    }
  }
  let d = "";
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const grow = (p: { x: number; y: number }) => {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  };
  out.forEach((a, i) => {
    d += `${i === 0 ? "M" : "L"}${fmt(a.from.x)} ${fmt(a.from.y)}`;
    if (a.r > 1e-9) d += `A${fmt(a.r)} ${fmt(a.r)} 0 ${a.large} ${a.sweep} ${fmt(a.to.x)} ${fmt(a.to.y)}`;
    grow(a.from);
    grow(a.to);
    // Arc extremes (the box of a quarter-circle corner is its end points; a round hole needs its extremes).
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const p = { x: a.cx + dx * a.r, y: a.cy + dy * a.r };
      if (onArc(a, p)) grow(p);
    }
  });
  return { kind, arcs: out, path: `${d}Z`, box: { x0, x1, y0, y1 } };
}

/** Whether p (on the arc's circle) lies on the arc between `from` and `to` in its sweep direction. */
function onArc(a: DielineArc, p: { x: number; y: number }): boolean {
  const ang = (q: { x: number; y: number }) => Math.atan2(q.y - a.cy, q.x - a.cx);
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // sweep 1 = clockwise on the page = increasing angle with y down.
  const s = a.sweep === 1 ? 1 : -1;
  const span = norm(s * (ang(a.to) - ang(a.from)));
  const at = norm(s * (ang(p) - ang(a.from)));
  return at <= span + 1e-9;
}

/** A landscape-front mm rectangle in a side's view of the frame (portrait turns it, the back mirrors it). */
function frontRect(r: MmRect, portrait: boolean, width: number, height: number, mirror: boolean): MmRect {
  const c = isoRect(r, portrait);
  const map = toMm(width, height, mirror);
  const a = map(c.x - c.w / 2, c.y + c.h / 2);
  const b = map(c.x + c.w / 2, c.y - c.h / 2);
  const q = (v: number) => Math.round(v * 1e6) / 1e6;
  return { x0: q(Math.min(a.x, b.x)), x1: q(Math.max(a.x, b.x)), y0: q(Math.min(a.y, b.y)), y1: q(Math.max(a.y, b.y)) };
}

/** A landscape-back mm rectangle (as seen from the back) → landscape-front mm. */
const backToFront = (r: MmRect): MmRect => ({ x0: ISO_ID1_MM.width - r.x1, x1: ISO_ID1_MM.width - r.x0, y0: r.y0, y1: r.y1 });

export function cardDieline(design: Pick<CardDesign, "shape" | "recipe" | "materialOverride">, o: DielineOptions): CardDieline {
  const s = printShape(design);
  const frame = frameForShape(s);
  const width = frame.bodyWidth * MM_PER_UNIT;
  const height = frame.bodyHeight * MM_PER_UNIT;
  const radius = frame.cornerRadius * MM_PER_UNIT;
  const bleed = Math.max(0, o.bleedMm);
  const safe = Math.max(0, o.safeMm);
  const { outer, holes } = shapeContours(s);
  const holeKinds = s.cutouts.filter((c) => c !== "notch");
  const portrait = s.portrait;
  const sides = {} as Record<Side, DielineSide>;
  for (const side of ["front", "back"] as const) {
    const mirror = side === "back";
    const map = toMm(width, height, mirror);
    const fr = (r: MmRect) => frontRect(r, portrait, width, height, mirror);
    const keepOuts: KeepOut[] = [];
    const add = (k: Omit<KeepOut, "side" | "id" | "clearance"> & { id?: string; clearance?: number }) =>
      keepOuts.push({ ...k, id: k.id ?? `${side}-${k.kind}`, side, clearance: Math.max(0, k.clearance ?? 0) });
    const chipClear = o.chipClearanceMm ?? 0;
    const panelClear = o.panelClearanceMm ?? 0;
    if (side === "front") {
      add({
        kind: "contact-plate",
        label: "Chip module (contact plate)",
        rule: "block",
        rect: fr(ISO_CHIP_PLATE_MM),
        radius: ISO_CHIP_PLATE.cornerRadius,
        clearance: chipClear,
        source: "ISO/IEC 7816-2 contact positions; plate 12.6 × 11.4 mm (NXP SOT658-1 etched area), centred on them",
      });
      add({ kind: "contact-area", label: "ISO/IEC 7816-2 contacts C1–C8", rule: "block", rect: fr(ISO_CONTACT_AREA), radius: 0, source: "ISO/IEC 7816-2" });
      if (!portrait && o.embossingAreas !== false) {
        add({
          id: "front-embossing-number",
          kind: "embossing-area",
          label: "Embossing area 1 (number)",
          rule: "info",
          rect: fr(ISO_7811_AREAS.number),
          radius: 0,
          source: "ISO/IEC 7811-1",
        });
        add({
          id: "front-embossing-name",
          kind: "embossing-area",
          label: "Embossing area 2 (name)",
          rule: "info",
          rect: fr(ISO_7811_AREAS.name),
          radius: 0,
          source: "ISO/IEC 7811-1",
        });
      }
      if (o.networkMark)
        add({
          kind: "network-mark",
          label: "Network brand mark",
          rule: "block",
          rect: fr(o.networkMark),
          radius: 0,
          clearance: panelClear,
          source: o.source ?? "vendor preset",
        });
    }
    add({
      kind: "antenna",
      label: "Contactless / NFC antenna zone",
      rule: "avoid",
      rect: fr(ISO_14443_CLASS1.outer),
      radius: 3,
      inner: { rect: fr(ISO_14443_CLASS1.inner), radius: 0 },
      source: "ISO/IEC 14443-1 Class 1 (the band between 81 × 49 and 64 × 34 mm); a vendor's own antenna routing may differ",
    });
    if (o.magstripe) {
      const stripe = {
        x0: 0,
        x1: ISO_ID1_MM.width,
        y0: ISO_7811_6_STRIPE.top,
        y1: o.magstripeTracks === 2 ? ISO_7811_6_STRIPE.bottom2 : ISO_7811_6_STRIPE.bottom3,
      };
      const raised = { x0: 0, x1: ISO_ID1_MM.width, y0: 0, y1: ISO_7811_6_STRIPE.raisedFree };
      // The stripe is on the back; the raised-free band applies to both faces (same edge of the body).
      if (side === "back")
        add({
          kind: "magstripe",
          label: "Magnetic stripe",
          rule: "block",
          rect: fr(backToFront(stripe)),
          radius: 0,
          clearance: panelClear,
          source: `ISO/IEC 7811-6:2008 (${o.magstripeTracks === 2 ? "2" : "3"}-track minimum band, 5.54–${o.magstripeTracks === 2 ? "11.89" : "15.95"} mm from the top)`,
        });
      add({
        kind: "raised-free",
        label: "No raised marks (stripe edge)",
        rule: "info",
        rect: fr(side === "back" ? backToFront(raised) : raised),
        radius: 0,
        source: "ISO/IEC 7811-6: no raised areas within 19.05 mm of the stripe's edge, either face",
      });
    }
    if (side === "back" && o.signaturePanel)
      add({
        kind: "signature-panel",
        label: "Signature panel",
        rule: "avoid",
        rect: fr(backToFront(o.signaturePanel)),
        radius: 0,
        clearance: panelClear,
        source: o.source ?? "vendor preset",
      });
    if (side === "back" && o.hologram)
      add({
        kind: "hologram",
        label: "Hologram",
        rule: "avoid",
        rect: fr(backToFront(o.hologram)),
        radius: 0,
        clearance: panelClear,
        source: o.source ?? "vendor preset",
      });
    sides[side] = {
      side,
      trim: contour("trim", outer, map, mirror),
      cutouts: holes.map((h, i) => contour(holeKinds[i] ?? "window", h, map, mirror)),
      keepOuts,
    };
  }
  const safeRadius = Math.max(0, radius - safe);
  return {
    width,
    height,
    orientation: portrait ? "portrait" : "landscape",
    cornerRadiusMm: radius,
    bleedMm: bleed,
    safeMm: safe,
    safe: { rect: { x0: safe, x1: width - safe, y0: safe, y1: height - safe }, radius: safeRadius },
    bleed: { x0: -bleed, x1: width + bleed, y0: -bleed, y1: height + bleed },
    notch: s.cutouts.includes("notch"),
    sides,
  };
}

/** Rounded-rectangle path data, mm. */
export function roundedRectPath(r: MmRect, radius: number): string {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const k = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (k <= 1e-9) return `M${fmt(r.x0)} ${fmt(r.y0)}H${fmt(r.x1)}V${fmt(r.y1)}H${fmt(r.x0)}Z`;
  return (
    `M${fmt(r.x0 + k)} ${fmt(r.y0)}H${fmt(r.x1 - k)}A${fmt(k)} ${fmt(k)} 0 0 1 ${fmt(r.x1)} ${fmt(r.y0 + k)}` +
    `V${fmt(r.y1 - k)}A${fmt(k)} ${fmt(k)} 0 0 1 ${fmt(r.x1 - k)} ${fmt(r.y1)}H${fmt(r.x0 + k)}` +
    `A${fmt(k)} ${fmt(k)} 0 0 1 ${fmt(r.x0)} ${fmt(r.y1 - k)}V${fmt(r.y0 + k)}A${fmt(k)} ${fmt(k)} 0 0 1 ${fmt(r.x0 + k)} ${fmt(r.y0)}Z`
  );
}

/** Whether a point (mm) lies in a keep-out (inside its rounded rect, and outside its inner one for a band). */
export function inKeepOut(k: Pick<KeepOut, "rect" | "radius" | "inner">, x: number, y: number): boolean {
  if (!inRounded(k.rect, k.radius, x, y)) return false;
  return !(k.inner && inRounded(k.inner.rect, k.inner.radius, x, y));
}

/** Whether (x, y) lies inside the rounded rectangle (mm). */
export function inRounded(r: MmRect, radius: number, x: number, y: number): boolean {
  if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) return false;
  const k = Math.max(0, Math.min(radius, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2));
  if (k <= 0) return true;
  const cx = Math.min(Math.max(x, r.x0 + k), r.x1 - k);
  const cy = Math.min(Math.max(y, r.y0 + k), r.y1 - k);
  return (x - cx) ** 2 + (y - cy) ** 2 <= k * k;
}

/** Whether (x, y) lies inside a closed contour (even-odd over its arcs and joins, sampled). */
export function inContour(c: DielineContour, x: number, y: number): boolean {
  if (x < c.box.x0 || x > c.box.x1 || y < c.box.y0 || y > c.box.y1) return false;
  const pts = contourPoints(c, 0.2);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const pointCache = new WeakMap<DielineContour, Array<{ x: number; y: number }>>();
/** The contour as a polygon, arcs sampled every `step` mm. */
export function contourPoints(c: DielineContour, step = 0.2): Array<{ x: number; y: number }> {
  const hit = pointCache.get(c);
  if (hit) return hit;
  const pts: Array<{ x: number; y: number }> = [];
  for (const a of c.arcs) {
    const t0 = Math.atan2(a.from.y - a.cy, a.from.x - a.cx);
    let t1 = Math.atan2(a.to.y - a.cy, a.to.x - a.cx);
    const s = a.sweep === 1 ? 1 : -1;
    let span = s * (t1 - t0);
    span = ((span % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (a.large && span < Math.PI) span += 2 * Math.PI;
    t1 = t0 + s * span;
    const n = Math.max(1, Math.ceil((span * a.r) / step));
    for (let k = 0; k <= n; k++) {
      const t = t0 + ((t1 - t0) * k) / n;
      pts.push({ x: a.cx + a.r * Math.cos(t), y: a.cy + a.r * Math.sin(t) });
    }
  }
  pointCache.set(c, pts);
  return pts;
}

export interface DielineSvgOptions {
  /** Labels on keep-outs and a title. Default true. */
  labels?: boolean;
  /** An image (artwork) drawn under the lines, covering the raster box (mm). */
  underlay?: { href: string; box: { x: number; y: number; width: number; height: number } };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

/**
 * The dieline of one side as SVG in mm (1 user unit = 1 mm; the origin at the trim's top-left, the
 * bleed at negative coordinates). Layers (`<g id>`): `CutContour` (trim + cutouts, magenta hairline:
 * the cut path), `bleed` (cyan), `safe` (green, dashed), `keep-outs` (red; blocking areas filled), and
 * `labels`.
 */
export function dielineSvg(d: CardDieline, side: Side, o: DielineSvgOptions = {}): string {
  const S = d.sides[side];
  const b = d.bleedMm;
  const vbW = d.width + 2 * b;
  const vbH = d.height + 2 * b;
  const hair = 0.1;
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fmt(vbW)}mm" height="${fmt(vbH)}mm" viewBox="${fmt(-b)} ${fmt(-b)} ${fmt(vbW)} ${fmt(vbH)}">`,
  );
  lines.push(`<title>Dieline, ${side} (mm; origin at the trim's top-left${side === "back" ? ", as seen from the back" : ""})</title>`);
  if (o.underlay) {
    const u = o.underlay;
    lines.push(
      `<image id="artwork" x="${fmt(u.box.x)}" y="${fmt(u.box.y)}" width="${fmt(u.box.width)}" height="${fmt(u.box.height)}" preserveAspectRatio="none" xlink:href="${esc(u.href)}" href="${esc(u.href)}"/>`,
    );
  }
  lines.push(
    `<g id="bleed" fill="none" stroke="#00a0e9" stroke-width="${hair}"><rect x="${fmt(-b)}" y="${fmt(-b)}" width="${fmt(vbW)}" height="${fmt(vbH)}"/></g>`,
  );
  lines.push(
    `<g id="safe" fill="none" stroke="#2fa84f" stroke-width="${hair}" stroke-dasharray="0.8 0.6"><path d="${roundedRectPath(d.safe.rect, d.safe.radius)}"/></g>`,
  );
  lines.push(`<g id="keep-outs" stroke="#e5262b" stroke-width="${hair}">`);
  for (const k of S.keepOuts) {
    const fill =
      k.rule === "block"
        ? ` fill="#e5262b" fill-opacity="0.18"`
        : k.rule === "avoid"
          ? ` fill="#e5262b" fill-opacity="0.07"`
          : ` fill="none" stroke-dasharray="0.5 0.5"`;
    const path = k.inner ? `${roundedRectPath(k.rect, k.radius)}${roundedRectPath(k.inner.rect, k.inner.radius)}` : roundedRectPath(k.rect, k.radius);
    if (k.clearance > 0) {
      const c = k.clearance;
      lines.push(
        `<path data-clearance="${fmt(c)}" fill="none" stroke-dasharray="0.4 0.4" d="${roundedRectPath({ x0: k.rect.x0 - c, x1: k.rect.x1 + c, y0: k.rect.y0 - c, y1: k.rect.y1 + c }, k.radius + c)}"/>`,
      );
    }
    lines.push(
      `<path id="${esc(k.id)}" data-kind="${k.kind}" data-rule="${k.rule}" fill-rule="evenodd"${fill} d="${path}"><title>${esc(`${k.label} (${k.source})`)}</title></path>`,
    );
  }
  lines.push(`</g>`);
  lines.push(`<g id="CutContour" fill="none" stroke="#ec008c" stroke-width="${hair}">`);
  lines.push(
    `<path id="trim" d="${S.trim.path}"><title>Trim: ${fmt(d.width)} × ${fmt(d.height)} mm, corner radius ${fmt(d.cornerRadiusMm)} mm${d.notch ? ", corner notch" : ""}</title></path>`,
  );
  for (const c of S.cutouts) lines.push(`<path id="cutout-${c.kind}" d="${c.path}"><title>Cutout: ${c.kind}</title></path>`);
  lines.push(`</g>`);
  if (o.labels !== false) {
    const size = 1.3;
    lines.push(`<g id="labels" font-family="Helvetica, Arial, sans-serif" font-size="${size}" fill="#e5262b">`);
    for (const k of S.keepOuts) {
      if (k.kind === "contact-area" || k.kind === "raised-free") continue;
      const x = k.kind === "antenna" ? k.rect.x0 + 3.5 : k.rect.x0 + 0.4;
      const y = k.kind === "antenna" ? k.rect.y0 + 1.6 : k.rect.y0 + size + 0.2;
      lines.push(`<text x="${fmt(x)}" y="${fmt(y)}">${esc(k.label)}</text>`);
    }
    lines.push(
      `<text x="0" y="${fmt(d.height + Math.min(b, 1.5) * 0.8)}" fill="#ec008c" font-size="${fmt(Math.min(size, Math.max(0.6, b * 0.6)))}">${esc(`${side} · trim ${fmt(d.width)} × ${fmt(d.height)} mm · R ${fmt(d.cornerRadiusMm)} · bleed ${fmt(b)} · safe ${fmt(d.safeMm)}`)}</text>`,
    );
    lines.push(`</g>`);
  }
  lines.push(`</svg>`);
  return lines.join("\n");
}
