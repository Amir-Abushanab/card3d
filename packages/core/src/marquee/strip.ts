/**
 * The strip / pool model and its motion store . Pure state + functions, no three.js.
 *
 * A page may show one strip twice (a live hero and a tile copy) and keep both in sync. Here a
 * strip is an explicit object: `createMarqueeStrip()` for an independent marquee, or pass the same
 * strip to several `mountMarquee` calls to sync them (`sharedMarqueeStrip` is a page-wide default).
 */
import { HALF, MARQUEE, clamp, seekEase } from "./constants.ts";

export interface MarqueeSeek {
  active: boolean;
  from: number;
  delta: number;
  startMs: number;
  durationMs: number;
}

export interface MarqueeStrip {
  /** Real-valued strip position in cards; increasing moves the cards toward −x. */
  offset: number;
  /** Marquee time in seconds (drives the pitch wobble). */
  time: number;
  /** Fling inertia, cards/s. */
  scrubVelocity: number;
  /** Current drift velocity, cards/s. */
  driftVel: number;
  driftPausedUntil: number;
  dragActive: boolean;
  scrubbing: boolean;
  /** ms timestamp of the previous advance; 0 = not primed. */
  lastAdvance: number;
  seek: MarqueeSeek;
  focusHeld: boolean;
  /** `?card=` preview: strip frozen, time frozen. */
  previewPaused: boolean;
  /** Global drift gate published by the active hero during its intro (0..1). */
  driftGate: number;
}

export function createMarqueeStrip(init: Partial<Pick<MarqueeStrip, "offset" | "time">> = {}): MarqueeStrip {
  return {
    offset: init.offset ?? 0,
    time: init.time ?? 0,
    scrubVelocity: 0,
    driftVel: 0,
    driftPausedUntil: 0,
    dragActive: false,
    scrubbing: false,
    lastAdvance: 0,
    seek: { active: false, from: 0, delta: 0, startMs: 0, durationMs: 0 },
    focusHeld: false,
    previewPaused: false,
    driftGate: 1,
  };
}

/** A page-wide strip, for hosts that want one shared strip (hero + tile copy). */
export const sharedMarqueeStrip: MarqueeStrip = createMarqueeStrip();

/**
 * `advanceMarqueeDrift(now, gate)` (F:513–565). Call once per animating frame with
 * `performance.now()`. Instances sharing a strip add up to the real elapsed time.
 */
export function advanceMarqueeDrift(s: MarqueeStrip, now: number, gate = 1): void {
  const prev = s.lastAdvance;
  s.lastAdvance = now;
  if (prev === 0) return;
  const dt = (now - prev) / 1000;
  if (!(dt > 0)) return;
  const g = Math.min(clamp(gate, 0, 1), s.driftGate);
  if (!s.previewPaused) s.time += dt;
  if (s.seek.active) {
    const p = clamp((now - s.seek.startMs) / Math.max(s.seek.durationMs, 1), 0, 1);
    s.offset = s.seek.from + s.seek.delta * seekEase(p);
    if (p >= 1) {
      s.seek.active = false;
      s.scrubVelocity = 0;
      s.driftPausedUntil = 0;
      s.driftVel = 0;
    }
    return;
  }
  if (s.focusHeld || s.previewPaused) {
    s.scrubVelocity = 0;
    s.driftVel = 0;
    return;
  }
  const inertia = !s.scrubbing && Math.abs(s.scrubVelocity) > MARQUEE.SCRUB_MIN_VELOCITY;
  if (inertia) {
    s.offset += s.scrubVelocity * dt;
    s.scrubVelocity *= Math.exp(-MARQUEE.SCRUB_FRICTION * dt);
    if (Math.abs(s.scrubVelocity) <= MARQUEE.SCRUB_MIN_VELOCITY) {
      s.driftVel = s.scrubVelocity;
      s.scrubVelocity = 0;
      s.driftPausedUntil = 0;
    }
  }
  if (!s.scrubbing && !inertia && now >= s.driftPausedUntil && !s.dragActive) {
    const target = MARQUEE.SPEED * g;
    const k = 1 - Math.exp(-dt / (MARQUEE.DRIFT_RESUME_MS / 1000));
    s.driftVel += (target - s.driftVel) * k;
    s.offset += s.driftVel * dt;
  }
}

