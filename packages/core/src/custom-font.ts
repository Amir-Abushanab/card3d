/**
 * Custom card fonts (`CardDesign.font` as a `CardCustomFont`): a Google Fonts family by name, a web
 * font URL, or an uploaded file.
 *
 * Validation is pure (`sanitizeCustomFont`, `sanitizeFontUrl`, …: ensureDesign, the element's
 * attributes, the studio). Loading (`loadCustomFont`) registers the face with `document.fonts` under a
 * card3d-only family ("card3d custom <hash>"), so the user's family name never reaches CSS and a
 * locally installed copy never changes the raster. It is cached per font; a font that can't be
 * loaded (offline, 404, CORS, not a font) resolves `{ ok: false }` and the card falls back to the
 * provider's family (`loadDesignFont` in fonts.ts). Nothing is fetched until a card uses the font.
 *
 * Untrusted input: URLs must be https (or a same-origin path; plain http only for loopback hosts
 * while developing), carry no credentials and are fetched with `credentials: "omit"`; Google
 * stylesheets may only point at fonts.gstatic.com; uploads must be base64 `data:font/…` URLs within
 * `CUSTOM_FONT_LIMITS`.
 */
import type { CardCustomFont, CustomFontSource } from "./types.ts";

export const CUSTOM_FONT_LIMITS = {
  /** Family name, characters. */
  familyChars: 64,
  /** Web font URL, characters. */
  urlChars: 2048,
  /** Uploaded file, bytes (the data URL is about 4/3 of this). */
  uploadBytes: 1024 * 1024,
} as const;

export const CUSTOM_FONT_SOURCES: readonly CustomFontSource[] = ["google", "url", "upload"];
/** The weight names are drawn at, and the default Google Fonts weight. */
export const CUSTOM_FONT_WEIGHT = 700;
/** Where Google Fonts are requested from (CSS2 API) and the only host their files may come from. */
const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com/css2";
const GOOGLE_FONTS_FILES = "https://fonts.gstatic.com/";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const uploadChars = Math.ceil(CUSTOM_FONT_LIMITS.uploadBytes / 3) * 4 + 64;
const FONT_DATA_URL =
  /^data:(?:font\/(?:woff2|woff|ttf|otf|sfnt|collection)|application\/(?:font-woff2?|x-font-(?:woff|ttf|otf)|font-sfnt|vnd\.ms-opentype|octet-stream));base64,[A-Za-z0-9+/]+={0,2}$/;

/** A Google Fonts family name ("Fraunces", "Noto Sans JP"): letters, digits and single spaces; else null. */
export function sanitizeGoogleFamily(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\+/g, " ").trim().replace(/\s+/g, " ");
  return s.length <= CUSTOM_FONT_LIMITS.familyChars && /^[A-Za-z0-9][A-Za-z0-9 ]*$/.test(s) ? s : null;
}

/** A display name for a URL or uploaded font: letters, digits, spaces and `. _ -` (anything else becomes a space). */
export function sanitizeFontLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CUSTOM_FONT_LIMITS.familyChars)
    .trim();
  return s || null;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * A web font URL from untrusted input: an https URL without credentials, a same-origin path
 * ("/fonts/brand.woff2", "fonts/brand.woff2"), or http on a loopback host (local development).
 * No other scheme (`javascript:`, `data:`, `blob:`…), no whitespace, quotes, parentheses or
 * backslashes. Null when it doesn't qualify.
 */
export function sanitizeFontUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > CUSTOM_FONT_LIMITS.urlChars || /[\s"'`()<>\\]/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return s.startsWith("//") ? null : s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.test(u.hostname))) return u.href;
  return null;
}

/** An uploaded font's data URL (`data:font/woff2;base64,…` and the legacy font MIME types), within the size limit. */
export const isFontDataUrl = (v: unknown): v is string => typeof v === "string" && v.length <= uploadChars && FONT_DATA_URL.test(v);

