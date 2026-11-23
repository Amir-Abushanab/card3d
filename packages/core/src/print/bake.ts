/**
 * Flat production artwork from a built card (`@card3d/core/print`): each face rendered face-on with an
 * orthographic camera at print resolution, unlit, with the bleed, plus one greyscale separation per
 * manufacturing process and the coverage of every placed element (text, logo, contactless mark,
 * stickers) for preflight checks and vector outlines.
 *
 * Every pass renders the card as built (the same meshes, layer order, depth and blending, the same
 * sticker and branding code), swapping only materials, so the rasters register exactly with each other
 * and with the dieline (`layout.ts`: mm from the trim's top-left, the back seen from the back).
 *
 * - Colour: the albedo a printer reproduces. The metal face is its base colour shaded by the surface
 *   texture's relief (brushed, guilloché, hammered… read as their pattern; a fixed light from the top
 *   left, no environment, no specular), face-shader skins and overlays as they look face-on (a static
 *   frame), artwork (at the full resolution of the original image when given), branding in its finish's
 *   colour, stickers through their own material patch. Holo foil, the chip module and add-ons are left
 *   out (the foil is a separation; the chip is inserted, not printed). Pixels outside the trim and in
 *   cutouts are filled from the nearest artwork pixel (the bleed). A clear card keeps its alpha: only
 *   the print is opaque.
 * - Separations (`PrintMaskId`): white = the process applies. Later layers knock out earlier ones
 *   (a sticker over an engraved name hides that part of the engraving).
 *
 * This module is the bake's policy and its CPU steps, without three.js: which item draws how in each
 * pass, the bleed fill, separations, coverage boxes and element placement. The passes are drawn by the
 * card engine (`bakePrint`: the engine's `print` part on an offscreen stage, `createOffscreenStage`).
 */
import type { CardDesign, MarkFinish, Side } from "../types.ts";
import { MM_PER_UNIT } from "../geometry/constants.ts";
import type { MmRect } from "../geometry/iso.ts";
import { frameForShape } from "../geometry/shape-frame.ts";
import { createCanvas } from "../geometry/canvas.ts";
import type { EnginePrintItem, EnginePrintJob } from "../../wasm/loader.js";
import { printShape } from "./dieline.ts";
import { printLayout, type PrintLayout } from "./layout.ts";

/** One greyscale separation per process (white = where it applies). */
export type PrintMaskId = "engrave" | "fill" | "etch" | "emboss" | "foil" | "spot-gloss" | "relief" | "white";

export const PRINT_MASKS: Readonly<Record<PrintMaskId, { label: string; process: string; description: string }>> = {
  engrave: { label: "Engrave / deboss", process: "laser engrave or deboss", description: "Marks with the engraved finish: cut into the card." },
  fill: {
    label: "Colour fill (engraved text)",
    process: "colour infill",
    description: "Engraved text and marks to fill with colour after engraving (the fill colour is in spec.json).",
  },
  etch: { label: "Etch", process: "laser etch / frost", description: "Marks with the etched finish: a shallow frosted mark with almost no depth." },
  emboss: { label: "Emboss", process: "emboss (raised)", description: "Marks with the embossed finish: raised out of the card." },
  foil: {
    label: "Foil / holographic",
    process: "foil stamping",
    description: "Where the holographic foil lies (knocked out under printed and placed elements).",
  },
  "spot-gloss": {
    label: "Spot gloss",
    process: "spot UV / gloss varnish",
    description: "Printed marks with the glossy branding finish (a clear gloss coat over the ink).",
  },
  relief: {
    label: "Surface texture",
    process: "surface finish (brushing, laser texturing)",
    description: "The surface texture's relief as greyscale (50 % = flat, lit from the top left), for reference.",
  },
  white: { label: "White underprint", process: "white ink under colour", description: "A clear card: where ink is printed (white backing under the colour)." },
};

export type PrintElementKind = "logo" | "name" | "bio" | "text" | "contactless" | "sticker";