const cancelSeek = (s: MarqueeStrip) => {
  s.seek.active = false;
};

/** Press: cancel seek, stop the strip dead. */
export function beginGesture(s: MarqueeStrip): void {
  cancelSeek(s);
  s.dragActive = true;
  s.scrubbing = false;
  s.scrubVelocity = 0;
  s.driftVel = 0;
}

export function endGesture(s: MarqueeStrip): void {
  s.dragActive = false;
  s.scrubbing = false;
}

export function scrubBy(s: MarqueeStrip, d: number, now: number): void {
  cancelSeek(s);
  s.offset += d;
  s.scrubVelocity = 0;
  s.scrubbing = true;
  s.driftPausedUntil = now + MARQUEE.SCRUB_RESUME_DRIFT_MS;
  s.driftVel = 0;
}

/** Like `scrubBy` but does not set `scrubbing`. */
export function wheelScrub(s: MarqueeStrip, d: number, now: number): void {
  cancelSeek(s);
  s.offset += d;
  s.scrubVelocity = 0;
  s.driftPausedUntil = now + MARQUEE.SCRUB_RESUME_DRIFT_MS;
  s.driftVel = 0;
}

export function fling(s: MarqueeStrip, v: number): void {
  cancelSeek(s);
  s.dragActive = false;
  s.scrubbing = false;
  s.scrubVelocity = v;
  s.driftPausedUntil = 0;
  s.driftVel = 0;
}

/** Starts a seek by `d` cards; returns its duration in ms (0 if ignored). */
export function seekBy(s: MarqueeStrip, d: number, now: number): number {
  if (!Number.isFinite(d) || Math.abs(d) < 1e-4) return 0;
  cancelSeek(s);
  s.dragActive = false;
  s.scrubbing = false;
  s.scrubVelocity = 0;
  s.driftVel = 0;
  s.driftPausedUntil = 0;
  const durationMs = clamp(MARQUEE.SEEK_MS_MIN + MARQUEE.SEEK_MS_PER_CARD * Math.abs(d), MARQUEE.SEEK_MS_MIN, MARQUEE.SEEK_MS_MAX);
  s.seek = { active: true, from: s.offset, delta: d, startMs: now, durationMs };
  return durationMs;
}

export function setFocusHold(s: MarqueeStrip, held: boolean): void {
  s.focusHeld = held;
  if (held) {
    s.scrubbing = false;
    s.scrubVelocity = 0;
    s.driftVel = 0;
    s.dragActive = false;
    s.driftPausedUntil = 0;
  }
}

export function publishDriftGate(s: MarqueeStrip, g: number): void {
  s.driftGate = clamp(g, 0, 1);
}

export function isUserScrolling(s: MarqueeStrip, now: number): boolean {
  return s.scrubbing || Math.abs(s.scrubVelocity) > MARQUEE.SCRUB_MIN_VELOCITY || now < s.driftPausedUntil;
}

/** `initializeMarqueePreview(i)`: centre design `i`, freeze strip and time. */
export function initializeMarqueePreview(s: MarqueeStrip, index: number): void {
  cancelSeek(s);
  s.offset = index;
  s.time = 0;
  s.scrubVelocity = 0;
  s.driftVel = 0;
  s.driftPausedUntil = 0;
  s.dragActive = false;
  s.scrubbing = false;
  s.previewPaused = true;
}

export interface SlotAssignment {
  /** Logical card index (integer, may be negative). */
  logical: number;
  /** Wrapped strip position ∈ [−3.5, 3.5). */
  a: number;
  /** Design index `logical mod designCount`. */
  design: number;
}

/** The design shown by slot `e` at `offset`. */
export function assignSlot(e: number, offset: number, designCount: number): SlotAssignment {
  const a0 = e - offset;
  const n = Math.floor((a0 + HALF) / MARQUEE.POOL);
  const logical = e - MARQUEE.POOL * n;
  const a = a0 - MARQUEE.POOL * n;
  const design = designCount > 0 ? ((logical % designCount) + designCount) % designCount : 0;
  return { logical, a, design };
}

/** Seek distance for a click on `logical`. */
export function wrappedDistance(logical: number, offset: number): number {
  const r = logical - offset;
  return r - MARQUEE.POOL * Math.floor((r + HALF) / MARQUEE.POOL);
}
