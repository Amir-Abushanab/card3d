/**
 * Numeric helpers shared by the material code, with the exact JS semantics.
 * Everything here is IEEE-754 double maths; keep the operation order as written, because the hashes
 * amplify last-bit differences.
 */

/** `min(hi, max(lo, x))`: a NaN input stays NaN. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** `x − floor(x)`, in [0, 1) for negative x too. */
function fract(x: number): number {
  return x - Math.floor(x);
}

/** Cell hash `H(x, y)`. */
export function cellHash(x: number, y: number): number {
  return fract(43758.5453 * Math.sin(127.1 * x + 311.7 * y));
}

/** Per-texel white noise `m(x, y)` in [−0.5, 0.5), x = column, y = row. @archive the local three.js archive imports it */
export function texelNoise(x: number, y: number): number {
  return fract(43758.5453 * Math.sin(12.9898 * x + 78.233 * y)) - 0.5;
}

/**
 * Negative Gaussian groove of width `w` at every multiple of `period`. Uses a positive
 * modulo because JS `%` keeps the dividend's sign.
 */
export function ridge(x: number, period: number, w: number): number {
  const q = ((x % period) + period) % period;
  const d = Math.min(q, period - q);
  return -Math.exp(-(d * d) / (w * w));
}