/** A family name from a font file's URL or file name: "BrandSans-Bold.woff2" → "BrandSans Bold". */
export function familyFromFileName(name: string): string {
  const file = name.split(/[?#]/)[0].split("/").pop() ?? "";
  let base = file.replace(/\.(woff2?|ttf|otf)$/i, "");
  try {
    base = decodeURIComponent(base);
  } catch {
    /* keep it encoded */
  }
  return sanitizeFontLabel(base.replace(/[-_]+/g, " ")) ?? "Custom font";
}

const weightOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 900 && v % 100 === 0 ? v : null);

/**
 * `google:<Family>[@<weight>]` (the `<metal-card font>` syntax, also accepted as `CardDesign.font`):
 * "google:Fraunces", "google:Playfair Display@900" (or `+` for spaces). Null otherwise.
 */
export function parseGoogleFontSpec(v: string): CardCustomFont | null {
  const m = /^google:([^@]*?)(?:@(\d+))?$/i.exec(v.trim());
  const family = m && sanitizeGoogleFamily(m[1]);
  if (!family) return null;
  const out: CardCustomFont = { source: "google", family };
  if (m[2] !== undefined) {
    const w = weightOf(Number(m[2]));
    if (!w) return null;
    if (w !== CUSTOM_FONT_WEIGHT) out.weight = w;
  }
  return out;
}

/** The `google:` spec of a Google font (`fontSpec({ source: "google", family: "Fraunces" })` → "google:Fraunces"); null for other sources. */
export const googleFontSpec = (f: CardCustomFont): string | null =>
  f.source === "google" ? `google:${f.family}${f.weight && f.weight !== CUSTOM_FONT_WEIGHT ? `@${f.weight}` : ""}` : null;

/**
 * A custom font from untrusted input (share links, files, embeds); null when unusable. An upload
 * keeps its family without `src` (a stripped share link) so the studio can ask for the file.
 */
export function sanitizeCustomFont(v: unknown): CardCustomFont | null {
  if (typeof v === "string") return parseGoogleFontSpec(v);
  if (!isObj(v)) return null;
  if (v.source === "google") {
    const family = sanitizeGoogleFamily(v.family);
    if (!family) return null;
    const w = weightOf(v.weight);
    return w && w !== CUSTOM_FONT_WEIGHT ? { source: "google", family, weight: w } : { source: "google", family };
  }
  if (v.source === "url") {
    const src = sanitizeFontUrl(v.src);
    return src ? { source: "url", family: sanitizeFontLabel(v.family) ?? familyFromFileName(src), src } : null;
  }
  if (v.source === "upload") {
    const family = sanitizeFontLabel(v.family);
    if (!family) return null;
    return isFontDataUrl(v.src) ? { source: "upload", family, src: v.src } : { source: "upload", family };
  }
  return null;
}

export const isCustomFont = (v: unknown): v is CardCustomFont => isObj(v) && CUSTOM_FONT_SOURCES.includes(v.source as CustomFontSource);

/** An upload whose file was left out (a share link): nothing to load, the card shows the fallback. */
export const isMissingUpload = (f: CardCustomFont): boolean => f.source === "upload" && !f.src;

/** The CSS2 API URL of a Google font (`weight` left out for the family's default). */
export function googleFontsCssUrl(family: string, weight?: number): string {
  return `${GOOGLE_FONTS_CSS}?family=${encodeURIComponent(family).replace(/%20/g, "+")}${weight ? `:wght@${weight}` : ""}&display=swap`;
}

// ── loading ─────────────────────────────────────────────────────────────────

export type CustomFontStatus = { ok: true; family: string } | { ok: false; error: string };

/** FNV-1a, base 36: the registered family's suffix. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// A URL or upload's family is only a label: renaming it reuses the loaded face.
const keyOf = (f: CardCustomFont) => (f.source === "google" ? `google|${f.family}|${f.weight ?? ""}` : `${f.source}|${f.src ?? ""}`);
const cache = new Map<string, Promise<CustomFontStatus>>();
const settled = new Map<string, CustomFontStatus>();
const customFamilies = new Set<string>();
const warned = new Set<string>();
const RETRY_AFTER_MS = 30_000;
// Every weight maps to the one face: the raster asks for 700 and must get this file, never a synthetic bold.
const DESCRIPTORS: FontFaceDescriptors = { weight: "100 900", display: "swap" };

/** Whether `family` is a custom font this module registered (its subsets load per text like the catalog's). */
export const isCustomFontFamily = (family: string): boolean => customFamilies.has(family);

/** The registered family of a custom font that has already loaded, else null (sync; see `loadCustomFont`). */
export function loadedCustomFontFamily(f: CardCustomFont): string | null {
  const s = settled.get(keyOf(f));
  return s?.ok ? s.family : null;
}

/**
 * Load a custom font once (cached): fetch it, register it with `document.fonts` and wait until the
 * face covering basic Latin has loaded. Resolves `{ ok: true, family }` with the family to draw with,
 * or `{ ok: false, error }`; never rejects. Not time-bounded itself: callers race it (`loadDesignFont`).
 */
export function loadCustomFont(font: CardCustomFont): Promise<CustomFontStatus> {
  const key = keyOf(font);
  const cached = cache.get(key);
  if (cached) return cached;
  const p = loadFace(font, `card3d custom ${hash(key)}`).then(
    (family): CustomFontStatus => ({ ok: true, family }),
    (err: unknown): CustomFontStatus => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  cache.set(key, p);
  void p.then((s) => {
    settled.set(key, s);
    if (s.ok) return;
    if (!warned.has(key)) console.warn(`[card3d] the font "${font.family}" (${font.source}) could not be loaded: ${s.error}. Using the default font.`);
    warned.add(key);
    // Rebuilds reuse the failure for a while; a later use tries again (back online, file fixed).
    setTimeout(() => cache.get(key) === p && cache.delete(key), RETRY_AFTER_MS);
  });
  return p;
}

async function loadFace(font: CardCustomFont, family: string): Promise<string> {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (typeof FontFace === "undefined" || !fonts) throw new Error("this environment can't load web fonts");
  if (isMissingUpload(font)) throw new Error("the font file isn't included (share links leave uploads out)");
  const faces = font.source === "google" ? await googleFaces(font, family) : [new FontFace(family, await fontBytes(font), DESCRIPTORS)];
  for (const f of faces) fonts.add(f);
  customFamilies.add(family);
  try {
    // The face with the capitals every name uses (Google splits a family into unicode-range subsets).
    await fonts.load(`700 100px "${family}"`, "H");
  } catch {
    /* judged by the faces' status below */
  }
  if (!faces.some((f) => f.status === "loaded")) {
    for (const f of faces) fonts.delete(f);
    customFamilies.delete(family);
    throw new Error(font.source === "google" ? "its font files didn't load" : "the file isn't a font this browser can read");
  }
  return family;
}

const describeFetchError = (err: unknown) => `network error${err instanceof Error && err.message ? ` (${err.message})` : ""}`;

/** The file of a `url` or `upload` font, as bytes (FontFace parses them; a bad file rejects there). */
async function fontBytes(font: CardCustomFont): Promise<ArrayBuffer> {
  if (font.source === "upload") {
    if (!isFontDataUrl(font.src)) throw new Error("not a font data URL");
    const b64 = font.src.slice(font.src.indexOf(",") + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  const url = sanitizeFontUrl(font.src);
  if (!url) throw new Error("not an allowed font URL");
  let r: Response;
  try {
    r = await fetch(url, { credentials: "omit" });
  } catch (err) {
    throw new Error(describeFetchError(err), { cause: err });
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.arrayBuffer();
}

/** A Google family's faces from its CSS2 stylesheet (one per unicode-range subset, files on fonts.gstatic.com only). */
async function googleFaces(font: CardCustomFont, family: string): Promise<FontFace[]> {
  const name = sanitizeGoogleFamily(font.family);
  if (!name) throw new Error("not a Google Fonts family name");
  const weight = font.weight ?? CUSTOM_FONT_WEIGHT;
  const get = async (w?: number) => {
    try {
      return await fetch(googleFontsCssUrl(name, w), { credentials: "omit" });
    } catch (err) {
      throw new Error(describeFetchError(err), { cause: err });
    }
  };
  // A family without that weight answers 400: then take its default weight.
  let r = await get(weight);
  if (r.status === 400) r = await get();
  if (!r.ok) throw new Error(r.status === 400 ? "no such Google Fonts family" : `HTTP ${r.status}`);
  const css = await r.text();
  const faces: FontFace[] = [];
  for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    if (/font-style:\s*italic/i.test(block)) continue;
    const src = /url\((['"]?)([^'")\s]+)\1\)/.exec(block)?.[2];
    if (!src || !src.startsWith(GOOGLE_FONTS_FILES) || /["'\\]/.test(src)) continue;
    const range = /unicode-range:\s*([U+0-9A-Fa-f?,\s-]+)/.exec(block)?.[1].trim();
    try {
      faces.push(new FontFace(family, `url(${JSON.stringify(src)})`, range ? { ...DESCRIPTORS, unicodeRange: range } : DESCRIPTORS));
    } catch {
      /* a malformed rule: skip it */
    }
  }
  if (!faces.length) throw new Error("the stylesheet had no usable fonts");
  return faces;
}
