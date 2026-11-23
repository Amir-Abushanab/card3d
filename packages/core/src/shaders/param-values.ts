/** Face-shader parameter values: parsing, coercion, defaults (the design model and the editor use them). */
import type { ShaderParamValue } from "../types.ts";
import type { ShaderDefinition, ShaderParamSpec } from "./types.ts";

/** GLSL uniform name of a param: `spec.uniform`, else `u` + PascalCase(key) ("flowStrength" → "uFlowStrength"). */
export function uniformName(spec: ShaderParamSpec): string {
  if (spec.uniform) return spec.uniform;
  const k = spec.key.replace(/[^A-Za-z0-9_]/g, "_");
  return `u${k.charAt(0).toUpperCase()}${k.slice(1)}`;
}

/** "#rgb" / "#rrggbb" (or an [r, g, b] 0..1 triple) → [r, g, b] in 0..1, or null. No colour conversion. */
export function parseShaderColor(v: unknown): [number, number, number] | null {
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return [v[0], v[1], v[2]];
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  m = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16) / 255);
    return [r, g, b];
  }
  return null;
}

/** [r, g, b] 0..1 → "#rrggbb". */
export function toHexColor(rgb: readonly number[]): string {
  const c = (x: number) =>
    Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Coerces one value to its spec's type; returns undefined when it does not fit (the default is used).
 * Numbers are not clamped to min/max (those are UI hints) but ints are rounded and options enforced.
 */
export function coerceParam(spec: ShaderParamSpec, v: unknown): ShaderParamValue | undefined {
  switch (spec.type) {
    case "float":
    case "int": {
      const n = typeof v === "boolean" ? Number(v) : v;
      if (!isNum(n)) return undefined;
      const value = spec.type === "int" ? Math.round(n) : n;
      if (spec.options?.length && !spec.options.some((o) => o.value === value)) return undefined;
      return value;
    }
    case "bool":
      if (typeof v === "boolean") return v;
      if (isNum(v)) return v !== 0;
      return undefined;
    case "color": {
      const c = parseShaderColor(v);
      if (!c) return undefined;
      return Array.isArray(v) ? c : toHexColor(c);
    }
    case "vec2":
    case "vec3": {
      const n = spec.type === "vec2" ? 2 : 3;
      if (!Array.isArray(v) || v.length !== n || !v.every(isNum)) return undefined;
      return [...v] as [number, number] | [number, number, number];
    }
  }
}

/**
 * Merges `values` over the definition's defaults: every declared param present, each coerced to its
 * type; unknown keys and ill-typed values are dropped.
 */
export function resolveShaderParams(def: Pick<ShaderDefinition, "params">, values?: Record<string, ShaderParamValue> | null): Record<string, ShaderParamValue> {
  const out: Record<string, ShaderParamValue> = {};
  for (const spec of def.params) {
    const given = values && Object.prototype.hasOwnProperty.call(values, spec.key) ? coerceParam(spec, values[spec.key]) : undefined;
    out[spec.key] = given ?? coerceParam(spec, spec.default) ?? spec.default;
  }
  return out;
}

/** GLSL type of a param's uniform. @archive the local three.js archive imports it */
export function glslType(spec: ShaderParamSpec): string {
  switch (spec.type) {
    case "float":
      return "float";
    case "int":
      return "int";
    case "bool":
      return "bool";
    case "color":
    case "vec3":
      return "vec3";
    case "vec2":
      return "vec2";
  }
}
