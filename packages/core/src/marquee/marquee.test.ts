import { describe, expect, it } from "vitest";
import { MARQUEE, PERSP, VIEWPORT_H, hash, mulberry32, seekEase } from "./constants.ts";
import {
  advanceMarqueeDrift,
  assignSlot,
  beginGesture,
  createMarqueeStrip,
  fling,
  initializeMarqueePreview,
  scrubBy,
  seekBy,
  wrappedDistance,
} from "./strip.ts";
import { computeMarqueeLayout, computeSlotPose, frameInputs, slotRandoms, DEFAULT_MARQUEE_LAYOUT, type LogicalJitter } from "./pose.ts";
import { shuffleMarqueeOrder, resolveMarqueePin } from "./designs.ts";

const ZERO_JITTER: LogicalJitter = { jYaw: 0, jPitch: 0, jRoll: 0, jPhase: 0 };

describe("constants", () => {
  it("derived values", () => {
    expect(PERSP).toBeCloseTo(0.816667, 6);
    expect(VIEWPORT_H).toBeCloseTo(7.337536, 5);
    expect(Math.cos(MARQUEE.ORBIT_HALF_ANGLE)).toBeCloseTo(0.408487, 6);
  });
  it("hash is fract(43758.5453·sin(12.9898x))", () => {
    expect(hash(0)).toBe(0);
    const v = 43758.5453 * Math.sin(12.9898 * 3);
    expect(hash(3)).toBeCloseTo(v - Math.floor(v), 12);
  });
  it("seekEase meets at (0.4, 0.5714) and ends at 1", () => {
    expect(seekEase(0)).toBe(0);
    expect(seekEase(0.4)).toBeCloseTo(0.5714, 10);
    expect(seekEase(0.3999999)).toBeCloseTo(0.5714, 5);
    expect(seekEase(1)).toBeCloseTo(1, 10);
  });
});

describe("pose", () => {
  const frame = frameInputs(DEFAULT_MARQUEE_LAYOUT, 16 / 9);
  it("frame inputs at the default layout", () => {
    expect(frame.w).toBeCloseTo(0.846, 3);
    expect(frame.yRow).toBeCloseTo(0.7191, 4);
  });
  // a, u→(y drop, z), yaw, roll
  const rows: [number, number, number, number, number][] = [
    [0, 0, 2.2, 0, 0],
    [0.25, -0.009, 2.143, 0.081, 0.007],
    [0.5, -0.037, 1.973, 0.191, 0.026],
    [1, -0.148, 1.3, 0.456, 0.082],
    [1.5, -0.326, 0.211, 0.714, 0.13],
    [2, -0.566, -1.25, 0.883, 0.14],
    [2.5, -0.856, -3.02, 1.009, 0.14],
    [2.8, -1.05, -4.2, 1.084, 0.14],
    [3.5, -1.05, -4.2, 1.168, 0.14],
  ];
  for (const [a, drop, z, yaw, roll] of rows) {
    it(`a = ${a}`, () => {
      for (const sgn of [1, -1]) {
        const p = computeSlotPose({ a: sgn * a, t: 0, frame, slot: slotRandoms(0), jitter: ZERO_JITTER });
        expect(p.y - frame.yRow).toBeCloseTo(drop, 2);
        expect(p.z).toBeCloseTo(z, 2);
        expect(p.yaw).toBeCloseTo(sgn * yaw, 2);
        expect(p.roll).toBeCloseTo(sgn * roll, 2);
        expect(p.x).toBeCloseTo(sgn * a * 4, 10);
        expect(p.scale).toBeCloseTo(frame.w, 10);
      }
    });
  }
  it("preview override", () => {
    const turn = { yaw: 0.3, pitch: 0.1, flip: Math.PI, stand: 0 };
    const p = computeSlotPose({ a: 0, t: 5, frame, slot: slotRandoms(2), jitter: ZERO_JITTER, turn, previewPaused: true });
    expect(p.scale).toBeCloseTo(frame.w, 10);
    expect(p.yaw).toBeCloseTo(0.3 + Math.PI, 10);
    expect(p.pitch).toBeCloseTo(0.1, 10);
    expect(p.roll).toBe(0);
  });
  it("intro: hidden at arriveT 0, steady at arriveT 1", () => {
    const base = { a: 1.2, t: 3, frame, slot: slotRandoms(4), jitter: ZERO_JITTER };
    expect(computeSlotPose({ ...base, introT: 0, introDone: false }).visible).toBe(false);
    const end = computeSlotPose({ ...base, introT: 1, introDone: false });
    const steady = computeSlotPose(base);
    for (const k of ["x", "y", "z", "yaw", "roll", "pitch", "scale"] as const) expect(end[k]).toBeCloseTo(steady[k], 6);
  });
});

