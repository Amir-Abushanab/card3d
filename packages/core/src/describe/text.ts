/**
 * The model-facing description of the design space: what a `CardDesign` can hold, generated from the
 * real catalogs (recipe controls, materials, textures, foils, presets, face shaders and the custom
 * shader contract, add-ons, body options, lighting, scene, fonts) so it can't drift from
 * the engine. Card Studio's "Describe a finish…" sends it as the system prompt, and the
 * `describe-finish` Claude Code skill reads it (`pnpm finish describe`).
 */
import { CARD_FONTS } from "../fonts.ts";
import { CARD_PRESETS, CARD_PRESET_CATEGORIES, presetExtras } from "../presets.ts";
import { DEFAULT_RECIPE, RECIPE_MATERIALS, RECIPE_CONTROLS, TEXTURE_OPTIONS } from "../recipe/defaults.ts";
import { FOIL_TEXTURES, HOLO_STYLES, type Recipe } from "../types.ts";
import { BUILTIN_SHADERS } from "../shaders/registry.ts";
import { WGSL_SHADER_EXAMPLES } from "../shaders/wgsl-examples.ts";
import { WGSL_PRELUDE_NAMES } from "../shaders/prelude-wgsl.ts";
import type { ShaderParamSpec } from "../shaders/types.ts";
import { EFFECT_CATALOG, type EffectParamSpec } from "../effects/params.ts";
import { LIGHTING_PRESETS } from "../scene/lighting-presets.ts";
import { SCENE_ENVIRONMENTS } from "../scene/environments.ts";
import { SCENE_BACKDROPS } from "../scene/staging-view.ts";
import { CARD_CUTOUTS, DEFAULT_CORNER_RADIUS } from "../geometry/shape-frame.ts";
import { EDGE_DEFAULT_COLOR, EDGE_FINISHES } from "../card/edge-finish.ts";
import { MARK_FINISHES } from "../card/mark-finishes.ts";
import { LOGO_LIMITS, LOGO_POSITIONS } from "../card/logo-limits.ts";
import { MAX_CUSTOM_CODE, MAX_SHADER_LAYERS, TEXT_LINE_RANGES } from "../design/sanitize.ts";
import { DEFAULT_NAME } from "../design/design.ts";
import {
  ADDON_FIELDS,
  BRANDING_OVERRIDE_FIELDS,
  CONTACTLESS_FIELDS,
  DECAL_ADJUST_FIELDS,
  DECAL_CROP_FIELDS,
  DECAL_FIELDS,
  DECAL_TINT_FIELDS,
  DESIGN_FIELDS,
  EDGE_FIELDS,
  FINISH_FIELDS,
  FLOOR_FIELDS,
  FOIL_TEXTURE_DOCS,
  HOLO_STYLE_DOCS,
  LAYER_FIELDS,
  LOGO_FIELDS,
  MARK_FINISH_DOCS,
  MATERIAL_OVERRIDE_FIELDS,
  RECIPE_DOCS,
  SCENE_FIELDS,
  SHAPE_FIELDS,
  TEXT_LINE_FIELDS,
  TEXTURE_DOCS,
  type FieldDoc,
} from "./fields.ts";
import { DESIGN_EXAMPLES } from "./examples.ts";

export interface DesignSpaceSection {
  id: string;
  title: string;
  body: string;
}

const code = (s: string) => `\`${s}\``;
const json = (v: unknown) => JSON.stringify(v);

/** A field table as a markdown list: `- \`key\` (type): doc`. */
function fieldList(fields: Record<string, FieldDoc>, prefix = ""): string {
  return Object.entries(fields)
    .map(([k, f]) => `- ${code(prefix + k)} (${f.type})${f.avoid ? " — leave out" : ""}: ${f.doc}`)
    .join("\n");
}

function range(p: { min?: number; max?: number }): string {
  return p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ""}–${p.max ?? ""}` : "";
}

function shaderParam(p: ShaderParamSpec): string {
  const opts = p.options?.length ? ` options ${p.options.map((o) => `${o.value}=${o.label}`).join(", ")}` : "";
  return `${code(p.key)} ${p.type}${range(p)}${opts}, default ${json(p.default)}${p.description ? ` — ${p.description}` : ""}`;
}

function effectParam(p: EffectParamSpec): string {
  const opts = p.options?.length ? ` one of ${p.options.map((o) => json(o.value)).join(" | ")}` : "";
  return `${code(p.key)} ${p.type}${range(p)}${opts}, default ${json(p.default)}${p.description ? ` — ${p.description}` : ""}`;
}

/** The prelude's uniform and global declarations (crates/card3d-engine/shaders/face/prelude.wgsl). */
function preludeDeclarations(): string {
  return [
    ...WGSL_PRELUDE_NAMES.filter((n) => n.kind !== "helper").map((n) => `var<private> ${n.name}: ${n.type}; // ${n.doc}`),
    "var uArtwork: texture_2d<f32>; // this face's artwork (transparent when absent): use artwork(uv)",
  ].join("\n");
}

