/**
 * Add-ons, face-shader layers and the advanced overrides of a `CardDesign`: validation of
 * untrusted input (share links, imports, drafts), layer helpers for the panel, and the "still"
 * variants used for thumbnails and exports. Pure: never touches the renderer.
 */
import type { AddonId, CardDesign, FaceShader, ShaderParamValue, Side } from "@card3d/core/model";
import {
  EFFECT_PARAMS,
  customShaderDefinition,
  getShaderDefinition,
  parseCustomShader,
  isDefaultParam,
  type EffectId,
  type EffectParamSpec,
  type ShaderDefinition,
} from "@card3d/core/editor";

// Validation of untrusted input and the layer / add-on copies live in @card3d/core (`design/`).
export { MAX_SHADER_LAYERS, MAX_CUSTOM_CODE, LAYOUT_RANGES, layerParams, cloneLayer, pruneLayerParams } from "@card3d/core/model";

const specsOf = (id: EffectId) => EFFECT_PARAMS[id] as readonly EffectParamSpec[];

// ── definitions ──────────────────────────────────────────────────────────────

/** The definition a layer runs: the registry entry, or one built from its custom code. */
export function layerDefinition(layer: FaceShader): ShaderDefinition | undefined {
  if (layer.id === "custom") return customShaderDefinition(layer.code ?? "", parseCustomShader(layer.code ?? "", layer.language === "wgsl" ? "wgsl" : "glsl"));
  return getShaderDefinition(layer.id);
}

export const isCustom = (l: FaceShader | undefined): boolean => l?.id === "custom";

/** A short name for the layer list: the definition label, or a custom shader's first comment. */
export function layerName(layer: FaceShader): string {
  if (layer.id !== "custom") return getShaderDefinition(layer.id)?.label ?? layer.id;
  const first = /^\s*\/\/\s*([^\n]{1,80})/.exec(layer.code ?? "");
  const title = first?.[1].split(/[:.—–-]\s/)[0].trim();
  return title && title.length <= 28 ? `Custom · ${title}` : "Custom shader";
}

/** A new layer for a built-in definition (its default target/blend), on `side`. */
export function newBuiltinLayer(def: ShaderDefinition, side: FaceShader["side"], design?: CardDesign): FaceShader {
  const layer: FaceShader = { id: def.id, side, target: def.defaultTarget };
  if (def.defaultBlend && def.defaultBlend !== "normal") layer.blend = def.defaultBlend;
  // Liquid metal's default mask is the face's artwork; on a face without one, use the brand mark.
  if (def.id === "liquid-metal" && design) {
    const sides: Side[] = side === "both" ? ["front", "back"] : [side];
    if (!sides.some((s) => design.surfaceSources[s])) layer.params = { mask: 1 };
  }
  return layer;
}

export function newCustomLayer(code: string, target: FaceShader["target"], side: FaceShader["side"]): FaceShader {
  return { id: "custom", side, target, language: "wgsl", code };
}

// ── GLSL layers (the three.js engine's custom shaders) ───────────────────────

/** A custom layer in GLSL: the card engine runs WGSL only, so it skips the layer. */
export const isGlslLayer = (l: FaceShader | undefined): boolean => l?.id === "custom" && l.language !== "wgsl";

export const GLSL_LAYER_MESSAGE =
  "This layer is GLSL, which the card engine no longer runs, so it is skipped. Rewrite it in WGSL (fn mainImage(uv: vec2f) -> vec4f; the shader editor's cheat sheet lists the prelude) and it runs again.";

/** The design's enabled GLSL layers as skipped-layer errors (the panel lists them with the card's own). */
export function glslLayerErrors(d: CardDesign): { index: number; side: Side; errors: { line: number; message: string }[] }[] {
  return (d.shaders ?? []).flatMap((l, index) =>
    isGlslLayer(l) && l.enabled !== false
      ? (l.side === "both" ? (["front", "back"] as const) : [l.side]).map((side) => ({ index, side, errors: [{ line: 0, message: GLSL_LAYER_MESSAGE }] }))
      : [],
  );
}

// ── add-on values (the panel writes through these) ──────────────────────────

export const addonOn = (d: CardDesign, id: AddonId): boolean => d.addons?.[id] != null;

export function setAddon(d: CardDesign, id: AddonId, on: boolean): void {
  if (on) {
    if (!addonOn(d, id)) d.addons = { ...d.addons, [id]: {} };
    return;
  }
  if (!d.addons) return;
  const next = { ...d.addons };
  delete next[id];
  if (Object.keys(next).length) d.addons = next;
  else delete d.addons;
}

export function addonValue(d: CardDesign, id: AddonId, key: string): ShaderParamValue | undefined {
  return (d.addons?.[id] as Record<string, ShaderParamValue> | null | undefined)?.[key];
}

export function setAddonValue(d: CardDesign, id: AddonId, key: string, v: ShaderParamValue | undefined): void {
  if (!addonOn(d, id)) return;
  const spec = specsOf(id).find((s) => s.key === key);
  const cur = { ...(d.addons![id] as Record<string, ShaderParamValue>) };
  if (v !== undefined && (spec?.optional || !isDefaultParam(id, key, v))) cur[key] = v;
  else delete cur[key];
  d.addons = { ...d.addons, [id]: cur };
}

// ── the untrusted-code gate ─────────────────────────────────────────────────

/** Custom layers that would run (enabled WGSL with code; GLSL layers never run on the card engine). */
function runnableCustomLayers(d: CardDesign): number[] {
  return (d.shaders ?? []).flatMap((l, i) => (l.id === "custom" && !isGlslLayer(l) && l.enabled !== false && l.code ? [i] : []));
}

/** Disables every runnable custom layer and returns their indices (for "Run it"). */
export function pauseCustomLayers(d: CardDesign): number[] {
  const idx = runnableCustomLayers(d);
  for (const i of idx) d.shaders![i] = { ...d.shaders![i], enabled: false };
  return idx;
}

// ── stills (thumbnails, image exports) ──────────────────────────────────────

/**
 * A copy for a single frame: live clocks frozen at `t` seconds (face shaders, the vines cycle), so a
 * freshly built offscreen card looks like the live one after `t` seconds. `vinesGrown` shows the vines
 * fully grown instead (thumbnails).
 */
export function stillDesign(d: CardDesign, t: number, opts: { vinesTime?: number; vinesGrown?: boolean } = {}): CardDesign {
  const next: CardDesign = { ...d };
  if (d.shaders) next.shaders = d.shaders.map((l) => (l.time === undefined && l.animated !== false ? { ...l, time: t } : l));
  const s = d.addons?.shine;
  if (s && s.time === undefined) next.addons = { ...d.addons, shine: { ...s, time: t } };
  const v = d.addons?.vines;
  if (v && v.time === undefined && v.cycle !== false) {
    next.addons = { ...next.addons, vines: opts.vinesGrown ? { ...v, cycle: false } : { ...v, time: opts.vinesTime ?? t } };
  }
  return next;
}