/** A placed element and where it landed on its side's raster. */
export interface PrintElement {
  /** The mesh's name ("cardholder name", "text line 1", "sticker decal 0", …). */
  id: string;
  kind: PrintElementKind;
  side: Side;
  /** Branding finish; null for stickers (printed). */
  finish: MarkFinish | null;
  /** Coverage at print resolution (0–255), cropped to its box (px in the side's raster); null: nothing drawn. */
  coverage: { x: number; y: number; width: number; height: number; data: Uint8Array } | null;
  /** The coverage box, mm from the trim's top-left (the side's own view). */
  boxMm: MmRect | null;
  /** The placed plane (before any finish padding), mm, and the part of its image shown (crop). */
  plane: { widthMm: number; heightMm: number; uvWidth: number; uvHeight: number; imageWidth: number; imageHeight: number };
  /** Plane transform in the side's view: centre (mm), rotation (radians, clockwise on the page). */
  placement: { x: number; y: number; rotation: number };
}

export interface PrintRaster {
  width: number;
  height: number;
  /** 1: grey; 4: RGBA (sRGB, straight alpha). Top row first. */
  channels: 1 | 4;
  data: Uint8Array;
}

export interface PrintSideBake {
  side: Side;
  layout: PrintLayout;
  /** RGBA, sRGB. Alpha 255 everywhere except a clear card's unprinted areas. */
  color: PrintRaster;
  masks: Partial<Record<PrintMaskId, PrintRaster>>;
  elements: PrintElement[];
  /** What the side carries that a printer can't reproduce as rendered. */
  features: { foil: boolean; shaderSkin: boolean; shaderOverlays: number; addons: boolean; effects: boolean; clear: boolean };
}

/** An image the bake can draw (an `<img>`, a canvas, a bitmap). */
export type PrintImage = TexImageSource & { width: number; height: number };

export interface PrintBakeOptions {
  /** Default 600. */
  dpi?: number;
  /** Default 2. */
  bleedMm?: number;
  sides?: readonly Side[];
  /** Separations to make (default: all that apply). */
  masks?: readonly PrintMaskId[];
  /**
   * Full-resolution artwork images per side: the engine draws a copy of at most 1280 px
   * (`MAX_DESIGN_IMAGE_SIDE`); the print raster uses these instead when given.
   */
  artwork?: Partial<Record<Side, PrintImage>>;
  /** Keep the chip module in the colour artwork (a preview; it is inserted, not printed). Default false. */
  showChip?: boolean;
}

// ── the passes, whoever draws them ────────────────────────────────────────────

export type BakeRole = "base" | "artwork" | "foil" | "chip" | "chip-mask" | "glass" | "mark" | "sticker" | "overlay" | "addon" | "other";

/** A drawn item of the card, posed at the identity (three: a mesh; the engine: a renderer item). */
export interface BakeItem {
  /** three's mesh name: "card body", "front face", "back face", "front design", "logo", "cardholder name", "text line 1", "sticker decal 0", … */
  name: string;
  role: BakeRole;
  side: Side;
  kind?: PrintElementKind;
  /** A branding mark's finish. */
  finish?: MarkFinish;
  /** A face skin with a map (a face shader's painting). */
  hasMap: boolean;
  /** The plane as built (with any finish padding), card units; the padding (fraction of its glyph raster, each side). */
  plane: { width: number; height: number; padX: number; padY: number };
  /** The mark's glyph raster, else the map's image: its size (0 when none). */
  image: { width: number; height: number };
  /** The map's repeat (a sticker's crop). */
  uv: { width: number; height: number };
  /** World position and x axis (the card at the identity). */
  position: { x: number; y: number; z: number };
  xAxis: { x: number; y: number; z: number };
}

/**
 * How an item draws in a pass: hidden, as built, the metal face's flat print colour (`surface`: 0) or
 * its relief (1), unlit albedo (`artwork`: with the side's full-resolution artwork), or a mask value
 * where it draws.
 */
export type BakeChoice = "hide" | "keep" | { surface: 0 | 1 } | { albedo: true; artwork?: boolean } | { mask: number };

/** What draws the passes: the card's items, and a pass of them into a colour or mask target. */
export interface BakeRenderer {
  readonly items: readonly BakeItem[];
  /** The largest raster side the GPU renders. */
  readonly maxSize: number;
  /** Full-resolution artwork per side, at most `maxSide` px. */
  setArtwork(side: Side, image: PrintImage, maxSide: number): void;
  /**
   * RGBA, rows top first. Colour: the sRGB encoding of premultiplied linear colour over transparent;
   * mask: as written (red = the value × coverage).
   */
  render(target: "color" | "mask", side: Side, layout: PrintLayout, pick: (item: BakeItem) => BakeChoice): Promise<Uint8Array>;
  dispose(): void;
}

