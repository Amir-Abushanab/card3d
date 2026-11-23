/**
 * Marquee constants and helpers. Pure, no three.js.
 */

/** The marquee's constants. World units are card units (card = 3.37 × 2.125). */
export const MARQUEE = {
  ARC_SPAN: 2.8,
  ARC_Y: 1.05,
  AXIS_LOCK_PX: 10,
  MOBILE_AXIS_LOCK_PX: 14,
  CLICK_SLOP_PX: 6,
  MOBILE_CLICK_SLOP_PX: 12,
  CAM_Z: 12,
  CAM_FOV: 34,
  CAM_NEAR: 0.1,
  CAM_FAR: 60,
  CARD_HEIGHT_UNITS: 2.125,
  CARD_WIDTH_UNITS: 3.37,
  CARD_SPACING: 4,
  CENTER_HEIGHT_FRAC: 0.3,
  CENTER_POSE_KEEP: 0.42,
  CONTINUOUS_SPIN_YAW: 0.12,
  DRAG_SENSITIVITY: 0.01,
  DRIFT_RESUME_MS: 420,
  FOCUS_SPAN: 1.35,
  MAX_SIDE_YAW: 0.38,
  MAX_USER_PITCH: 1.3,
  MOBILE_BREAKPOINT_PX: 720,
  MOBILE_ROW_Y_FRAC: -0.02,
  ORBIT_HALF_ANGLE: 1.15,
  ORBIT_YAW_SCALE: 0.32,
  PITCH_RANGE: 0.2,
  PITCH_VAR: 0.08,
  PITCH_WOBBLE: 0.04,
  POOL: 7,
  ROLL_RANGE: 0.14,
  ROLL_SPAN: 1.8,
  ROLL_VAR: 0.06,
  SCRUB_FRICTION: 3.4,
  SCRUB_MIN_VELOCITY: 0.08,
  SCRUB_PX_TO_CARDS: 1 / 180,
  SCRUB_RESUME_DRIFT_MS: 700,
  SEEK_CENTER_EPS: 0.28,
  SEEK_MS_MIN: 900,
  SEEK_MS_MAX: 1300,
  SEEK_MS_PER_CARD: 150,
  SPEED: 0.24,
  TURN_FLIP_MS: 620,
  TURN_FLIP_SEEK_FRAC: 0.92,
  WOBBLE_SPEED: 0.42,
  YAW_PHASE_VAR: 0.25,
  YAW_SPAN: 1.9,
  YAW_VAR: 0.08,
  Z_FAR: -4.2,
  Z_NEAR: 2.2,
  /** Intro. */
  INTRO_WARM_FRAMES: 10,
  INTRO_SECONDS: 0.72,
  INTRO_MAX_FRAME: 1 / 45,
  INTRO_SETTLE_AT: 0.34,
} as const;

/** Derived. */
export const HALF = MARQUEE.POOL / 2;
export const INTRO_N = 1 / ((MARQUEE.POOL - 1) / 2);
export const PERSP = (MARQUEE.CAM_Z - MARQUEE.Z_NEAR) / MARQUEE.CAM_Z;
export const NEAR_TO_FAR = MARQUEE.Z_NEAR - MARQUEE.Z_FAR;
export const COS_HALF = Math.cos(MARQUEE.ORBIT_HALF_ANGLE);
/** The viewport's height in world units at the z = 0 plane, camera at z 12, fov 34. Constant. */
export const VIEWPORT_H = 2 * MARQUEE.CAM_Z * Math.tan(((MARQUEE.CAM_FOV / 2) * Math.PI) / 180);
export const CARD_ASPECT = MARQUEE.CARD_WIDTH_UNITS / MARQUEE.CARD_HEIGHT_UNITS;

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

/** `c²(3 − 2c)`, c = clamp(t, 0, 1). */
export const smoothstep = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};
export const easeOutQuart = (t: number): number => 1 - Math.pow(1 - t, 4);
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const quadBezier = (p0: number, p1: number, p2: number, t: number): number => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2;

/** `fract(43758.5453 · sin(12.9898·x))`: seeds every jitter, copied exactly. */
export const hash = (x: number): number => {
  const v = 43758.5453 * Math.sin(12.9898 * x);
  return v - Math.floor(v);
};

/** Seek easing: quadratic in to (0.4, 0.5714), quartic out (F:527–535). */
export const seekEase = (t: number): number => {
  if (t < 0.4) {
    const u = t / 0.4;
    return 0.5714 * u * u;
  }
  const r = 1 - (t - 0.4) / 0.6;
  return 0.5714 + 0.4286 * (1 - r * r * r * r);
};

/** `smootherstep` used by the page shell's scroll morph. */
export const smootherstep = (t: number): number => {
  const u = clamp01(t);
  return u * u * u * (u * (6 * u - 15) + 10);
};

/** Mulberry32 PRNG; `seed` is any 32-bit integer. */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
