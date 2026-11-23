/**
 * Export → Print files…: the production package of a design.
 *
 * 1. The printed design: in non-payment mode (with "leave out"), payment-card features are removed.
 * 2. The flat bake (`@card3d/core/print` `bakePrint`, on the studio's export stage): per side a colour
 *    composite and greyscale separations at the print resolution with bleed, plus each element's coverage.
 * 3. Preflight: design rules, element geometry against the dieline, image resolution.
 * 4. Files: composites, plates (1-bit PNG + traced SVG each; Cut, Keepout from the dieline), dielines,
 *    outlined text, exact vectors (logo path, contactless mark), proofs, the master and proof PDFs,
 *    spec.json, fonts with licences, README, vendor derivatives — zipped.
 */
import { getCardFont, googleFontsCssUrl, DEFAULT_CARD_FONT, type AssetProvider, type CardDesign, type Side } from "@card3d/core/model";
import {
  cardDieline,
  dielineSvg,
  drawLogoCanvas,
  drawUserLogoCanvas,
  printTrimMm,
  rasterBoxMm,
  roundedRectPath,
  CONTACTLESS_ASPECT,
  CONTACTLESS_GEOMETRY,
  PRINT_MASKS,
  type CardDieline,
  type PrintBakeOptions,
  type PrintElement,
  type PrintLayout,
  type PrintMaskId,
  type PrintRaster,
  type PrintSideBake,
} from "@card3d/core/print";
import { zipSync, strToU8 } from "fflate";
import { encodePng } from "./png.ts";
import { loopsToPath, traceLoops } from "./trace.ts";
import { cmykFor, dominantColors } from "./color.ts";
import {
  blocking,
  preflightDesign,
  preflightGeometry,
  preflightImages,
  printDesign,
  type PlacedImage,
  type PreflightIssue,
  type PrintOptions,
  type StripNote,
} from "./preflight.ts";
import { buildPrintSpec, designColors, designFonts, PRINT_SPEC_FORMAT, type FontEntry, type PlateFile } from "./spec.ts";
import { getPreset, type PrintDerivative, type PrintPreset } from "./vendors.ts";
import type { LookalikeFeatures } from "./lookalike.ts";
import interOfl from "@card3d/core/assets/fonts/licenses/inter-OFL.txt?url";
import manropeOfl from "@card3d/core/assets/fonts/licenses/manrope-OFL.txt?url";
import spaceGroteskOfl from "@card3d/core/assets/fonts/licenses/space-grotesk-OFL.txt?url";
import unboundedOfl from "@card3d/core/assets/fonts/licenses/unbounded-OFL.txt?url";
import playfairOfl from "@card3d/core/assets/fonts/licenses/playfair-display-OFL.txt?url";
import plexMonoOfl from "@card3d/core/assets/fonts/licenses/ibm-plex-mono-OFL.txt?url";

const LICENCES: Record<string, string> = {
  inter: interOfl,
  manrope: manropeOfl,
  "space-grotesk": spaceGroteskOfl,
  unbounded: unboundedOfl,
  playfair: playfairOfl,
  "plex-mono": plexMonoOfl,
};

export interface PrintDeps {
  /** Build `design` on an offscreen stage and bake it (`bakePrint`). */
  bake(design: CardDesign, o: PrintBakeOptions): Promise<PrintSideBake[]>;
  assets: AssetProvider;
  /** File name stem, e.g. "ada-lovelace". */
  fileBase: string;
  onProgress?(fraction: number, label: string): void;
  signal?: AbortSignal;
}

export interface PrintAnalysis {
  options: PrintOptions;
  preset: PrintPreset;
  design: CardDesign;
  stripped: StripNote[];
  dieline: CardDieline;
  bake: PrintSideBake[];
  issues: PreflightIssue[];
  lookalike: { score: number; lookalike: boolean; features: LookalikeFeatures };
  blocked: boolean;
}

/** Plate names (spot layers) of the separations. */
const PLATE_NAME: Record<PrintMaskId, string> = {
  engrave: "Engrave",
  fill: "ColorFill",
  etch: "Etch",
  emboss: "Emboss",
  foil: "Foil-Holographic",
  "spot-gloss": "SpotUV",
  relief: "Surface",
  white: "White",
};

/** Preview colours of the spots in the master PDF (CMYK 0–1): any distinct, light colour does. */
const PLATE_CMYK: Record<string, [number, number, number, number]> = {
  Engrave: [0, 0, 0, 0.6],
  Etch: [0, 0, 0, 0.35],
  Emboss: [0.25, 0, 0, 0.1],
  "Foil-Holographic": [0, 0.06, 0.25, 0.04],
  SpotUV: [0.15, 0, 0, 0],
  White: [0, 0, 0, 0.05],
  Window: [0.1, 0, 0.03, 0],
};

const mmToPxFn =
  (L: PrintLayout) =>
  (x: number, y: number): [number, number] => [(x - L.trim.x) / L.pxPerMm, (y - L.trim.y) / L.pxPerMm];

