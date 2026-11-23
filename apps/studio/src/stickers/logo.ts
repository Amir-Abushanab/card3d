/**
 * Logo upload → `CardDesign.logo`. The card embosses the logo like the corner mark (alpha = shape,
 * colour discarded), so uploads are reduced to what the card uses, small enough for share links and
 * autosave:
 *
 * - an SVG that is one filled `<path>` (no transforms, strokes or other shapes) keeps its path data
 *   (`path` + `viewBox`), crisp at any size;
 * - anything else (other SVGs, PNG, WebP, JPEG, GIF) is rasterised to a white-on-transparent PNG
 *   mask, trimmed to the shape. Images without transparency (a dark logo on white, or light on dark)
 *   get their alpha from the contrast against the background colour in the corners.
 */
import { LOGO_LIMITS, type CardLogo } from "@card3d/core/model";

/** Upload limit for the source file. */
const MAX_LOGO_FILE_BYTES = 4 * 1024 * 1024;
/** Mask PNG budget (data URL characters) for links and autosave; the raster shrinks until it fits. */
const LOGO_MASK_BUDGET = 48_000;
const MASK_HEIGHTS = [384, 320, 256, 192, 144];

const DRAWABLE = "path,rect,circle,ellipse,polygon,polyline,line,text,image,use,foreignObject";

export async function logoFromFile(file: File): Promise<CardLogo> {
  if (file.size > MAX_LOGO_FILE_BYTES) throw new Error("That file is over 4 MB. Use a smaller logo.");
  const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
  if (isSvg) return logoFromSvg(await file.text());
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Use an SVG, PNG, WebP, JPEG or GIF logo.");
  const bitmap = await createImageBitmap(file);
  try {
    return rasterLogo(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** An SVG document → a path logo when it is a single plain path, else a raster mask. */
async function logoFromSvg(text: string): Promise<CardLogo> {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) throw new Error("That SVG couldn't be read.");
  const box = svgBox(svg);
  if (!box) throw new Error("That SVG has no size (viewBox or width/height).");
  const path = singlePath(svg);
  if (path && path.d.length <= LOGO_LIMITS.pathChars) {
    return {
      path: path.d,
      viewBox: [box.w, box.h],
      ...(box.x || box.y ? { origin: [box.x, box.y] as [number, number] } : {}),
      ...(path.evenodd ? { fillRule: "evenodd" as const } : {}),
    };
  }
  // Rasterise: give the root an explicit size so it decodes at a useful resolution.
  const scale = 1024 / Math.max(box.w, box.h);
  svg.setAttribute("width", String(Math.round(box.w * scale)));
  svg.setAttribute("height", String(Math.round(box.h * scale)));
  if (!svg.getAttribute("viewBox")) svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return rasterLogo(img, img.naturalWidth, img.naturalHeight);
  } catch {
    throw new Error("That SVG couldn't be drawn.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function svgBox(svg: Element): { x: number; y: number; w: number; h: number } | null {
  const vb = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  const w = parseFloat(svg.getAttribute("width") ?? "");
  const h = parseFloat(svg.getAttribute("height") ?? "");
  return w > 0 && h > 0 ? { x: 0, y: 0, w, h } : null;
}

/** The one filled path of a plain SVG (no transforms, strokes, masks or other shapes), else null. */
function singlePath(svg: Element): { d: string; evenodd: boolean } | null {
  const shapes = svg.querySelectorAll(DRAWABLE);
  if (shapes.length !== 1 || shapes[0].nodeName.toLowerCase() !== "path") return null;
  if (svg.querySelector("mask,clipPath,pattern,filter,style")) return null;
  const path = shapes[0];
  const d = (path.getAttribute("d") ?? "").trim();
  if (!d) return null;
  // The path and every ancestor below the root must be untransformed and filled.
  for (let el: Element | null = path; el && el !== svg; el = el.parentElement) {
    if (el.getAttribute("transform") || el.getAttribute("clip-path") || el.getAttribute("mask")) return null;
    const fill = el.getAttribute("fill") ?? (el.getAttribute("style") ?? "").match(/fill\s*:\s*([^;]+)/)?.[1]?.trim();
    if (fill === "none") return null;
    const stroke = el.getAttribute("stroke") ?? (el.getAttribute("style") ?? "").match(/stroke\s*:\s*([^;]+)/)?.[1]?.trim();
    if (stroke && stroke !== "none") return null;
  }
  const rule = path.getAttribute("fill-rule") ?? (path.getAttribute("style") ?? "").match(/fill-rule\s*:\s*([^;]+)/)?.[1]?.trim();
  return { d: d.replace(/\s+/g, " "), evenodd: rule === "evenodd" };
}

/** Draw `src` and turn it into a trimmed white-on-transparent mask PNG within the budget. */
function rasterLogo(src: CanvasImageSource, w: number, h: number): CardLogo {
  if (!(w > 0 && h > 0)) throw new Error("That image is empty.");
  // Work at up to 1024 px on the long side.
  const k = Math.min(1, 1024 / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k));
  const H = Math.max(1, Math.round(h * k));
  const work = new OffscreenCanvas(W, H);
  const ctx = work.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H);
  const alpha = maskAlpha(img);
  // Trim to the shape (+ a 2 % margin).
  let x0 = W,
    y0 = H,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (alpha[y * W + x] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) throw new Error("That image looks empty (no shape found).");
  const pad = Math.round(0.02 * Math.max(x1 - x0, y1 - y0));
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad);
  y1 = Math.min(H - 1, y1 + pad);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const mask = new OffscreenCanvas(cw, ch);
  const mctx = mask.getContext("2d")!;
  const out = mctx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const o = (y * cw + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = 255;
      out.data[o + 3] = alpha[(y + y0) * W + (x + x0)];
    }
  mctx.putImageData(out, 0, 0);
  const aspect = cw / ch;

  // Encode at the largest height that fits the budget.
  for (const target of MASK_HEIGHTS) {
    const th = Math.min(target, ch);
    const tw = Math.max(1, Math.min(Math.round(th * aspect), 4 * target));
    const c = document.createElement("canvas");
    c.width = tw;
    c.height = th;
    const g = c.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(mask, 0, 0, tw, th);
    const url = c.toDataURL("image/png");
    if (url.length <= LOGO_MASK_BUDGET || target === MASK_HEIGHTS[MASK_HEIGHTS.length - 1]) {
      if (url.length > LOGO_LIMITS.srcChars) throw new Error("That logo is too detailed to keep. Try a simpler or smaller one.");
      return { src: url, aspect: tw / th };
    }
  }
  throw new Error("That logo couldn't be encoded.");
}

