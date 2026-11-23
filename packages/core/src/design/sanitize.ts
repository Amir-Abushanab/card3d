/**
 * Validation of untrusted design input (share links, opened files, embed attributes): face-shader
 * layers, add-ons, material / branding overrides and the name layout. Pure: never
 * touches the renderer. (Moved here from the studio so the embeds decode designs exactly like it.)
 */
import { ADDON_IDS } from "../addons/ids.ts";
import { EFFECT_PARAMS, coerceEffectParam, type EffectId, type EffectParamSpec } from "../effects/params.ts";
import { getShaderDefinition } from "../shaders/registry.ts";
import { coerceParam } from "../shaders/param-values.ts";
import { parseCustomShader } from "../shaders/custom-parse.ts";
import { CORNER_RADIUS_RANGE } from "../geometry/constants.ts";
import { CONTACTLESS_SCALE } from "../card/contactless.ts";
import type { ShaderParamSpec } from "../shaders/types.ts";
import type {
  BrandingOverride,
  CardAddons,
  CardContactless,
  CardCutout,
  CardDesign,
  CardEdge,
  CardFinishes,
  CardFloor,
  CardScene,
  CardShape,
  CardTextLine,
  FaceShader,
  MarkFinish,
  MaterialOverride,
  ShaderParamValue,
} from "../types.ts";

/** At most this many shader layers per card. */
export const MAX_SHADER_LAYERS = 8;
/** At most this much GLSL per custom layer (characters). */
export const MAX_CUSTOM_CODE = 20_000;
/** At most this many param values per layer (custom shaders declare their own). */
const MAX_LAYER_PARAMS = 48;

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const HEX = /^#[0-9a-f]{6}$/i;

const specsOf = (id: EffectId) => EFFECT_PARAMS[id] as readonly EffectParamSpec[];

/** Param specs of a layer (custom: parsed from its annotations). */
export function layerParams(layer: FaceShader): ShaderParamSpec[] {
  if (layer.id === "custom") return parseCustomShader(layer.code ?? "", layer.language === "wgsl" ? "wgsl" : "glsl").params;
  return getShaderDefinition(layer.id)?.params ?? [];
}

/** Deep copy of one layer (params' vectors copied too). */
export function cloneLayer(l: FaceShader): FaceShader {
  const out: FaceShader = { ...l };
  if (l.params) out.params = Object.fromEntries(Object.entries(l.params).map(([k, v]) => [k, Array.isArray(v) ? ([...v] as typeof v) : v]));
  return out;
}

export function cloneAddons(a: CardAddons): CardAddons {
  const out: CardAddons = {};
  for (const id of ADDON_IDS) if (a[id]) (out as Record<string, unknown>)[id] = { ...a[id] };
  return out;
}

/** Drops param values the layer's definition no longer declares (custom code edited) or that don't fit. */
export function pruneLayerParams(layer: FaceShader): void {
  if (!layer.params) return;
  const specs = layerParams(layer);
  const next: Record<string, ShaderParamValue> = {};
  for (const spec of specs) {
    if (!Object.prototype.hasOwnProperty.call(layer.params, spec.key)) continue;
    const v = coerceParam(spec, layer.params[spec.key]);
    if (v !== undefined) next[spec.key] = v;
  }
  if (Object.keys(next).length) layer.params = next;
  else delete layer.params;
}