async function loadImageEl(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Full-resolution artwork images per side (the engine draws a ≤ 1280 px copy). */
async function artworkImages(design: CardDesign, assets: AssetProvider): Promise<Partial<Record<Side, HTMLImageElement>>> {
  const out: Partial<Record<Side, HTMLImageElement>> = {};
  for (const side of ["front", "back"] as const) {
    const src = design.surfaceSources[side];
    if (!src) continue;
    const img = await loadImageEl(assets.resolveUrl(src));
    if (img) out[side] = img;
  }
  return out;
}

/** Placed uploads and their printed size, for the resolution check. */
async function placedImages(
  design: CardDesign,
  bake: PrintSideBake[],
  art: Partial<Record<Side, HTMLImageElement>>,
  assets: AssetProvider,
): Promise<PlacedImage[]> {
  const trim = printTrimMm(design);
  const out: PlacedImage[] = [];
  for (const side of ["front", "back"] as const) {
    const img = art[side];
    if (img)
      out.push({
        label: `${side === "front" ? "Front" : "Back"} artwork`,
        width: img.naturalWidth,
        height: img.naturalHeight,
        widthMm: trim.width,
        heightMm: trim.height,
      });
  }
  for (const s of bake)
    for (const e of s.elements) {
      if (e.kind === "sticker" && e.plane.imageWidth)
        out.push({
          label: `Sticker ${e.id.replace(/\D+/g, "")} (${s.side})`,
          width: Math.round(e.plane.imageWidth * e.plane.uvWidth),
          height: Math.round(e.plane.imageHeight * e.plane.uvHeight),
          widthMm: e.plane.widthMm,
          heightMm: e.plane.heightMm,
        });
    }
  const logo = design.logo;
  if (logo?.src && !logo.path) {
    const img = await loadImageEl(assets.resolveUrl(logo.src));
    const el = bake.find((s) => s.side === "front")?.elements.find((e) => e.kind === "logo");
    if (img && el)
      out.push({ label: "Logo (image)", width: img.naturalWidth, height: img.naturalHeight, widthMm: el.plane.widthMm, heightMm: el.plane.heightMm });
  }
  return out;
}

function printDieline(design: CardDesign, o: PrintOptions, preset: PrintPreset): CardDieline {
  return cardDieline(design, {
    bleedMm: o.bleedMm,
    safeMm: o.safeMm,
    magstripe: o.magstripe,
    chipClearanceMm: preset.chipClearanceMm,
    panelClearanceMm: preset.panelClearanceMm,
    signaturePanel: o.mode === "payment" ? preset.signaturePanel : null,
    hologram: o.mode === "payment" ? preset.hologram : null,
    networkMark: o.mode === "payment" ? preset.networkMark : null,
    embossingAreas: o.mode === "payment",
    source: preset.name,
  });
}

/** Bake (at `dpi`, a preview by default) and preflight. */
export async function analysePrint(
  design: CardDesign,
  o: PrintOptions,
  deps: PrintDeps,
  dpi = o.dpi,
  art?: Partial<Record<Side, HTMLImageElement>>,
): Promise<PrintAnalysis> {
  const preset = getPreset(o.presetId);
  const pre = preflightDesign(design, o, preset);
  const { design: printed, stripped } = printDesign(design, o);
  const dieline = printDieline(printed, o, preset);
  const images = art ?? (await artworkImages(printed, deps.assets));
  const bake = await deps.bake(printed, { dpi, bleedMm: o.bleedMm, artwork: images });
  const geo = preflightGeometry(bake, dieline, o, preset, printed);
  const res = preflightImages(await placedImages(printed, bake, images, deps.assets), o, preset);
  const issues = [...pre.issues, ...geo, ...res];
  const order = { error: 0, warning: 1, info: 2 } as const;
  issues.sort((a, b) => +b.blocking - +a.blocking || order[a.level] - order[b.level]);
  return { options: o, preset, design: printed, stripped, dieline, bake, issues, lookalike: pre.lookalike, blocked: blocking(issues) };
}

// ── rasters ─────────────────────────────────────────────────────────────────

function rasterCanvas(r: PrintRaster): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = r.width;
  c.height = r.height;
  const g = c.getContext("2d")!;
  const img = g.createImageData(r.width, r.height);
  if (r.channels === 4) img.data.set(r.data);
  else
    for (let i = 0; i < r.width * r.height; i++) {
      const v = r.data[i]!;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}

/** Draw `src` (a canvas) region (px) into a new w × h canvas. */
function resample(src: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number, w: number, h: number, background?: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, w, h);
  }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return c;
}

const canvasRgba = (c: HTMLCanvasElement) => new Uint8Array(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.buffer);

function canvasJpeg(c: HTMLCanvasElement, q = 0.88): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error("JPEG encoding failed"))), "image/jpeg", q),
  );
}

/** Fill a dieline path (mm) into a raster the size of the layout: 255 inside (even-odd). */
function rasterizePath(L: PrintLayout, paths: string[]): Uint8Array {
  const c = document.createElement("canvas");
  c.width = L.width;
  c.height = L.height;
  const g = c.getContext("2d")!;
  g.setTransform(L.pxPerMm, 0, 0, L.pxPerMm, L.trim.x, L.trim.y);
  g.fillStyle = "#fff";
  const p = new Path2D();
  for (const d of paths) p.addPath(new Path2D(d));
  g.fill(p, "evenodd");
  const rgba = g.getImageData(0, 0, c.width, c.height).data;
  const out = new Uint8Array(L.width * L.height);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4]!;
  return out;
}

const rgbOf = (r: PrintRaster): { width: number; height: number; channels: 3; data: Uint8Array } => {
  const out = new Uint8Array(r.width * r.height * 3);
  for (let i = 0, j = 0; i < r.width * r.height; i++) {
    out[j++] = r.data[i * 4]!;
    out[j++] = r.data[i * 4 + 1]!;
    out[j++] = r.data[i * 4 + 2]!;
  }
  return { width: r.width, height: r.height, channels: 3, data: out };
};

