import type { ShaderParamValue } from "../types.ts";
import type { ShaderParamSpec } from "../shaders/types.ts";

/**
 * User-facing parameters of the add-on rigs (`src/addons`), as data the studio can build controls
 * from. Every default reproduces the add-on's standard look exactly: a param left at its default
 * never changes a shader, a material or a uniform. Values live in each add-on's own object,
 * `CardDesign.addons.shine` / `CardDesign.addons.vines`.
 */

export type EffectParamType = "float" | "int" | "bool" | "color" | "select";

export interface EffectParamOption {
  value: string;
  label: string;
}

/**
 * One parameter. Same field names and meaning as the face-shader `ShaderParamSpec` (key, label,
 * default, min/max/step, description), plus a string `select` type.
 *
 * - float / int: number; values are clamped to [min, max] and ints rounded.
 * - bool: boolean.
 * - color: "#rrggbb" (display sRGB).
 * - select: one of `options[].value`.
 * - `optional`: the value may be left unset, meaning "off / automatic" (the default is then only
 *   the control's starting value). The studio shows an enable toggle.
 */
export interface EffectParamSpec extends Pick<ShaderParamSpec, "key" | "label" | "min" | "max" | "step" | "description"> {
  type: EffectParamType;
  default: number | boolean | string;
  options?: readonly EffectParamOption[];
  optional?: boolean;
}

export type EffectId = "shine" | "vines";

/** @archive the local three.js archive (.archive/three-engine) imports it */
export const VINES_LEAF_DEFAULT = "#6b9e45";

export const EFFECT_PARAMS = {
  shine: [
    {
      key: "tone",
      label: "Tone",
      type: "select",
      default: "gold",
      options: [
        { value: "gold", label: "Gold" },
        { value: "ice", label: "Ice" },
      ],
    },
    { key: "intensity", label: "Intensity", type: "float", default: 1, min: 0, max: 2, step: 0.01 },
    {
      key: "time",
      label: "Sweep frozen at (s)",
      type: "float",
      default: 0,
      min: 0,
      max: 3600,
      step: 0.1,
      optional: true,
      description: "Freeze the light sweep at this time.",
    },
  ],
  vines: [
    { key: "cycle", label: "Grow and wither", type: "bool", default: true, description: "Loop the 80 s grow / wither cycle; off shows the vines fully grown." },
    { key: "density", label: "Density", type: "float", default: 1, min: 0.1, max: 1, step: 0.01, description: "Share of the vines that grow." },
    {
      key: "leafColor",
      label: "Leaf colour",
      type: "color",
      default: VINES_LEAF_DEFAULT,
      description: "Recolours the young leaves (autumn colours are kept).",
    },
    {
      key: "time",
      label: "Frozen at (s)",
      type: "float",
      default: 0,
      min: 0,
      max: 80,
      step: 0.1,
      optional: true,
      description: "Freeze the cycle at this time.",
    },
  ],
} as const satisfies Record<EffectId, readonly EffectParamSpec[]>;

export interface EffectCatalogEntry {
  id: EffectId;
  /** Where it is selected: `addons.<id>`. */
  kind: "addon";
  label: string;
  description: string;
  /** Runs every frame (wind, drifting light, growth). */
  animated: boolean;
  params: readonly EffectParamSpec[];
}

export const EFFECT_CATALOG: Record<EffectId, EffectCatalogEntry> = {
  shine: {
    id: "shine",
    kind: "addon",
    label: "Shine",
    description: "Drifting lights, a pastel aura, light streaks and a glint over the card.",
    animated: true,
    params: EFFECT_PARAMS.shine,
  },
  vines: {
    id: "vines",
    kind: "addon",
    label: "Vines",
    description: "Ivy that grows over both faces and wraps the edges, sways with the card and casts leaf shadows.",
    animated: true,
    params: EFFECT_PARAMS.vines,
  },
};

// ── resolving values ────────────────────────────────────────────────────────

export type ResolvedEffectParams = Record<string, number | boolean | string | undefined>;

