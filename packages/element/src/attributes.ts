/**
 * `<metal-card>` attribute parsing and design resolution. Pure (no DOM, no WebGL), so it is unit
 * tested in Node and shared with `@card3d/react`.
 */
import {
  CARD_FONTS,
  LIGHTING_PRESETS,
  cloneDesign,
  decodeDesignToken,
  defaultDesign,
  ensureDesign,
  getPreset,
  normalizeRecipe,
  parseGoogleFontSpec,
  presetExtras,
  presetRecipe,
  sanitizeFontLabel,
  sanitizeFontUrl,
  familyFromFileName,
  sanitizeScene,
  type CardDesign,
  type CardFloor,
  type CardScene,
  type LightingPresetId,
  type Quality,
  type Recipe,
} from "@card3d/core/model";
import type { EngineFit } from "@card3d/core/engine";

export type Interaction = "drag" | "turntable" | "none";

/** Turntable speed when `auto-rotate` is present without a number, degrees per second. */
export const DEFAULT_AUTO_ROTATE = 20;
const MAX_AUTO_ROTATE = 360;

/**
 * A boolean attribute: absent → `fallback`; present → true, except `"false"`, `"0"`, `"off"` and
 * `"no"` (so `lazy="false"` reads as written).
 */
export function parseBool(value: string | null | undefined, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  return !/^\s*(false|0|off|no)\s*$/i.test(value);
}

/**
 * `auto-rotate`: degrees per second (negative spins the other way). Absent → 0 (off); present
 * without a usable number (`auto-rotate`, `auto-rotate="true"`) → `DEFAULT_AUTO_ROTATE`; `"false"` /
 * `"0"` → 0. Clamped to ±360.
 */
export function parseAutoRotate(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (!parseBool(value, true)) return 0;
  const n = Number(value.trim());
  if (value.trim() === "" || !Number.isFinite(n)) return DEFAULT_AUTO_ROTATE;
  return Math.max(-MAX_AUTO_ROTATE, Math.min(MAX_AUTO_ROTATE, n));
}

/** `interaction`: `drag` (default), `turntable` or `none` (`static` and `false` also mean none). */
export function parseInteraction(value: string | null | undefined): Interaction {
  const v = value?.trim().toLowerCase();
  if (v === "turntable") return "turntable";
  if (v === "none" || v === "static" || v === "false" || v === "off") return "none";
  return "drag";
}

/** `fit`: `contain` (default: the card fills the element with a small margin, and stays whole as it turns) or `studio` (Card Studio's camera). */
export function parseFit(value: string | null | undefined): EngineFit {
  return value?.trim().toLowerCase() === "studio" ? "studio" : "contain";
}

/** `quality`: `full` (default; up to 2× pixel ratio, finer textures) or `performance`. */
export function parseQuality(value: string | null | undefined): Quality {
  return value?.trim().toLowerCase() === "performance" ? "performance" : "full";
}

/** A `#rgb` / `#rrggbb` colour, lower-cased and expanded; null otherwise. */
export function parseHexColor(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase() ?? "";
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return null;
}

/**
 * The `font` attribute: a `CARD_FONTS` id or label, case-insensitive (`space-grotesk`, `Space
 * Grotesk`), or a Google Fonts family as `google:<Family>[@<weight>]` (`google:Fraunces`,
 * `google:Playfair Display@900`). Null when it is neither.
 */
export function parseFont(value: string | null | undefined): CardDesign["font"] {
  const v = value?.trim();
  if (!v) return null;
  if (/^google:/i.test(v)) return parseGoogleFontSpec(v);
  const lower = v.toLowerCase();
  return CARD_FONTS.find((f) => f.id === lower || f.label.toLowerCase() === lower)?.id ?? null;
}

/**
 * `font-url` (+ `font` as its family name): a web font file (woff2 / woff / ttf / otf) at an https
 * URL or a same-origin path. Null when the URL isn't allowed (`sanitizeFontUrl`).
 */