const fmt = (v: number) => {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

function svgDoc(L: PrintLayout, title: string, body: string): string {
  const b = rasterBoxMm(L);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(b.width)}mm" height="${fmt(b.height)}mm" viewBox="${fmt(b.x)} ${fmt(b.y)} ${fmt(b.width)} ${fmt(b.height)}">`,
    `<title>${title.replace(/[&<>]/g, "")}</title>`,
    body,
    `</svg>`,
  ].join("\n");
}

/** A mask traced to an SVG path (mm from the trim's top-left). */
function tracedPath(L: PrintLayout, data: Uint8Array, crop?: { x: number; y: number; width: number; height: number }): string {
  const w = crop?.width ?? L.width;
  const h = crop?.height ?? L.height;
  const ox = crop?.x ?? 0;
  const oy = crop?.y ?? 0;
  const loops = traceLoops({ width: w, height: h, data }, 128, 0.25);
  const m = mmToPxFn(L);
  return loopsToPath(loops, (x, y) => m(x + ox, y + oy).map((v) => v) as [number, number]).replace(/NaN/g, "0");
}

// ── fonts ───────────────────────────────────────────────────────────────────

const baseName = (url: string) => decodeURIComponent(url.split("?")[0]!.split("/").pop() ?? "font");

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(url, { credentials: "omit" });
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function collectFonts(design: CardDesign, o: PrintOptions, files: Record<string, Uint8Array>, dir: string): Promise<FontEntry[]> {
  const out: FontEntry[] = [];
  for (const f of designFonts(design)) {
    const font = f.font;
    if (typeof font === "string") {
      const cf = getCardFont(font) ?? getCardFont(DEFAULT_CARD_FONT)!;
      const names: string[] = [];
      for (const file of cf.files) {
        const bytes = await fetchBytes(file.url);
        if (!bytes) continue;
        const n = `${dir}fonts/${baseName(file.url).replace(/-[\w]{8}\.woff2$/, ".woff2")}`;
        files[n] = bytes;
        names.push(n);
      }
      const lic = LICENCES[cf.id];
      if (lic) {
        const bytes = await fetchBytes(lic);
        if (bytes) {
          const n = `${dir}fonts/${cf.id}-OFL.txt`;
          files[n] = bytes;
          names.push(n);
        }
      }
      out.push({
        roles: f.roles,
        family: cf.label,
        source: "catalog",
        id: cf.id,
        weight: cf.weight === "100 900" ? 700 : Number(cf.weight),
        licence: "SIL Open Font License 1.1",
        licenceConfirmed: true,
        files: names,
        note: cf.source,
      });
      continue;
    }
    const names: string[] = [];
    const weight = font.weight ?? 700;
    if (font.source === "upload" && font.src) {
      const m = /^data:font\/(woff2|woff|ttf|otf);base64,(.*)$/.exec(font.src);
      if (m) {
        const bin = atob(m[2]!);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const n = `${dir}fonts/${font.family.replace(/[^\w-]+/g, "-")}.${m[1]}`;
        files[n] = bytes;
        names.push(n);
      }
    } else if (font.source === "url" && font.src) {
      const bytes = await fetchBytes(font.src);
      if (bytes) {
        const n = `${dir}fonts/${baseName(font.src)}`;
        files[n] = bytes;
        names.push(n);
      }
    } else if (font.source === "google") {
      try {
        const css = await (await fetch(googleFontsCssUrl(font.family, weight), { credentials: "omit" })).text();
        let k = 0;
        for (const m of css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)) {
          const bytes = await fetchBytes(m[1]!);
          if (!bytes) continue;
          const n = `${dir}fonts/${font.family.replace(/[^\w-]+/g, "-")}-${weight}-${k++}.${m[1]!.split(".").pop()}`;
          files[n] = bytes;
          names.push(n);
        }
      } catch {
        /* offline: named only */
      }
    }
    out.push({
      roles: f.roles,
      family: font.family,
      source: font.source,
      weight,
      licence: font.source === "google" ? "Google Fonts (most families: SIL Open Font License; check the family's)" : "user-supplied",
      licenceConfirmed: font.source === "google" ? null : o.fontRights,
      files: names,
      ...(names.length ? {} : { note: "font file not included: supply it to the printer, or use the outlined text (…-text.svg)" }),
    });
  }
  return out;
}

// ── package ─────────────────────────────────────────────────────────────────

export interface PrintPackage {
  name: string;
  zip: Uint8Array<ArrayBuffer>;
  files: Record<string, Uint8Array>;
  spec: Record<string, unknown>;
  analysis: PrintAnalysis;
}

const TEXT_KINDS = new Set<PrintElement["kind"]>(["name", "bio", "text", "logo", "contactless"]);

