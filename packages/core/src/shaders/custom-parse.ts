import { coerceParam, parseShaderColor } from "./param-values.ts";
import { COMMON_GLOBALS, COMMON_UNIFORMS } from "./prelude.ts";
import type { ShaderDefinition, ShaderError, ShaderParamOption, ShaderParamSpec, ShaderParamType } from "./types.ts";

/**
 * Custom face shaders: `FaceShader { id: "custom", language, code }`, parsed for their parameters
 * (pure text work: the card engine compiles and draws them, crates/card3d-engine/src/face_custom.rs).
 *
 * WGSL (`language: "wgsl"`, the language the engine draws): `fn mainImage(uv: vec2f) -> vec4f` plus helpers, parameters as
 * `var<private> uName: type; // @param …` / `// @color …` (see `parseCustomWgsl`; starters:
 * `WGSL_SHADER_EXAMPLES`).
 *
 * GLSL (the default `language`, from the three.js engine's era): the engine skips these layers, but
 * their parameters stay readable so an editor can show them while the code is rewritten in WGSL.
 * Parameters are uniforms annotated on the same line:
 *
 *   uniform float uSpeed;  // @param 0 5 1 label="Speed"      min max default (+ step=, label=)
 *   uniform int   uCount;  // @param 1 12 6
 *   uniform bool  uGlow;   // @param default=true
 *   uniform vec2  uCenter; // @param 0 1 default=0.5,0.5
 *   uniform vec3  uTint;   // @color #ff8800 label="Tint"
 *   uniform float uMode;   // @param options="Soft:0,Hard:1" default=1
 *
 * In both, a line `// @replaces-artwork` anywhere in the code hides the face's own artwork layer (for
 * shaders that draw a processed version of it via artwork(uv)), and the prelude's names
 * (`COMMON_UNIFORMS`, `COMMON_GLOBALS`) are reserved. Unannotated uniforms are not exposed.
 */

export interface CustomShaderParse {
  params: ShaderParamSpec[];
  errors: ShaderError[];
}

const PARAM_TYPES: Record<string, ShaderParamType> = { float: "float", int: "int", bool: "bool", vec2: "vec2", vec3: "vec3" };
const RESERVED = new Set<string>([...COMMON_UNIFORMS, ...COMMON_GLOBALS, "card3dLoopGuard", "card3dGuard"]);

/** "uGlowAmount" → "Glow amount". */
function humanize(name: string): string {
  const s = name
    .replace(/^u(?=[A-Z])/, "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : name;
}

/** Splits an annotation into tokens: bare words and key=value / key="quoted value". */
function tokenize(s: string): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  const re = /([A-Za-z_][\w]*)\s*=\s*("([^"]*)"|'([^']*)'|\S+)|("([^"]*)"|\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[1]) named[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[2];
    else positional.push(m[6] ?? m[5]);
  }
  return { positional, named };
}

const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

