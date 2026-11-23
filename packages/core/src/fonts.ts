/**
 * Card fonts: a small curated set of open-licence (SIL OFL 1.1) faces for the cardholder name and
 * bio, self-hosted with the package (`assets/fonts/`, from the Fontsource packages; licences in
 * `assets/fonts/licenses/` and THIRD_PARTY_NOTICES.md). The public asset provider rasterises with
 * `DEFAULT_CARD_FONT`; a design picks another with `CardDesign.font` (a catalog id).
 *
 * Faces are registered with `document.fonts` under their own family names ("card3d Inter", …) so a
 * locally installed copy never changes the raster, and they stay unloaded until text needs them
 * (`loadCardFont` waits for exactly the glyph subsets a text uses).
 *
 * A design without `font` keeps the asset provider's family (for example a local pack's face), untouched.
 * A design can also name a font outside the catalog (a Google Fonts family, a web font URL, an
 * uploaded file: `custom-font.ts`); `loadDesignFont` waits for it and falls back to the provider's.
 */
import type { AssetProvider, CardDesign } from "./types.ts";
import { isCustomFontFamily, loadCustomFont, loadedCustomFontFamily } from "./custom-font.ts";

export interface CardFontFile {
  url: string;
  /** CSS unicode-range of this subset. */
  unicodeRange: string;
}

export interface CardFont {
  /** Stable id stored in `CardDesign.font`. */
  id: string;
  label: string;
  /** The family the faces are registered under (unique to card3d). */
  family: string;
  /** CSS weight descriptor: "700", or a range for a variable face. */
  weight: string;
  kind: "sans" | "mono" | "serif" | "display";
  /** Where the font comes from and its licence (also in THIRD_PARTY_NOTICES.md). */
  source: string;
  licence: "OFL-1.1";
  files: readonly CardFontFile[];
}

const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

// Each URL is a literal `new URL(…, import.meta.url)` so bundlers (Vite, Rollup, esbuild, webpack 5)
// emit the file next to the bundle; native ESM resolves it against this module.
export const CARD_FONTS: readonly CardFont[] = [
  {
    id: "inter",
    label: "Inter",
    family: "card3d Inter",
    weight: "100 900",
    kind: "sans",
    source: "Inter by The Inter Project Authors (rsms/inter), via @fontsource-variable/inter 5.3.0",
    licence: "OFL-1.1",
    files: [
      { url: new URL("../assets/fonts/inter-latin-wght-normal.woff2", import.meta.url).href, unicodeRange: LATIN },
      { url: new URL("../assets/fonts/inter-latin-ext-wght-normal.woff2", import.meta.url).href, unicodeRange: LATIN_EXT },
    ],
  },
  {
    id: "manrope",
    label: "Manrope",
    family: "card3d Manrope",
    weight: "700",
    kind: "sans",
    source: "Manrope by The Manrope Project Authors (sharanda/manrope), via @fontsource/manrope 5.3.0",
    licence: "OFL-1.1",
    files: [
      { url: new URL("../assets/fonts/manrope-latin-700-normal.woff2", import.meta.url).href, unicodeRange: LATIN },
      { url: new URL("../assets/fonts/manrope-latin-ext-700-normal.woff2", import.meta.url).href, unicodeRange: LATIN_EXT },
    ],
  },
  {
    id: "space-grotesk",
    label: "Space Grotesk",
    family: "card3d Space Grotesk",
    weight: "700",
    kind: "sans",
    source: "Space Grotesk by The Space Grotesk Project Authors (floriankarsten/space-grotesk), via @fontsource/space-grotesk 5.3.0",
    licence: "OFL-1.1",
    files: [
      { url: new URL("../assets/fonts/space-grotesk-latin-700-normal.woff2", import.meta.url).href, unicodeRange: LATIN },
      { url: new URL("../assets/fonts/space-grotesk-latin-ext-700-normal.woff2", import.meta.url).href, unicodeRange: LATIN_EXT },
    ],
  },
  {
    id: "unbounded",
    label: "Unbounded",
    family: "card3d Unbounded",
    weight: "700",
    kind: "display",
    source: "Unbounded by The Unbounded Project Authors (googlefonts/unbounded), via @fontsource/unbounded 5.3.0",
    licence: "OFL-1.1",
    files: [
      { url: new URL("../assets/fonts/unbounded-latin-700-normal.woff2", import.meta.url).href, unicodeRange: LATIN },
      { url: new URL("../assets/fonts/unbounded-latin-ext-700-normal.woff2", import.meta.url).href, unicodeRange: LATIN_EXT },
    ],
  },
  {
    id: "playfair",
    label: "Playfair Display",
    family: "card3d Playfair Display",
    weight: "700",
    kind: "serif",
    source: "Playfair Display by The Playfair Display Project Authors (clauseggers/Playfair-Display), via @fontsource/playfair-display 5.3.0",
    licence: "OFL-1.1",
    files: [
      { url: new URL("../assets/fonts/playfair-display-latin-700-normal.woff2", import.meta.url).href, unicodeRange: LATIN },
      { url: new URL("../assets/fonts/playfair-display-latin-ext-700-normal.woff2", import.meta.url).href, unicodeRange: LATIN_EXT },
    ],
  },
  {
    id: "plex-mono",
    label: "IBM Plex Mono",
    family: "card3d IBM Plex Mono",
    weight: "700",
    kind: "mono",
    source: "IBM Plex Mono by IBM Corp., via @fontsource/ibm-plex-mono 5.3.0",
    licence: "OFL-1.1",
    files: [
      { url: new URL("../assets/fonts/ibm-plex-mono-latin-700-normal.woff2", import.meta.url).href, unicodeRange: LATIN },
      { url: new URL("../assets/fonts/ibm-plex-mono-latin-ext-700-normal.woff2", import.meta.url).href, unicodeRange: LATIN_EXT },
    ],
  },
];