export function parseFontUrl(url: string | null | undefined, family?: string | null): CardDesign["font"] {
  const src = sanitizeFontUrl(url);
  return src ? { source: "url", family: sanitizeFontLabel(family) ?? familyFromFileName(src), src } : null;
}

export function parseLighting(value: string | null | undefined): LightingPresetId | null {
  const v = value?.trim().toLowerCase();
  return (LIGHTING_PRESETS.find((p) => p.id === v)?.id as LightingPresetId | undefined) ?? null;
}

/** The attributes that patch a design (applied over whatever `design` / `share` / `src` / `preset` gave). */
export interface DesignPatch {
  material?: string | null;
  texture?: string | null;
  pattern?: string | null;
  color?: string | null;
  name?: string | null;
  bio?: string | null;
  /** A font id or label, `google:<Family>[@weight]`, or with `fontUrl` the family name of that file. */
  font?: string | null;
  /** The `font-url` attribute: a web font file (https or same-origin), named by `font`. */
  fontUrl?: string | null;
  lighting?: string | null;
  /** Scene environment: "studio", an environment id (`SCENE_ENVIRONMENTS`) or a `.hdr` / `.webp` URL. */
  environment?: string | null;
  /** Reflective floor: present / "true" (defaults), a reflectivity 0–1, or "false" / "none" (off). */
  floor?: string | null;
}

/** The `floor` attribute: null = leave the design's floor alone, false = none, else the floor. */
export function parseFloor(value: string | null | undefined): CardFloor | false | null {
  if (value == null) return null;
  const v = value.trim().toLowerCase();
  if (v === "false" || v === "none" || v === "off" || v === "0") return false;
  if (v === "" || v === "true" || v === "floor") return {};
  const n = Number(v);
  return Number.isFinite(n) ? { reflectivity: Math.min(1, Math.max(0, n)) } : null;
}

/**
 * Apply the convenience attributes to a copy of `design`. Unknown values are ignored (and reported
 * in `ignored`), never reset the field: `material="gold"` keeps the design's own material.
 */
export function applyPatch(design: CardDesign, patch: DesignPatch): { design: CardDesign; ignored: string[] } {
  const out = cloneDesign(design);
  const ignored: string[] = [];
  const enumField = (key: "material" | "texture" | "pattern") => {
    const raw = patch[key]?.trim().toLowerCase();
    if (!raw) return;
    const next = normalizeRecipe({ ...out.recipe, [key]: raw } as Partial<Recipe>);
    if (next[key] === raw) out.recipe = next;
    else ignored.push(`${key}="${patch[key]}"`);
  };
  enumField("material");
  enumField("texture");
  enumField("pattern");
  if (patch.color != null && patch.color.trim()) {
    const c = parseHexColor(patch.color);
    if (c) out.recipe = { ...out.recipe, color: c };
    else ignored.push(`color="${patch.color}"`);
  }
  if (patch.name != null) out.cardholderName = patch.name;
  if (patch.bio != null) out.cardholderBio = patch.bio;
  if (patch.fontUrl != null && patch.fontUrl.trim()) {
    const f = parseFontUrl(patch.fontUrl, patch.font);
    if (f) out.font = f;
    else ignored.push(`font-url="${patch.fontUrl}"`);
  } else if (patch.font != null && patch.font.trim()) {
    const f = parseFont(patch.font);
    if (f) out.font = f;
    else ignored.push(`font="${patch.font}"`);
  }
  if (patch.lighting != null && patch.lighting.trim()) {
    const l = parseLighting(patch.lighting);
    if (l) out.lighting = l;
    else ignored.push(`lighting="${patch.lighting}"`);
  }
  const scene: CardScene = { ...out.scene };
  if (patch.environment != null && patch.environment.trim()) {
    const env = patch.environment.trim();
    if (env.toLowerCase() === "studio") delete scene.environment;
    else {
      // Ids are lower-case; URLs are taken as written.
      const checked = sanitizeScene({ environment: /[:/.]/.test(env) ? env : env.toLowerCase() });
      if (checked?.environment) scene.environment = checked.environment;
      else ignored.push(`environment="${patch.environment}"`);
    }
  }
  const floor = parseFloor(patch.floor);
  if (floor === false) delete scene.floor;
  else if (floor) scene.floor = { ...scene.floor, ...floor };
  else if (patch.floor != null) ignored.push(`floor="${patch.floor}"`);
  if (patch.environment != null || patch.floor != null) {
    if (Object.keys(scene).length) out.scene = scene;
    else delete out.scene;
  }
  return { design: out, ignored };
}

