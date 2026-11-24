/**
 * Thumbnail scheduler: preset and shader-picker thumbnails rendered on the offscreen thumbnail stage
 * without competing with the live card.
 *
 * - **Cached first.** Each request is keyed by `thumbCacheKey` (design hash + size + version). Hits
 *   come from memory or the persistent cache (`thumb-cache.ts`) and render nothing; a warm visit
 *   never even creates the thumbnail stage (a second WebGL context).
 * - **Lazy, by priority.** `visible` jobs (the preset category on screen, the open shader picker) go
 *   first; `idle` jobs (other categories) run only once the user has been idle for a moment.
 *   Nothing starts before the live card is up, and nothing runs while it rebuilds.
 * - **One per idle slot.** Each job waits for `requestIdleCallback` (with a timeout fallback, and a
 *   `setTimeout` fallback where it doesn't exist), builds the card (the stage compiles its programs
 *   in parallel with KHR_parallel_shader_compile before the first draw), yields to another idle slot,
 *   then renders + reads back in one short task, and yields two frames before the next job.
 * - **One design at a time.** The offscreen stage holds one card: `exclusive` serialises other users
 *   (draft thumbnails) with the queue.
 */
import { defaultDesign } from "../state/design.ts";
import type { CardDesign } from "@card3d/core/model";
import type { CaptureStage } from "./offscreen.ts";
import { renderThumb } from "./exporters.ts";
import { thumbCacheKey } from "./thumb-key.ts";
import type { ThumbCache } from "./thumb-cache.ts";

export type ThumbPriority = "visible" | "idle";

export interface ThumbRequest {
  /** Caller's id (preset id, picker key); `onThumb` reports it. */
  id: string;
  design: CardDesign;
  width: number;
  height: number;
}

export interface ThumbSchedulerDeps {
  /** The thumbnail stage, called under `exclusive` (it may be a new one after an idle while). */
  stage(): CaptureStage;
  cache: ThumbCache;
  version: string;
  /** True when the live card is up and not rebuilding (thumbnails wait otherwise). */
  liveReady(): boolean;
  /** When the live card was last built (performance.now()); idle work leaves it a moment to settle. */
  liveBuiltAt(): number;
  /** The live card renders every frame (animated, glass): its GPU is never idle, so idle work is paced. */
  liveAnimated(): boolean;
}

interface Job extends ThumbRequest {
  key: string;
  priority: ThumbPriority;
  seq: number;
  listeners: ((id: string, url: string) => void)[];
}

/** Idle-priority work waits this long after the last pointer/key/wheel input… */
const INPUT_QUIET_MS = 1500;
/** …and after the live card was (re)built (its intro / grow-in plays then). */
const BUILD_QUIET_MS = 6000;
/** Idle-priority jobs start at least this far apart while the live card animates. */
const ANIMATED_GAP_MS = 1500;

export interface ThumbStats {
  rendered: number;
  cached: number;
  /** Per rendered job: build (ms, async), draw + readback (ms, one task). */
  jobs: { id: string; at: number; buildMs: number; drawMs: number }[];
}

export class ThumbScheduler {
  private readonly mem = new Map<string, string>();
  private readonly queue = new Map<string, Job>(); // by cache key
  private seq = 0;
  private running = false;
  private lock: Promise<unknown> = Promise.resolve();
  /** The stage that drew its warm-up frame (`deps.stage()` makes a new one after an idle while). */
  private warmed: CaptureStage | null = null;
  private lastInput = 0;
  private lastIdleJob = -Infinity;
  readonly stats: ThumbStats = { rendered: 0, cached: 0, jobs: [] };

  constructor(private readonly deps: ThumbSchedulerDeps) {
    if (typeof window !== "undefined") {
      const note = () => (this.lastInput = performance.now());
      for (const t of ["pointerdown", "keydown", "wheel"]) window.addEventListener(t, note, { capture: true, passive: true });
    }
  }

  /**
   * Thumbnails for `items`: each is delivered through `onThumb` as soon as it is known (memory and
   * storage hits right away, renders as they finish). Re-requesting a pending item raises its priority.
   */
  request(items: readonly ThumbRequest[], priority: ThumbPriority, onThumb: (id: string, url: string) => void): void {
    const lookups: Job[] = [];
    for (const it of items) {
      let key: string;
      try {
        key = thumbCacheKey({ design: it.design, width: it.width, height: it.height, version: this.deps.version });
      } catch (err) {
        console.warn("[studio] thumbnail key failed", it.id, err);
        continue;
      }
      const hit = this.mem.get(key);
      if (hit) {
        onThumb(it.id, hit);
        continue;
      }
      const queued = this.queue.get(key);
      if (queued) {
        if (priority === "visible") queued.priority = "visible";
        queued.listeners.push(onThumb);
        continue;
      }
      lookups.push({ ...it, key, priority, seq: this.seq++, listeners: [onThumb] });
    }
    if (!lookups.length) return void this.pump();
    // Queue first (so duplicates coalesce), then resolve storage hits before anything renders.
    for (const j of lookups) this.queue.set(j.key, j);
    const pending = this.deps.cache.getMany(lookups.map((j) => j.key)).then((hits) => {
      for (const [key, url] of hits) {
        const j = this.queue.get(key);
        this.mem.set(key, url);
        this.stats.cached++;
        if (!j) continue;
        this.queue.delete(key);
        for (const l of j.listeners) l(j.id, url);
      }
    });
    this.storage = this.storage.then(() => pending);
    void this.pump();
  }

