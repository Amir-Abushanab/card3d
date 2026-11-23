/**
 * Slot pose maths, intro fly-in and responsive layout. Pure functions.
 */
import { CARD_ASPECT, COS_HALF, INTRO_N, MARQUEE, NEAR_TO_FAR, PERSP, VIEWPORT_H, clamp, easeOutQuart, hash, quadBezier, smoothstep } from "./constants.ts";

/** Responsive layout record. */
export interface MarqueeLayout {
  rowYFrac: number;
  xFrac: number;
  centerHeightFrac: number;
  cardSpacing: number;
}

/** Default before anything is measured. */
export const DEFAULT_MARQUEE_LAYOUT: MarqueeLayout = { rowYFrac: -0.12, xFrac: 0, centerHeightFrac: 0.3, cardSpacing: 4 };

export interface LayoutInput {
  /** Container size in CSS px. */
  width: number;
  height: number;
  /**
   * Optional band (container-relative CSS px) the centre card must fit between, for example a
   * page's nav bottom edge and its headline block's top. When absent, the row offset falls back to −0.12
   * (desktop) / −0.02 (mobile).
   */
  band?: { top: number; bottom: number } | null;
  previewPaused?: boolean;
}

/** Measurement. */
export function computeMarqueeLayout({ width: W, height: H, band, previewPaused }: LayoutInput): MarqueeLayout {
  if (!(W > 0) || !(H > 0)) return { ...DEFAULT_MARQUEE_LAYOUT };
  const target = clamp(Math.min(0.45 * H, 0.5 * W), 172, 372);
  const narrow = clamp(target / H, 0.3, 0.4) * H;
  let cardH = narrow + (target - narrow) * smoothstep(clamp((W - 720) / 160, 0, 1));
  if (previewPaused) cardH = Math.min(cardH, (0.92 * W) / CARD_ASPECT);
  let rowYFrac: number;
  if (band) {
    const top = clamp(band.top, 0, H);
    const bottom = clamp(band.bottom, top, H);
    cardH = Math.max(1, Math.min(cardH, bottom - top));
    rowYFrac = ((top + bottom) / 2 - H / 2) / H;
  } else {
    rowYFrac = W <= MARQUEE.MOBILE_BREAKPOINT_PX ? MARQUEE.MOBILE_ROW_Y_FRAC : -0.12;
  }
  const centerHeightFrac = cardH / H;
  return { rowYFrac, xFrac: 0, centerHeightFrac, cardSpacing: (MARQUEE.CARD_SPACING * centerHeightFrac) / 0.3 };
}

export function layoutValid(l: MarqueeLayout): boolean {
  return [l.rowYFrac, l.xFrac, l.centerHeightFrac, l.cardSpacing].every(Number.isFinite) && l.centerHeightFrac > 0 && l.cardSpacing > 0;
}

export function layoutDiffers(a: MarqueeLayout, b: MarqueeLayout): boolean {
  return (
    Math.abs(a.rowYFrac - b.rowYFrac) > 1e-6 ||
    Math.abs(a.xFrac - b.xFrac) > 1e-6 ||
    Math.abs(a.centerHeightFrac - b.centerHeightFrac) > 1e-6 ||
    Math.abs(a.cardSpacing - b.cardSpacing) > 1e-6
  );
}

/** Per-frame world inputs derived from the layout and canvas aspect. */
export interface FrameInputs {
  viewportW: number;
  /** Uniform card scale at the default layout. */
  w: number;
  xOff: number;
  yRow: number;
  spacing: number;
}

export function frameInputs(layout: MarqueeLayout, aspect: number): FrameInputs {
  const viewportW = VIEWPORT_H * aspect;
  const v = (VIEWPORT_H * layout.centerHeightFrac) / MARQUEE.CARD_HEIGHT_UNITS;
  return {
    viewportW,
    w: v * PERSP,
    xOff: viewportW * layout.xFrac * PERSP,
    yRow: -VIEWPORT_H * layout.rowYFrac * PERSP,
    spacing: layout.cardSpacing,
  };
}

/** Static per-slot randoms. */
export interface SlotRandoms {
  phasePitch: number;
  pitchBias: number;
  introJitter: number;
  introSide: 1 | -1;
}

export function slotRandoms(e: number): SlotRandoms {
  const r = 2 * hash(e + 9) - 1;
  return {
    phasePitch: hash(e + 7) * 2 * Math.PI,
    pitchBias: Math.sign(r || 1) * (0.35 + 0.65 * Math.abs(r)),
    introJitter: (hash(3.1 * e) - 0.5) * 0.1,
    introSide: hash(e) > 0.5 ? 1 : -1,
  };
}

/** Per-logical jitter. */
export interface LogicalJitter {
  jYaw: number;
  jPitch: number;
  jRoll: number;
  jPhase: number;
}

export function logicalJitter(o: number): LogicalJitter {
  return {
    jYaw: (2 * hash(1.7 * o + 3.1) - 1) * MARQUEE.YAW_VAR,
    jPitch: (2 * hash(2.3 * o + 8.7) - 1) * MARQUEE.PITCH_VAR,
    jRoll: (2 * hash(3.9 * o + 1.3) - 1) * MARQUEE.ROLL_VAR,
    jPhase: (2 * hash(0.7 * o + 5.5) - 1) * MARQUEE.YAW_PHASE_VAR,
  };
}

/** User turn state on a logical card (stand/press are dormant and stay 0). */
export interface TurnPose {
  yaw: number;
  pitch: number;
  flip: number;
  stand: number;
}

