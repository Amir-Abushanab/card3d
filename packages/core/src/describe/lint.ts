/**
 * `lintDesign`: run a hand- or model-written design through `ensureDesign` (the one reader every
 * design goes through) and report, in words a model can act on, what the sanitizer rejected, dropped
 * or clamped, plus a few known pitfalls. It never re-implements validation: it compares the input
 * with what `ensureDesign` kept. WGSL compile errors need a GPU and are checked by the hosts
 * (Card Studio, `pnpm finish render`) with `compileCustomShader`; annotation errors are reported here.
 */
import { CARD_FONTS } from "../fonts.ts";
import { RECIPE_CONTROLS } from "../recipe/defaults.ts";
import type { CardDesign, Recipe } from "../types.ts";
import { BUILTIN_SHADERS, getShaderDefinition } from "../shaders/registry.ts";
import { parseCustomShader } from "../shaders/custom-parse.ts";
import { EFFECT_PARAMS } from "../effects/params.ts";
import { LIGHTING_PRESETS } from "../scene/lighting-presets.ts";
import { ensureDesign } from "../design/design.ts";
import { MAX_CUSTOM_CODE, MAX_SHADER_LAYERS, isObj, sanitizeLayer } from "../design/sanitize.ts";
import {
  ADDON_FIELDS,
  BRANDING_OVERRIDE_FIELDS,
  CONTACTLESS_FIELDS,
  DESIGN_FIELDS,
  EDGE_FIELDS,
  FINISH_FIELDS,
  FLOOR_FIELDS,
  LAYER_FIELDS,
  LOGO_FIELDS,
  MATERIAL_OVERRIDE_FIELDS,
  SCENE_FIELDS,
  SHAPE_FIELDS,
  TEXT_LINE_FIELDS,
  type FieldDoc,
} from "./fields.ts";

export interface DesignIssue {
  /** Where, e.g. `recipe.texture`, `shaders[0].code:12` (line in the WGSL). */
  path: string;
  message: string;
}

export interface DesignLint {
  /** The design as Card Studio will load it (null when nothing could be read). */
  design: CardDesign | null;
  /** Things that make the design not what was written: fix and retry. */
  errors: DesignIssue[];
  /** Clamped values and likely mistakes. */
  warnings: DesignIssue[];
}

const HEX = /^#[0-9a-f]{6}$/i;
/** Own keys only: `in` would also find `Object.prototype`'s (`constructor`, `toString`, …). */
const has = (o: object, k: string) => Object.hasOwn(o, k);
const list = (xs: readonly string[]) => xs.map((x) => JSON.stringify(x)).join(", ");
const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s && s.length > 60 ? `${s.slice(0, 57)}…` : String(s);
};

/**
 * Lints a design given as an object or JSON text. `errors` empty means `design` is exactly what was
 * written (modulo clamping, reported in `warnings`).
 */