  /** Raise queued items to `visible` (e.g. the category the user switched to). */
  prioritize(ids: readonly string[]): void {
    const want = new Set(ids);
    for (const j of this.queue.values()) if (want.has(j.id)) j.priority = "visible";
  }

  /** Run `fn` with the thumbnail stage to itself (between queued jobs). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => undefined);
    return p;
  }

  private storage: Promise<unknown> = Promise.resolve();

  private next(): Job | null {
    let best: Job | null = null;
    for (const j of this.queue.values()) {
      if (!best || rank(j) < rank(best) || (rank(j) === rank(best) && j.seq < best.seq)) best = j;
    }
    return best;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.size) {
        await this.storage; // storage hits never render (requests made meanwhile included)
        await this.whenLiveReady();
        let job = this.next();
        if (!job) break;
        await this.slot(job.priority, true);
        job = this.next(); // priorities may have changed while waiting
        if (!job) break;
        this.queue.delete(job.key);
        await this.exclusive(() => this.render(job!));
        await frames(2);
      }
    } finally {
      this.running = false;
    }
    if (this.queue.size) void this.pump();
  }

  private async render(job: Job): Promise<void> {
    try {
      const off = this.deps.stage();
      if (this.warmed !== off) {
        // A fresh stage's first frame can precede its environment upload: draw (and drop) one first.
        const base = defaultDesign();
        base.cardholderName = "";
        await off.setDesign(base, "warm-up");
        await this.slot(job.priority);
        off.frame({ width: job.width, height: job.height });
        this.warmed = off;
        await this.slot(job.priority);
      }
      const t0 = performance.now();
      await off.setDesign(job.design, job.key); // builds + compiles in parallel (async)
      const buildMs = performance.now() - t0;
      await this.slot(job.priority); // yield: the draw + readback below is one task
      const t1 = performance.now();
      // Two frames between draw and readback: the readback then doesn't wait on the GPU (which the
      // live card keeps busy), so the task stays short.
      const url = await renderThumb(off, job.design, job.width, job.height, job.key, () => frames(2));
      this.stats.jobs.push({ id: job.id, at: Math.round(t0), buildMs: Math.round(buildMs), drawMs: Math.round(performance.now() - t1) });
      this.stats.rendered++;
      this.mem.set(job.key, url);
      this.deps.cache.put(job.key, url);
      for (const l of job.listeners) l(job.id, url);
    } catch (err) {
      console.warn("[studio] thumbnail failed", job.id, err);
    }
  }

  private async whenLiveReady(): Promise<void> {
    while (!this.deps.liveReady()) await sleep(200);
  }

  /**
   * One idle slot for `priority`: idle work also waits for quiet input and a settled live card, and
   * (`start`, the slot that begins a job) keeps jobs apart while the live card animates.
   */
  private async slot(priority: ThumbPriority, start = false): Promise<void> {
    if (priority === "idle") {
      for (;;) {
        const now = performance.now();
        const wait = Math.max(
          INPUT_QUIET_MS - (now - this.lastInput),
          BUILD_QUIET_MS - (now - this.deps.liveBuiltAt()),
          start && this.deps.liveAnimated() ? ANIMATED_GAP_MS - (now - this.lastIdleJob) : 0,
        );
        if (wait <= 0) break;
        await sleep(wait + 20);
      }
      await idle(4000, 8);
      if (start) this.lastIdleJob = performance.now();
    } else {
      await idle(400, 3);
    }
  }
}

const rank = (j: Job) => (j.priority === "visible" ? 0 : 1);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frames = (n: number) =>
  new Promise<void>((r) => {
    const step = () => (--n <= 0 ? r() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

/**
 * Resolves in an idle period with at least `minMs` left, or after `timeoutMs` regardless (so work
 * still happens on a busy page). Falls back to a short timeout without requestIdleCallback (Safari).
 */
function idle(timeoutMs: number, minMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback !== "function") {
      setTimeout(resolve, 60);
      return;
    }
    const start = performance.now();
    const ask = () => {
      const left = timeoutMs - (performance.now() - start);
      requestIdleCallback(
        (d) => {
          if (d.didTimeout || d.timeRemaining() >= minMs || performance.now() - start >= timeoutMs) resolve();
          else ask();
        },
        { timeout: Math.max(1, left) },
      );
    };
    ask();
  });
}
