/**
 * Marquee design order and `?card=`-style pinning.
 *
 * The strip shuffles its designs on every load. It takes a `random` source, so the order can be made
 * reproducible (`mulberry32(seed)`).
 */
import type { CardDesign } from "../types.ts";

/** Fisher–Yates: i from n−1 down to 1, j = floor(random·(i+1)). Returns a copy. */
export function fisherYates<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * The marquee's default order: every design shuffled with `fisherYates`. Pass `designs` in a stable
 * order, so a seeded `random` always gives the same strip.
 */
export function shuffleMarqueeOrder<T>(designs: readonly T[], random: () => number = Math.random): T[] {
  return fisherYates(designs, random);
}

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** What `resolveMarqueePin` reads from a design: the name plus optional ids and pin aliases. */
export type PinnableDesign = Pick<CardDesign, "cardholderName"> & {
  /** a stable id or slug */
  id?: string;
  slug?: string;
  /** extra pin keys for this design (other names a `?card=` link may use for it) */
  aliases?: readonly string[];
};

/**
 * Resolve a pin key to a design index. Accepts, case-insensitively: an index, a design
 * alias (data), an id or slug, a full cardholder name, or a first name. Returns −1 when nothing
 * matches.
 */
export function resolveMarqueePin(designs: readonly PinnableDesign[], key: number | string | null | undefined): number {
  if (key === null || key === undefined || key === "") return -1;
  if (typeof key === "number") return Number.isInteger(key) && key >= 0 && key < designs.length ? key : -1;
  const k = norm(key);
  if (!k) return -1;
  let i = designs.findIndex((d) => d.aliases?.some((a) => norm(a) === k));
  if (i >= 0) return i;
  const ids = designs.map((d) => [d.id, d.slug].filter((s): s is string => !!s).map((s) => norm(s.replace(/-/g, " "))));
  const names = designs.map((d) => norm(d.cardholderName ?? ""));
  i = ids.findIndex((list) => list.includes(k));
  if (i < 0) i = names.findIndex((n) => n === k);
  if (i < 0) i = names.findIndex((n) => n.split(" ")[0] === k);
  return i;
}