export function lintDesign(input: unknown): DesignLint {
  const errors: DesignIssue[] = [];
  const warnings: DesignIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });

  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      err("", `not valid JSON: ${(e as Error).message}`);
      return { design: null, errors, warnings };
    }
  }
  if (!isObj(raw)) {
    err("", "expected a JSON object (a CardDesign)");
    return { design: null, errors, warnings };
  }
  let design: CardDesign;
  try {
    design = ensureDesign(raw);
  } catch (e) {
    err("", (e as Error).message);
    return { design: null, errors, warnings };
  }

  // ── top level ──
  const bareRecipe = !isObj(raw.recipe) && ["material", "texture", "grain", "polish", "holoStyle", "frontHolo"].some((k) => k in raw);
  const rawRecipe: Record<string, unknown> = isObj(raw.recipe) ? raw.recipe : bareRecipe ? raw : {};
  for (const k of Object.keys(raw)) {
    if (has(DESIGN_FIELDS, k) || k === "ownerName" || (bareRecipe && has(RECIPE_CONTROLS, k))) continue;
    err(k, `unknown field (CardDesign fields: ${Object.keys(DESIGN_FIELDS).join(", ")})`);
  }

  // ── recipe ──
  for (const [k, v] of Object.entries(rawRecipe)) {
    const path = `recipe.${k}`;
    const control = has(RECIPE_CONTROLS, k) ? RECIPE_CONTROLS[k as keyof Recipe] : undefined;
    if (!control) {
      err(path, `unknown recipe field (fields: ${Object.keys(RECIPE_CONTROLS).join(", ")})`);
      continue;
    }
    if (v === null || v === undefined) continue;
    const kept = design.recipe[k as keyof Recipe];
    if (control.kind === "enum") {
      if (v !== kept) err(path, `${show(v)} is not one of ${list(control.options.map((o) => o.value))}`);
    } else if (control.kind === "range") {
      if (typeof v !== "number" || !Number.isFinite(v)) err(path, `expected a number, got ${show(v)}`);
      else if (v < control.range.min || v > control.range.max) warn(path, `${v} is outside ${control.range.min}–${control.range.max} (the engine clamps it)`);
    } else if (control.kind === "color") {
      if (typeof v !== "string" || !HEX.test(v.trim())) err(path, `expected a "#rrggbb" colour, got ${show(v)}`);
    } else if (typeof v !== "boolean") warn(path, `expected true or false, got ${show(v)} (read as ${kept})`);
  }
  const r = design.recipe;
  if (r.texture === "none" && (r.grain > 0 || r.relief > 0) && ("texture" in rawRecipe || "grain" in rawRecipe || "relief" in rawRecipe)) {
    warn(
      "recipe.texture",
      `"none" with grain ${r.grain} / relief ${r.relief} renders as brushed metal; set grain and relief to 0 for a flat finish, or texture "brushed"`,
    );
  }
  const foilKeys = ["holoStyle", "foilTexture", "foilIntensity", "holoGlare", "foilScale", "foilCoverage"];
  if (!r.frontHolo && foilKeys.some((k) => k in rawRecipe)) warn("recipe.frontHolo", "foil fields are set but frontHolo is false, so no foil shows");

  // ── ids from catalogs ──
  if (raw.font != null && !design.font)
    err("font", `${show(raw.font)} is not a font id (${list(CARD_FONTS.map((f) => f.id))}) or a custom font ({ source: "google", family })`);
  if (raw.lighting != null && raw.lighting !== design.lighting)
    err("lighting", `${show(raw.lighting)} is not a lighting preset (${list(LIGHTING_PRESETS.map((l) => l.id))})`);
  if (Array.isArray(raw.decals) && raw.decals.length) warn("decals", "stickers need uploaded images; write []");
  for (const k of ["surfaceSources", "surfaceTreatments"] as const)
    if (isObj(raw[k]) && Object.keys(raw[k] as object).length) warn(k, "artwork needs uploaded images; write {}");

  // ── nested objects: unknown keys are errors, dropped or changed values are warnings ──
  const flat = (key: string, fields: Record<string, FieldDoc>, kept: unknown, opts: { allowTrue?: boolean } = {}) => {
    const v = raw[key];
    if (v === undefined || v === null || (opts.allowTrue && v === true)) return;
    if (!isObj(v)) return err(key, `expected an object, got ${show(v)}`);
    compareObject(key, v, isObj(kept) ? kept : {}, fields, err, warn);
    if (!isObj(kept)) warn(key, "nothing usable was left, so it was dropped");
  };
  flat("materialOverride", MATERIAL_OVERRIDE_FIELDS, design.materialOverride);
  flat("brandingOverride", BRANDING_OVERRIDE_FIELDS, design.brandingOverride);
  flat("frontLayout", { nameFontHeight: DESIGN_FIELDS.frontLayout, nameBottom: DESIGN_FIELDS.frontLayout }, design.frontLayout);
  flat("finish", FINISH_FIELDS, design.finish);
  flat("edge", EDGE_FIELDS, design.edge);
  flat("shape", SHAPE_FIELDS, design.shape);
  flat("contactless", CONTACTLESS_FIELDS, design.contactless, { allowTrue: true });
  flat("logo", LOGO_FIELDS, design.logo);
  flat("addons", ADDON_FIELDS, design.addons);
  if (isObj(raw.scene)) {
    const { floor, ...rest } = raw.scene;
    compareObject("scene", rest, isObj(design.scene) ? design.scene : {}, SCENE_FIELDS, err, warn);
    if (isObj(floor)) compareObject("scene.floor", floor, isObj(design.scene?.floor) ? design.scene.floor : {}, FLOOR_FIELDS, err, warn);
  } else if (raw.scene != null) err("scene", `expected an object, got ${show(raw.scene)}`);
  for (const id of ["shine", "vines"] as const) {
    const a = isObj(raw.addons) ? raw.addons[id] : undefined;
    if (isObj(a))
      compareObject(
        `addons.${id}`,
        a,
        (design.addons?.[id] ?? {}) as Record<string, unknown>,
        Object.fromEntries(EFFECT_PARAMS[id].map((p) => [p.key, { type: p.type, doc: p.label }])),
        err,
        warn,
      );
  }
  if (Array.isArray(raw.textLines)) {
    raw.textLines.forEach((line, i) => {
      if (!isObj(line) || typeof line.text !== "string") return err(`textLines[${i}]`, "expected { text, … }");
      compareObject(`textLines[${i}]`, line, (design.textLines?.[i] ?? {}) as Record<string, unknown>, TEXT_LINE_FIELDS, err, warn);
    });
    if (raw.textLines.length > (design.textLines?.length ?? 0)) warn("textLines", `only ${design.textLines?.length ?? 0} line(s) kept (≤ 3, each with text)`);
  }

  // ── shader layers ──
  if (raw.shaders !== undefined && raw.shaders !== null && !Array.isArray(raw.shaders)) err("shaders", "expected an array of layers");
  if (Array.isArray(raw.shaders)) {
    if (raw.shaders.length > MAX_SHADER_LAYERS) err("shaders", `at most ${MAX_SHADER_LAYERS} layers`);
    const glass = design.recipe.material === "glass";
    raw.shaders.slice(0, MAX_SHADER_LAYERS).forEach((l, i) => lintLayer(`shaders[${i}]`, l, glass, err, warn));
  }

  return { design, errors, warnings };
}