/** Signatures of the prelude's helper functions. */
function preludeHelpers(): string[] {
  return WGSL_PRELUDE_NAMES.filter((n) => n.kind === "helper").map((n) => n.type.replace(/^fn /, ""));
}

function recipeSection(): string {
  const rows = (Object.keys(RECIPE_DOCS) as (keyof Recipe)[]).map((k) => {
    const d = RECIPE_DOCS[k];
    const label = RECIPE_CONTROLS[k].label;
    return `- ${code(k)} (${d.type}; default ${json(DEFAULT_RECIPE[k])}; "${label}"): ${d.doc}`;
  });
  return [
    "Numbers are 0–100 integers unless noted; out-of-range values are clamped by the engine.",
    "",
    ...rows,
    "",
    "### Materials (`recipe.material`)",
    "Ids are internal names; the labels say how each looks. Colour still comes from `color`: gold, bronze, copper or rose tones are `silver` (or `brass` for a glassier face) with the right `color`.",
    ...RECIPE_MATERIALS.map((m) => `- ${code(m.id)}: ${m.name}. ${m.note}.`),
    "",
    "### Textures (`recipe.texture`)",
    ...TEXTURE_OPTIONS.map((o) => `- ${code(o.value)} (${o.label}): ${TEXTURE_DOCS[o.value]}`),
    "",
    "### Holo foil styles (`recipe.holoStyle`)",
    "The foil is an additive iridescent layer over the metal. It shows only with `frontHolo: true` (and on the back with `matchHoloSides: true` or `backHolo: true`).",
    ...HOLO_STYLES.map((s) => `- ${code(s)}: ${HOLO_STYLE_DOCS[s]}`),
    "",
    "### Foil textures (`recipe.foilTexture`)",
    ...FOIL_TEXTURES.map((t) => `- ${code(t)}: ${FOIL_TEXTURE_DOCS[t]}`),
  ].join("\n");
}

function presetsSection(): string {
  const lines: string[] = [
    "Proven starting points. A preset stores only the recipe fields that differ from the defaults; copy its values into `recipe` (and its extras into the design) and adjust.",
  ];
  for (const cat of CARD_PRESET_CATEGORIES) {
    lines.push("", `### ${cat.label}`);
    for (const p of CARD_PRESETS.filter((x) => x.category === cat.id)) {
      const extras = presetExtras(p);
      const ex = Object.keys(extras).length ? ` + ${json(extras)}` : "";
      lines.push(`- ${code(p.id)} ${p.name}: ${json(p.recipe)}${ex}`);
    }
  }
  return lines.join("\n");
}

function shadersSection(): string {
  const lines: string[] = [
    `Up to ${MAX_SHADER_LAYERS} layers in \`shaders\`, applied in order. Each layer:`,
    fieldList(LAYER_FIELDS),
    "",
    'A layer\'s `opacity`, and `strength`-style params, scale its blend linearly: for a "faint" or "subtle" sheen use about 0.1–0.2, "clear" 0.3–0.5, full 1. The base metal should still dominate a faint layer: check the render.',
    'Skins don\'t render on glass cards (use overlays there). Overlays with `blend: "screen"` or `"add"` brighten (sheens, glints, foil); `"multiply"` darkens; `"normal"` covers by alpha.',
    "",
    "### Built-in shaders",
  ];
  for (const s of BUILTIN_SHADERS) {
    const flags = [
      `targets ${s.targets.join("/")}`,
      `default target ${s.defaultTarget}`,
      s.defaultBlend ? `default blend ${s.defaultBlend}` : "",
      s.animated ? "animated" : "",
    ]
      .filter(Boolean)
      .join("; ");
    lines.push(`- ${code(s.id)} ${s.label} (${flags}): ${s.description}`);
    for (const p of s.params) lines.push(`  - ${shaderParam(p)}`);
  }
  return lines.join("\n");
}

