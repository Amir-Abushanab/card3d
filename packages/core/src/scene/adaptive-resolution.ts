/**
 * Adaptive resolution for a continuously rendering stage: lower the device-pixel ratio while frames
 * cost more than a budget, raise it again when there is clear headroom. Pure (time is passed in), so
 * the stepping and hysteresis rules are unit-tested; `GpuFrameTimer` below supplies GPU times.
 *
 * Rules:
 * - Decisions use the median of the recent samples (robust to one-off spikes such as a texture upload).
 * - **Down** when the median stays above `budgetMs` for `downAfter` s. With `predictive` costs (GPU
 *   time, which scales with the pixel count, i.e. ratio²) it jumps straight to the level expected to
 *   fit (`ratio·sqrt(0.9·budget / median)`, snapped down to the step grid); otherwise one step.
 * - **Up** one step when the median stays low enough for `upAfter` s: predictive, the cost expected at
 *   the next level (`median·(next/ratio)²`) must be ≤ `budget·upHeadroom`, so stepping up cannot put it
 *   back over budget unless the prediction is off by more than 1/upHeadroom; non-predictive (frame
 *   intervals, which are quantised by vsync and say nothing about headroom), the median must be
 *   ≤ `budget·upHeadroom` and the step up is a probe.
 * - A level that had to be left downwards is **blocked** for `retryAfter` s, doubling on every failure,
 *   and permanently after `maxRetries` failures (until `reset`). So the ratio never oscillates: at
 *   most a few spaced-out probes, then it settles.
 * - After every change, samples are ignored for `settle` s (the new size takes effect, timer queries
 *   in flight still report the old one).
 */

export interface AdaptiveResolutionConfig {
  /** Full (and highest) ratio. */
  max: number;
  /** Floor. */
  min: number;
  /** Ratio step (grid anchored at `max`; `min` is always a level). Default 0.25. */
  step?: number;
  /** Frame cost budget, ms. */
  budgetMs: number;
  /** Costs scale with the pixel count (GPU time): jump to the predicted level, predict before stepping up. Default true. */
  predictive?: boolean;
  /** Seconds above budget before stepping down. Default 1. */
  downAfter?: number;
  /** Seconds with headroom before stepping up. Default 3. */
  upAfter?: number;
  /** Fraction of the budget the (predicted) cost must stay under to step up. Default 0.8. */
  upHeadroom?: number;
  /** Seconds to ignore samples after a change. Default 0.5. */
  settle?: number;
  /** Seconds a failed level stays blocked (doubles per failure). Default 8. */
  retryAfter?: number;
  /** Failures after which a level stays blocked until `reset`. Default 3. */
  maxRetries?: number;
  /** Samples in the median window. Default 24. */
  window?: number;
}

export interface AdaptiveResolutionChange {
  ratio: number;
  previous: number;
  direction: "down" | "up";
  /** Median frame cost (ms) that triggered the change. */
  frameMs: number;
}

const EPS = 1e-6;

export class AdaptiveResolution {
  private cfg: Required<AdaptiveResolutionConfig>;
  private current: number;
  private samples: number[] = [];
  private overSince: number | null = null;
  private underSince: number | null = null;
  private ignoreUntil = -Infinity;
  private readonly failures = new Map<number, { count: number; until: number }>();

  constructor(cfg: AdaptiveResolutionConfig) {
    this.cfg = AdaptiveResolution.normalize(cfg);
    this.current = this.cfg.max;
  }

  private static normalize(cfg: AdaptiveResolutionConfig): Required<AdaptiveResolutionConfig> {
    const max = Math.max(EPS, cfg.max);
    return {
      step: 0.25,
      predictive: true,
      downAfter: 1,
      upAfter: 3,
      upHeadroom: 0.8,
      settle: 0.5,
      retryAfter: 8,
      maxRetries: 3,
      window: 24,
      ...cfg,
      max,
      min: Math.min(max, Math.max(EPS, cfg.min)),
    };
  }

  /** Current ratio. */
  get ratio(): number {
    return this.current;
  }

  get config(): Readonly<Required<AdaptiveResolutionConfig>> {
    return this.cfg;
  }

  /** The ratio levels, highest first: max, max − step, …, down to and including min. */
  levels(): number[] {
    const { max, min, step } = this.cfg;
    const out: number[] = [];
    for (let r = max; r > min + EPS; r = round(r - step)) out.push(round(r));
    out.push(round(min));
    return out;
  }

  /** Back to `max` (or a new config), forgetting samples and blocked levels. */
  reset(cfg?: Partial<AdaptiveResolutionConfig>): void {
    if (cfg) this.cfg = AdaptiveResolution.normalize({ ...this.cfg, ...cfg });
    this.current = this.cfg.max;
    this.failures.clear();
    this.clearStats();
    this.ignoreUntil = -Infinity;
  }