/**
 * Per-pixel shape alpha: the image's own alpha when it has transparency, else the contrast against the
 * background colour sampled in the corners (dark-on-light and light-on-dark both work).
 */
export function maskAlpha(img: ImageData): Uint8ClampedArray {
  const { width: W, height: H, data: d } = img;
  const n = W * H;
  const out = new Uint8ClampedArray(n);
  let transparent = 0;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3] < 250) transparent++;
  if (transparent > n * 0.01) {
    for (let i = 0; i < n; i++) out[i] = d[i * 4 + 3];
    return out;
  }
  const lum = (i: number) => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  const s = Math.max(1, Math.round(Math.min(W, H) * 0.03));
  let bg = 0;
  let count = 0;
  for (const [cx, cy] of [
    [0, 0],
    [W - s, 0],
    [0, H - s],
    [W - s, H - s],
  ])
    for (let y = cy; y < cy + s; y++)
      for (let x = cx; x < cx + s; x++) {
        bg += lum(y * W + x);
        count++;
      }
  bg /= count;
  // Contrast range: the farthest value from the background maps to full ink.
  let far = 0;
  for (let i = 0; i < n; i++) far = Math.max(far, Math.abs(lum(i) - bg));
  if (far < 24) throw new Error("That image has no contrast to find a logo in.");
  for (let i = 0; i < n; i++) {
    const t = (Math.abs(lum(i) - bg) / far - 0.15) / 0.55;
    out[i] = Math.round(255 * Math.min(1, Math.max(0, t)));
  }
  return out;
}
