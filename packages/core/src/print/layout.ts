/**
 * Print registration: how a card's trim (mm) maps onto the pixels of a production raster at a given
 * resolution and bleed. Every raster of a print package (colour artwork, separation masks, element
 * coverage) uses the same layout, so they register exactly; the vector files (dieline, outlines) use
 * mm from the trim's top-left corner, the same frame.
 *
 * The raster is `round((trim + 2 · bleed) · dpi / 25.4)` pixels each way, at exactly `dpi`; the trim
 * is centred on it, so its edges may fall between pixels (the half-pixel of rounding is split between
 * the two sides). `trim` gives that box in fractional pixels.
 */

export const MM_PER_INCH = 25.4;

/** The print resolutions the exporter offers (dots per inch). */
export const PRINT_DPI = [300, 600, 1200] as const;

export interface PrintLayout {
  dpi: number;
  bleedMm: number;
  /** Trim size, mm. */
  trimMm: { width: number; height: number };
  /** Pixels per mm (dpi / 25.4). */
  pxPerMm: number;
  /** Raster size, px (trim + bleed on every side). */
  width: number;
  height: number;
  /** The trim box in raster pixels (fractional), from the raster's top-left corner. */
  trim: { x: number; y: number; width: number; height: number };
}

export function printLayout(trimMm: { width: number; height: number }, dpi: number, bleedMm: number): PrintLayout {
  if (!(dpi > 0) || !Number.isFinite(dpi)) throw new RangeError(`bad print resolution ${dpi}`);
  const bleed = Math.max(0, Number.isFinite(bleedMm) ? bleedMm : 0);
  const pxPerMm = dpi / MM_PER_INCH;
  const width = Math.round((trimMm.width + 2 * bleed) * pxPerMm);
  const height = Math.round((trimMm.height + 2 * bleed) * pxPerMm);
  const tw = trimMm.width * pxPerMm;
  const th = trimMm.height * pxPerMm;
  return {
    dpi,
    bleedMm: bleed,
    trimMm: { ...trimMm },
    pxPerMm,
    width,
    height,
    trim: { x: (width - tw) / 2, y: (height - th) / 2, width: tw, height: th },
  };
}

/** A point in mm from the trim's top-left corner → raster pixels (fractional; pixel centres at +0.5). */
export function mmToPx(L: PrintLayout, xMm: number, yMm: number): { x: number; y: number } {
  return { x: L.trim.x + xMm * L.pxPerMm, y: L.trim.y + yMm * L.pxPerMm };
}

/** Raster pixels → mm from the trim's top-left corner. */
export function pxToMm(L: PrintLayout, x: number, y: number): { x: number; y: number } {
  return { x: (x - L.trim.x) / L.pxPerMm, y: (y - L.trim.y) / L.pxPerMm };
}

/** The raster's extent in mm from the trim's top-left (negative left / top: the bleed). */
export function rasterBoxMm(L: PrintLayout): { x: number; y: number; width: number; height: number } {
  return { x: -L.trim.x / L.pxPerMm, y: -L.trim.y / L.pxPerMm, width: L.width / L.pxPerMm, height: L.height / L.pxPerMm };
}