function sanitizeParamValue(v: unknown): ShaderParamValue | undefined {
  if (isNum(v) || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length <= 32 ? v : undefined;
  if (Array.isArray(v) && (v.length === 2 || v.length === 3) && v.every(isNum)) return [...v] as [number, number] | [number, number, number];
  return undefined;
}

/** One layer from untrusted JSON, or null when it can't be used. */
export function sanitizeLayer(v: unknown): FaceShader | null {
  if (!isObj(v) || typeof v.id !== "string") return null;
  const custom = v.id === "custom";
  const def = custom ? null : getShaderDefinition(v.id);
  if (!custom && !def) return null;
  let code: string | undefined;
  if (custom) {
    if (typeof v.code !== "string" || !v.code.trim() || v.code.length > MAX_CUSTOM_CODE) return null;
    code = v.code;
  }
  const targets = def?.targets ?? ["skin", "overlay"];
  const side = v.side === "back" || v.side === "both" ? v.side : "front";
  const target = (v.target === "skin" || v.target === "overlay") && targets.includes(v.target) ? v.target : (def?.defaultTarget ?? "skin");
  const layer: FaceShader = { id: v.id, side, target };
  if (v.blend === "normal" || v.blend === "add" || v.blend === "multiply" || v.blend === "screen") layer.blend = v.blend;
  if (isNum(v.opacity)) layer.opacity = clamp(v.opacity, 0, 1);
  if (typeof v.animated === "boolean") layer.animated = v.animated;
  if (isNum(v.time)) layer.time = clamp(v.time, 0, 3600);
  if (typeof v.enabled === "boolean") layer.enabled = v.enabled;
  if (code !== undefined) layer.code = code;
  if (custom && v.language === "wgsl") layer.language = "wgsl";
  if (isObj(v.params)) {
    const params: Record<string, ShaderParamValue> = {};
    for (const [k, raw] of Object.entries(v.params).slice(0, MAX_LAYER_PARAMS)) {
      if (!/^[A-Za-z_]\w{0,63}$/.test(k)) continue;
      const pv = sanitizeParamValue(raw);
      if (pv !== undefined) params[k] = pv;
    }
    if (Object.keys(params).length) layer.params = params;
    pruneLayerParams(layer);
  }
  return layer;
}

export function sanitizeShaders(v: unknown): FaceShader[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .slice(0, MAX_SHADER_LAYERS * 2)
    .map(sanitizeLayer)
    .filter((x): x is FaceShader => x !== null)
    .slice(0, MAX_SHADER_LAYERS);
  return out.length ? out : undefined;
}

export function sanitizeAddons(v: unknown): CardAddons | undefined {
  if (!isObj(v)) return undefined;
  const out: CardAddons = {};
  for (const id of ADDON_IDS) {
    const raw = v[id];
    if (raw === undefined || raw === null || raw === false) continue;
    const src = isObj(raw) ? raw : {};
    const vals: Record<string, unknown> = {};
    for (const spec of specsOf(id)) {
      if (!Object.prototype.hasOwnProperty.call(src, spec.key)) continue;
      const c = coerceEffectParam(spec, src[spec.key]);
      if (c !== undefined) vals[spec.key] = c;
    }
    (out as Record<string, unknown>)[id] = vals;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Numeric material fields and their sane ranges (anything else is dropped). */
const OVERRIDE_RANGES: Record<string, [number, number]> = {
  metalness: [0, 1],
  roughness: [0, 1],
  clearcoat: [0, 1],
  clearcoatRoughness: [0, 1],
  transmission: [0, 1],
  thickness: [0, 10],
  ior: [1, 2.5],
  brandingClearcoat: [0, 1],
};

export function sanitizeOverride<T extends MaterialOverride | BrandingOverride>(v: unknown, branding = false): T | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, unknown> = {};
  if (typeof v.color === "string" && HEX.test(v.color.trim())) out.color = v.color.trim().toLowerCase();
  for (const [k, [a, b]] of Object.entries(OVERRIDE_RANGES)) {
    if (k === "brandingClearcoat" && !branding) continue;
    if (isNum(v[k])) out[k] = clamp(v[k] as number, a, b);
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

export const LAYOUT_RANGES = { nameFontHeight: [0.02, 0.12], nameBottom: [0.02, 0.4] } as const;

export function sanitizeLayout(v: unknown): CardDesign["frontLayout"] | undefined {
  if (!isObj(v)) return undefined;
  const out: NonNullable<CardDesign["frontLayout"]> = {};
  for (const [k, [a, b]] of Object.entries(LAYOUT_RANGES) as [keyof typeof LAYOUT_RANGES, readonly [number, number]][]) {
    if (isNum(v[k])) out[k] = clamp(v[k] as number, a, b);
  }
  return Object.keys(out).length ? out : undefined;
}

// ── card body and typography (finish, edge, shape, contactless, textLines) ──────

const MARK_FINISH_IDS = ["embossed", "engraved", "etched"] as const;
const isMarkFinish = (v: unknown): v is Exclude<MarkFinish, "default"> => MARK_FINISH_IDS.includes(v as never);

/** `finish`: per-element mark finishes; "default" (and unknown values) are dropped. */
export function sanitizeFinish(v: unknown): CardFinishes | undefined {
  if (!isObj(v)) return undefined;
  const out: CardFinishes = {};
  for (const k of ["name", "bio", "logo"] as const) if (isMarkFinish(v[k])) out[k] = v[k];
  return Object.keys(out).length ? out : undefined;
}

/** `edge`: a known finish and/or the chamfer; a colour only with metal / anodized. */
export function sanitizeEdge(v: unknown): CardEdge | undefined {
  if (!isObj(v)) return undefined;
  const out: CardEdge = {};
  if (v.finish === "metal" || v.finish === "anodized" || v.finish === "match") out.finish = v.finish;
  if (out.finish && out.finish !== "match" && typeof v.color === "string" && HEX.test(v.color.trim())) out.color = v.color.trim().toLowerCase();
  if (v.chamfer === true) out.chamfer = true;
  return out.finish || out.chamfer ? out : undefined;
}

const CUTOUT_IDS: readonly CardCutout[] = ["lanyard", "notch", "window"];

/**
 * `shape`: corner radius rounded to 3 decimals and clamped to `CORNER_RADIUS_RANGE` (ISO/IEC 7810,
 * 2.88–3.48 mm: older designs' pills, sharp corners or the former 4 mm default land on its ends),
 * portrait, known cutouts once each. Undefined when it is the standard card.
 */
export function sanitizeShape(v: unknown): CardShape | undefined {
  if (!isObj(v)) return undefined;
  const out: CardShape = {};
  if (isNum(v.cornerRadius)) out.cornerRadius = clamp(Math.round(v.cornerRadius * 1000) / 1000, CORNER_RADIUS_RANGE.min, CORNER_RADIUS_RANGE.max);
  if (v.orientation === "portrait") out.orientation = "portrait";
  if (Array.isArray(v.cutouts)) {
    const cuts = CUTOUT_IDS.filter((c) => (v.cutouts as unknown[]).includes(c));
    if (cuts.length) out.cutouts = cuts;
  }
  const standardRadius = out.cornerRadius === undefined || Math.abs(out.cornerRadius - CORNER_RADIUS_RANGE.iso) < 5e-4;
  if (standardRadius) delete out.cornerRadius;
  return Object.keys(out).length ? out : undefined;
}

/** `contactless`: `true` or an object turns it on; finish and scale (`CONTACTLESS_SCALE`, 0.4–1.2) checked. */
export function sanitizeContactless(v: unknown): CardContactless | undefined {
  if (v === true) return {};
  if (!isObj(v)) return undefined;
  const out: CardContactless = {};
  if (v.finish === "default" || isMarkFinish(v.finish)) out.finish = v.finish;
  if (isNum(v.scale)) out.scale = Math.round(clamp(v.scale, CONTACTLESS_SCALE.min, CONTACTLESS_SCALE.max) * 100) / 100;
  return out;
}

export const TEXT_LINE_RANGES = { size: [0.4, 2], tracking: [-0.05, 0.6], maxLines: 3, maxChars: 48 } as const;
const PLACEMENTS = ["bottom-left", "bottom-right", "center", "top"] as const;
const ALIGNS = ["left", "center", "right"] as const;

/** `textLines`: at most three lines of ≤ 48 characters; font from the catalog; size, tracking clamped. */
export function sanitizeTextLines(v: unknown, fontIds: readonly string[]): CardTextLine[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: CardTextLine[] = [];
  for (const raw of v) {
    if (out.length >= TEXT_LINE_RANGES.maxLines) break;
    if (!isObj(raw) || typeof raw.text !== "string") continue;
    const line: CardTextLine = { text: raw.text.replace(/[\r\n]+/g, " ").slice(0, TEXT_LINE_RANGES.maxChars) };
    if (typeof raw.font === "string" && fontIds.includes(raw.font)) line.font = raw.font;
    if (isNum(raw.size)) line.size = Math.round(clamp(raw.size, ...TEXT_LINE_RANGES.size) * 100) / 100;
    if (isNum(raw.tracking)) line.tracking = Math.round(clamp(raw.tracking, ...TEXT_LINE_RANGES.tracking) * 1000) / 1000;
    if (ALIGNS.includes(raw.align as never)) line.align = raw.align as CardTextLine["align"];
    if (PLACEMENTS.includes(raw.placement as never)) line.placement = raw.placement as CardTextLine["placement"];
    out.push(line);
  }
  return out.length ? out : undefined;
}

export function cloneTextLines(lines: readonly CardTextLine[]): CardTextLine[] {
  return lines.map((l) => ({ ...l }));
}

const SCENE_BACKDROP_IDS = ["none", "sweep", "gradient", "environment"] as const;
const round = (v: number, k: number) => Math.round(v * k) / k;

/**
 * `scene`: an environment id ("studio", a catalog id) or URL (http(s), or a site path, ending in `.hdr`
 * or `.webp`), numbers clamped, a known backdrop, a "#rrggbb" colour, a floor (`true` = defaults).
 * Undefined when nothing usable is left.
 */
export function sanitizeScene(v: unknown): CardScene | undefined {
  if (!isObj(v)) return undefined;
  const out: CardScene = {};
  const env = typeof v.environment === "string" ? v.environment.trim() : "";
  if (
    env &&
    env !== "studio" &&
    env.length <= 2048 &&
    (/^[a-z0-9][a-z0-9-]{0,40}$/.test(env) || /^(https?:\/\/|\/|\.{1,2}\/)[^\s"'<>]*\.(hdr|webp)([?#][^\s"'<>]*)?$/i.test(env))
  )
    out.environment = env;
  if (isNum(v.environmentIntensity)) {
    const k = round(clamp(v.environmentIntensity, 0.25, 3), 100);
    if (k !== 1) out.environmentIntensity = k;
  }
  if (isNum(v.environmentRotation)) {
    const r = round(((v.environmentRotation % 360) + 360) % 360, 10);
    if (r) out.environmentRotation = r;
  }
  if (SCENE_BACKDROP_IDS.includes(v.backdrop as never) && v.backdrop !== "none") out.backdrop = v.backdrop as CardScene["backdrop"];
  if (typeof v.backdropColor === "string" && HEX.test(v.backdropColor.trim())) out.backdropColor = v.backdropColor.trim().toLowerCase();
  if (isNum(v.backdropBlur)) out.backdropBlur = round(clamp(v.backdropBlur, 0, 1), 100);
  if (v.floor === true) out.floor = {};
  else if (isObj(v.floor)) {
    const f: CardFloor = {};
    if (isNum(v.floor.reflectivity)) f.reflectivity = round(clamp(v.floor.reflectivity, 0, 1), 100);
    if (isNum(v.floor.shadow)) f.shadow = round(clamp(v.floor.shadow, 0, 1), 100);
    if (isNum(v.floor.blur)) f.blur = round(clamp(v.floor.blur, 0, 1), 100);
    out.floor = f;
  }
  return Object.keys(out).length ? out : undefined;
}

export function cloneScene(s: CardScene): CardScene {
  return { ...s, ...(s.floor ? { floor: { ...s.floor } } : {}) };
}
