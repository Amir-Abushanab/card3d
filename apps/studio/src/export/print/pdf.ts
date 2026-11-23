/**
 * The package's PDFs (pdf-lib, loaded with the rest of the print export):
 *
 * - **Print-ready master** (`<name>-print.pdf`): page 1 front, page 2 back, each the trim plus bleed with
 *   TrimBox and BleedBox set; the sRGB composite as an embedded image, each plate as vector paths filled
 *   with a named Separation (spot) colour on its own optional-content layer (overprinting, so it never
 *   knocks out the artwork), the cut path as the "CutContour" spot, and the keep-out guides on a
 *   non-printing layer. Not PDF/X-4: there is no output intent or ICC profile (the composite is sRGB;
 *   the vendor converts). The plates' outlines are traced from the masks at print resolution.
 * - **Proof** (`<name>-proof.pdf`, A4 landscape): page 1 front and back with trim, bleed, safe zone and
 *   keep-outs drawn over the artwork and the dimensions; page 2 the separations; page 3 on the spec and
 *   preflight (more pages if it runs long).
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames as Op,
  PDFString,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import { zlibSync } from "fflate";

const PT_PER_MM = 72 / 25.4;
const num = (v: number) => PDFNumber.of(Math.round(v * 1000) / 1000);
const op = (name: Op, ...args: Array<PDFNumber | PDFName | ReturnType<typeof PDFArray.withContext>>) => PDFOperator.of(name, args);

export interface PdfPlate {
  /** Spot / layer name. */
  name: string;
  /** Alternate (preview) colour, CMYK 0–1. */
  cmyk: [number, number, number, number];
  /** SVG path data, mm from the trim's top-left. */
  path: string;
}

export interface PdfSide {
  side: "front" | "back";
  /** Trim size and bleed, mm. */
  trim: { width: number; height: number };
  bleedMm: number;
  /** The raster box, mm from the trim's top-left (it can be a fraction of a pixel off the bleed edge). */
  rasterBox: { x: number; y: number; width: number; height: number };
  image: { width: number; height: number; channels: 3 | 4; data: Uint8Array };
  plates: PdfPlate[];
  /** Trim and cutouts, SVG path data in mm. */
  cut: string;
  keepouts: Array<{ path: string; label: string; rule: string }>;
}

// ── SVG path (M L H V A Z, absolute) → PDF path operators ────────────────────

type Pt = [number, number];