export async function buildPrintPackage(design: CardDesign, o: PrintOptions, deps: PrintDeps): Promise<PrintPackage> {
  const step = (f: number, label: string) => {
    if (deps.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    deps.onProgress?.(f, label);
  };
  step(0.02, "Preparing");
  const preset = getPreset(o.presetId);
  const art = await artworkImages(printDesign(design, o).design, deps.assets);
  step(0.08, `Rendering at ${o.dpi} dpi`);
  const a = await analysePrint(design, o, deps, o.dpi, art);
  if (a.blocked) throw new Error(`Preflight blocks the export: ${a.issues.find((i) => i.blocking)!.message}`);
  const base = deps.fileBase || "card";
  const dir = `${base}-print/`;
  const files: Record<string, Uint8Array> = {};
  const name = (side: Side, what: string, ext: string) => `${dir}${base}-${side}-${what}.${ext}`;
  const plates: PlateFile[] = [];
  const dielineFiles: Partial<Record<Side, string>> = {};
  const proofs: string[] = [];
  const pdfSides: import("./pdf.ts").PdfSide[] = [];
  const proofSides: import("./pdf.ts").ProofSide[] = [];
  const proofPlates: import("./pdf.ts").ProofPlate[] = [];
  const colors = designColors(a.design, preset.blackK100);
  const fillHex = (colors.find((c) => c.role === "engraved fill")?.hex ?? "#000000").replace("#", "").toUpperCase();
  const invert = true; // masks: black = the effect, white elsewhere
  const bits = o.maskBits;
  const sidesSpec = [];
  let k = 0;
  for (const s of a.bake) {
    const L = s.layout;
    const D = a.dieline.sides[s.side];
    step(0.15 + 0.5 * (k++ / a.bake.length), `Writing the ${s.side}`);
    // Composite.
    const composite = name(s.side, "composite", "png");
    files[composite] = encodePng(s.features.clear ? { ...s.color, channels: 4 } : rgbOf(s.color), { dpi: o.dpi });
    const layerPlates: import("./pdf.ts").PdfPlate[] = [];
    const masks: Partial<Record<PrintMaskId | "window", PrintRaster>> = { ...s.masks };
    if (s.features.clear && s.masks.white) {
      // Window: inside the trim, where nothing is printed.
      const inside = rasterizePath(L, [D.trim.path, ...D.cutouts.map((c) => c.path)]);
      const w = new Uint8Array(L.width * L.height);
      for (let i = 0; i < w.length; i++) w[i] = inside[i]! > 127 && s.masks.white.data[i]! < 128 ? 255 : 0;
      masks.window = { width: L.width, height: L.height, channels: 1, data: w };
    }
    for (const [id, r] of Object.entries(masks) as Array<[PrintMaskId | "window", PrintRaster]>) {
      if (!r) continue;
      const plateName = id === "window" ? "Window" : id === "fill" ? `ColorFill-${fillHex}` : PLATE_NAME[id];
      const slug = plateName.toLowerCase();
      const png = name(s.side, slug, "png");
      const relief = id === "relief";
      files[png] = encodePng(
        { width: r.width, height: r.height, channels: 1, data: r.data },
        { dpi: o.dpi, bits: relief ? 8 : bits, invert: !relief && invert },
      );
      const info =
        id === "window"
          ? {
              label: "Window",
              process: "no ink, no white (stays clear)",
              description: "A clear card: inside the trim where nothing is printed (it stays transparent).",
            }
          : PRINT_MASKS[id];
      const pf: PlateFile = {
        side: s.side,
        name: plateName,
        kind: id === "window" ? "white" : id,
        files: [png],
        process: info.process,
        description: info.description,
        bits: relief ? 8 : bits,
        polarity: relief ? "greyscale" : "black = effect",
      };
      if (id === "fill") pf.color = { hex: `#${fillHex.toLowerCase()}`, cmyk: cmykFor(`#${fillHex}`, { text: true, blackK100: preset.blackK100 }), pms: null };
      if (!relief) {
        const d = tracedPath(L, r.data);
        const svg = name(s.side, slug, "svg");
        files[svg] = strToU8(
          svgDoc(
            L,
            `${plateName} (${s.side}): traced from the ${o.dpi} dpi mask; mm from the trim's top-left`,
            `<g id="${plateName}"><path fill="#000" fill-rule="evenodd" d="${d}"/></g>`,
          ),
        );
        pf.files.push(svg);
        const cm =
          id === "fill"
            ? ((c) => (c ? ([c.c / 100, c.m / 100, c.y / 100, c.k / 100] as [number, number, number, number]) : [0, 0, 0, 1]))(pf.color!.cmyk)
            : (PLATE_CMYK[plateName] ?? [0, 0, 0, 0.5]);
        layerPlates.push({ name: plateName, cmyk: cm as [number, number, number, number], path: d });
        const thumb = resample(
          rasterCanvas({ ...r, data: r.data.map((v) => 255 - v) }),
          0,
          0,
          r.width,
          r.height,
          360,
          Math.round((360 * r.height) / r.width),
          "#fff",
        );
        proofPlates.push({ side: s.side, name: plateName, description: info.description, jpeg: await canvasJpeg(thumb), aspect: r.width / r.height });
      }
      plates.push(pf);
    }
    // Cut: the card's material (black), from the dieline; its SVG is the cut path.
    const cutPaths = [D.trim.path, ...D.cutouts.map((c) => c.path)];
    const cutPng = name(s.side, "cut", "png");
    files[cutPng] = encodePng({ width: L.width, height: L.height, channels: 1, data: rasterizePath(L, cutPaths) }, { dpi: o.dpi, bits, invert });
    const cutSvg = name(s.side, "cut", "svg");
    files[cutSvg] = strToU8(
      svgDoc(
        L,
        `Cut (${s.side}): trim and cutouts, mm`,
        `<g id="CutContour" fill="none" stroke="#ec008c" stroke-width="0.1">${cutPaths.map((d, i) => `<path id="${i ? `cutout-${D.cutouts[i - 1]!.kind}` : "trim"}" d="${d}"/>`).join("")}</g>`,
      ),
    );
    plates.push({
      side: s.side,
      name: "Cut",
      kind: "cut",
      files: [cutSvg, cutPng],
      process: "die cut / laser cut",
      description: "Trim (ISO/IEC 7810 corners) and cutouts. PNG: the card's material in black.",
      bits,
      polarity: "black = effect",
    });
    // Keep-outs (non-printing guides).
    const keepPaths = D.keepOuts
      .filter((x) => x.rule !== "info")
      .map((x) => (x.inner ? `${roundedRectPath(x.rect, x.radius)}${roundedRectPath(x.inner.rect, x.inner.radius)}` : roundedRectPath(x.rect, x.radius)));
    if (keepPaths.length) {
      const kp = name(s.side, "keepout", "png");
      files[kp] = encodePng({ width: L.width, height: L.height, channels: 1, data: rasterizePath(L, keepPaths) }, { dpi: o.dpi, bits, invert });
      plates.push({
        side: s.side,
        name: "Keepout",
        kind: "keepout",
        files: [kp],
        process: "none (guides)",
        description: "Areas to keep clear (chip, antenna zone, stripe…): non-printing. Labelled in the dieline SVG.",
        bits,
        polarity: "black = effect",
      });
    }
    const dl = `${dir}${base}-${s.side}-dieline.svg`;
    files[dl] = strToU8(dielineSvg(a.dieline, s.side));
    dielineFiles[s.side] = dl;

    // Outlined text and marks (traced), and exact vectors where the source is vector.
    const marks = s.elements.filter((e) => TEXT_KINDS.has(e.kind) && e.coverage);
    if (marks.length) {
      const groups = marks.map((e) => {
        const c = e.coverage!;
        return `<g id="${e.id.replace(/\s+/g, "-")}" data-kind="${e.kind}" data-finish="${e.finish ?? "print"}"><path fill-rule="evenodd" d="${tracedPath(L, c.data, c)}"/></g>`;
      });
      const f = name(s.side, "text", "svg");
      files[f] = strToU8(svgDoc(L, `Text and marks (${s.side}), outlined: traced from the ${o.dpi} dpi render`, `<g fill="#000">${groups.join("")}</g>`));
    }
    if (s.side === "front") {
      const vec = exactVectors(a.design, s.elements, L);
      if (vec.logo) files[name("front", "logo", "svg")] = strToU8(vec.logo);
      if (vec.contactless) files[name("front", "contactless", "svg")] = strToU8(vec.contactless);
    }

    // Proof image (150 dpi with the guides) and the proof PDF's artwork.
    const full = rasterCanvas(s.color);
    const pw = Math.round((L.width * 150) / o.dpi);
    const ph = Math.round((L.height * 150) / o.dpi);
    const small = resample(full, 0, 0, L.width, L.height, pw, ph, s.features.clear ? "#ffffff" : undefined);
    proofSides.push({
      side: s.side,
      jpeg: await canvasJpeg(small),
      rasterBox: rasterBoxMm(L),
      trim: { width: a.dieline.width, height: a.dieline.height },
      bleedMm: o.bleedMm,
      safe: roundedRectPath(a.dieline.safe.rect, a.dieline.safe.radius),
      trimPath: D.trim.path,
      cutouts: D.cutouts.map((c) => c.path),
      keepouts: D.keepOuts.map((x) => ({
        path: x.inner ? `${roundedRectPath(x.rect, x.radius)}${roundedRectPath(x.inner.rect, x.inner.radius)}` : roundedRectPath(x.rect, x.radius),
        label: x.label,
        rule: x.rule,
        source: x.source,
      })),
    });
    drawGuides(small, L, a.dieline, s.side, 150 / o.dpi);
    const proof = `${dir}proof-${s.side}.png`;
    files[proof] = encodePng({ width: small.width, height: small.height, channels: 4, data: canvasRgba(small) }, { dpi: 150 });
    proofs.push(proof);

    pdfSides.push({
      side: s.side,
      trim: { width: a.dieline.width, height: a.dieline.height },
      bleedMm: o.bleedMm,
      rasterBox: rasterBoxMm(L),
      image: s.features.clear ? { ...s.color, channels: 4 } : rgbOf(s.color),
      plates: layerPlates,
      cut: cutPaths.join(""),
      keepouts: proofSides.at(-1)!.keepouts.filter((x) => x.rule !== "info"),
    });
    sidesSpec.push({
      side: s.side,
      layout: L,
      composite,
      elements: s.elements,
      palette: dominantColors(s.color.data, s.color.width, s.color.height, 8),
      features: s.features,
    });
  }

  step(0.7, "Vendor files");
  const derivatives: Array<{ id: string; file: string; width: number; height: number; note: string }> = [];
  for (const dv of preset.derivatives) {
    const bytes = await derivative(dv, a, design, o, deps);
    if (!bytes) continue;
    const f = `${dir}${base}-${dv.file}`;
    files[f] = bytes;
    derivatives.push({ id: dv.id, file: f, width: dv.width, height: dv.height, note: dv.note });
  }

  step(0.78, "Fonts");
  const fonts = await collectFonts(a.design, o, files, dir);

  step(0.84, "PDFs");
  const pdf = await import("./pdf.ts");
  const title = `${base}: print files (${preset.name})`;
  files[`${dir}${base}-print.pdf`] = await pdf.masterPdf(pdfSides, { title, subject: `${PRINT_SPEC_FORMAT}, ${o.mode}, ${o.dpi} dpi, bleed ${o.bleedMm} mm` });
  const facts: Array<[string, string]> = [
    [
      "Profile",
      `${preset.name}${preset.status !== "published" ? ` (${preset.status === "todo" ? "specs not public: generic values" : "partly published"})` : ""}`,
    ],
    ["Mode", o.mode === "payment" ? "Payment card program" : "Non-payment card"],
    [
      "Card",
      `ISO/IEC 7810 ID-1, ${a.dieline.width.toFixed(2)} × ${a.dieline.height.toFixed(2)} mm, corner radius ${a.dieline.cornerRadiusMm.toFixed(2)} mm, ${a.dieline.orientation}`,
    ],
    [
      "Cutouts",
      a.dieline.sides.front.cutouts
        .map((c) => c.kind)
        .concat(a.dieline.notch ? ["notch"] : [])
        .join(", ") || "none",
    ],
    ["Resolution", `${o.dpi} dpi, ${a.bake[0]!.layout.width} × ${a.bake[0]!.layout.height} px; bleed ${o.bleedMm} mm, safe zone ${o.safeMm} mm`],
    [
      "Material",
      `${a.design.recipe.material}, ${a.design.recipe.texture} texture${a.design.recipe.pattern !== "none" ? `, ${a.design.recipe.pattern} pattern` : ""}`,
    ],
    ["Edge", a.design.edge ? `${a.design.edge.finish ?? "metal"} ${a.design.edge.color ?? ""}${a.design.edge.chamfer ? ", chamfer" : ""}` : "the body metal"],
    ["Colours", colors.map((c) => `${c.role} ${c.hex}${c.cmyk ? ` (≈ C${c.cmyk.c} M${c.cmyk.m} Y${c.cmyk.y} K${c.cmyk.k})` : ""}`).join("; ")],
    ["Colour handling", "sRGB master; CMYK conversion by the vendor; approximate CMYK only; no Pantone match"],
    [
      "Plates",
      plates
        .filter((p) => p.kind !== "keepout")
        .map((p) => `${p.side} ${p.name}`)
        .join(", "),
    ],
    ["Fonts", fonts.map((f) => `${f.family} (${f.source}, ${f.licence})`).join("; ") || "none"],
    [
      "Chip",
      o.mode === "payment" ? "EMV contact module (inserted by the manufacturer)" : o.decorativeChip ? "decorative / NFC module" : "contact plate (unconfirmed)",
    ],
    ...(o.mode === "non-payment"
      ? ([["Look-alike score", `${a.lookalike.score.toFixed(2)}${a.lookalike.lookalike ? " (looks like a payment card)" : ""}`]] as Array<[string, string]>)
      : []),
    ...(a.stripped.length ? ([["Left out", a.stripped.map((x) => `${x.what}: ${x.why}`).join("; ")]] as Array<[string, string]>) : []),
  ];
  files[`${dir}${base}-proof.pdf`] = await pdf.proofPdf(proofSides, proofPlates, {
    title: base,
    facts,
    issues: a.issues.map((i) => ({ level: i.level, message: i.message })),
  });

  step(0.92, "Packing");
  const readme = readmeText(base, preset, o, a);
  files[`${dir}README.txt`] = strToU8(readme);
  const fileList = [...Object.keys(files), `${dir}spec.json`].sort();
  const spec = buildPrintSpec({
    design: a.design,
    options: o,
    preset,
    dieline: a.dieline,
    sides: sidesSpec,
    plates,
    fonts,
    files: fileList,
    dielineFiles,
    proofs: [...proofs, `${dir}${base}-proof.pdf`],
    derivatives,
    issues: a.issues,
    lookalike: a.lookalike,
    stripped: a.stripped,
    createdAt: new Date().toISOString(),
  });
  files[`${dir}spec.json`] = strToU8(JSON.stringify(spec, null, 2));
  const stored = /\.(png|pdf|woff2?|jpe?g)$/i;
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([n, b]) => [n, [b, { level: stored.test(n) ? 0 : 6 }]])) as never);
  step(1, "Done");
  return { name: `${base}-print.zip`, zip: zip as Uint8Array<ArrayBuffer>, files, spec, analysis: a };
}