export const NO_MARQUEE_TURN: TurnPose = { yaw: 0, pitch: 0, flip: 0, stand: 0 };

export interface SlotPose {
  x: number;
  y: number;
  z: number;
  /** Euler XYZ radians: x = pitch, y = yaw, z = roll. */
  pitch: number;
  yaw: number;
  roll: number;
  scale: number;
  visible: boolean;
}

const arcAngle = (x: number) => clamp(x / MARQUEE.ARC_SPAN, -1, 1) * MARQUEE.ORBIT_HALF_ANGLE;

export interface PoseInput {
  a: number;
  /** marquee time, s */
  t: number;
  frame: FrameInputs;
  slot: SlotRandoms;
  jitter: LogicalJitter;
  turn?: TurnPose;
  previewPaused?: boolean;
  /** Intro progress `arriveT` (0..1); undefined or ≥ 1 with `introDone` = steady state. */
  introT?: number;
  introDone?: boolean;
}

/** Steady pose + optional intro fly-in. */
export function computeSlotPose(p: PoseInput, out: SlotPose = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, scale: 1, visible: true }): SlotPose {
  const { a, t, frame, slot, jitter } = p;
  const turn = p.turn ?? NO_MARQUEE_TURN;
  const s = smoothstep(clamp(1 - Math.abs(a) / MARQUEE.FOCUS_SPAN, 0, 1));
  const B = 1 - s * (1 - MARQUEE.CENTER_POSE_KEEP);
  const u = (Math.cos(Math.abs(arcAngle(a))) - COS_HALF) / (1 - COS_HALF);

  const x0 = a * frame.spacing + frame.xOff;
  const y0 = frame.yRow - MARQUEE.ARC_Y * (1 - u);
  const z0 = MARQUEE.Z_FAR + NEAR_TO_FAR * u;

  const q = clamp((a - jitter.jPhase) / MARQUEE.YAW_SPAN, -1, 1);
  let yaw =
    arcAngle(a - jitter.jPhase) * MARQUEE.ORBIT_YAW_SCALE +
    Math.sign(q) * smoothstep(Math.abs(q)) * MARQUEE.MAX_SIDE_YAW +
    MARQUEE.CONTINUOUS_SPIN_YAW * a +
    jitter.jYaw +
    (turn.yaw + turn.flip);
  const Y = clamp(a / MARQUEE.ROLL_SPAN, -1, 1);
  let roll = Math.sign(Y) * smoothstep(Math.abs(Y)) * MARQUEE.ROLL_RANGE + jitter.jRoll + turn.stand;
  const wobble = Math.sin(t * MARQUEE.WOBBLE_SPEED + slot.phasePitch) * MARQUEE.PITCH_WOBBLE;
  const pitchBase = slot.pitchBias * MARQUEE.PITCH_RANGE * B + jitter.jPitch * B + turn.pitch;
  let pitch = pitchBase + wobble;
  const scale0 = frame.w;

  if (p.previewPaused && Math.abs(a) < 0.001) {
    yaw = turn.yaw + turn.flip;
    pitch = turn.pitch;
    roll = turn.stand;
  }

  out.visible = true;
  if (p.introDone === false && p.introT !== undefined) {
    // Fly-in.
    const arriveT = p.introT;
    const n = clamp(Math.abs(a) * INTRO_N + slot.introJitter, 0, 1);
    const pr = clamp((arriveT - 0.36 * n) * 1.5625, 0, 1);
    if (pr <= 0.001) {
      out.visible = false;
      out.x = x0;
      out.y = y0;
      out.z = z0;
      out.pitch = pitch;
      out.yaw = yaw;
      out.roll = roll;
      out.scale = scale0;
      return out;
    }
    const pos = easeOutQuart(pr);
    const lift = 1 - Math.pow(1 - clamp((pr - 0.06) / 0.94, 0, 1), 3);
    const grow = easeOutQuart(clamp(1.04 * pr, 0, 1));
    const side = Math.sign(a) || slot.introSide;
    const centre = Math.abs(a) < 0.35;
    const spread = centre ? 0.18 : 0.5 + 0.5 * n;
    const sx = x0 + 1.05 * side * (centre ? 0.12 : 0.5 + 0.5 * n);
    const sy = y0 - 0.36 * (0.65 + 0.35 * n);
    const sz = z0 - 1.85 * (0.7 + 0.3 * n);
    const cx = x0 + 1.05 * side * 0.1 * n;
    const cy = y0 + 0.16 * (0.35 + 0.65 * n);
    const cz = (sz + z0) / 2 + 0.4;
    out.x = quadBezier(sx, cx, x0, pos);
    out.y = quadBezier(sy, cy, y0, pos);
    out.z = quadBezier(sz, cz, z0, pos);
    out.scale = 0.82 * scale0 + 0.18 * scale0 * grow;
    const pitchSteady = pitchBase + (lift > 0.55 ? wobble * lift : 0);
    out.yaw = yaw + 0.78 * side * spread * (1 - lift);
    out.pitch = -0.22 * spread + (pitchSteady + 0.22 * spread) * lift;
    out.roll = 0.11 * side * spread + (roll - 0.11 * side * spread) * lift + 0.033 * side * spread * Math.sin(Math.PI * lift) * (1 - lift);
    return out;
  }

  out.x = x0;
  out.y = y0;
  out.z = z0;
  out.pitch = pitch;
  out.yaw = yaw;
  out.roll = roll;
  out.scale = scale0;
  return out;
}

/** Drift gate during the intro. */
export const introGate = (arriveT: number, done: boolean): number => (done ? 1 : smoothstep((arriveT - 0.1) / 0.45));
