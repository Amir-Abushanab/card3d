import { describe, expect, it } from "vitest";
import { AdaptiveResolution } from "./adaptive-resolution.ts";

/** Feed `seconds` of frames at `fps`, each costing cost(ratio) ms; returns the changes. */
function run(ctl: AdaptiveResolution, from: number, seconds: number, cost: (ratio: number) => number, fps = 60) {
  const changes: { t: number; ratio: number; direction: string }[] = [];
  for (let t = from; t < from + seconds; t += 1 / fps) {
    const c = ctl.sample(cost(ctl.ratio), t);
    if (c) changes.push({ t, ratio: c.ratio, direction: c.direction });
  }
  return changes;
}

/** GPU cost proportional to the pixel count. */
const gpu = (msAtOne: number) => (r: number) => msAtOne * r * r;

describe("AdaptiveResolution", () => {
  it("lists levels from max down to min on the step grid", () => {
    expect(new AdaptiveResolution({ max: 2, min: 1, budgetMs: 14 }).levels()).toEqual([2, 1.75, 1.5, 1.25, 1]);
    expect(new AdaptiveResolution({ max: 1.6, min: 1, budgetMs: 14 }).levels()).toEqual([1.6, 1.35, 1.1, 1]);
    expect(new AdaptiveResolution({ max: 1, min: 1, budgetMs: 14 }).levels()).toEqual([1]);
  });

  it("stays at full ratio within budget", () => {
    const ctl = new AdaptiveResolution({ max: 2, min: 1, budgetMs: 14 });
    expect(run(ctl, 0, 20, gpu(2.5))).toEqual([]); // 10 ms at 2
    expect(ctl.ratio).toBe(2);
  });

  it("ignores short spikes (median, sustained for downAfter)", () => {
    const ctl = new AdaptiveResolution({ max: 2, min: 1, budgetMs: 14 });
    let i = 0;
    const changes = run(ctl, 0, 10, () => (i++ % 10 === 0 ? 80 : 8));
    expect(changes).toEqual([]);
    // a 0.5 s burst over budget is not sustained either
    expect(run(ctl, 10, 0.5, () => 30)).toEqual([]);
    expect(run(ctl, 10.5, 5, () => 8)).toEqual([]);
  });

  it("jumps down to the level predicted to fit, after ~downAfter", () => {
    const ctl = new AdaptiveResolution({ max: 2, min: 1, budgetMs: 14 });
    const changes = run(ctl, 0, 3, gpu(5)); // 20 ms at 2 → want 2·sqrt(12.6/20) ≈ 1.59 → 1.5
    expect(changes.length).toBe(1);
    expect(changes[0]!.ratio).toBe(1.5);
    expect(changes[0]!.t).toBeGreaterThan(1);
    expect(changes[0]!.t).toBeLessThan(1.5);
  });

  it("never goes below min", () => {
    const ctl = new AdaptiveResolution({ max: 2, min: 1, budgetMs: 14 });
    run(ctl, 0, 30, gpu(40));
    expect(ctl.ratio).toBe(1);
  });

  it("settles without oscillating when the cost hovers around the budget", () => {
    const ctl = new AdaptiveResolution({ max: 2, min: 1, budgetMs: 14 });
    const changes = run(ctl, 0, 120, gpu(3.6)); // 14.4 ms at 2 (just over), 11 ms at 1.75
    expect(changes.map((c) => c.ratio)).toEqual([1.75]);
  });

  it("steps back up, one level at a time, once there is headroom for upAfter", () => {
    const ctl = new AdaptiveResolution({ max: 2, min: 1, budgetMs: 14 });
    run(ctl, 0, 5, gpu(10)); // heavy: down to 1
    expect(ctl.ratio).toBe(1);
    const changes = run(ctl, 5, 40, gpu(1)); // light: 4 ms at 2
    expect(changes.map((c) => c.ratio)).toEqual([1.25, 1.5, 1.75, 2]);
    for (let i = 1; i < changes.length; i++) expect(changes[i]!.t - changes[i - 1]!.t).toBeGreaterThanOrEqual(3);
  });

  it("does not step up when the next level is predicted over budget·upHeadroom", () => {
    const ctl = new AdaptiveResolution({ max: 2, min: 1, budgetMs: 14 });
    run(ctl, 0, 3, gpu(4)); // 16 ms at 2 → down
    expect(ctl.ratio).toBeLessThan(2);
    const r = ctl.ratio;
    expect(run(ctl, 3, 60, gpu(4))).toEqual([]); // 16·(2/r)² ... stays
    expect(ctl.ratio).toBe(r);
  });

  it("non-predictive (frame intervals): probes up, and blocks a failing level with growing back-off", () => {
    const ctl = new AdaptiveResolution({ max: 2, min: 1, budgetMs: 20, predictive: false });
    // 60 Hz vsync; anything above 1.5 can't keep up (33 ms intervals)
    const interval = (r: number) => (r > 1.5 ? 33.3 : 16.7);
    const changes = run(ctl, 0, 200, interval);
    const ups = changes.filter((c) => c.direction === "up");
    expect(ctl.ratio).toBe(1.5);
    // one step at a time down to 1.5, then at most maxRetries (3) failed probes of 1.75, spaced out
    expect(ups.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < ups.length; i++) expect(ups[i]!.t - ups[i - 1]!.t).toBeGreaterThan(8);
    // and after that it stays put for good
    expect(run(ctl, 200, 300, interval)).toEqual([]);
  });

  it("reset returns to max and forgets blocked levels", () => {
    const ctl = new AdaptiveResolution({ max: 2, min: 1, budgetMs: 14 });
    run(ctl, 0, 5, gpu(10));
    expect(ctl.ratio).toBe(1);
    ctl.reset();
    expect(ctl.ratio).toBe(2);
    ctl.reset({ max: 1.25 });
    expect(ctl.ratio).toBe(1.25);
    expect(ctl.levels()).toEqual([1.25, 1]);
  });

  it("ignores samples while settling after a change, and junk samples", () => {
    const ctl = new AdaptiveResolution({ max: 2, min: 1, budgetMs: 14, settle: 1 });
    const c = run(ctl, 0, 2, gpu(10));
    expect(c.length).toBe(1);
    const t = c[0]!.t;
    for (let x = t; x < t + 0.99; x += 1 / 60) expect(ctl.sample(1000, x)).toBeNull();
    expect(ctl.sample(Number.NaN, 100)).toBeNull();
    expect(ctl.sample(-1, 100)).toBeNull();
  });
});