/** Draw the dieline's guides (keep-outs, safe zone, trim and cutouts) over a raster of `L` scaled by `k`. */
function drawGuides(c: HTMLCanvasElement, L: PrintLayout, d: CardDieline, side: Side, k: number): void {
  const D = d.sides[side];
  const g = c.getContext("2d")!;
  const ppm = L.pxPerMm * k;
  g.save();
  g.setTransform(ppm, 0, 0, ppm, L.trim.x * k, L.trim.y * k);
  g.lineWidth = Math.max(0.12, 1.2 / ppm);
  for (const x of D.keepOuts) {
    const p = new Path2D(x.inner ? `${roundedRectPath(x.rect, x.radius)}${roundedRectPath(x.inner.rect, x.inner.radius)}` : roundedRectPath(x.rect, x.radius));
    g.strokeStyle = "#e5262b";
    g.fillStyle = "rgba(229,38,43,0.2)";
    if (x.rule === "block") g.fill(p, "evenodd");
    g.setLineDash(x.rule === "info" ? [0.6, 0.6] : []);
    g.stroke(p);
  }
  g.setLineDash([0.8, 0.6]);
  g.strokeStyle = "#2fa84f";
  g.stroke(new Path2D(roundedRectPath(d.safe.rect, d.safe.radius)));
  g.setLineDash([]);
  g.strokeStyle = "#ec008c";
  g.stroke(new Path2D([D.trim.path, ...D.cutouts.map((x) => x.path)].join("")));
  g.restore();
}