/** Arc (SVG endpoint parameterisation) → cubic béziers. */
function arcToBeziers(p0: Pt, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p1: Pt): Array<[Pt, Pt, Pt]> {
  if (rx === 0 || ry === 0) return [[p0, p1, p1]];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const s =
    (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (s * rx * y1) / ry;
  const cy1 = (-s * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t0 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const at = (t: number): Pt => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const d = (t: number): Pt => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out: Array<[Pt, Pt, Pt]> = [];
  for (let i = 0; i < n; i++) {
    const a = t0 + i * step;
    const b = a + step;
    const pa = at(a);
    const pb = at(b);
    const da = d(a);
    const db = d(b);
    out.push([[pa[0] + k * da[0], pa[1] + k * da[1]], [pb[0] - k * db[0], pb[1] - k * db[1]], pb]);
  }
  return out;
}

/** Path operators for SVG path data (mm), mapped to page points by `map`. */
function pathOps(d: string, map: (x: number, y: number) => Pt): PDFOperator[] {
  const ops: PDFOperator[] = [];
  const tokens = d.match(/[MLHVAZmlhvaz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let cur: Pt = [0, 0];
  let start: Pt = [0, 0];
  let cmd = "";
  const n = () => parseFloat(tokens[i++]!);
  const mv = (p: Pt) => ops.push(op(Op.MoveTo, ...map(...p).map(num)));
  const ln = (p: Pt) => ops.push(op(Op.LineTo, ...map(...p).map(num)));
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/[A-Za-z]/.test(t)) {
      cmd = t.toUpperCase();
      i++;
      if (cmd === "Z") {
        ops.push(op(Op.ClosePath));
        cur = start;
        continue;
      }
    }
    if (cmd === "M") {
      cur = start = [n(), n()];
      mv(cur);
      cmd = "L";
    } else if (cmd === "L") {
      cur = [n(), n()];
      ln(cur);
    } else if (cmd === "H") {
      cur = [n(), cur[1]];
      ln(cur);
    } else if (cmd === "V") {
      cur = [cur[0], n()];
      ln(cur);
    } else if (cmd === "A") {
      const rx = n();
      const ry = n();
      const rot = n();
      const large = n() !== 0;
      const sweep = n() !== 0;
      const to: Pt = [n(), n()];
      for (const [c1, c2, p] of arcToBeziers(cur, rx, ry, rot, large, sweep, to))
        ops.push(op(Op.AppendBezierCurve, ...[...map(...c1), ...map(...c2), ...map(...p)].map(num)));
      cur = to;
    } else i++;
  }
  return ops;
}

/** WinAnsi-safe text for the standard fonts. */
function pdfText(s: string): string {
  const map: Record<string, string> = {
    "≥": ">=",
    "≤": "<=",
    "≈": "~",
    "→": "->",
    "←": "<-",
    "↔": "<->",
    "−": "-",
    "‑": "-",
    " ": " ",
    "✓": "OK",
    "⚠": "!",
    "×": "x",
    "′": "'",
    "″": '"',
  };
  const ok = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
  let out = "";
  for (const ch of s) {
    if (map[ch] !== undefined) out += map[ch];
    else if (ch.charCodeAt(0) < 0x7f || (ch.charCodeAt(0) >= 0xa0 && ch.charCodeAt(0) <= 0xff) || ok.has(ch)) out += ch;
    else out += "?";
  }
  return out;
}

function embedRaw(doc: PDFDocument, img: PdfSide["image"]): PDFRef {
  const { width: w, height: h, channels, data } = img;
  const rgbBytes = new Uint8Array(w * h * 3);
  let alpha: Uint8Array | null = null;
  if (channels === 4) alpha = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++) {
    rgbBytes[j++] = data[i * channels]!;
    rgbBytes[j++] = data[i * channels + 1]!;
    rgbBytes[j++] = data[i * channels + 2]!;
    if (alpha) alpha[i] = data[i * 4 + 3]!;
  }
  const dict: Record<string, unknown> = {
    Type: "XObject",
    Subtype: "Image",
    Width: w,
    Height: h,
    ColorSpace: "DeviceRGB",
    BitsPerComponent: 8,
    Filter: "FlateDecode",
  };
  if (alpha && alpha.some((a) => a < 255)) {
    const smask = doc.context.stream(zlibSync(alpha, { level: 6 }), {
      Type: "XObject",
      Subtype: "Image",
      Width: w,
      Height: h,
      ColorSpace: "DeviceGray",
      BitsPerComponent: 8,
      Filter: "FlateDecode",
    });
    dict.SMask = doc.context.register(smask);
  }
  return doc.context.register(doc.context.stream(zlibSync(rgbBytes, { level: 6 }), dict as never));
}

function resources(page: PDFPage) {
  return page.node.normalizedEntries().Resources;
}

/** The print-ready master: one page per side, plates as spot colours on layers. */
export async function masterPdf(sides: PdfSide[], meta: { title: string; subject: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(meta.title);
  doc.setSubject(meta.subject);
  doc.setProducer("Card Studio");
  doc.setCreator("Card Studio print export");
  const ctx = doc.context;
  const ocgs = new Map<string, PDFRef>();
  const off: PDFRef[] = [];
  const ocg = (name: string, print = true) => {
    let ref = ocgs.get(name);
    if (!ref) {
      const usage = print ? undefined : ctx.obj({ Print: { PrintState: "OFF" }, View: { ViewState: "ON" } });
      ref = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of(name), ...(usage ? { Usage: usage } : {}) }));
      ocgs.set(name, ref);
      if (!print) off.push(ref);
    }
    return ref;
  };
  const spots = new Map<string, PDFRef>();
  const spot = (name: string, cmyk: [number, number, number, number]) => {
    let ref = spots.get(name);
    if (!ref) {
      const fn = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: cmyk, N: 1 });
      ref = ctx.register(ctx.obj([PDFName.of("Separation"), PDFName.of(name.replace(/[^A-Za-z0-9_.-]/g, "_")), PDFName.of("DeviceCMYK"), fn]));
      spots.set(name, ref);
    }
    return ref;
  };
  const overprint = ctx.register(ctx.obj({ Type: "ExtGState", OP: true, op: true, OPM: 1 }));
  for (const s of sides) {
    const W = (s.trim.width + 2 * s.bleedMm) * PT_PER_MM;
    const H = (s.trim.height + 2 * s.bleedMm) * PT_PER_MM;
    const page = doc.addPage([W, H]);
    page.setBleedBox(0, 0, W, H);
    page.setTrimBox(s.bleedMm * PT_PER_MM, s.bleedMm * PT_PER_MM, s.trim.width * PT_PER_MM, s.trim.height * PT_PER_MM);
    const map = (x: number, y: number): Pt => [(x + s.bleedMm) * PT_PER_MM, H - (y + s.bleedMm) * PT_PER_MM];
    const res = resources(page);
    const cs = ctx.obj({}) as PDFDict;
    const props = ctx.obj({}) as PDFDict;
    const ext = ctx.obj({ GSop: overprint }) as PDFDict;
    res.set(PDFName.of("ColorSpace"), cs);
    res.set(PDFName.of("Properties"), props);
    res.set(PDFName.of("ExtGState"), ext);
    const ops: PDFOperator[] = [];
    // Artwork.
    const im = embedRaw(doc, s.image);
    page.node.setXObject(PDFName.of("Art"), im);
    props.set(PDFName.of("OCArt"), ocg("Artwork (sRGB composite)"));
    const [ix, iy] = map(s.rasterBox.x, s.rasterBox.y + s.rasterBox.height);
    ops.push(
      op(Op.BeginMarkedContentSequence, PDFName.of("OC"), PDFName.of("OCArt")),
      op(Op.PushGraphicsState),
      op(Op.ConcatTransformationMatrix, num(s.rasterBox.width * PT_PER_MM), num(0), num(0), num(s.rasterBox.height * PT_PER_MM), num(ix), num(iy)),
      op(Op.DrawObject, PDFName.of("Art")),
      op(Op.PopGraphicsState),
      op(Op.EndMarkedContent),
    );
    // Plates: spot fills, overprinting.
    s.plates.forEach((p, k) => {
      if (!p.path) return;
      const csName = `CS${k}`;
      const ocName = `OC${k}`;
      cs.set(PDFName.of(csName), spot(p.name, p.cmyk));
      props.set(PDFName.of(ocName), ocg(p.name));
      ops.push(
        op(Op.BeginMarkedContentSequence, PDFName.of("OC"), PDFName.of(ocName)),
        op(Op.PushGraphicsState),
        op(Op.SetGraphicsStateParams, PDFName.of("GSop")),
        op(Op.NonStrokingColorspace, PDFName.of(csName)),
        op(Op.NonStrokingColorN, num(1)),
        ...pathOps(p.path, map),
        op(Op.FillEvenOdd),
        op(Op.PopGraphicsState),
        op(Op.EndMarkedContent),
      );
    });
    // Cut path: a hairline in the CutContour spot.
    cs.set(PDFName.of("CSCut"), spot("CutContour", [0, 1, 0, 0]));
    props.set(PDFName.of("OCCut"), ocg("Cut"));
    ops.push(
      op(Op.BeginMarkedContentSequence, PDFName.of("OC"), PDFName.of("OCCut")),
      op(Op.PushGraphicsState),
      op(Op.SetGraphicsStateParams, PDFName.of("GSop")),
      op(Op.StrokingColorspace, PDFName.of("CSCut")),
      op(Op.StrokingColorN, num(1)),
      op(Op.SetLineWidth, num(0.25)),
      ...pathOps(s.cut, map),
      op(Op.StrokePath),
      op(Op.PopGraphicsState),
      op(Op.EndMarkedContent),
    );
    // Keep-outs: non-printing guides.
    if (s.keepouts.length) {
      props.set(PDFName.of("OCKeep"), ocg("Keepout (non-printing)", false));
      ops.push(
        op(Op.BeginMarkedContentSequence, PDFName.of("OC"), PDFName.of("OCKeep")),
        op(Op.PushGraphicsState),
        op(Op.StrokingColorCmyk, num(0), num(1), num(1), num(0)),
        op(Op.SetLineWidth, num(0.3)),
      );
      for (const k of s.keepouts) ops.push(...pathOps(k.path, map), op(Op.StrokePath));
      ops.push(op(Op.PopGraphicsState), op(Op.EndMarkedContent));
    }
    page.pushOperators(...ops);
  }
  const all = [...ocgs.values()];
  doc.catalog.set(
    PDFName.of("OCProperties"),
    ctx.obj({
      OCGs: all,
      D: {
        Name: PDFString.of("Layers"),
        Order: all,
        ON: all.filter((r) => !off.includes(r)),
        OFF: off,
        AS: [{ Event: "Print", Category: ["Print"], OCGs: all }],
      },
    }),
  );
  return doc.save({ useObjectStreams: false });
}