  /** Forget the samples and timers (e.g. another card), keeping the ratio and blocked levels. */
  clearStats(): void {
    this.samples = [];
    this.overSince = null;
    this.underSince = null;
  }

  /**
   * Feed one frame's cost (ms) observed at `now` (seconds, monotonic). Returns the change when the
   * ratio changed, else null.
   */
  sample(ms: number, now: number): AdaptiveResolutionChange | null {
    if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(now)) return null;
    if (now < this.ignoreUntil) return null;
    const c = this.cfg;
    this.samples.push(ms);
    if (this.samples.length > c.window) this.samples.shift();
    if (this.samples.length < Math.min(c.window, 8)) return null;
    const med = median(this.samples);

    if (med > c.budgetMs) {
      this.underSince = null;
      this.overSince ??= now;
      if (now - this.overSince >= c.downAfter && this.current > c.min + EPS) {
        const levels = this.levels();
        const i = levels.findIndex((l) => l <= this.current + EPS);
        let next = levels[Math.min(levels.length - 1, i + 1)]!;
        if (c.predictive) {
          const want = this.current * Math.sqrt((0.9 * c.budgetMs) / med);
          next = levels.find((l) => l <= want + EPS) ?? levels[levels.length - 1]!;
          next = Math.min(next, levels[Math.min(levels.length - 1, i + 1)]!);
        }
        this.block(this.current, now);
        return this.change(next, "down", med, now);
      }
      return null;
    }
    this.overSince = null;

    if (this.current < c.max - EPS) {
      const levels = this.levels();
      const i = levels.findIndex((l) => l <= this.current + EPS);
      const next = levels[Math.max(0, i - 1)]!;
      const expected = c.predictive ? med * (next / this.current) ** 2 : med;
      if (expected <= c.budgetMs * c.upHeadroom && !this.blocked(next, now)) {
        this.underSince ??= now;
        if (now - this.underSince >= c.upAfter) return this.change(next, "up", med, now);
        return null;
      }
    }
    this.underSince = null;
    return null;
  }

  private change(ratio: number, direction: "down" | "up", frameMs: number, now: number): AdaptiveResolutionChange | null {
    const previous = this.current;
    if (Math.abs(ratio - previous) < EPS) return null;
    this.current = ratio;
    this.clearStats();
    this.ignoreUntil = now + this.cfg.settle;
    return { ratio, previous, direction, frameMs };
  }

  /** The level we leave downwards failed: block it, longer each time. */
  private block(level: number, now: number): void {
    const key = round(level);
    const f = this.failures.get(key) ?? { count: 0, until: 0 };
    f.count++;
    f.until = f.count >= this.cfg.maxRetries ? Infinity : now + this.cfg.retryAfter * 2 ** (f.count - 1);
    this.failures.set(key, f);
  }

  private blocked(level: number, now: number): boolean {
    const f = this.failures.get(round(level));
    return !!f && now < f.until;
  }
}

function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

function median(a: readonly number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ── GPU frame timer (EXT_disjoint_timer_query_webgl2) ────────────────────────

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/**
 * Measures GPU time per frame with `EXT_disjoint_timer_query_webgl2`: wrap each frame in
 * `begin()` / `end()`, then `poll()` returns the frames whose results have arrived (a few frames
 * later), in ms. Results spanning a disjoint event (GPU reset, power change) are dropped. `create`
 * returns null when the extension (or WebGL2) is unavailable.
 * @archive the local three.js archive (.archive/three-engine) imports it
 */
export class GpuFrameTimer {
  private readonly pending: WebGLQuery[] = [];
  private readonly free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ext: TimerExt,
  ) {}

  static create(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuFrameTimer | null {
    if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) return null;
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
    return ext ? new GpuFrameTimer(gl, ext) : null;
  }

  begin(): void {
    if (this.active || this.pending.length > 8) return; // results stalled: skip frames rather than pile up
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Drop the frames still in flight (they measured something no longer on screen). */
  discardPending(): void {
    this.dropUntil = this.pending.length;
  }
  private dropUntil = 0;

  /** Completed frames since the last poll, oldest first (ms). */
  poll(): number[] {
    const { gl } = this;
    const out: number[] = [];
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const q = this.pending[0]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (this.dropUntil > 0) this.dropUntil--;
      else if (!disjoint) out.push(ns / 1e6);
      this.free.push(q);
    }
    return out;
  }

  dispose(): void {
    if (this.active) this.end();
    for (const q of [...this.pending, ...this.free]) this.gl.deleteQuery(q);
    this.pending.length = 0;
    this.free.length = 0;
  }
}