/** A side's artwork at `dpi` with the guides, for previews. */
export function previewCanvas(a: PrintAnalysis, side: Side, maxWidth: number): HTMLCanvasElement | null {
  const s = a.bake.find((x) => x.side === side);
  if (!s) return null;
  const L = s.layout;
  const k = Math.min(1, maxWidth / L.width);
  const c = resample(
    rasterCanvas(s.color),
    0,
    0,
    L.width,
    L.height,
    Math.round(L.width * k),
    Math.round(L.height * k),
    s.features.clear ? "#e9ecef" : undefined,
  );
  drawGuides(c, L, a.dieline, side, k);
  return c;
}

/** Exact vectors where the source is vector: a path logo and the contactless mark (front). */
function exactVectors(design: CardDesign, elements: PrintElement[], L: PrintLayout): { logo?: string; contactless?: string } {
  const out: { logo?: string; contactless?: string } = {};
  const plane = (e: PrintElement) => ({
    x0: e.placement.x - e.plane.widthMm / 2,
    y0: e.placement.y - e.plane.heightMm / 2,
    w: e.plane.widthMm,
    h: e.plane.heightMm,
  });
  const logo = design.logo;
  const le = elements.find((e) => e.kind === "logo");
  if (logo?.path && logo.viewBox && le && le.plane.imageWidth) {
    const p = plane(le);
    const W = le.plane.imageWidth;
    const H = le.plane.imageHeight;
    const [vw, vh] = logo.viewBox;
    const k = Math.min(W / vw, H / vh);
    const sx = (p.w / W) * k;
    const sy = (p.h / H) * k;
    const tx = p.x0 + ((W - vw * k) / 2) * (p.w / W) - (logo.origin?.[0] ?? 0) * sx;
    const ty = p.y0 + ((H - vh * k) / 2) * (p.h / H) - (logo.origin?.[1] ?? 0) * sy;
    out.logo = svgDoc(
      L,
      "Logo (front): the design's own path, placed in mm",
      `<path id="logo" fill="#000" fill-rule="${logo.fillRule ?? "nonzero"}" transform="matrix(${fmt(sx)} 0 0 ${fmt(sy)} ${fmt(tx)} ${fmt(ty)})" d="${logo.path.replace(/"/g, "")}"/>`,
    );
  }
  const ce = elements.find((e) => e.kind === "contactless");
  if (design.contactless && ce && ce.plane.imageHeight) {
    const p = plane(ce);
    const H = ce.plane.imageHeight;
    const W = ce.plane.imageWidth;
    const G = CONTACTLESS_GEOMETRY;
    const s = H * (1 - 2 * G.margin);
    const ox = (W - s * CONTACTLESS_ASPECT) / 2;
    const oy = H * G.margin;
    const mx = (x: number) => p.x0 + (x * p.w) / W;
    const my = (y: number) => p.y0 + (y * p.h) / H;
    const sc = p.h / H;
    const arcs = G.arcs.map(({ r, half }) => {
      const cx = ox + G.centre.x * s;
      const cy = oy + G.centre.y * s;
      const R = r * s;
      const a = [cx + R * Math.cos(-half), cy + R * Math.sin(-half)];
      const b = [cx + R * Math.cos(half), cy + R * Math.sin(half)];
      return `M${fmt(mx(a[0]!))} ${fmt(my(a[1]!))}A${fmt(R * sc)} ${fmt(R * sc)} 0 0 1 ${fmt(mx(b[0]!))} ${fmt(my(b[1]!))}`;
    });
    out.contactless = svgDoc(
      L,
      "Contactless indicator (front): EMVCo's trademark, traced from its public reproduction requirements; the issuer must hold EMVCo's licence and use the official artwork",
      `<path id="contactless" fill="none" stroke="#000" stroke-linecap="round" stroke-width="${fmt(G.stroke * s * sc)}" d="${arcs.join("")}"/>`,
    );
  }
  return out;
}

