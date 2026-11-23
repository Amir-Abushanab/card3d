import { describe, expect, it } from "vitest";
import { describeDesignSpace, designSpaceSections, lintDesign, DESIGN_EXAMPLES } from "../describe.ts";
import * as F from "./fields.ts";
import { ensureDesign } from "../design/design.ts";
import { CARD_PRESETS } from "../presets.ts";
import { BUILTIN_SHADERS } from "../shaders/registry.ts";
import { COMMON_GLOBALS, COMMON_UNIFORMS } from "../shaders/prelude.ts";
import { EFFECT_PARAMS } from "../effects/params.ts";
import { LIGHTING_PRESETS } from "../scene/lighting-presets.ts";
import { SCENE_ENVIRONMENTS } from "../scene/environments.ts";
import { SCENE_BACKDROPS } from "../scene/staging-view.ts";
import { CARD_FONTS } from "../fonts.ts";
import { CARD_CUTOUTS } from "../geometry/shape-frame.ts";
import { EDGE_FINISHES } from "../card/edge-finish.ts";
import { MARK_FINISHES } from "../card/mark-finishes.ts";
import { LOGO_POSITIONS } from "../card/logo-limits.ts";
import { FOIL_TEXTURES, HOLO_STYLES, type CardDesign } from "../types.ts";
import { RECIPE_MATERIALS, TEXTURE_OPTIONS } from "../recipe/defaults.ts";

const text = describeDesignSpace();
const mentions = (s: string) => text.includes(`\`${s}\``);

/**
 * A design that sets every documented top-level field (the kitchen sink). If a field is added to
 * `CardDesign` (and to `ensureDesign`), `DESIGN_FIELDS` stops compiling until it is documented, and
 * this test fails until the field is set here too.
 */
const KITCHEN_SINK: Record<keyof typeof F.DESIGN_FIELDS, unknown> = {
  recipe: { material: "brass", color: "#e39a4a", texture: "guilloche", pattern: "orbit", frontHolo: true, holoStyle: "cosmos" },
  cardholderName: "Ada Lovelace",
  cardholderBio: "Member since 1843",
  decals: [
    {
      id: "s",
      side: "front",
      src: "/sticker.png",
      aspect: 1,
      x: 50,
      y: 50,
      width: 20,
      rotation: 0,
      scale: 1,
      crop: { x: 0.1, y: 0, w: 0.5, h: 0.8 },
      flip: { h: true },
      tint: { color: "#808080", amount: 1 },
      adjust: { contrast: 0.2 },
      opacity: 0.8,
    },
  ],
  surfaceSources: { front: "/art.png" },
  surfaceTreatments: { front: "inlay" },
  materialOverride: { clearcoat: 0.5 },
  brandingOverride: { brandingClearcoat: 0.4 },
  frontLayout: { nameFontHeight: 0.05 },
  shaders: [{ id: "oil-slick", side: "both", target: "overlay" }],
  addons: { shine: { tone: "ice" }, vines: {} },
  font: "manrope",
  logo: { path: "M0 0H10V10Z", viewBox: [10, 10], position: "center" },
  lighting: "warm",
  finish: { name: "engraved" },
  edge: { finish: "anodized", color: "#2f6fd6", chamfer: true },
  shape: { cornerRadius: 0.125, orientation: "portrait", cutouts: ["window"] },
  contactless: { scale: 1 },
  textLines: [{ text: "4000 1234", placement: "top" }],
  scene: { environment: "softbox", backdrop: "sweep", floor: true },
};

