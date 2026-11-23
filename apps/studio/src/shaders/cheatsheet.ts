/**
 * The custom-shader contract as reference data: the WGSL prelude's uniforms, globals and helpers
 * (`WGSL_PRELUDE_NAMES`, held to crates/card3d-engine/shaders/face/prelude.wgsl by a core test),
 * the annotation syntax, and the WGSL built-ins the editor
 * completes. Rendered as the drawer's collapsible cheat sheet.
 */
import { WGSL_PRELUDE_NAMES, type WgslPreludeName } from "@card3d/core/editor";
import { h } from "../ui/dom.ts";

export type PreludeDoc = WgslPreludeName;

export const PRELUDE_DOCS: readonly PreludeDoc[] = WGSL_PRELUDE_NAMES;

export const WGSL_BUILTINS = (
  "radians degrees sin cos tan asin acos atan atan2 sinh cosh tanh pow exp log exp2 log2 sqrt inverseSqrt " +
  "abs sign floor ceil trunc round fract modf min max clamp mix step smoothstep saturate fma select " +
  "length distance dot cross normalize faceForward reflect refract transpose determinant " +
  "any all arrayLength textureSample textureSampleLevel textureDimensions textureLoad dpdx dpdy fwidth " +
  "pack4x8unorm unpack4x8unorm bitcast"
).split(" ");

const ANNOTATIONS: [string, string][] = [
  ['var<private> uSpeed: f32; // @param 0 3 1 label="Speed"', "Slider: min max default (step= optional)."],
  ["var<private> uCount: i32; // @param 1 12 6", "Integer slider (step 1)."],
  ['var<private> uGlow: bool; // @param default=true label="Glow"', "Checkbox."],
  ['var<private> uMode: f32; // @param options="Soft:0,Hard:1" default=1', "Dropdown of values."],
  ["var<private> uCenter: vec2f; // @param 0 1 default=0.5,0.5", "2D point (per-component range)."],
  ['var<private> uTint: vec3f; // @color #ff8800 label="Tint"', "Colour picker (value arrives as display sRGB)."],
  ["// @replaces-artwork", "Anywhere in the code: hide this face's own artwork (for shaders that redraw it via artwork(uv))."],
];

/** The collapsible cheat sheet element. */
export function cheatSheet(): HTMLDetailsElement {
  const table = (rows: [string, string, string][]) =>
    h(
      "table.c3-cheat-t",
      {},
      ...rows.map(([a, b, c]) => h("tr", {}, h("td", {}, h("code", { text: a })), h("td.c3-cheat-type", { text: b }), h("td", { text: c }))),
    );
  const section = (title: string, ...children: Node[]) => h("section.c3-cheat-s", {}, h("h4", { text: title }), ...children);
  const pick = (kind: PreludeDoc["kind"]) =>
    PRELUDE_DOCS.filter((d) => d.kind === kind && d.doc).map(
      (d) => [d.name, kind === "helper" ? "" : d.type, kind === "helper" ? `${d.type} — ${d.doc}` : d.doc] as [string, string, string],
    );
  return h(
    "details.c3-cheat",
    {},
    h("summary", { text: "Cheat sheet: uniforms, helpers, annotations" }),
    section(
      "Contract",
      h("p", {
        text: "WGSL. Write fn mainImage(uv: vec2f) -> vec4f (uv: (0,0) bottom-left of the face) returning a display-sRGB colour and straight alpha; alpha 0 shows the layer below. Don't write entry points (@fragment) or redeclare the names below; helper fns and consts are fine. GLSL's mod is mod1 / mod2 / mod3 (WGSL's % truncates). Loops are capped at 10 000 iterations per pixel, but heavy per-pixel work can still stall the GPU.",
      }),
    ),
    section("Uniforms", table(pick("uniform"))),
    section("Globals", table(pick("global"))),
    section("Helpers (also PI, TAU)", table(pick("helper"))),
    section("Parameters (annotated var<private> declarations become controls)", table(ANNOTATIONS.map(([a, b]) => [a, "", b]))),
  );
}