/** The public build's name/bio font. */
export const DEFAULT_CARD_FONT = "inter";

export const getCardFont = (id: string | null | undefined): CardFont | undefined => (id ? CARD_FONTS.find((f) => f.id === id) : undefined);

/** The catalog font registered under `family`, if any. */
export const cardFontByFamily = (family: string): CardFont | undefined => CARD_FONTS.find((f) => f.family === family);

const registered = new Set<string>();

/**
 * Add a catalog font's faces to `document.fonts` (unloaded: nothing is fetched until text uses them).
 * Idempotent; a no-op without the CSS Font Loading API. With no id, every catalog font.
 */
export function registerCardFonts(id?: string): void {
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return;
  for (const f of id ? [getCardFont(id)].filter((x): x is CardFont => !!x) : CARD_FONTS) {
    if (registered.has(f.id)) continue;
    registered.add(f.id);
    for (const file of f.files) {
      try {
        document.fonts.add(
          new FontFace(f.family, `url(${JSON.stringify(file.url)}) format("woff2")`, { weight: f.weight, unicodeRange: file.unicodeRange, display: "swap" }),
        );
      } catch (err) {
        console.warn(`[card3d] font ${f.id} could not be registered`, err);
      }
    }
  }
}

/**
 * The family a design's name and bio rasterise with: its catalog `font`, a custom font that has
 * already loaded, else the provider's. Sync; `loadDesignFont` waits for a custom font first.
 */
export function designFontFamily(design: Pick<CardDesign, "font">, assets: Pick<AssetProvider, "nameFontFamily">): string {
  const f = design.font;
  if (f && typeof f === "object") return loadedCustomFontFamily(f) ?? assets.nameFontFamily;
  return getCardFont(f)?.family ?? assets.nameFontFamily;
}

/** How long a card waits for a custom font before it draws with the fallback. */
export const CUSTOM_FONT_TIMEOUT_MS = 8000;

/**
 * `designFontFamily`, after waiting (bounded) for a custom font to load. A custom font that fails
 * (offline, 404, CORS, not a font, a share link without the uploaded file) or is slower than
 * `timeoutMs` gives the provider's family; `loadCustomFont` warns once. Never rejects.
 */
export async function loadDesignFont(
  design: Pick<CardDesign, "font">,
  assets: Pick<AssetProvider, "nameFontFamily">,
  timeoutMs = CUSTOM_FONT_TIMEOUT_MS,
): Promise<string> {
  const f = design.font;
  if (!f || typeof f !== "object") return designFontFamily(design, assets);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([loadCustomFont(f), new Promise<null>((res) => (timer = setTimeout(() => res(null), timeoutMs)))]);
  clearTimeout(timer);
  return r?.ok ? r.family : assets.nameFontFamily;
}

/**
 * Bounded wait until `font` (a CSS font shorthand for `family`) can draw `text`, so
 * the rasteriser measures and draws with the real face. Catalog families are registered first and
 * only the subsets the text needs are fetched (custom families too, once `loadDesignFont` registered
 * them); other families (the host's own, e.g. a local
 * pack's) keep the plain check-then-load. Never throws: an unknown family falls back in the canvas.
 */
export async function loadCardFont(family: string, font: string, text = "", timeoutMs = 4000): Promise<void> {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (!fonts) return;
  const catalog = cardFontByFamily(family);
  if (catalog) registerCardFonts(catalog.id);
  // Upper-cased like the raster ; always include a capital so the latin face is loaded.
  const sample = catalog || isCustomFontFamily(family) ? `H${text.toLocaleUpperCase()}` : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (sample ? fonts.check(font, sample) : fonts.check(font)) return;
    await Promise.race([sample ? fonts.load(font, sample) : fonts.load(font), new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
  } catch {
    // Unknown family: the canvas falls back through "Arial, sans-serif".
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The design's extra text lines (`CardDesign.textLines`, non-empty text only, at most three), each
 * with the family it rasterises in: its own `font` when that is a catalog id, else `fallback` (the
 * name's family).
 */
export function textLineFamilies(
  design: Pick<CardDesign, "textLines">,
  fallback: string,
): Array<{ line: NonNullable<CardDesign["textLines"]>[number]; family: string }> {
  const lines = Array.isArray(design.textLines) ? design.textLines : [];
  return lines
    .filter((l) => l && typeof l.text === "string" && l.text.trim())
    .slice(0, 3)
    .map((line) => ({ line, family: getCardFont(line.font)?.family ?? fallback }));
}