/**
 * Fill every pixel not fully covered from its nearest covered neighbour (breadth-first: cutouts and
 * gaps). With `edge` (a rounded rectangle, px), uncovered pixels outside it take the colour on its
 * outline straight out (radially at the corners), so the bleed extends the artwork without the
 * diagonal streaks of a nearest-pixel fill.
 */
export function fillUncovered(rgba: Uint8Array, width: number, height: number, edge?: { x0: number; y0: number; x1: number; y1: number; r: number }): void {
  const n = width * height;
  const src = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] === 255) {
      src[i] = i;
      queue[tail++] = i;
    }
  }
  if (!tail) return;
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % width;
    const y = (i - x) / width;
    const s = src[i]!;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if ((dx === 0 && dy === 0) || xx < 0 || xx >= width) continue;
        const j = yy * width + xx;
        if (src[j] !== -1) continue;
        src[j] = s;
        queue[tail++] = j;
      }
    }
  }
  if (edge) {
    const { x0, y0, x1, y1 } = edge;
    const r = Math.max(0, Math.min(edge.r, (x1 - x0) / 2, (y1 - y0) / 2));
    for (let y = 0; y < height; y++) {
      const py = y + 0.5;
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (rgba[i * 4 + 3] === 255) continue;
        const px = x + 0.5;
        const qx = Math.min(Math.max(px, x0 + r), x1 - r);
        const qy = Math.min(Math.max(py, y0 + r), y1 - r);
        const dx = px - qx;
        const dy = py - qy;
        const len = Math.hypot(dx, dy);
        if (len <= r) continue; // inside the rounded rectangle: a gap or cutout
        // On the outline, half a pixel in.
        const sx = Math.min(width - 1, Math.max(0, Math.floor(qx + (dx * (r - 0.5)) / len)));
        const sy = Math.min(height - 1, Math.max(0, Math.floor(qy + (dy * (r - 0.5)) / len)));
        const j = sy * width + sx;
        // Only from a covered pixel (a notch can cut the outline away: keep the nearest-pixel fill).
        if (rgba[j * 4 + 3] === 255) src[i] = j;
      }
    }
  }
  // The render is premultiplied in linear light and stored sRGB-encoded (blended over a transparent
  // clear): add the fill under it in linear light, then encode.
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3]!;
    if (a === 255) continue;
    const s = src[i]! * 4;
    const k = 1 - a / 255;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = encodeSrgb(SRGB_TO_LINEAR[rgba[i * 4 + c]!]! + SRGB_TO_LINEAR[rgba[s + c]!]! * k);
    rgba[i * 4 + 3] = 255;
  }
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
const encodeSrgb = (l: number) => Math.round(255 * Math.min(1, Math.max(0, l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055)));

/** Premultiplied → straight alpha (a clear card's print keeps its transparency). */
function unpremultiply(rgba: Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    if (a === 0 || a === 255) continue;
    for (let c = 0; c < 3; c++) rgba[i + c] = encodeSrgb((SRGB_TO_LINEAR[rgba[i + c]!]! * 255) / a);
  }
}

const red = (rgba: Uint8Array, w: number, h: number): PrintRaster => {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4]!;
  return { width: w, height: h, channels: 1, data: out };
};

const any = (r: PrintRaster) => r.data.some((v) => v > 127);

function cropCoverage(rgba: Uint8Array, w: number, h: number): PrintElement["coverage"] {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (rgba[(row + x) * 4]! > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const data = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) data[y * cw + x] = rgba[((y0 + y) * w + x0 + x) * 4]!;
  return { x: x0, y: y0, width: cw, height: ch, data };
}

/** The trim size of a design's card, mm (ID-1, landscape or portrait). */
export function printTrimMm(design: Pick<CardDesign, "shape" | "recipe" | "materialOverride">): { width: number; height: number } {
  const f = frameForShape(printShape(design));
  return { width: f.bodyWidth * MM_PER_UNIT, height: f.bodyHeight * MM_PER_UNIT };
}

/** The print raster's layout for `design` and the bake's options. */
export function bakeLayout(design: CardDesign, o: PrintBakeOptions = {}): PrintLayout {
  return printLayout(printTrimMm(design), o.dpi ?? 600, o.bleedMm ?? 2);
}