// ── proof ───────────────────────────────────────────────────────────────────

export interface ProofSide {
  side: "front" | "back";
  /** JPEG of the artwork (raster box), and that box in mm from the trim's top-left. */
  jpeg: Uint8Array;
  rasterBox: { x: number; y: number; width: number; height: number };
  trim: { width: number; height: number };
  bleedMm: number;
  safe: string;
  trimPath: string;
  cutouts: string[];
  keepouts: Array<{ path: string; label: string; rule: string; source?: string }>;
}

export interface ProofPlate {
  side: "front" | "back";
  name: string;
  description: string;
  /** JPEG of the mask (black = effect, white elsewhere), covering the raster box. */
  jpeg: Uint8Array;
  aspect: number;
}

export interface ProofText {
  title: string;
  facts: Array<[string, string]>;
  issues: Array<{ level: string; message: string }>;
}

const A4: [number, number] = [842, 595];
const MAGENTA = rgb(0.93, 0, 0.55);
const CYAN = rgb(0, 0.63, 0.91);
const GREEN = rgb(0.18, 0.66, 0.31);
const RED = rgb(0.9, 0.15, 0.17);
const INK = rgb(0.12, 0.12, 0.14);
const MUTED = rgb(0.42, 0.42, 0.46);

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = pdfText(text).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function proofPdf(sides: ProofSide[], plates: ProofPlate[], text: ProofText): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${text.title} (proof)`);
  doc.setProducer("Card Studio");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const head = (page: PDFPage, title: string, sub: string) => {
    page.drawText(pdfText(title), { x: 36, y: A4[1] - 44, size: 16, font: bold, color: INK });
    page.drawText(pdfText(sub), { x: 36, y: A4[1] - 60, size: 9, font, color: MUTED });
  };

  // Page 1: artwork with overlays and dimensions.
  const p1 = doc.addPage(A4);
  head(
    p1,
    `${text.title}: artwork proof`,
    "Magenta: trim and cutouts. Cyan: bleed. Green dashed: safe zone. Red: keep-outs (filled: nothing may go there). Not a colour proof (sRGB screen colours).",
  );
  const slotW = (A4[0] - 36 * 3) / 2;
  let lowest = A4[1];
  for (let k = 0; k < sides.length; k++) {
    const s = sides[k]!;
    const totalW = s.trim.width + 2 * s.bleedMm;
    const totalH = s.trim.height + 2 * s.bleedMm;
    const scale = Math.min((slotW - 30) / totalW, (A4[1] - 190) / totalH);
    const ox = 36 + k * (slotW + 36) + 10;
    const oyTop = A4[1] - 96;
    const X = (x: number) => ox + (x + s.bleedMm) * scale;
    const Y = (y: number) => oyTop - (y + s.bleedMm) * scale;
    const img = await doc.embedJpg(s.jpeg);
    p1.drawImage(img, { x: X(s.rasterBox.x), y: Y(s.rasterBox.y + s.rasterBox.height), width: s.rasterBox.width * scale, height: s.rasterBox.height * scale });
    const svg = (d: string, o: { color: ReturnType<typeof rgb>; width: number; dash?: number[]; fill?: ReturnType<typeof rgb>; opacity?: number }) =>
      // drawSvgPath scales the stroke with the path: widths and dashes are given in page points.
      p1.drawSvgPath(d, {
        x: X(0),
        y: Y(0),
        scale,
        borderColor: o.color,
        borderWidth: o.width / scale,
        ...(o.dash ? { borderDashArray: o.dash.map((v) => v / scale) } : {}),
        ...(o.fill ? { color: o.fill, opacity: o.opacity ?? 0.2 } : {}),
      });
    for (const ko of s.keepouts)
      svg(ko.path, { color: RED, width: 0.6, ...(ko.rule === "block" ? { fill: RED, opacity: 0.18 } : ko.rule === "info" ? { dash: [2, 2] } : {}) });
    svg(`M${-s.bleedMm} ${-s.bleedMm}H${s.trim.width + s.bleedMm}V${s.trim.height + s.bleedMm}H${-s.bleedMm}Z`, { color: CYAN, width: 0.6 });
    svg(s.safe, { color: GREEN, width: 0.6, dash: [3, 2] });
    svg(s.trimPath, { color: MAGENTA, width: 0.9 });
    for (const c of s.cutouts) svg(c, { color: MAGENTA, width: 0.9 });
    // Dimensions: width under the card, height to its right.
    const y0 = Y(s.trim.height) - s.bleedMm * scale - 14;
    p1.drawLine({ start: { x: X(0), y: y0 }, end: { x: X(s.trim.width), y: y0 }, thickness: 0.5, color: INK });
    for (const x of [X(0), X(s.trim.width)]) p1.drawLine({ start: { x, y: y0 - 3 }, end: { x, y: y0 + 3 }, thickness: 0.5, color: INK });
    const wl = `${s.trim.width.toFixed(2)} mm`;
    p1.drawText(wl, { x: (X(0) + X(s.trim.width)) / 2 - font.widthOfTextAtSize(wl, 8) / 2, y: y0 - 11, size: 8, font, color: INK });
    const x0 = X(s.trim.width) + s.bleedMm * scale + 8;
    p1.drawLine({ start: { x: x0, y: Y(0) }, end: { x: x0, y: Y(s.trim.height) }, thickness: 0.5, color: INK });
    for (const y of [Y(0), Y(s.trim.height)]) p1.drawLine({ start: { x: x0 - 3, y }, end: { x: x0 + 3, y }, thickness: 0.5, color: INK });
    p1.drawText(`${s.trim.height.toFixed(2)} mm`, { x: x0 + 4, y: (Y(0) + Y(s.trim.height)) / 2 - 3, size: 8, font, color: INK });
    p1.drawText(pdfText(`${s.side === "front" ? "Front" : "Back (as seen from the back)"}`), {
      x: X(-s.bleedMm),
      y: Y(-s.bleedMm) + 8,
      size: 10,
      font: bold,
      color: INK,
    });
    p1.drawText(pdfText(`bleed ${s.bleedMm} mm`), { x: X(-s.bleedMm), y: y0 - 24, size: 7, font, color: MUTED });
    lowest = Math.min(lowest, y0 - 24);
  }

  // Keep-outs and where their numbers come from, under the cards.
  if (lowest > 110) {
    let y = lowest - 22;
    p1.drawText("Keep-outs", { x: 36, y, size: 10, font: bold, color: INK });
    y -= 14;
    const seen = new Set<string>();
    for (const s of sides)
      for (const k of s.keepouts) {
        const key = `${k.label}|${k.source ?? ""}`;
        if (seen.has(key) || y < 40) continue;
        seen.add(key);
        const rule = k.rule === "block" ? "keep clear" : k.rule === "avoid" ? "avoid" : "zone";
        for (const [i, l] of wrap(
          `${s.side === "front" ? "Front" : "Back"} · ${k.label} (${rule})${k.source ? `: ${k.source}` : ""}`,
          font,
          7.5,
          A4[0] - 72,
        ).entries()) {
          p1.drawText(l, { x: i ? 46 : 36, y, size: 7.5, font, color: MUTED });
          y -= 10;
        }
      }
  }

  // Page 2: separations.
  const p2 = doc.addPage(A4);
  head(p2, "Separations", "One plate per process (black = where it applies), front and back. Each is also a 1-bit PNG and an SVG in the package.");
  const cols = 4;
  const cellW = (A4[0] - 72 - (cols - 1) * 14) / cols;
  let pageNow = p2;
  let row = 0;
  let col = 0;
  for (const p of plates) {
    const h = cellW / p.aspect;
    let top = A4[1] - 84 - row * (h + 40);
    if (top - h - 30 < 30) {
      pageNow = doc.addPage(A4);
      head(pageNow, "Separations (continued)", "");
      row = 0;
      col = 0;
      top = A4[1] - 84;
    }
    const x = 36 + col * (cellW + 14);
    const img = await doc.embedJpg(p.jpeg);
    pageNow.drawImage(img, { x, y: top - h, width: cellW, height: h });
    pageNow.drawRectangle({ x, y: top - h, width: cellW, height: h, borderColor: MUTED, borderWidth: 0.4 });
    pageNow.drawText(pdfText(`${p.side} · ${p.name}`), { x, y: top - h - 11, size: 8, font: bold, color: INK });
    const lines = wrap(p.description, font, 6.5, cellW);
    lines.slice(0, 2).forEach((l, i) => pageNow.drawText(l, { x, y: top - h - 20 - i * 8, size: 6.5, font, color: MUTED }));
    col++;
    if (col === cols) {
      col = 0;
      row++;
    }
  }
  if (!plates.length) p2.drawText("No separations: the card is printed only (see the artwork).", { x: 36, y: A4[1] - 100, size: 10, font, color: INK });

  // Page 3: spec and preflight.
  let p3 = doc.addPage(A4);
  head(p3, "Specification and preflight", "The full specification is spec.json in the package.");
  let y = A4[1] - 88;
  const line = (label: string, value: string) => {
    const lines = wrap(value, font, 8.5, A4[0] - 72 - 170);
    if (y - lines.length * 11 < 36) {
      p3 = doc.addPage(A4);
      y = A4[1] - 44;
    }
    p3.drawText(pdfText(label), { x: 36, y, size: 8.5, font: bold, color: INK });
    lines.forEach((l, i) => p3.drawText(l, { x: 206, y: y - i * 11, size: 8.5, font, color: INK }));
    y -= Math.max(1, lines.length) * 11 + 3;
  };
  for (const [k, v] of text.facts) line(k, v);
  y -= 8;
  p3.drawText("Preflight", { x: 36, y, size: 11, font: bold, color: INK });
  y -= 16;
  if (!text.issues.length) line("", "No findings.");
  for (const it of text.issues) line(it.level === "error" ? "Error" : it.level === "warning" ? "Warning" : "Note", it.message);
  return doc.save();
}