function customShaderSection(): string {
  const ex = WGSL_SHADER_EXAMPLES;
  return [
    'A layer `{ id: "custom", language: "wgsl", side, target, code }` runs your own WGSL fragment code on the card engine (WebGPU, or its WebGL 2 build). Always set `language: "wgsl"`: GLSL layers are skipped.',
    "",
    "Rules:",
    "- Define `fn mainImage(uv: vec2f) -> vec4f`: return display-sRGB colour and straight alpha (alpha 0 shows what's below). Don't write entry points (`@fragment`); don't redeclare any prelude name; helper `fn`s and `const`s are fine.",
    "- It is WGSL, not GLSL: `vec2f` / `vec3f` / `vec4f`, `let` / `var`, `fn f(x: f32) -> f32`, no implicit int → float conversion (write `1.0`), `select(a, b, cond)` instead of `?:`, and `mod1` / `mod2` / `mod3` (prelude helpers) for GLSL's floored `mod` (WGSL's `%` truncates).",
    "- `uv` is the face uv as you look at that face, (0,0) bottom-left. Prefer `facePos` (aspect-correct, centred, y in [-0.5, 0.5]) for patterns.",
    "- Expose parameters as annotated module-scope declarations; the key in `params` is the declared name:",
    '  - `var<private> uSpeed: f32; // @param 0 3 0.6 label="Speed"` (min max default; also `step=`, `description="…"`, `options="Soft:0,Hard:1"` for selects) on f32, i32, bool, vec2f, vec3f (`default=x,y` for vectors, `default=true` for bools)',
    '  - `var<private> uTint: vec3f; // @color #f8cdda label="Tint"`',
    "  - Unannotated declarations stay 0. Annotations are checked; mistakes come back as errors with line numbers.",
    "- `// @replaces-artwork` anywhere hides the face's artwork (for shaders that redraw it via `artwork(uv)`).",
    "- Using `uTime` or `uTilt` makes the layer animated; `uPointer` makes it react to the pointer.",
    `- At most ${MAX_CUSTOM_CODE} characters. Loops are capped at 10 000 iterations per pixel, but keep per-pixel work small (no huge loops or heavy ray marching): it runs on phones.`,
    "- Skin layers render into the face texture under the metal lighting, so a skin's colour still looks like metal (polish, clearcoat and holo apply on top). Overlays sit over the face; use them for view-dependent sheens (`viewDir`, `faceNormal`, `uEye`).",
    "- Keep the chip area calm: blend with `smoothstep(0.0, 0.06, chipDistance(uv))`.",
    "",
    "In scope (the prelude's declarations):",
    "```wgsl",
    preludeDeclarations(),
    "```",
    "",
    `Helpers: ${preludeHelpers().map(code).join(", ")}, and \`PI\`, \`TAU\`.`,
    "",
    "Starter examples:",
    ...ex.flatMap((e) => [``, `${e.label} (${e.target}): ${e.description}`, "```wgsl", e.code.trimEnd(), "```"]),
  ].join("\n");
}

function addonsSection(): string {
  const lines: string[] = [];
  for (const e of Object.values(EFFECT_CATALOG)) {
    const where = `\`addons.${e.id}: { … }\` (\`{}\` for defaults)`;
    lines.push(`- ${e.label} — ${where}${e.animated ? ", animated" : ""}: ${e.description}`);
    for (const p of e.params) lines.push(`  - ${effectParam(p)}`);
  }
  lines.push("", "Add-on fields:", fieldList(ADDON_FIELDS, "addons."));
  return lines.join("\n");
}

function bodySection(): string {
  return [
    "### finish",
    fieldList(FINISH_FIELDS, "finish."),
    `Mark finishes: ${MARK_FINISHES.map((f) => `${code(f)} (${MARK_FINISH_DOCS[f]})`).join("; ")}.`,
    "",
    "### edge",
    fieldList(EDGE_FIELDS, "edge."),
    `Finishes: ${EDGE_FINISHES.map(code).join(", ")}. Default colours: ${Object.entries(EDGE_DEFAULT_COLOR)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}.`,
    "",
    "### shape",
    fieldList(SHAPE_FIELDS, "shape."),
    `Cutouts: ${CARD_CUTOUTS.map(code).join(", ")} (lanyard: a slot by a short edge; notch: a corner notch; window: a round see-through window). Standard corner radius ${DEFAULT_CORNER_RADIUS.toFixed(3)} (3.18 mm, ISO/IEC 7810 ID-1).`,
    "",
    "### contactless",
    "`true` or an object:",
    fieldList(CONTACTLESS_FIELDS, "contactless."),
    "",
    "### decals",
    "Stickers are the user's uploads: write `decals: []`. For reading an existing design, each sticker is:",
    fieldList(DECAL_FIELDS),
    fieldList(DECAL_CROP_FIELDS, "crop."),
    fieldList(DECAL_TINT_FIELDS, "tint."),
    fieldList(DECAL_ADJUST_FIELDS, "adjust."),
    "",
    "### textLines",
    `Up to ${TEXT_LINE_RANGES.maxLines} lines of ≤ ${TEXT_LINE_RANGES.maxChars} characters:`,
    fieldList(TEXT_LINE_FIELDS),
    "",
    "### logo",
    fieldList(LOGO_FIELDS, "logo."),
    `Positions: ${LOGO_POSITIONS.map(code).join(", ")}. Path data ≤ ${LOGO_LIMITS.pathChars} characters. Simple geometric marks only; never reproduce a real brand's logo.`,
    "",
    "### materialOverride",
    fieldList(MATERIAL_OVERRIDE_FIELDS, "materialOverride."),
    "",
    "### brandingOverride",
    "Same fields as materialOverride, plus:",
    fieldList({ brandingClearcoat: BRANDING_OVERRIDE_FIELDS.brandingClearcoat }, "brandingOverride."),
  ].join("\n");
}

