/**
 * The little vector maths the sticker editor needs over the card engine's view (`EngineStage.view`:
 * the card's world transform, the camera's view matrix, eye and field of view): pointer rays into the
 * card's space and card points onto the screen. Matrices are column-major (`m[col * 4 + row]`).
 */
import type { EngineView } from "@card3d/core/engine";

/** A 2D vector with the handful of in-place operations the editor chains (three's `Vector2` subset). */
export class V2 {
  constructor(
    public x = 0,
    public y = 0,
  ) {}
  clone(): V2 {
    return new V2(this.x, this.y);
  }
  add(v: V2): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }
  sub(v: V2): this {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }
  multiplyScalar(s: number): this {
    this.x *= s;
    this.y *= s;
    return this;
  }
  addScaledVector(v: V2, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    return this;
  }
  lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }
  normalize(): this {
    const l = Math.sqrt(this.lengthSq());
    return l > 0 ? this.multiplyScalar(1 / l) : this;
  }
}

export type Vec3 = [number, number, number];

/** `m · (x, y, z, 1)` (an affine transform). */
function transformPoint(m: ArrayLike<number>, [x, y, z]: Vec3): Vec3 {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/** `m · (x, y, z, 0)`. */
function transformDirection(m: ArrayLike<number>, [x, y, z]: Vec3): Vec3 {
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

/** The inverse of an affine 4 × 4 matrix (rotation, scale, translation). */
function invertAffine(m: ArrayLike<number>): Float64Array {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const k = det ? 1 / det : 0;
  // Rows of the inverse 3 × 3.
  const r = [
    (e * i - f * h) * k,
    (c * h - b * i) * k,
    (b * f - c * e) * k,
    (f * g - d * i) * k,
    (a * i - c * g) * k,
    (c * d - a * f) * k,
    (d * h - e * g) * k,
    (b * g - a * h) * k,
    (a * e - b * d) * k,
  ];
  const [tx, ty, tz] = [m[12], m[13], m[14]];
  const out = new Float64Array(16);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) out[col * 4 + row] = r[row * 3 + col];
    out[12 + row] = -(r[row * 3] * tx + r[row * 3 + 1] * ty + r[row * 3 + 2] * tz);
  }
  out[15] = 1;
  return out;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The ray through the canvas's normalised device coordinates (x right, y up, −1..1), in the card's own
 * space: origin and direction.
 */
export function cardRay(v: EngineView, nx: number, ny: number): { origin: Vec3; dir: Vec3 } {
  const t = Math.tan(((v.fov / 2) * Math.PI) / 180);
  // The camera's axes are the view matrix's rows.
  const m = v.view;
  const cx = nx * t * v.aspect;
  const cy = ny * t;
  const world: Vec3 = [m[0] * cx + m[1] * cy - m[2], m[4] * cx + m[5] * cy - m[6], m[8] * cx + m[9] * cy - m[10]];
  const inv = invertAffine(v.model);
  return { origin: transformPoint(inv, v.eye), dir: transformDirection(inv, world) };
}

/** Where a ray meets the card-space plane z = `z` (null when parallel or behind). */
export function hitPlane(ray: { origin: Vec3; dir: Vec3 }, z: number): V2 | null {
  const dz = ray.dir[2];
  if (Math.abs(dz) < 1e-12) return null;
  const s = (z - ray.origin[2]) / dz;
  return s < 0 ? null : new V2(ray.origin[0] + ray.dir[0] * s, ray.origin[1] + ray.dir[1] * s);
}

/** The distance along a card-space ray to a point on it. */
export const rayDistance = (ray: { origin: Vec3; dir: Vec3 }, p: Vec3): number =>
  dot([p[0] - ray.origin[0], p[1] - ray.origin[1], p[2] - ray.origin[2]], ray.dir);

/** A card-space point in the canvas's normalised device coordinates (y up). */
export function projectCardPoint(v: EngineView, p: Vec3): V2 {
  const w = transformPoint(v.model, p);
  const c = transformPoint(v.view, w);
  const t = Math.tan(((v.fov / 2) * Math.PI) / 180);
  const depth = Math.max(1e-6, -c[2]);
  return new V2(c[0] / depth / (t * v.aspect), c[1] / depth / t);
}

/** Whether the card-space plane at `p` with normal `n` faces the camera. */
export function facesCamera(v: EngineView, p: Vec3, n: Vec3): boolean {
  const w = transformPoint(v.model, p);
  const nw = transformDirection(v.model, n);
  return dot(nw, [v.eye[0] - w[0], v.eye[1] - w[1], v.eye[2] - w[2]]) > 0;
}