/** A vendor derivative of the front. */
async function derivative(dv: PrintDerivative, a: PrintAnalysis, original: CardDesign, o: PrintOptions, deps: PrintDeps): Promise<Uint8Array | null> {
  const front = a.bake.find((s) => s.side === "front");
  if (!front) return null;
  const L = front.layout;
  if (dv.kind === "composite" || dv.kind === "bw") {
    const b = Math.min(dv.bleedMm ?? 0, o.bleedMm);
    const sx = L.trim.x - b * L.pxPerMm;
    const sy = L.trim.y - b * L.pxPerMm;
    const c = resample(rasterCanvas(front.color), sx, sy, L.trim.width + 2 * b * L.pxPerMm, L.trim.height + 2 * b * L.pxPerMm, dv.width, dv.height, "#ffffff");
    const px = canvasRgba(c);
    if (dv.kind === "composite")
      return encodePng(
        { width: dv.width, height: dv.height, channels: 3, data: px.filter((_, i) => i % 4 !== 3) },
        { dpi: Math.round((dv.width / (a.dieline.width + 2 * b)) * 25.4) },
      );
    const grey = new Uint8Array(dv.width * dv.height);
    for (let i = 0; i < grey.length; i++) grey[i] = 0.2126 * px[i * 4]! + 0.7152 * px[i * 4 + 1]! + 0.0722 * px[i * 4 + 2]! >= 128 ? 255 : 0;
    return encodePng({ width: dv.width, height: dv.height, channels: 1, data: grey }, { bits: 1, dpi: 600 });
  }
  if (dv.kind === "logo") {
    const logo = a.design.logo;
    let src: HTMLCanvasElement | OffscreenCanvas | null = null;
    if (logo) {
      const img = logo.src && !logo.path ? await loadImageEl(deps.assets.resolveUrl(logo.src)) : null;
      src = drawUserLogoCanvas(logo, img)?.canvas ?? null;
    } else src = drawLogoCanvas(deps.assets.brandMark);
    if (!src) return null;
    const c = document.createElement("canvas");
    c.width = dv.width;
    c.height = dv.height;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    const k = Math.min((dv.width * 0.9) / src.width, (dv.height * 0.8) / src.height);
    const w = src.width * k;
    const h = src.height * k;
    // The mask is white on transparent: draw it as black.
    const tmp = document.createElement("canvas");
    tmp.width = Math.max(1, Math.round(w));
    tmp.height = Math.max(1, Math.round(h));
    const tg = tmp.getContext("2d")!;
    tg.drawImage(src as CanvasImageSource, 0, 0, tmp.width, tmp.height);
    tg.globalCompositeOperation = "source-in";
    tg.fillStyle = "#000";
    tg.fillRect(0, 0, tmp.width, tmp.height);
    g.drawImage(tmp, Math.round((dv.width - w) / 2), Math.round((dv.height - h) / 2));
    const px = canvasRgba(c);
    const grey = new Uint8Array(dv.width * dv.height);
    for (let i = 0; i < grey.length; i++) grey[i] = px[i * 4]! >= 128 ? 255 : 0;
    return encodePng({ width: dv.width, height: dv.height, channels: 1, data: grey }, { bits: 1 });
  }
  // Wallet art: the front without chip, foil, name, number, text or contactless mark; square corners.
  const wallet: CardDesign = {
    ...original,
    cardholderName: "",
    cardholderBio: "",
    textLines: null,
    contactless: null,
    recipe: { ...original.recipe, frontHolo: false },
  };
  const trim = printTrimMm(wallet);
  const dpi = (dv.width / trim.width) * 25.4;
  const [w] = await deps.bake(wallet, { dpi, bleedMm: 0, sides: ["front"], masks: [], artwork: await artworkImages(wallet, deps.assets) });
  if (!w) return null;
  const c = resample(rasterCanvas(w.color), 0, 0, w.layout.width, w.layout.height, dv.width, dv.height, "#ffffff");
  const px = canvasRgba(c);
  return encodePng({ width: dv.width, height: dv.height, channels: 3, data: px.filter((_, i) => i % 4 !== 3) });
}