function stageSection(): string {
  return [
    "### Lighting (`lighting`)",
    ...LIGHTING_PRESETS.map((l) => `- ${code(l.id)}: ${l.label}. ${l.description}.${l.backdrop.dark ? " Dark backdrop." : ""}`),
    'Dark and black metals need light to read: "studio" or "light" show them best face-on; "dark"/"dramatic" suit bright metals.',
    "",
    "### scene",
    fieldList(SCENE_FIELDS, "scene."),
    `Environments: ${["studio", ...SCENE_ENVIRONMENTS.map((e) => e.id)].map(code).join(", ")}.`,
    ...SCENE_ENVIRONMENTS.map((e) => `- ${code(e.id)}: ${e.description}`),
    `Backdrops: ${SCENE_BACKDROPS.map(code).join(", ")}.`,
    "Floor fields:",
    fieldList(FLOOR_FIELDS, "scene.floor."),
    "",
    "### Fonts (`font`, `textLines[].font`)",
    ...CARD_FONTS.map((f) => `- ${code(f.id)}: ${f.label} (${f.kind})`),
  ].join("\n");
}

function examplesSection(): string {
  return DESIGN_EXAMPLES.flatMap((e) => [`"${e.description}":`, "```json", JSON.stringify(e.design, null, 2), "```", ""]).join("\n");
}

/** The description, section by section. */
export function designSpaceSections(): DesignSpaceSection[] {
  return [
    {
      id: "task",
      title: "Card Studio design space",
      body: [
        "A Card Studio card is one JSON object, a `CardDesign`. This document lists every field, its range and its options; it is generated from the engine's own catalogs.",
        "",
        "To turn a description into a design:",
        '1. Start from the closest preset ("Presets") or example ("Examples"); the recipe does most of the work.',
        "2. Hue comes from `recipe.color` (any material); `material` picks the metal's character; `texture` + `grain` + `relief` the surface; `polish` the gloss; `spectrum` a built-in iridescent tint; the holo foil adds a separate rainbow layer.",
        "3. Reach for face shaders only for what the recipe can't do (patterns, prints, animated sheens), and for custom WGSL only when no built-in fits.",
        "4. Write the full design: `recipe`, `cardholderName`, `cardholderBio`, `decals: []`, `surfaceSources: {}`, `surfaceTreatments: {}`, plus only the optional fields you need. Unknown fields and values are rejected or dropped.",
        `5. Keep the user's name if they gave one, else "${DEFAULT_NAME}". Never use real people's or brands' names, logos or trademarks.`,
      ].join("\n"),
    },
    { id: "fields", title: "CardDesign fields", body: fieldList(DESIGN_FIELDS) },
    { id: "recipe", title: "recipe", body: recipeSection() },
    { id: "presets", title: "Presets", body: presetsSection() },
    { id: "shaders", title: "Face shaders", body: shadersSection() },
    { id: "custom", title: "Custom shaders", body: customShaderSection() },
    { id: "addons", title: "Add-ons", body: addonsSection() },
    { id: "body", title: "Card body and branding", body: bodySection() },
    { id: "stage", title: "Lighting, scene and fonts", body: stageSection() },
    { id: "examples", title: "Examples", body: examplesSection() },
  ];
}

/** The whole description as Markdown. */
export function describeDesignSpace(): string {
  return designSpaceSections()
    .map((s, i) => `${i === 0 ? "#" : "##"} ${s.title}\n\n${s.body.trim()}\n`)
    .join("\n");
}