/**
 * Bakes the print rasters with `r` drawing the passes (the card posed at the identity): the policy every
 * renderer shares.
 */
export async function runBake(r: BakeRenderer, design: CardDesign, o: PrintBakeOptions = {}): Promise<PrintSideBake[]> {
  const layout = bakeLayout(design, o);
  const max = r.maxSize;
  if (layout.width > max || layout.height > max)
    throw new Error(`${layout.width} × ${layout.height} px is more than this GPU can render (${max}); choose a lower resolution`);
  const wanted = new Set<PrintMaskId>(o.masks ?? (Object.keys(PRINT_MASKS) as PrintMaskId[]));
  const out: PrintSideBake[] = [];
  const items = r.items;
  const cornerMm = frameForShape(printShape(design)).cornerRadius * MM_PER_UNIT;
  const glass = items.some((i) => i.role === "glass");
  // Full-resolution artwork in place of the engine's ≤ 1280 px copy.
  for (const side of ["front", "back"] as const) {
    const img = o.artwork?.[side];
    if (img) r.setArtwork(side, img, Math.min(max, Math.ceil(layout.trim.width * 1.05)));
  }
  for (const side of o.sides ?? (["front", "back"] as const)) {
    const here = items.filter((i) => i.side === side);
    const { width: W, height: H } = layout;

    // Colour.
    const faceSkin = items.some((i) => i.name === `${side} face`);
    // Layers of the other face never show (a clear card would show them mirrored through the slab).
    const away = (item: BakeItem) =>
      item.side !== side && (item.role === "mark" || item.role === "sticker" || item.role === "artwork" || item.role === "overlay");
    const color = await r.render("color", side, layout, (item) => {
      if (away(item)) return "hide";
      switch (item.role) {
        case "base":
          // The face skin is the print; the body under it (its bevel and walls: an edge colour is a
          // spec value, not print) would leave a seam round the edge: the bleed fill covers it instead.
          if (item.name === "card body" && faceSkin) return "hide";
          return { surface: 0 };
        case "artwork":
          return { albedo: true, artwork: true };
        case "foil":
        case "addon":
        case "glass":
          return "hide";
        case "chip":
          return o.showChip ? { albedo: true } : "hide";
        case "chip-mask":
        case "overlay":
          return "keep";
        default:
          return { albedo: true };
      }
    });
    if (glass) unpremultiply(color);
    else {
      // Bleed: outside the trim, continue the artwork straight out from its edge (radially at the
      // corners) from 0.3 mm inside it; cutouts and anything else uncovered from the nearest pixel.
      const inset = 0.3 * layout.pxPerMm;
      fillUncovered(color, W, H, {
        x0: layout.trim.x + inset,
        y0: layout.trim.y + inset,
        x1: layout.trim.x + layout.trim.width - inset,
        y1: layout.trim.y + layout.trim.height - inset,
        r: Math.max(0, cornerMm * layout.pxPerMm - inset),
      });
    }

    // Separations.
    const masks: Partial<Record<PrintMaskId, PrintRaster>> = {};
    const membersOf = (id: PrintMaskId): ((i: BakeItem) => boolean) | null => {
      switch (id) {
        case "engrave":
          return (i) => i.role === "mark" && i.finish === "engraved";
        case "fill":
          return (i) => i.role === "mark" && i.finish === "engraved" && (i.kind === "name" || i.kind === "bio" || i.kind === "text");
        case "etch":
          return (i) => i.role === "mark" && i.finish === "etched";
        case "emboss":
          return (i) => i.role === "mark" && i.finish === "embossed";
        case "spot-gloss":
          return (i) => i.role === "mark" && i.finish === "default";
        case "foil":
          return (i) => i.role === "foil";
        default:
          return null;
      }
    };
    for (const id of Object.keys(PRINT_MASKS) as PrintMaskId[]) {
      if (!wanted.has(id)) continue;
      if (id === "white") {
        if (!glass) continue;
        const m: PrintRaster = { width: W, height: H, channels: 1, data: new Uint8Array(W * H) };
        for (let i = 0; i < m.data.length; i++) m.data[i] = color[i * 4 + 3]!;
        if (any(m)) masks.white = m;
        continue;
      }
      if (id === "relief") {
        const tex = design.recipe.texture;
        if (glass || ((!tex || tex === "none") && (!design.recipe.pattern || design.recipe.pattern === "none"))) continue;
        const px = await r.render("mask", side, layout, (item) => (item.role === "base" ? { surface: 1 } : "hide"));
        masks.relief = red(px, W, H);
        continue;
      }
      const member = membersOf(id);
      if (!member || !here.some(member)) continue;
      const px = await r.render("mask", side, layout, (item) => {
        if (item.role === "chip-mask") return "keep";
        if (away(item)) return "hide";
        if (item.role === "chip" || item.role === "addon" || item.role === "overlay" || item.role === "glass") return "hide";
        if (item.role === "foil" && id !== "foil") return "hide";
        return { mask: member(item) ? 1 : 0 };
      });
      const m = red(px, W, H);
      if (any(m)) masks[id] = m;
    }

    // Each placed element alone: where it lands, for preflight and vector outlines.
    const elements: PrintElement[] = [];
    for (const item of here) {
      if (item.role !== "mark" && item.role !== "sticker") continue;
      const px = await r.render("mask", side, layout, (other) => (other === item ? { mask: 1 } : "hide"));
      elements.push(elementInfo(item, cropCoverage(px, W, H), layout, side));
    }
    out.push({
      side,
      layout,
      color: { width: W, height: H, channels: 4, data: color },
      masks,
      elements,
      features: {
        foil: here.some((i) => i.role === "foil"),
        shaderSkin: items.some((i) => i.name === `${side} face` && i.hasMap),
        shaderOverlays: here.filter((i) => i.role === "overlay").length,
        addons: items.some((i) => i.role === "addon"),
        effects: here.some((i) => i.role === "other"),
        clear: glass,
      },
    });
  }
  return out;
}