describe("design-space description", () => {
  it("documents every CardDesign field, and ensureDesign keeps nothing undocumented", () => {
    const d = ensureDesign(KITCHEN_SINK);
    for (const k of Object.keys(F.DESIGN_FIELDS)) {
      expect(mentions(k), `field ${k} in the text`).toBe(true);
      expect(d, `ensureDesign keeps ${k}`).toHaveProperty(k);
    }
    for (const k of Object.keys(d)) expect(F.DESIGN_FIELDS, `${k} is documented`).toHaveProperty(k);
    for (const k of Object.keys(F.DECAL_FIELDS)) expect(d.decals[0], `ensureDesign keeps decal ${k}`).toHaveProperty(k);
    for (const k of Object.keys(d.decals[0])) expect(F.DECAL_FIELDS, `decal ${k} is documented`).toHaveProperty(k);
  });

  it("documents every nested field", () => {
    const nested: [string, Record<string, unknown>][] = [
      ["finish.", F.FINISH_FIELDS],
      ["edge.", F.EDGE_FIELDS],
      ["shape.", F.SHAPE_FIELDS],
      ["contactless.", F.CONTACTLESS_FIELDS],
      ["", F.TEXT_LINE_FIELDS],
      ["logo.", F.LOGO_FIELDS],
      ["materialOverride.", F.MATERIAL_OVERRIDE_FIELDS],
      ["scene.", F.SCENE_FIELDS],
      ["scene.floor.", F.FLOOR_FIELDS],
      ["", F.LAYER_FIELDS],
      ["", F.DECAL_FIELDS],
      ["crop.", F.DECAL_CROP_FIELDS],
      ["tint.", F.DECAL_TINT_FIELDS],
      ["adjust.", F.DECAL_ADJUST_FIELDS],
      ["addons.", F.ADDON_FIELDS],
      ["", F.RECIPE_DOCS],
    ];
    for (const [prefix, table] of nested) for (const k of Object.keys(table)) expect(mentions(prefix + k), `${prefix}${k}`).toBe(true);
    expect(mentions("brandingOverride.brandingClearcoat")).toBe(true);
  });

  it("lists every catalog entry", () => {
    const ids = [
      ...CARD_PRESETS.map((p) => p.id),
      ...BUILTIN_SHADERS.map((s) => s.id),
      ...LIGHTING_PRESETS.map((l) => l.id),
      ...SCENE_ENVIRONMENTS.map((e) => e.id),
      ...SCENE_BACKDROPS,
      ...CARD_FONTS.map((f) => f.id),
      ...CARD_CUTOUTS,
      ...EDGE_FINISHES,
      ...MARK_FINISHES,
      ...LOGO_POSITIONS,
      ...HOLO_STYLES,
      ...FOIL_TEXTURES,
      ...RECIPE_MATERIALS.map((m) => m.id),
      ...TEXTURE_OPTIONS.map((t) => t.value),
    ];
    for (const id of ids) expect(mentions(id), id).toBe(true);
    for (const s of BUILTIN_SHADERS) for (const p of s.params) expect(mentions(p.key), `${s.id}.${p.key}`).toBe(true);
    for (const [id, specs] of Object.entries(EFFECT_PARAMS)) for (const p of specs) expect(mentions(p.key), `${id}.${p.key}`).toBe(true);
    for (const u of [...COMMON_UNIFORMS, ...COMMON_GLOBALS.filter((g) => !g.startsWith("v"))]) expect(text, u).toContain(` ${u}`);
  });

  it("only offers values the sanitizer accepts", () => {
    const base = { recipe: {}, cardholderName: "x" };
    for (const l of LIGHTING_PRESETS) expect(ensureDesign({ ...base, lighting: l.id }).lighting ?? "studio").toBe(l.id);
    for (const f of CARD_FONTS) expect(ensureDesign({ ...base, font: f.id }).font).toBe(f.id);
    for (const f of EDGE_FINISHES) expect(ensureDesign({ ...base, edge: { finish: f } }).edge?.finish).toBe(f);
    for (const c of CARD_CUTOUTS) expect(ensureDesign({ ...base, shape: { cutouts: [c] } }).shape?.cutouts).toEqual([c]);
    for (const f of MARK_FINISHES.filter((x) => x !== "default")) expect(ensureDesign({ ...base, finish: { name: f } }).finish?.name).toBe(f);
    for (const e of SCENE_ENVIRONMENTS) expect(ensureDesign({ ...base, scene: { environment: e.id } }).scene?.environment).toBe(e.id);
    for (const b of SCENE_BACKDROPS.filter((x) => x !== "none")) expect(ensureDesign({ ...base, scene: { backdrop: b } }).scene?.backdrop).toBe(b);
    for (const s of BUILTIN_SHADERS)
      expect(ensureDesign({ ...base, shaders: [{ id: s.id, side: "front", target: s.defaultTarget }] }).shaders?.[0].id).toBe(s.id);
  });

  it("has sections with titles and bodies", () => {
    const sections = designSpaceSections();
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length);
    for (const s of sections) expect(s.body.length, s.id).toBeGreaterThan(40);
  });
});

