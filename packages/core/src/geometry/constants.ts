/**
 * Card-wide layout constants. All lengths are card units: an ISO ID-1 card is
 * 3.37 × 2.125. Note the deliberate mismatch between the layout height `CARD_H` (2.125) and the
 * reference model's body height (540 · BODY_SCALE ≈ 2.116): do not "fix" the layout.
 * The public ID-1 body (`ID1_BODY_NATIVE`) is 2.125 tall, so there the print and the body agree.
 */

/** Card layout width `W`. */
export const CARD_W = 3.37;
/** Card layout height `H`. */
export const CARD_H = 2.125;

/**
 * The glTF card model's native (glTF-unit) body outline: 860 × 540 × 7 with corner radius 40 and a
 * 2-unit bevel. Only a local pack's model has these proportions (≈ 4.0 mm
 * corners, 53.75 mm tall); the public body is `ID1_BODY_NATIVE`.
 * @archive the local three.js archive (.archive/three-engine) imports it
 */
export const BODY_NATIVE = { width: 860, height: 540, depth: 7, cornerRadius: 40, bevel: 2 } as const;
/** Native chip outline: 140 × 120 × 6.5, corner radius 20, same 2-unit bevel. @archive the local three.js archive imports it */
export const CHIP_NATIVE = { width: 140, height: 120, depth: 6.5, cornerRadius: 20, bevel: 2 } as const;

/**
 * ISO/IEC 7810 ID-1, millimetres: 85.60 × 53.98, 0.76 ± 0.08 thick, corners 3.18 ± 0.30 (the
 * width and height tolerances are 85.47–85.72 and 53.92–54.03).
 */
export const ISO_ID1_MM = {
  width: 85.6,
  height: 53.98,
  thickness: { min: 0.68, nominal: 0.76, max: 0.84 },
  cornerRadius: { min: 2.88, nominal: 3.18, max: 3.48 },
} as const;

/** Millimetres per card unit: the ID-1 width, 85.60 mm, is `CARD_W` (card units are inches, to 0.002 %). */
export const MM_PER_UNIT = ISO_ID1_MM.width / CARD_W;

/** Native units per millimetre (the body's 860 native units span 85.60 mm). */
const NATIVE_PER_MM = BODY_NATIVE.width / ISO_ID1_MM.width;

/**
 * The public card body in native units, ISO/IEC 7810 ID-1: 860 × 542.3 (85.60 × 53.98 mm), 7 thick
 * (0.70 mm), corner radius 31.95 (3.18 mm), a 2-unit bevel. The procedural standard
 * body and every shaped body (the engine's geometry.rs and shape.rs) are built on it.
 */
export const ID1_BODY_NATIVE = {
  width: BODY_NATIVE.width,
  height: ISO_ID1_MM.height * NATIVE_PER_MM,
  depth: BODY_NATIVE.depth,
  cornerRadius: ISO_ID1_MM.cornerRadius.nominal * NATIVE_PER_MM,
  bevel: BODY_NATIVE.bevel,
} as const;

/**
 * Corner radius, as `CardShape.cornerRadius` measures it: a fraction of half the card's short side
 * (53.98 / 2 mm on an ID-1 card). A design's radius stays within ISO/IEC 7810 ID-1: 3.18 mm ± 0.30,
 * the nominal 3.18 mm being the standard card's.
 */
export const CORNER_RADIUS_MM_PER_UNIT = ISO_ID1_MM.height / 2;
export const CORNER_RADIUS_RANGE = {
  min: ISO_ID1_MM.cornerRadius.min / CORNER_RADIUS_MM_PER_UNIT,
  iso: ISO_ID1_MM.cornerRadius.nominal / CORNER_RADIUS_MM_PER_UNIT,
  max: ISO_ID1_MM.cornerRadius.max / CORNER_RADIUS_MM_PER_UNIT,
} as const;

/** `A`: native → card units. */
export const BODY_SCALE = CARD_W / BODY_NATIVE.width;

/** Chip layout as fractions of W/H: left, top, width; aspect = w/h. */
export const CHIP_LAYOUT = { left: 0.75, top: 0.475, width: 0.15, aspect: 140 / 120 } as const;

/** Chip footprint in card units. */
export const CHIP_SIZE = {
  width: CHIP_LAYOUT.width * CARD_W,
  height: (CHIP_LAYOUT.width * CARD_W) / CHIP_LAYOUT.aspect,
} as const;

/** Chip centre in card-local x/y: (1.09525, −0.1635179). */
export const CHIP_CENTER = {
  x: -CARD_W / 2 + CHIP_LAYOUT.left * CARD_W + CHIP_SIZE.width / 2,
  y: CARD_H / 2 - CHIP_LAYOUT.top * CARD_H - CHIP_SIZE.height / 2,
} as const;

/**
 * Face-plane scale relative to the body footprint and its quadratic corner radius (for
 * a body with 40-unit corners; a body with other corners scales the radius with them).
 * @archive the local three.js archive (.archive/three-engine) imports it
 */
export const FACE_PLANE_SCALE = 0.998;
/** @archive the local three.js archive (.archive/three-engine) imports it */
export const FACE_PLANE_RADIUS = 0.17;

/**
 * `metalCardChipBounds()`: chip bounds in normalised card coordinates with v measured
 * from the top, as [centre-u, centre-v, half-width, half-height] = [0.825, 0.5769496, 0.075, 0.1019496].
 * @archive the local three.js archive (.archive/three-engine) imports it
 */
export function metalCardChipBounds(): [number, number, number, number] {
  const halfW = CHIP_LAYOUT.width / 2;
  const halfH = (CHIP_LAYOUT.width * CARD_W) / (CHIP_LAYOUT.aspect * CARD_H) / 2;
  return [CHIP_LAYOUT.left + halfW, CHIP_LAYOUT.top + halfH, halfW, halfH];
}

/** The "card UV" mapping `u = x/W + 0.5, v = y/H + 0.5` used by the holo meshes. @archive the local three.js archive imports it */
export function cardUv(x: number, y: number): [number, number] {
  return [x / CARD_W + 0.5, y / CARD_H + 0.5];
}

/** Longest side of a design image handed to the engine (larger images are downscaled). */
export const MAX_DESIGN_IMAGE_SIDE = 1280;