function parseVector(s: string, n: number): number[] | null {
  const parts = s
    .replace(/^[([]|[)\]]$/g, "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length === 1 && Number.isFinite(parts[0])) return Array(n).fill(parts[0]);
  return parts.length === n && parts.every(Number.isFinite) ? parts : null;
}

/** Strips comments (keeping line structure) so code scans ignore commented-out text. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * Parses a custom shader's annotated uniforms into param specs (pure; no GL). Errors carry 1-based
 * lines of `code`.
 */
export function parseCustomShader(code: string, language: "glsl" | "wgsl" = "glsl"): CustomShaderParse {
  if (language === "wgsl") return parseCustomWgsl(code);
  const params: ShaderParamSpec[] = [];
  const errors: ShaderError[] = [];
  const lines = code.split("\n");
  const bare = stripComments(code).split("\n");
  const seen = new Set<string>();

  lines.forEach((raw, i) => {
    const line = i + 1;
    const decl = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*(\[[^\]]*\])?\s*;/.exec(bare[i]);
    if (!decl) return;
    const [, type, name, array] = decl;
    if (RESERVED.has(name)) {
      errors.push({ line, message: `"${name}" is provided by the face shader prelude; remove this declaration` });
      return;
    }
    const comment = /\/\/\s*@(param|color)\b(.*)$/.exec(raw);
    if (!comment) return;
    if (array) {
      errors.push({ line, message: `array uniform "${name}" can't be a @${comment[1]}` });
      return;
    }
    if (seen.has(name)) {
      errors.push({ line, message: `"${name}" is declared twice` });
      return;
    }
    const kind = comment[1];
    const { positional, named } = tokenize(comment[2]);
    const label = named.label ?? humanize(name);
    const description = named.description ?? named.help;

    if (kind === "color") {
      if (type !== "vec3") {
        errors.push({ line, message: `@color needs a vec3 uniform ("${name}" is ${type})` });
        return;
      }
      const given = named.default ?? positional[0] ?? "#ffffff";
      const rgb = parseShaderColor(given);
      if (!rgb) errors.push({ line, message: `@color default "${given}" is not a #rrggbb colour` });
      seen.add(name);
      params.push({
        key: name,
        uniform: name,
        label,
        type: "color",
        default: rgb ? (coerceParam({ key: name, label, type: "color", default: "#ffffff" }, given) as string) : "#ffffff",
        ...(description ? { description } : {}),
      });
      return;
    }

    const ptype = PARAM_TYPES[type];
    if (!ptype) {
      errors.push({ line, message: `@param supports float, int, bool, vec2 and vec3 uniforms ("${name}" is ${type}); use @color for colours` });
      return;
    }
    const spec: ShaderParamSpec = { key: name, uniform: name, label, type: ptype, default: 0 };
    if (description) spec.description = description;

    if (ptype === "bool") {
      const d = (named.default ?? positional[0] ?? "false").toLowerCase();
      if (d !== "true" && d !== "false" && d !== "1" && d !== "0") errors.push({ line, message: `bool default must be true or false (got "${d}")` });
      spec.default = d === "true" || d === "1";
    } else {
      const min = num(named.min ?? positional[0]);
      const max = num(named.max ?? positional[1]);
      const step = num(named.step ?? (ptype === "float" || ptype === "int" ? positional[3] : undefined));
      for (const [k, v] of [
        ["min", named.min ?? positional[0]],
        ["max", named.max ?? positional[1]],
      ] as const) {
        if (v !== undefined && num(v) === undefined) errors.push({ line, message: `${k} "${v}" is not a number` });
      }
      if (min !== undefined) spec.min = min;
      if (max !== undefined) spec.max = max;
      if (min !== undefined && max !== undefined && min > max) errors.push({ line, message: `min ${min} is greater than max ${max}` });
      if (step !== undefined) spec.step = step;
      else if (ptype === "int") spec.step = 1;
      const dRaw = named.default ?? positional[2];
      if (ptype === "vec2" || ptype === "vec3") {
        const n = ptype === "vec2" ? 2 : 3;
        const v = dRaw === undefined ? Array(n).fill(min ?? 0) : parseVector(dRaw, n);
        if (!v) errors.push({ line, message: `default "${dRaw}" is not a ${type} (write default=x,y${n === 3 ? ",z" : ""})` });
        spec.default = (v ?? Array(n).fill(0)) as [number, number] | [number, number, number];
      } else {
        if (named.options) {
          const options: ShaderParamOption[] = [];
          for (const part of named.options.split(",")) {
            const m = /^\s*([^:=]+?)\s*[:=]\s*(-?[\d.]+)\s*$/.exec(part);
            if (m) options.push({ label: m[1], value: Number(m[2]) });
            else errors.push({ line, message: `option "${part.trim()}" should look like Label:value` });
          }
          if (options.length) spec.options = options;
        }
        const d = dRaw === undefined ? (spec.options?.[0]?.value ?? min ?? 0) : num(dRaw);
        if (d === undefined) errors.push({ line, message: `default "${dRaw}" is not a number` });
        spec.default = ptype === "int" ? Math.round(d ?? 0) : (d ?? 0);
      }
    }
    seen.add(name);
    params.push(spec);
  });

  if (!/\bvec4\s+mainImage\s*\(\s*(?:in\s+)?vec2\s+\w+\s*\)/.test(stripComments(code))) {
    errors.push({ line: 0, message: "define vec4 mainImage(vec2 uv) — it returns the colour (display sRGB) and alpha of each pixel" });
  }
  if (/\bvoid\s+main\s*\(/.test(stripComments(code))) {
    const line =
      stripComments(code)
        .split("\n")
        .findIndex((l) => /\bvoid\s+main\s*\(/.test(l)) + 1;
    errors.push({ line, message: "don't define main(); write vec4 mainImage(vec2 uv) instead" });
  }
  return { params, errors };
}

const WGSL_TYPES: Record<string, ShaderParamType> = {
  f32: "float",
  i32: "int",
  bool: "bool",
  vec2f: "vec2",
  "vec2<f32>": "vec2",
  vec3f: "vec3",
  "vec3<f32>": "vec3",
};

/**
 * The WGSL form of `parseCustomShader` (the Rust engine's `face_custom::parse`): parameters are
 * `var<private> uName: type; // @param …` / `// @color …`, the shader defines
 * `fn mainImage(uv: vec2f) -> vec4f`, and entry points are not allowed. Same annotations and errors.
 */
function parseCustomWgsl(code: string): CustomShaderParse {
  const params: ShaderParamSpec[] = [];
  const errors: ShaderError[] = [];
  const lines = code.split("\n");
  const bare = stripComments(code).split("\n");
  const seen = new Set<string>();
  lines.forEach((raw, i) => {
    const line = i + 1;
    const decl = /^\s*var\s*<\s*private\s*>\s*(\w+)\s*:\s*([^;=]+?)\s*;/.exec(bare[i]);
    if (!decl) return;
    const name = decl[1];
    const type = decl[2].replace(/\s+/g, "");
    if (RESERVED.has(name) || name === "uSource") {
      errors.push({ line, message: `"${name}" is provided by the face shader prelude; remove this declaration` });
      return;
    }
    const comment = /\/\/\s*@(param|color)\b(.*)$/.exec(raw);
    if (!comment) return;
    if (seen.has(name)) {
      errors.push({ line, message: `"${name}" is declared twice` });
      return;
    }
    const { positional, named } = tokenize(comment[2]);
    const label = named.label ?? humanize(name);
    const description = named.description ?? named.help;
    if (comment[1] === "color") {
      if (WGSL_TYPES[type] !== "vec3") {
        errors.push({ line, message: `@color needs a vec3f declaration ("${name}" is ${type})` });
        return;
      }
      const given = named.default ?? positional[0] ?? "#ffffff";
      const rgb = parseShaderColor(given);
      if (!rgb) errors.push({ line, message: `@color default "${given}" is not a #rrggbb colour` });
      seen.add(name);
      params.push({
        key: name,
        uniform: name,
        label,
        type: "color",
        default: rgb ? (coerceParam({ key: name, label, type: "color", default: "#ffffff" }, given) as string) : "#ffffff",
        ...(description ? { description } : {}),
      });
      return;
    }
    const ptype = WGSL_TYPES[type];
    if (!ptype) {
      errors.push({ line, message: `@param supports f32, i32, bool, vec2f and vec3f ("${name}" is ${type}); use @color for colours` });
      return;
    }
    // The GLSL parser's rules from here on: reuse it on an equivalent uniform line.
    const glslType = ptype === "vec2" ? "vec2" : ptype === "vec3" ? "vec3" : ptype;
    const r = parseCustomShader(`uniform ${glslType} ${name}; // @param${comment[2]}\nvec4 mainImage(vec2 uv) { return vec4(0.0); }`);
    for (const e of r.errors) errors.push({ line, message: e.message });
    const spec = r.params[0];
    if (spec) {
      seen.add(name);
      params.push(spec);
    }
  });
  const stripped = stripComments(code);
  if (!/\bfn\s+mainImage\s*\(\s*\w+\s*:\s*vec2(?:f|<\s*f32\s*>)\s*\)\s*->\s*vec4(?:f|<\s*f32\s*>)/.test(stripped)) {
    errors.push({ line: 0, message: "define fn mainImage(uv: vec2f) -> vec4f — it returns the colour (display sRGB) and alpha of each pixel" });
  }
  const entry = stripped.split("\n").findIndex((l) => /@(fragment|vertex|compute)\b/.test(l));
  if (entry >= 0) errors.push({ line: entry + 1, message: "don't write entry points; write fn mainImage(uv: vec2f) -> vec4f instead" });
  return { params, errors };
}

/** A custom layer's definition (params from its annotations; whether it animates or reads the pointer). */
export function customShaderDefinition(code: string, parse: CustomShaderParse = parseCustomShader(code)): ShaderDefinition {
  const bare = stripComments(code);
  return {
    id: "custom",
    label: "Custom shader",
    description: "User shader: mainImage(uv).",
    targets: ["skin", "overlay"],
    defaultTarget: "skin",
    params: parse.params,
    animated: /\b(uTime|uTilt)\b/.test(bare),
    pointer: /\buPointer\b/.test(bare),
    replacesArtwork: /\/\/\s*@replaces-artwork\b/.test(code) ? () => true : undefined,
  };
}

/** A starter custom shader (`WGSL_SHADER_EXAMPLES`). */
export interface CustomShaderExample {
  id: string;
  label: string;
  description: string;
  target: "skin" | "overlay";
  code: string;
}
