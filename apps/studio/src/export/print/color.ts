/**
 * Colours for the print spec: sRGB hex, an approximate CMYK and the dominant colours of an artwork.
 *
 * The CMYK numbers are a naive, device-independent conversion, *not* a colour-managed one (no ICC
 * profile, no ink limits, no dot gain): a starting point for a conversation with the printer, who
 * converts the sRGB master with their own profile (GRACoL, FOGRA…). Formula (sRGB values 0–1, no
 * linearisation):
 *
 *   K = 1 − max(R, G, B)
 *   C = (1 − R − K) / (1 − K),  M = (1 − G − K) / (1 − K),  Y = (1 − B − K) / (1 − K)   (0 when K = 1)
 *
 * rounded to whole percent. For black text and marks the convention is K = 100 only (no rich black):
 * `cmykFor` gives 0/0/0/100 for near-neutral colours with K ≥ 90 %. Pantone (PMS) matches are not
 * computed: the library isn't ours to ship and a nearest-match would mislead; the field stays empty
 * for the card's author or the vendor to fill.
 */

export interface Cmyk {
  c: number;
  m: number;
  y: number;
  k: number;
}

export const CMYK_FORMULA =
  "Naive sRGB → CMYK (no ICC profile): K = 1 − max(R,G,B); C = (1 − R − K)/(1 − K), M = (1 − G − K)/(1 − K), Y = (1 − B − K)/(1 − K); whole percent. Black text and marks (near-neutral, K ≥ 90 %) as 0/0/0/100. Approximate only: the printer converts the sRGB master with their ICC profile.";

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** The naive conversion above, from 0–255 sRGB. */
export function rgbToCmyk(r: number, g: number, b: number): Cmyk {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const k = 1 - Math.max(R, G, B);
  if (k >= 1 - 1e-9) return { c: 0, m: 0, y: 0, k: 100 };
  const pct = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100);
  return { c: pct((1 - R - k) / (1 - k)), m: pct((1 - G - k) / (1 - k)), y: pct((1 - B - k) / (1 - k)), k: pct(k) };
}

/** CMYK for a role: black text and marks become K = 100 only (`blackK100`). */
export function cmykFor(hex: string, o: { text?: boolean; blackK100?: boolean } = {}): Cmyk | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const c = rgbToCmyk(...rgb);
  const neutral = Math.max(...rgb) - Math.min(...rgb) <= 24;
  if (o.text && o.blackK100 !== false && neutral && c.k >= 90) return { c: 0, m: 0, y: 0, k: 100 };
  return c;
}

export interface PaletteEntry {
  hex: string;
  /** Share of the sampled (opaque) area, 0–1. */
  share: number;
}

/**
 * Dominant colours of an RGBA image (median cut on a subsample): up to `count` entries, largest share
 * first. Transparent pixels are ignored.
 */
export function dominantColors(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, count = 8): PaletteEntry[] {
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)));
  const px: number[][] = [];
  for (let y = 0; y < height; y += step)
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3]! < 128) continue;
      px.push([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]);
    }
  if (!px.length) return [];
  let boxes: number[][][] = [px];
  while (boxes.length < count) {
    // Split the box with the widest channel range (weighted by size).
    let best = -1;
    let bestScore = 0;
    let bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255;
        let hi = 0;
        for (const p of b) {
          lo = Math.min(lo, p[ch]!);
          hi = Math.max(hi, p[ch]!);
        }
        const score = (hi - lo) * Math.sqrt(b.length);
        if (score > bestScore) {
          bestScore = score;
          best = i;
          bestCh = ch;
        }
      }
    });
    if (best < 0 || bestScore < 8) break;
    const b = boxes[best]!.sort((p, q) => p[bestCh]! - q[bestCh]!);
    const mid = b.length >> 1;
    boxes = [...boxes.slice(0, best), b.slice(0, mid), b.slice(mid), ...boxes.slice(best + 1)];
  }
  const total = px.length;
  // Refine (two k-means steps from the boxes' means): a median split can leave a mixed box.
  let centres = boxes.filter((b) => b.length).map((b) => [0, 1, 2].map((ch) => b.reduce((s, p) => s + p[ch]!, 0) / b.length));
  let counts: number[] = [];
  for (let it = 0; it < 2; it++) {
    const sums = centres.map(() => [0, 0, 0]);
    counts = centres.map(() => 0);
    for (const p of px) {
      let best = 0;
      let bd = Infinity;
      centres.forEach((c, i) => {
        const d = (c[0]! - p[0]!) ** 2 + (c[1]! - p[1]!) ** 2 + (c[2]! - p[2]!) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      counts[best]!++;
      for (let ch = 0; ch < 3; ch++) sums[best]![ch]! += p[ch]!;
    }
    centres = centres.map((c, i) => (counts[i] ? sums[i]!.map((v) => v / counts[i]!) : c));
  }
  const out = centres.map((c, i) => ({ hex: rgbToHex(c[0]!, c[1]!, c[2]!), share: counts[i]! / total })).filter((e) => e.share > 0);
  // Merge near-identical colours (median cut can split a flat area).
  const merged: PaletteEntry[] = [];
  for (const e of out.sort((a, b) => b.share - a.share)) {
    const rgb = hexToRgb(e.hex)!;
    const near = merged.find((m) => {
      const q = hexToRgb(m.hex)!;
      return Math.abs(q[0] - rgb[0]) + Math.abs(q[1] - rgb[1]) + Math.abs(q[2] - rgb[2]) < 12;
    });
    if (near) near.share += e.share;
    else merged.push({ ...e });
  }
  return merged.sort((a, b) => b.share - a.share).map((e) => ({ hex: e.hex, share: Math.round(e.share * 1000) / 1000 }));
}
