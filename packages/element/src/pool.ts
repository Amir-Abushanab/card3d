/**
 * Live WebGL contexts across every `<metal-card>` on the page.
 *
 * Each live card renders on its own canvas and WebGL context. Browsers cap the number of contexts a
 * page may hold (Chrome and Safari: 16; past it the oldest is lost without warning), so cards only
 * take a context while they are near the viewport, and at most `limit` are live at once. When another
 * card needs one and the pool is full, the card that left the viewport longest ago is *parked*: its
 * last frame stays on screen as a still image, its context is released, and it takes a context again
 * (rebuilding its card) when it scrolls back into view. Cards on screen are never parked; if more
 * than `limit` are visible at once, the extra ones wait (showing their still, if any) until a slot
 * frees up.
 */

export interface PoolMember {
  /** Near the viewport now. */
  readonly visible: boolean;
  /** `performance.now()` when it last left the viewport. */
  readonly hiddenSince: number;
  /**
   * Release the context (keep a still frame on screen). A promise: the context goes later (the engine
   * was still starting), and the slot stays taken until it settles.
   */
  park(): void | Promise<void>;
  /** A slot is free: take a context. */
  grant(): void;
}

class ContextPool {
  /** Default 12: leaves headroom under the browsers' 16 for the page's own WebGL. */
  limit = 12;
  private readonly live = new Set<PoolMember>();
  private readonly waiting = new Set<PoolMember>();
  /** Parked members whose context isn't gone yet: their slots stay taken. */
  private draining = 0;

  get size(): number {
    return this.live.size;
  }

  /** Parks `victim`; false when its slot frees only later (then the next waiting card gets it). */
  private evict(victim: PoolMember): boolean {
    this.live.delete(victim);
    const later = victim.park();
    if (!later) return true;
    this.draining++;
    void later.finally(() => {
      this.draining--;
      this.grantNext();
    });
    return false;
  }

  /** A slot is free: the first visible waiting card takes it. */
  private grantNext(): void {
    if (this.live.size + this.draining >= this.limit) return;
    for (const w of this.waiting) {
      if (!w.visible) continue;
      this.waiting.delete(w);
      this.live.add(w);
      w.grant();
      break;
    }
  }

  /** Whether `m` holds a slot now. */
  holds(m: PoolMember): boolean {
    return this.live.has(m);
  }

  /** Ask for a context. True: take it now. False: queued, `grant()` follows when one frees up. */
  request(m: PoolMember): boolean {
    if (this.live.has(m)) return true;
    if (this.live.size + this.draining >= this.limit) {
      let victim: PoolMember | null = null;
      for (const o of this.live) if (!o.visible && (!victim || o.hiddenSince < victim.hiddenSince)) victim = o;
      if (!victim || !this.evict(victim)) {
        this.waiting.add(m);
        return false;
      }
    }
    this.waiting.delete(m);
    this.live.add(m);
    return true;
  }

  /**
   * The member's context is gone (parked, disconnected) or it no longer wants one. `later`: the
   * context goes when it settles (its slot stays taken until then).
   */
  release(m: PoolMember, later?: Promise<void>): void {
    this.waiting.delete(m);
    if (!this.live.delete(m)) return;
    if (!later) return this.grantNext();
    this.draining++;
    void later.finally(() => {
      this.draining--;
      this.grantNext();
    });
  }

  /** A live member left the viewport: hand its slot to a visible card that is waiting, if any. */
  rebalance(): void {
    for (const w of this.waiting) {
      if (!w.visible) continue;
      let victim: PoolMember | null = null;
      for (const o of this.live) if (!o.visible && (!victim || o.hiddenSince < victim.hiddenSince)) victim = o;
      if (!victim) return;
      if (!this.evict(victim)) return; // w gets the slot when the victim's context is gone
      this.waiting.delete(w);
      this.live.add(w);
      w.grant();
    }
  }

  /** A visible member stopped wanting a context it was waiting for. */
  cancel(m: PoolMember): void {
    this.waiting.delete(m);
  }
}

export const contextPool = new ContextPool();