function elementInfo(item: BakeItem, coverage: PrintElement["coverage"], L: PrintLayout, side: Side): PrintElement {
  const { width: pw, height: ph, padX, padY } = item.plane;
  const p = item.position;
  const ax = item.xAxis;
  // The plane's x axis on the page (y down); the back is seen mirrored.
  const mirror = side === "back";
  const angle = Math.atan2(-ax.y, mirror ? -ax.x : ax.x);
  const cx = p.x * MM_PER_UNIT + L.trimMm.width / 2;
  const toBox = (c: NonNullable<PrintElement["coverage"]>): MmRect => ({
    x0: (c.x - L.trim.x) / L.pxPerMm,
    x1: (c.x + c.width - L.trim.x) / L.pxPerMm,
    y0: (c.y - L.trim.y) / L.pxPerMm,
    y1: (c.y + c.height - L.trim.y) / L.pxPerMm,
  });
  return {
    id: item.name,
    kind: item.kind ?? "text",
    side,
    finish: item.role === "mark" ? (item.finish ?? "default") : null,
    coverage,
    boxMm: coverage ? toBox(coverage) : null,
    plane: {
      widthMm: (pw / (1 + 2 * padX)) * MM_PER_UNIT,
      heightMm: (ph / (1 + 2 * padY)) * MM_PER_UNIT,
      uvWidth: item.role === "sticker" ? item.uv.width : 1,
      uvHeight: item.role === "sticker" ? item.uv.height : 1,
      imageWidth: item.image.width,
      imageHeight: item.image.height,
    },
    placement: { x: mirror ? L.trimMm.width - cx : cx, y: L.trimMm.height / 2 - p.y * MM_PER_UNIT, rotation: angle },
  };
}

// ── on the card engine ────────────────────────────────────────────────────────

/** What builds a design for a print bake on the engine (`OffscreenStage` of `@card3d/core/engine`). */
export interface PrintJobSource {
  printJob(design: CardDesign): Promise<EnginePrintJob>;
}

const ROLES: readonly BakeRole[] = ["other", "base", "base", "artwork", "foil", "chip", "chip-mask", "glass", "mark", "sticker", "overlay", "addon"];
const MARK_KINDS: readonly (PrintElementKind | undefined)[] = [undefined, "logo", "name", "bio", "text", "contactless"];
const MARK_NAMES: readonly string[] = ["", "logo", "cardholder name", "cardholder bio", "text line", "contactless mark"];
const FINISHES: readonly MarkFinish[] = ["default", "embossed", "engraved", "etched"];