describe("strip", () => {
  it("assign maps slots into [−3.5, 3.5)", () => {
    for (const offset of [0, 0.3, 3.5, 7.2, -2.7, 100.49]) {
      const seen = new Set<number>();
      for (let e = 0; e < 7; e++) {
        const s = assignSlot(e, offset, 63);
        expect(s.a).toBeGreaterThanOrEqual(-3.5);
        expect(s.a).toBeLessThan(3.5);
        expect(s.logical - offset).toBeCloseTo(s.a, 10);
        expect(s.design).toBe(((s.logical % 63) + 63) % 63);
        seen.add(s.logical);
      }
      expect(seen.size).toBe(7);
    }
    // at offset 0 the three slots left of centre are the last three designs (thermal, pool, camera)
    const left = [4, 5, 6].map((e) => assignSlot(e, 0, 63).design).sort();
    expect(left).toEqual([60, 61, 62]);
  });
  it("wrappedDistance", () => {
    expect(wrappedDistance(2, 0)).toBe(2);
    expect(wrappedDistance(5, 0)).toBe(-2);
  });
  it("drift relaxes to 0.24 cards/s with τ = 420 ms", () => {
    const s = createMarqueeStrip();
    advanceMarqueeDrift(s, 1000); // primes
    expect(s.offset).toBe(0);
    let now = 1000;
    for (let i = 0; i < 600; i++) advanceMarqueeDrift(s, (now += 1000 / 60));
    expect(s.driftVel).toBeCloseTo(0.24, 6);
    expect(s.time).toBeCloseTo(10, 6);
    // after 10 s from rest the lag costs ≈ τ·v = 0.42·0.24
    expect(s.offset).toBeCloseTo(2.4 - 0.42 * 0.24, 1);
  });
  it("gate 0 holds the strip", () => {
    const s = createMarqueeStrip();
    advanceMarqueeDrift(s, 1, 0);
    advanceMarqueeDrift(s, 2001, 0);
    expect(s.offset).toBe(0);
    expect(s.time).toBeCloseTo(2, 9);
  });
  it("press stops dead; fling decays with friction 3.4/s then hands over to drift", () => {
    const s = createMarqueeStrip();
    s.driftVel = 0.24;
    beginGesture(s);
    expect(s.driftVel).toBe(0);
    scrubBy(s, 0.5, 0);
    expect(s.offset).toBe(0.5);
    fling(s, 2);
    let now = 1;
    advanceMarqueeDrift(s, now);
    advanceMarqueeDrift(s, (now += 100));
    expect(s.scrubVelocity).toBeCloseTo(2 * Math.exp(-0.34), 9);
    for (let i = 0; i < 200; i++) advanceMarqueeDrift(s, (now += 16));
    expect(s.scrubVelocity).toBe(0);
  });
  it("seek: duration clamp(900 + 150|d|) and lands exactly", () => {
    const s = createMarqueeStrip();
    expect(seekBy(s, 2, 0)).toBe(1200);
    expect(seekBy(s, 10, 0)).toBe(1300);
    expect(seekBy(s, 0, 0)).toBe(0);
    s.offset = 0;
    seekBy(s, 2, 100);
    advanceMarqueeDrift(s, 100);
    advanceMarqueeDrift(s, 100 + 1400);
    expect(s.offset).toBe(2);
    expect(s.seek.active).toBe(false);
  });
  it("preview freezes time and offset", () => {
    const s = createMarqueeStrip();
    initializeMarqueePreview(s, 12);
    advanceMarqueeDrift(s, 1);
    advanceMarqueeDrift(s, 5000);
    expect(s.offset).toBe(12);
    expect(s.time).toBe(0);
  });
});

describe("layout", () => {
  it("wide viewport clamps to 372 px", () => {
    const l = computeMarqueeLayout({ width: 1440, height: 900 });
    expect(l.centerHeightFrac * 900).toBeCloseTo(372, 6);
    expect(l.cardSpacing).toBeCloseTo((4 * l.centerHeightFrac) / 0.3, 10);
    expect(l.rowYFrac).toBe(-0.12);
  });
  it("band centres the row and caps the height", () => {
    const l = computeMarqueeLayout({ width: 1440, height: 900, band: { top: 80, bottom: 380 } });
    expect(l.centerHeightFrac * 900).toBeCloseTo(300, 6);
    expect(l.rowYFrac).toBeCloseTo((230 - 450) / 900, 10);
  });
  it("narrow viewport: 30–40 % of height", () => {
    const l = computeMarqueeLayout({ width: 390, height: 844 });
    expect(l.centerHeightFrac).toBeGreaterThanOrEqual(0.2);
    expect(l.rowYFrac).toBe(-0.02);
  });
});

describe("design order and pin", () => {
  const mk = (name: string, extra: { id?: string; aliases?: string[] } = {}) => ({ cardholderName: name, id: extra.id, aliases: extra.aliases });
  const base = [
    ...Array.from({ length: 60 }, (_, i) => mk(`R${i}`)),
    mk("Grace Hopper", { aliases: ["shutter"] }),
    mk("Ada Lovelace", { id: "sample-61" }),
    mk("Alan Turing", { aliases: ["lens"] }),
  ];
  it("shuffles every design; seeded = reproducible", () => {
    const a = shuffleMarqueeOrder(base, mulberry32(42));
    const b = shuffleMarqueeOrder(base, mulberry32(42));
    const c = shuffleMarqueeOrder(base, mulberry32(43));
    expect(a.map((d) => d.cardholderName)).toEqual(b.map((d) => d.cardholderName));
    expect(a.map((d) => d.cardholderName)).not.toEqual(c.map((d) => d.cardholderName));
    expect(a.length).toBe(63);
    expect(new Set(a)).toEqual(new Set(base));
  });
  it("pin by alias, id, full name, first name, index", () => {
    const list = shuffleMarqueeOrder(base, mulberry32(1));
    const at = (name: string) => list.findIndex((d) => d.cardholderName === name);
    expect(resolveMarqueePin(list, "lens")).toBe(at("Alan Turing"));
    expect(resolveMarqueePin(list, "alan")).toBe(at("Alan Turing"));
    expect(resolveMarqueePin(list, "SAMPLE-61")).toBe(at("Ada Lovelace"));
    expect(resolveMarqueePin(list, "Ada Lovelace")).toBe(at("Ada Lovelace"));
    expect(resolveMarqueePin(list, 7)).toBe(7);
    expect(resolveMarqueePin(list, "shutter")).toBe(at("Grace Hopper"));
    expect(resolveMarqueePin(list, "nobody")).toBe(-1);
  });
});
