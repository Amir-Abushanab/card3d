/**
 * Showcase designs for the public build (a local plugin may supply others in dev:
 * src/local-plugin.ts).
 */
import { CARD_FONTS, CARD_PRESETS, DEFAULT_CARD_FONT, presetExtras, presetRecipe, type CardDesign } from "@card3d/core/model";

/** A marquee design plus what `?card=` can pin it by (`resolveMarqueePin`): id, slug, aliases. */
export type ShowcaseDesign = CardDesign & { id?: string; slug?: string; aliases?: string[] };

/**
 * Cardholders for the strip: pioneers of computing and science (historical figures), so every card
 * reads like a real card instead of carrying its preset's long name.
 */
const SHOWCASE_NAMES = [
  "Ada Lovelace",
  "Grace Hopper",
  "Alan Turing",
  "Hedy Lamarr",
  "Katherine Johnson",
  "Claude Shannon",
  "Emmy Noether",
  "Annie Easley",
  "Charles Babbage",
  "Marie Curie",
  "Dennis Ritchie",
  "Rosalind Franklin",
  "Edsger Dijkstra",
  "Mary Jackson",
  "Lise Meitner",
  "John McCarthy",
  "Sophie Germain",
  "Frances Allen",
  "Nikola Tesla",
  "Dorothy Vaughan",
] as const;

/**
 * One card per public preset (its id stays pinnable: `?card=gold-shine`): every finish and the
 * Effects presets with their add-ons and shader layers. Every third card shows another of the open
 * card fonts.
 */
export function publicMarqueeDesigns(): ShowcaseDesign[] {
  const others = CARD_FONTS.filter((f) => f.id !== DEFAULT_CARD_FONT);
  return CARD_PRESETS.map((p, i) => ({
    id: p.id,
    recipe: presetRecipe(p),
    cardholderName: SHOWCASE_NAMES[i % SHOWCASE_NAMES.length],
    cardholderBio: "",
    decals: [],
    surfaceSources: {},
    surfaceTreatments: {},
    ...(i % 3 === 2 ? { font: others[Math.floor(i / 3) % others.length].id } : {}),
    ...presetExtras(p),
  }));
}
