import { sanitizeLayer } from "../design/sanitize.ts";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { customShaderDefinition, parseCustomShader } from "./custom-parse.ts";
import { coerceParam, parseShaderColor, resolveShaderParams, uniformName } from "./param-values.ts";
import { BUILTIN_SHADERS, getShaderDefinition, listShaders } from "./registry.ts";
import type { ShaderDefinition, ShaderParamSpec } from "./types.ts";

/** A built-in's WGSL in the engine (crates/card3d-engine/shaders/face/<id>.wgsl). */
const engineWgsl = (id: string) => readFileSync(new URL(`../../../../crates/card3d-engine/shaders/face/${id}.wgsl`, import.meta.url), "utf8");

describe("custom shader annotations", () => {
  const code = [
    "// a starter", // 1
    'uniform float uSpeed; // @param 0 5 1 label="Speed"', // 2
    "uniform int uCount;   // @param 1 12 6", // 3
    "uniform bool uGlow;   // @param default=true", // 4
    "uniform vec2 uCenter; // @param 0 1 default=0.25,0.75", // 5
    'uniform vec3 uTint;   // @color #ff8800 label="Tint"', // 6
    'uniform float uMode;  // @param options="Soft:0,Hard:1" default=1', // 7
    "uniform float uPlain;", // 8: unannotated → not a param
    "// uniform float uCommented; // @param 0 1 0.5", // 9: commented out
    "uniform highp float uPrec; // @param -1 1 0 step=0.25", // 10
    "vec4 mainImage(vec2 uv) { return vec4(uTint, 1.0); }", // 11
  ].join("\n");
  const { params, errors } = parseCustomShader(code);
  const by = (k: string) => params.find((p) => p.key === k)!;

  it("parses every annotated type", () => {
    expect(errors).toEqual([]);
    expect(params.map((p) => p.key)).toEqual(["uSpeed", "uCount", "uGlow", "uCenter", "uTint", "uMode", "uPrec"]);
    expect(by("uSpeed")).toMatchObject({ type: "float", min: 0, max: 5, default: 1, label: "Speed", uniform: "uSpeed" });
    expect(by("uCount")).toMatchObject({ type: "int", min: 1, max: 12, default: 6, step: 1, label: "Count" });
    expect(by("uGlow")).toMatchObject({ type: "bool", default: true, label: "Glow" });
    expect(by("uCenter")).toMatchObject({ type: "vec2", min: 0, max: 1, default: [0.25, 0.75] });
    expect(by("uTint")).toMatchObject({ type: "color", default: "#ff8800", label: "Tint" });
    expect(by("uMode")).toMatchObject({
      type: "float",
      default: 1,
      options: [
        { label: "Soft", value: 0 },
        { label: "Hard", value: 1 },
      ],
    });
    expect(by("uPrec")).toMatchObject({ type: "float", min: -1, max: 1, default: 0, step: 0.25 });
  });

  it("reports annotation errors with user line numbers", () => {
    const bad = [
      "uniform vec2 uTint; // @color #ff0000", // 1
      "uniform float uTime;", // 2 (reserved)
      "uniform float uX; // @param a 1", // 3
      "uniform float uY; // @param 2 1", // 4
      "uniform mat3 uM; // @param", // 5
      "uniform bool uB; // @param default=maybe", // 6
      "vec4 mainImage(vec2 uv) { return vec4(1.0); }",
    ].join("\n");
    const r = parseCustomShader(bad);
    const at = (line: number) =>
      r.errors
        .filter((e) => e.line === line)
        .map((e) => e.message)
        .join(" | ");
    expect(at(1)).toMatch(/@color needs a vec3/);
    expect(at(2)).toMatch(/provided by the face shader prelude/);
    expect(at(3)).toMatch(/min "a" is not a number/);
    expect(at(4)).toMatch(/greater than max/);
    expect(at(5)).toMatch(/@param supports/);
    expect(at(6)).toMatch(/bool default/);
  });

  it("requires mainImage and forbids main()", () => {
    expect(parseCustomShader("vec4 foo(vec2 uv) { return vec4(1.0); }").errors[0]).toMatchObject({ line: 0 });
    const r = parseCustomShader("vec4 mainImage(vec2 uv) { return vec4(1.0); }\nvoid main() {}\n");
    expect(r.errors).toEqual([{ line: 2, message: expect.stringMatching(/don't define main/) }]);
  });

  it("builds a custom definition (animated/pointer from usage)", () => {
    const d = customShaderDefinition("vec4 mainImage(vec2 uv) { return vec4(uPointer.xy, sin(uTime), 1.0); }");
    expect(d).toMatchObject({ id: "custom", animated: true, pointer: true });
    expect(customShaderDefinition("vec4 mainImage(vec2 uv) { return vec4(1.0); }").animated).toBe(false);
    expect(customShaderDefinition("// @replaces-artwork\nvec4 mainImage(vec2 uv) { return artwork(uv); }").replacesArtwork?.({})).toBe(true);
  });
});

describe("custom shader annotations (WGSL)", () => {
  const code = [
    'var<private> uSpeed: f32; // @param 0 5 1 label="Speed"',
    "var<private> uCount: i32; // @param 1 12 6",
    "var<private> uCenter: vec2f; // @param 0 1 default=0.25,0.75",
    "var<private> uTint: vec3<f32>; // @color #ff8800",
    "var<private> uPlain: f32;",
    "fn mainImage(uv: vec2f) -> vec4f { return vec4f(uTint, 1.0); }",
  ].join("\n");

  it("parses the WGSL declarations with the GLSL parser's rules", () => {
    const { params, errors } = parseCustomShader(code, "wgsl");
    expect(errors).toEqual([]);
    expect(params.map((p) => [p.key, p.type, p.default])).toEqual([
      ["uSpeed", "float", 1],
      ["uCount", "int", 6],
      ["uCenter", "vec2", [0.25, 0.75]],
      ["uTint", "color", "#ff8800"],
    ]);
  });

  it("reports WGSL-specific errors with user lines", () => {
    const r = parseCustomShader("var<private> uTime: f32;\nvar<private> uM: mat3x3f; // @param\n@fragment fn main() {}", "wgsl");
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 0, 3]);
    expect(r.errors[1].message).toMatch(/f32, i32, bool, vec2f and vec3f/);
  });

  it("keeps a WGSL layer's params through sanitizing", () => {
    const layer = sanitizeLayer({ id: "custom", language: "wgsl", side: "front", target: "skin", code, params: { uSpeed: 2, uBogus: 1 } });
    expect(layer).toMatchObject({ language: "wgsl", params: { uSpeed: 2 } });
  });
});

describe("params", () => {
  const def: Pick<ShaderDefinition, "params"> = {
    params: [
      { key: "speed", label: "Speed", type: "float", default: 1, min: 0, max: 5 },
      { key: "count", label: "Count", type: "int", default: 3 },
      { key: "on", label: "On", type: "bool", default: false },
      { key: "tint", label: "Tint", type: "color", default: "#ff8800" },
      { key: "at", label: "At", type: "vec2", default: [0.5, 0.5] },
      {
        key: "mode",
        label: "Mode",
        type: "int",
        default: 0,
        options: [
          { label: "A", value: 0 },
          { label: "B", value: 2 },
        ],
      },
    ],
  };

  it("fills defaults and merges given values", () => {
    expect(resolveShaderParams(def)).toEqual({ speed: 1, count: 3, on: false, tint: "#ff8800", at: [0.5, 0.5], mode: 0 });
    expect(resolveShaderParams(def, { speed: 9, count: 4.6, on: true, tint: "#ABC", at: [0, 1], mode: 2, extra: 5 })).toEqual({
      speed: 9, // not clamped: min/max are UI hints
      count: 5,
      on: true,
      tint: "#aabbcc",
      at: [0, 1],
      mode: 2,
    });
  });

  it("drops ill-typed values back to defaults", () => {
    const r = resolveShaderParams(def, { speed: "fast", count: Number.NaN, on: "yes", tint: "red", at: [1], mode: 1 } as never);
    expect(r).toEqual(resolveShaderParams(def));
  });

  it("keeps [r,g,b] colours (exact palette values)", () => {
    expect(resolveShaderParams(def, { tint: [0.07, 0.072, 0.085] }).tint).toEqual([0.07, 0.072, 0.085]);
    expect(parseShaderColor("#ff0000")).toEqual([1, 0, 0]);
    expect(parseShaderColor("#0f0")).toEqual([0, 1, 0]);
    expect(parseShaderColor("nope")).toBeNull();
    expect(coerceParam({ key: "b", label: "B", type: "bool", default: false }, 1)).toBe(true);
  });

  it("derives uniform names", () => {
    expect(uniformName({ key: "flowStrength" } as ShaderParamSpec)).toBe("uFlowStrength");
    expect(uniformName({ key: "x", uniform: "uMine" } as ShaderParamSpec)).toBe("uMine");
  });
});

describe("registry", () => {
  it("has the built-in library with complete, valid param specs, each drawn by the engine", () => {
    const ids = BUILTIN_SHADERS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["thermal", "liquid-metal", "caustics", "lens", "vinyl", "wood", "oil-slick", "gradient-mesh", "foil-flakes", "halftone", "scanlines"]) {
      expect(ids).toContain(id);
    }
    for (const d of BUILTIN_SHADERS) {
      expect(d.label && d.description, d.id).toBeTruthy();
      expect(d.targets, d.id).toContain(d.defaultTarget);
      // The engine's WGSL for it (face_library.rs).
      const wgsl = engineWgsl(d.id);
      expect(wgsl, d.id).toMatch(/fn\s+mainImage\s*\(\s*uv\s*:\s*vec2f\s*\)\s*->\s*vec4f/);
      const keys = new Set<string>();
      for (const p of d.params) {
        const where = `${d.id}.${p.key}`;
        expect(keys.has(p.key), where).toBe(false);
        keys.add(p.key);
        expect(p.label, where).toBeTruthy();
        expect(coerceParam(p, p.default), where).not.toBeUndefined();
        if (p.min !== undefined && p.max !== undefined) expect(p.min, where).toBeLessThanOrEqual(p.max);
        if (typeof p.default === "number" && p.min !== undefined && p.max !== undefined) {
          expect(p.default, where).toBeGreaterThanOrEqual(p.min);
          expect(p.default, where).toBeLessThanOrEqual(p.max);
        }
        if ((p.type === "float" || p.type === "int") && !p.options) expect(p.min !== undefined && p.max !== undefined, `${where} range`).toBe(true);
        // every declared param is used by the shader (liquid metal's drive its runtime instead)
        if (d.id !== "liquid-metal") expect(wgsl, where).toContain(uniformName(p));
      }
    }
  });

  it("looks up and lists", () => {
    expect(getShaderDefinition("thermal")?.label).toBe("Thermal contours");
    expect(getShaderDefinition("nope")).toBeUndefined();
    expect(listShaders()).toEqual([...BUILTIN_SHADERS]);
  });
});

describe("the WGSL prelude's names", () => {
  it("list every declaration of crates/card3d-engine/shaders/face/prelude.wgsl, with its type", async () => {
    const { readFileSync } = await import("node:fs");
    const { WGSL_PRELUDE_NAMES } = await import("./prelude-wgsl.ts");
    const src = readFileSync(new URL("../../../../crates/card3d-engine/shaders/face/prelude.wgsl", import.meta.url), "utf8");
    const declared = [...src.matchAll(/^var<private>\s+(\w+)\s*:\s*(\w+)\s*;/gm)].filter((m) => !m[1].startsWith("card3d")).map((m) => [m[1], m[2]]);
    const helpers = [...src.matchAll(/^fn\s+(\w+)\s*\(([^)]*)\)\s*->\s*(\w+)/gm)].filter((m) => !m[1].startsWith("card3d")).map((m) => m[1]);
    for (const [name, type] of declared) expect(WGSL_PRELUDE_NAMES.find((n) => n.name === name)?.type, name).toBe(type);
    for (const name of helpers) expect(WGSL_PRELUDE_NAMES.find((n) => n.name === name)?.kind, name).toBe("helper");
    for (const n of WGSL_PRELUDE_NAMES) expect([...declared.map((d) => d[0]), ...helpers], n.name).toContain(n.name);
  });

  it("the WGSL starters parse without errors", async () => {
    const { WGSL_SHADER_EXAMPLES } = await import("./wgsl-examples.ts");
    const { parseCustomShader } = await import("./custom-parse.ts");
    for (const ex of WGSL_SHADER_EXAMPLES) expect(parseCustomShader(ex.code, "wgsl").errors, ex.id).toEqual([]);
  });
});