/** three's mesh name and the bake's view of an engine item. */
function engineItem(e: EnginePrintItem): BakeItem {
  const role = ROLES[e.role] ?? "other";
  const side: Side = e.side ? "back" : "front";
  let name = "";
  let kind: PrintElementKind | undefined;
  if (e.role === 1) name = "card body";
  else if (e.role === 2) name = e.kind ? "back face" : "front face";
  else if (e.role === 3) name = `${side} design`;
  else if (role === "mark") {
    kind = MARK_KINDS[e.kind] ?? "text";
    name = e.kind === 4 ? `text line ${e.n}` : (MARK_NAMES[e.kind] ?? "text line");
  } else if (role === "sticker") {
    kind = "sticker";
    name = `sticker decal ${e.n}`;
  }
  return {
    name,
    role,
    side,
    kind,
    finish: role === "mark" ? (FINISHES[e.finish] ?? "default") : undefined,
    hasMap: e.map,
    plane: { width: e.plane[0], height: e.plane[1], padX: e.pad[0], padY: e.pad[1] },
    image: { width: e.image[0], height: e.image[1] },
    uv: { width: e.uv[0], height: e.uv[1] },
    position: { x: e.pos[0], y: e.pos[1], z: e.pos[2] },
    xAxis: { x: e.axis[0], y: e.axis[1], z: e.axis[2] },
  };
}

/** `print.rs` choice codes. */
const HIDE = 0;
const KEEP = 1;
const SURFACE = 2;
const RELIEF = 3;
const ALBEDO = 4;
const ARTWORK = 5;
const MASK = 6;

/** The engine's print job as a bake renderer. */
function engineRenderer(job: EnginePrintJob): BakeRenderer {
  const list = job.items().map(engineItem);
  return {
    // three's scene graph lists the stickers before the branding (the elements' order).
    items: [...list.filter((i) => i.role === "sticker"), ...list.filter((i) => i.role !== "sticker")],
    maxSize: job.maxSize(),
    setArtwork(side, img, maxSide) {
      const w = (img as HTMLImageElement).naturalWidth || img.width;
      const h = (img as HTMLImageElement).naturalHeight || img.height;
      const k = Math.min(1, maxSide / Math.max(w, h, 1));
      const cw = Math.max(1, Math.round(w * k));
      const ch = Math.max(1, Math.round(h * k));
      const c = createCanvas(cw, ch);
      const g = c?.getContext("2d") as CanvasRenderingContext2D | null | undefined;
      if (!g) return;
      g.imageSmoothingQuality = "high";
      g.drawImage(img as CanvasImageSource, 0, 0, cw, ch);
      job.setArtwork(side === "back", g.getImageData(0, 0, cw, ch));
    },
    async render(target, side, layout, pick) {
      const spec = new Float32Array(6 + 2 * list.length);
      spec.set([
        side === "back" ? 1 : 0,
        target === "mask" ? 1 : 0,
        layout.width,
        layout.height,
        layout.width / layout.pxPerMm / 2 / MM_PER_UNIT,
        layout.height / layout.pxPerMm / 2 / MM_PER_UNIT,
      ]);
      list.forEach((item, k) => {
        const c = pick(item);
        let code = HIDE;
        let value = 0;
        if (c === "keep") code = KEEP;
        else if (c === "hide") code = HIDE;
        else if ("surface" in c) code = c.surface ? RELIEF : SURFACE;
        else if ("albedo" in c) code = c.artwork ? ARTWORK : ALBEDO;
        else {
          code = MASK;
          value = c.mask;
        }
        spec[6 + 2 * k] = code;
        spec[7 + 2 * k] = value;
      });
      const px = await job.render(spec);
      if (px.length !== layout.width * layout.height * 4) throw new Error("the card engine couldn't render the print pass");
      return px;
    },
    dispose: () => job.free(),
  };
}

/**
 * Bakes the print rasters of `design` on the card engine (`stage`: an offscreen stage of
 * `@card3d/core`, which builds the design for the bake on its GPU). A custom GLSL face layer is left
 * out, as on screen.
 */
export async function bakePrint(stage: PrintJobSource, design: CardDesign, o: PrintBakeOptions = {}): Promise<PrintSideBake[]> {
  const r = engineRenderer(await stage.printJob(design));
  try {
    return await runBake(r, design, o);
  } finally {
    r.dispose();
  }
}