function compareObject(
  path: string,
  given: Record<string, unknown>,
  kept: Record<string, unknown>,
  fields: Record<string, FieldDoc | { type: string; doc: string }>,
  err: (p: string, m: string) => void,
  warn: (p: string, m: string) => void,
): void {
  for (const [k, v] of Object.entries(given)) {
    const p = `${path}.${k}`;
    if (!has(fields, k)) {
      err(p, `unknown field (fields: ${Object.keys(fields).join(", ")})`);
      continue;
    }
    if (v === undefined || v === null) continue;
    if (!has(kept, k)) warn(p, `${show(v)} was ignored (wrong type, out of the allowed values, a default, or it doesn't apply here)`);
    else if (typeof v === "number" && typeof kept[k] === "number" && Math.abs(v - (kept[k] as number)) > 1e-9) warn(p, `${v} was clamped to ${kept[k]}`);
  }
}

function lintLayer(path: string, l: unknown, glass: boolean, err: (p: string, m: string) => void, warn: (p: string, m: string) => void): void {
  if (!isObj(l)) return err(path, "expected a layer object { id, side, target, … }");
  for (const k of Object.keys(l)) if (!has(LAYER_FIELDS, k)) err(`${path}.${k}`, `unknown field (fields: ${Object.keys(LAYER_FIELDS).join(", ")})`);
  const kept = sanitizeLayer(l);
  if (!kept) {
    if (typeof l.id !== "string") return err(`${path}.id`, "missing id");
    if (l.id === "custom") {
      if (typeof l.code !== "string" || !l.code.trim()) return err(`${path}.code`, "a custom layer needs WGSL code");
      return err(`${path}.code`, `the code is ${l.code.length} characters; the limit is ${MAX_CUSTOM_CODE}`);
    }
    return err(`${path}.id`, `unknown shader ${show(l.id)} (built-ins: ${list(BUILTIN_SHADERS.map((s) => s.id))}, or "custom")`);
  }
  const def = kept.id === "custom" ? null : getShaderDefinition(kept.id);
  if (l.side !== undefined && l.side !== kept.side) err(`${path}.side`, `${show(l.side)} is not "front", "back" or "both"`);
  if (l.target !== undefined && l.target !== kept.target) {
    err(`${path}.target`, `${show(l.target)} isn't available for ${kept.id} (targets: ${list(def?.targets ?? ["skin", "overlay"])})`);
  }
  if (l.blend !== undefined && l.blend !== kept.blend) err(`${path}.blend`, `${show(l.blend)} is not "normal", "add", "multiply" or "screen"`);
  if (glass && kept.target === "skin") warn(`${path}.target`, "skins don't render on glass cards; use an overlay");
  if (kept.id === "custom") {
    // The card engine runs WGSL; a GLSL layer is skipped.
    if (kept.language !== "wgsl") err(`${path}.language`, `custom layers are WGSL: set language: "wgsl" (GLSL layers are skipped)`);
    for (const e of parseCustomShader(kept.code ?? "", "wgsl").errors) err(`${path}.code${e.line ? `:${e.line}` : ""}`, e.message);
  }
  if (isObj(l.params)) {
    for (const [k, v] of Object.entries(l.params)) {
      if (!kept.params || !has(kept.params, k)) {
        const keys = (kept.id === "custom" ? parseCustomShader(kept.code ?? "", "wgsl").params : (def?.params ?? [])).map((p) => p.key);
        warn(`${path}.params.${k}`, `${show(v)} was ignored (params: ${keys.length ? keys.join(", ") : "none"})`);
      }
    }
  }
}
