/**
 * Undo/redo as a snapshot timeline (the wave3d studio model). The whole document is one plain
 * `CardDesign`, so each committed version is a clone; restoring goes through main.ts's `applyDesign`.
 *
 * Edits mark the timeline dirty and commit after a short pause (or at the end of a pointer gesture),
 * so one slider drag or one sticker drag becomes one entry. Discrete actions commit immediately with
 * an explicit label.
 */
import type { CardDesign, Decal } from "@card3d/core/model";
import { cloneDesign, fingerprint } from "./design.ts";

interface Entry {
  id: number;
  design: CardDesign;
  fp: string;
  label: string;
  time: number;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  entries: Array<{ id: number; label: string; time: number; current: boolean }>;
}

const FRIENDLY: Record<string, string> = {
  frontHolo: "front foil",
  backHolo: "back foil",
  matchHoloSides: "match sides",
  holoStyle: "foil style",
  backHoloStyle: "back foil style",
  foilTexture: "foil texture",
  backFoilTexture: "back foil texture",
  foilIntensity: "foil intensity",
  backFoilIntensity: "back foil intensity",
  holoGlare: "foil glare",
  backHoloGlare: "back foil glare",
  holoMotion: "foil motion",
  backHoloMotion: "back foil motion",
  foilScale: "foil scale",
  backFoilScale: "back foil scale",
  foilCoverage: "foil coverage",
  backFoilCoverage: "back foil coverage",
  cardholderName: "name",
  cardholderBio: "bio",
  surfaceSources: "artwork",
  surfaceTreatments: "artwork finish",
  decals: "stickers",
  addons: "add-ons",
  shaders: "shader layers",
  materialOverride: "material override",
  brandingOverride: "branding colour",
  frontLayout: "name layout",
};

const humanize = (k: string) =>
  FRIENDLY[k] ??
  k
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase();

function diffLabel(prev: CardDesign, next: CardDesign): string {
  for (const k of Object.keys(next.recipe) as (keyof CardDesign["recipe"])[]) {
    if (prev.recipe[k] !== next.recipe[k]) return humanize(k);
  }
  if (prev.decals.length !== next.decals.length) return next.decals.length > prev.decals.length ? "add sticker" : "remove sticker";
  for (const k of Object.keys(next) as (keyof CardDesign)[]) {
    if (k === "recipe") continue;
    if (fingerprintOf(prev[k]) !== fingerprintOf(next[k])) return k === "decals" ? decalLabel(prev.decals, next.decals) : humanize(k);
  }
  return "edit";
}
/** What changed on a sticker (same count): the first differing field of the first differing sticker. */
const DECAL_LABELS: Partial<Record<keyof Decal, string>> = {
  side: "move sticker",
  x: "move sticker",
  y: "move sticker",
  width: "resize sticker",
  scale: "resize sticker",
  aspect: "stretch sticker",
  rotation: "rotate sticker",
  crop: "crop sticker",
  flip: "flip sticker",
  tint: "sticker tint",
  adjust: "sticker corrections",
  opacity: "sticker opacity",
};
function decalLabel(prev: readonly Decal[], next: readonly Decal[]): string {
  for (let i = 0; i < next.length; i++) {
    const a = prev[i] as unknown as Record<string, unknown>;
    const b = next[i] as unknown as Record<string, unknown>;
    if (a?.id !== b.id) return "reorder stickers";
    for (const k of Object.keys(DECAL_LABELS) as (keyof Decal)[]) {
      if (fingerprintOf(a[k]) !== fingerprintOf(b[k])) return DECAL_LABELS[k]!;
    }
  }
  return "edit sticker";
}
const fingerprintOf = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "string" && x.length > 256 ? `§${x.length}:${x.slice(-64)}` : x));

export interface HistoryDeps {
  getLive(): CardDesign;
  onChange(): void;
}

export class History {
  private entries: Entry[] = [];
  private cursor = -1;
  private nextId = 1;
  private dirty = false;
  private timer = 0;
  private cleared?: { entries: Entry[]; cursor: number };

  constructor(
    private readonly deps: HistoryDeps,
    private readonly cap = 80,
    private readonly delay = 450,
  ) {}

  reset(design: CardDesign, label: string): void {
    this.cancel();
    this.dirty = false;
    this.entries = [this.entry(design, label)];
    this.cursor = 0;
    this.deps.onChange();
  }

  clear(design: CardDesign): void {
    this.cleared = { entries: this.entries.slice(), cursor: this.cursor };
    this.reset(design, "Cleared");
  }

  undoClear(): boolean {
    const s = this.cleared;
    if (!s) return false;
    this.cleared = undefined;
    this.cancel();
    this.entries = s.entries;
    this.cursor = s.cursor;
    this.deps.onChange();
    return true;
  }

  /** Commit after a pause of `delay` ms (longer for typing bursts, e.g. shader code). */
  markDirty(delay = this.delay): void {
    this.dirty = true;
    this.cancel();
    this.timer = window.setTimeout(() => {
      // Mid-gesture (a pointer is down) the pause doesn't count: a slow rebuild or a held slider
      // would split one drag into several steps. The release commits it (`release`).
      if (!this.holding) this.flush();
    }, delay);
  }

  private holding = false;

  /** A pointer gesture starts: timed commits wait for `release`. */
  hold(): void {
    this.holding = true;
  }

  /** The gesture ends: commit what it changed. */
  release(): void {
    this.holding = false;
    if (this.dirty) this.flush();
  }

  isDirty(): boolean {
    return this.dirty;
  }

  flush(): void {
    this.cancel();
    if (this.dirty) this.commit(this.deps.getLive());
  }

  commit(live: CardDesign, label?: string): boolean {
    this.cancel();
    this.dirty = false;
    const cur = this.entries[this.cursor];
    const fp = fingerprint(live);
    if (cur && cur.fp === fp) return false;
    const finalLabel = label ?? (cur ? diffLabel(cur.design, live) : "edit");
    this.entries.length = this.cursor + 1;
    this.entries.push(this.entry(live, finalLabel, fp));
    this.cursor = this.entries.length - 1;
    while (this.entries.length > this.cap) {
      this.entries.shift();
      this.cursor--;
    }
    this.deps.onChange();
    return true;
  }

  undo(): CardDesign | null {
    return this.cursor > 0 ? this.goTo(this.cursor - 1) : null;
  }

  redo(): CardDesign | null {
    return this.cursor < this.entries.length - 1 ? this.goTo(this.cursor + 1) : null;
  }

  jump(id: number): CardDesign | null {
    const i = this.entries.findIndex((e) => e.id === id);
    return i < 0 || i === this.cursor ? null : this.goTo(i);
  }

  getState(): HistoryState {
    return {
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.entries.length - 1,
      entries: this.entries.map((e, i) => ({ id: e.id, label: e.label, time: e.time, current: i === this.cursor })),
    };
  }

  dispose(): void {
    this.cancel();
  }

  private goTo(i: number): CardDesign {
    this.cursor = i;
    this.dirty = false;
    this.cancel();
    this.deps.onChange();
    return cloneDesign(this.entries[i].design);
  }

  private entry(design: CardDesign, label: string, fp = fingerprint(design)): Entry {
    return { id: this.nextId++, design: cloneDesign(design), fp, label, time: Date.now() };
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
  }
}