/** The default design with a `CARD_PRESETS` finish (and, for effect presets, its effects). */
export function presetDesign(id: string): CardDesign | null {
  const preset = getPreset(id.trim());
  if (!preset) return null;
  return { ...defaultDesign(), recipe: presetRecipe(preset), ...presetExtras(preset) };
}

/** Everything a `<metal-card>` (or `<MetalCard>`) can take a design from. */
export interface DesignSources extends DesignPatch {
  /** A `CARD_PRESETS` id. */
  preset?: string | null;
  /** URL of a design JSON (Card Studio's "Design JSON" / "Save design"). */
  src?: string | null;
  /** A Card Studio share link, its `#d=…` hash, or the bare token. */
  share?: string | null;
  /** Design JSON text (the `design` attribute). */
  designJson?: string | null;
  /** A design object (the `design` property / React prop); anything `ensureDesign` accepts. */
  design?: unknown;
}

export interface ResolvedDesign {
  design: CardDesign;
  /** Which source supplied the base design. */
  source: "default" | "preset" | "src" | "share" | "design";
  /** Problems with the inputs (unreadable JSON, unknown preset, ignored attribute values). */
  warnings: string[];
}

/**
 * Resolve the design to show. The base is the most specific complete design given —
 * `design` (property) › `design` attribute (JSON) › `share` › `src` › `preset` › the default card —
 * and the convenience attributes (`material`, `texture`, `pattern`, `color`, `name`, `bio`, `font`,
 * `font-url`, `lighting`) are applied over it. A source that can't be read is reported and the next one is used.
 * Every design goes through `ensureDesign`, exactly like Card Studio's share links and imports.
 */
export async function resolveDesign(s: DesignSources, fetchJson: (url: string) => Promise<unknown> = defaultFetchJson): Promise<ResolvedDesign> {
  const warnings: string[] = [];
  let base: CardDesign | null = null;
  let source: ResolvedDesign["source"] = "default";
  const attempt = async (kind: ResolvedDesign["source"], what: string, get: () => Promise<CardDesign> | CardDesign) => {
    if (base) return;
    try {
      base = await get();
      source = kind;
    } catch (err) {
      warnings.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (s.design != null) await attempt("design", "design property", () => ensureDesign(s.design));
  if (s.designJson?.trim()) await attempt("design", "design attribute", () => ensureDesign(JSON.parse(s.designJson!)));
  if (s.share?.trim()) await attempt("share", "share", () => decodeDesignToken(s.share!));
  if (s.src?.trim()) await attempt("src", `src "${s.src}"`, async () => ensureDesign(await fetchJson(s.src!)));
  if (s.preset?.trim()) {
    await attempt("preset", `preset "${s.preset}"`, () => {
      const d = presetDesign(s.preset!);
      if (!d) throw new Error("unknown preset id");
      return d;
    });
  }
  const { design, ignored } = applyPatch(base ?? defaultDesign(), s);
  for (const i of ignored) warnings.push(`ignored ${i}`);
  return { design, source, warnings };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** The accessible name: the `label` attribute, else "<cardholder name>, 3D metal card". */
export function accessibleLabel(label: string | null | undefined, design: Pick<CardDesign, "cardholderName"> | null): string {
  if (label?.trim()) return label.trim();
  const name = design?.cardholderName?.trim();
  return name ? `${name}, 3D metal card` : "3D metal card";
}