/** "#rgb" / "#rrggbb" → "#rrggbb" (lower case), or null. */
export function normalizeHexColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  let m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^#?([0-9a-f]{3})$/.exec(s);
  if (m)
    return `#${m[1]
      .split("")
      .map((c) => c + c)
      .join("")}`;
  return null;
}

/** Coerces one value to `spec`; undefined when it does not fit (the caller falls back to the default). */
export function coerceEffectParam(spec: EffectParamSpec, v: unknown): number | boolean | string | undefined {
  switch (spec.type) {
    case "float":
    case "int": {
      if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
      let n = spec.type === "int" ? Math.round(v) : v;
      if (spec.min !== undefined) n = Math.max(spec.min, n);
      if (spec.max !== undefined) n = Math.min(spec.max, n);
      return n;
    }
    case "bool":
      return typeof v === "boolean" ? v : undefined;
    case "color":
      return normalizeHexColor(v) ?? undefined;
    case "select":
      return typeof v === "string" && spec.options?.some((o) => o.value === v) ? v : undefined;
  }
}

/**
 * Every declared param of `id`, from `values` where valid, else the default. Optional params with no
 * valid value resolve to undefined.
 */
export function resolveEffectParams(id: EffectId, values?: Readonly<Record<string, unknown>> | null): ResolvedEffectParams {
  const out: ResolvedEffectParams = {};
  for (const spec of EFFECT_PARAMS[id] as readonly EffectParamSpec[]) {
    const given = values && Object.prototype.hasOwnProperty.call(values, spec.key) ? coerceEffectParam(spec, values[spec.key]) : undefined;
    out[spec.key] = given ?? (spec.optional ? undefined : spec.default);
  }
  return out;
}

/** The defaults of `id` (optional params omitted), e.g. to seed a studio panel. */
export function defaultEffectParams(id: EffectId): Record<string, ShaderParamValue> {
  const out: Record<string, ShaderParamValue> = {};
  for (const spec of EFFECT_PARAMS[id] as readonly EffectParamSpec[]) if (!spec.optional) out[spec.key] = spec.default;
  return out;
}

/** True when `value` equals the spec default (colours compared case-insensitively). */
export function isDefaultParam(id: EffectId, key: string, value: unknown): boolean {
  const spec = (EFFECT_PARAMS[id] as readonly EffectParamSpec[]).find((s) => s.key === key);
  if (!spec) return false;
  if (spec.type === "color") return normalizeHexColor(value) === normalizeHexColor(spec.default);
  return value === spec.default;
}

// ── colour helpers shared by the tint params ────────────────────────────────

/** "#rrggbb" → [h (0..1), s, v] of the display (sRGB) colour. */
function hexToHsv(hex: string): [number, number, number] {
  const n = parseInt((normalizeHexColor(hex) ?? "#000000").slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, max > 0 ? d / max : 0, max];
}

/**
 * A recolour from `reference` to `target` as [hue shift (turns), saturation ratio, value ratio],
 * for the shaders' `hsvShift` helpers. Identity ([0, 1, 1]) when the two are equal.
 */
export function hsvShift(reference: string, target: string): [number, number, number] {
  const [h0, s0, v0] = hexToHsv(reference);
  const [h1, s1, v1] = hexToHsv(target);
  let dh = h1 - h0;
  dh -= Math.round(dh);
  return [dh, s1 / Math.max(s0, 1e-3), v1 / Math.max(v0, 1e-3)];
}

/** GLSL: `vec3 hsvShift(vec3 rgb, vec3 shift)` applying an `hsvShift()` triple to a colour. @archive the local three.js archive imports it */
export const HSV_SHIFT_GLSL = /* glsl */ `
vec3 fxRgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 fxHsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 hsvShift(vec3 rgb, vec3 shift) {
  vec3 h = fxRgb2hsv(max(rgb, 0.0));
  return fxHsv2rgb(vec3(fract(h.x + shift.x), clamp(h.y * shift.y, 0.0, 1.0), h.z * shift.z));
}
`;