function readmeText(base: string, preset: PrintPreset, o: PrintOptions, a: PrintAnalysis): string {
  const L = a.bake[0]!.layout;
  const errors = a.issues.filter((i) => i.level === "error");
  const warnings = a.issues.filter((i) => i.level === "warning");
  return [
    `${base}: production files`,
    `Made with Card Studio. Profile: ${preset.name}. Mode: ${o.mode === "payment" ? "payment card program" : "non-payment card"}.`,
    "",
    "Geometry",
    `  Trim ${a.dieline.width.toFixed(2)} × ${a.dieline.height.toFixed(2)} mm (ISO/IEC 7810 ID-1), corner radius ${a.dieline.cornerRadiusMm.toFixed(2)} mm.`,
    `  Bleed ${o.bleedMm} mm, safe zone ${o.safeMm} mm. Rasters: ${o.dpi} dpi, ${L.width} × ${L.height} px, the trim centred (trim box in spec.json).`,
    "  Every file shares one origin: the trim's top-left corner, as seen from that side (the back is mirrored left to right).",
    "",
    "Files",
    "  <side>-composite.png    the flat colour artwork (sRGB, unlit, with bleed). The chip is not printed.",
    "  <side>-<plate>.png/svg  one plate per process (Engrave, Etch, Emboss, ColorFill-<hex>, Foil-…, SpotUV, White…):",
    `                          ${o.maskBits}-bit masks, black = the effect, white elsewhere; SVGs traced from them (mm).`,
    "  <side>-cut.svg/png      the cut path (trim with its ISO corners, cutouts).",
    "  <side>-dieline.svg      trim, bleed, safe zone and keep-outs (layers: CutContour, bleed, safe, keep-outs).",
    "  <side>-keepout.png      the keep-out areas (non-printing).",
    "  <side>-text.svg         text and marks as outlines (traced from the render: not the font's own curves).",
    "  front-logo.svg, front-contactless.svg   exact vectors where the source is vector.",
    `  ${base}-print.pdf       print-ready master: page 1 front, page 2 back, TrimBox and BleedBox, the composite, plates as`,
    "                          named spot colours on layers, the cut path as CutContour, keep-outs on a non-printing layer.",
    "                          Not PDF/X-4 (no output intent): the colour is sRGB.",
    `  ${base}-proof.pdf       proof: artwork with guides, separations, specification and preflight.`,
    "  proof-<side>.png        the artwork with guides at 150 dpi.",
    "  spec.json               everything above as data (card3d-print/1).",
    "  fonts/                  the font files and licences, for reproducing the text.",
    "",
    "Colour",
    "  The master is sRGB. CMYK conversion by the vendor, with their ICC profile. spec.json gives approximate CMYK",
    "  (a naive formula) and no Pantone match: agree PMS references with the vendor. Black text should print K = 100.",
    "",
    `Preflight: ${errors.length} error(s), ${warnings.length} warning(s).`,
    ...[...errors, ...warnings].map((i) => `  - [${i.level}] ${i.message}`),
    ...(preset.todo.length ? ["", "Not published by the vendor (confirm before ordering):", ...preset.todo.map((t) => `  - ${t}`)] : []),
    "",
  ].join("\n");
}