describe("lintDesign", () => {
  it("passes every worked example without errors or warnings", () => {
    for (const ex of DESIGN_EXAMPLES) {
      const r = lintDesign(ex.design);
      expect(r.errors, ex.description).toEqual([]);
      expect(r.warnings, ex.description).toEqual([]);
      expect(text).toContain(ex.description);
    }
  });

  it("reports unknown fields, bad ids and values, with paths", () => {
    const r = lintDesign({
      recipe: { material: "gold", color: "rose", grain: 140, sparkle: 3 },
      cardholderName: "x",
      glow: true,
      lighting: "sunny",
      edge: { finish: "match", color: "#ff0000", shine: 1 },
      shaders: [{ id: "plasma-x" }, { id: "oil-slick", side: "front", target: "overlay", params: { strength: 0.3, nope: 1 } }],
    });
    const paths = r.errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["glow", "recipe.material", "recipe.color", "recipe.sparkle", "lighting", "edge.shine", "shaders[0].id"]));
    const warned = r.warnings.map((e) => e.path);
    expect(warned).toEqual(expect.arrayContaining(["recipe.grain", "edge.color", "shaders[1].params.nope"]));
    expect(r.design?.recipe.material).toBe("silver");
  });

  it("reports custom shader annotation errors with their WGSL line", () => {
    const code = "var<private> uA: f32; // @param 0 1 x\nfn mainImage(uv: vec2f) -> vec4f { return vec4f(1.0); }";
    const r = lintDesign({ recipe: {}, cardholderName: "x", shaders: [{ id: "custom", language: "wgsl", side: "front", target: "skin", code }] });
    expect(r.errors).toEqual([{ path: "shaders[0].code:1", message: 'default "x" is not a number' }]);
  });

  it("rejects custom layers in GLSL (the card engine runs WGSL)", () => {
    const code = "fn mainImage(uv: vec2f) -> vec4f { return vec4f(1.0); }";
    const r = lintDesign({ recipe: {}, cardholderName: "x", shaders: [{ id: "custom", side: "front", target: "skin", code }] });
    expect(r.errors.map((e) => e.path)).toEqual(["shaders[0].language"]);
  });

  it("reports keys the design model no longer has as unknown fields", () => {
    const r = lintDesign({ ...DESIGN_EXAMPLES[0].design, frontEffect: null, bespoke: null });
    expect(r.errors.map((e) => e.path).sort()).toEqual(["bespoke", "frontEffect"]);
    expect(r.design).not.toBeNull();
  });

  it("reads JSON text and rejects non-designs", () => {
    expect(lintDesign("{ nope").errors[0].message).toMatch(/not valid JSON/);
    expect(lintDesign([]).errors[0].message).toMatch(/JSON object/);
    expect(lintDesign({ hello: 1 }).design).toBeNull();
    const ok = lintDesign(JSON.stringify(DESIGN_EXAMPLES[0].design));
    expect(ok.errors).toEqual([]);
    expect((ok.design as CardDesign).recipe.holoStyle).toBe("shiny");
  });
});

describe("finish prompt", () => {
  it("builds a stable system prompt and a user message with context and retry feedback", async () => {
    const { finishSystemPrompt, finishUserMessage } = await import("./prompt.ts");
    expect(finishSystemPrompt()).toBe(finishSystemPrompt());
    expect(finishSystemPrompt()).toContain(text.trim());
    const msg = finishUserMessage({
      description: "  smoked bronze  ",
      current: { cardholderName: "Grace Hopper", cardholderBio: "" },
      retry: { designJson: "{}", errors: ['recipe.material: "gold" is not one of …'] },
    });
    expect(msg).toMatch(/^Design this finish:\n\nsmoked bronze\n/);
    expect(msg).toContain('cardholderName "Grace Hopper"');
    expect(msg).toContain('- recipe.material: "gold"');
    expect(finishUserMessage({ description: "x".repeat(5000) }).length).toBeLessThan(2100);
  });

  it("parses the structured answer and explains what is wrong", async () => {
    const { parseFinishOutput, FinishOutputError } = await import("./prompt.ts");
    const a = parseFinishOutput(JSON.stringify({ summary: "s", design_json: '{"recipe":{}}' }));
    expect(a).toEqual({ summary: "s", design: { recipe: {} }, designJson: '{"recipe":{}}' });
    expect(() => parseFinishOutput("nope")).toThrow(FinishOutputError);
    expect(() => parseFinishOutput('{"summary":"s"}')).toThrow(/no design_json/);
    expect(() => parseFinishOutput('{"summary":"s","design_json":"{"}')).toThrow(/not valid JSON/);
  });
});
