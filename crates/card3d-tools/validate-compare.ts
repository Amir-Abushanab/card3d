// Pins the Rust design validator (crates/card3d-engine/src/validate/) to the TypeScript: runs
// `lintDesign` (which runs `ensureDesign`) and the Rust `validate` tool over every fixture, every public
// preset, hand-written edge cases and thousands of randomly mutated designs, and requires the same design
// JSON and the same errors and warnings, in order.
//
//   node crates/card3d-tools/validate-compare.ts [--count N] [--seed S] [--bin path/to/validate]
//   node crates/card3d-tools/validate-compare.ts --write-cases   # rewrite the committed sample
//                                                                  # (crates/card3d-engine/tests/data/validate-cases.json)
//
// Differences that are expected and normalised away: sticker ids made up at random for stickers without
// one (`sticker-<i>-<random>`), the wording of a JSON syntax error, and lone UTF-16 surrogates (Rust
// strings can't hold them; the Rust side has U+FFFD, as `toWellFormed()`).
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { lintDesign } from "../../packages/core/src/describe/lint.ts";
import { CARD_PRESETS, presetExtras, presetRecipe } from "../../packages/core/src/presets.ts";
import { catalog, catalogText, CATALOG_PATH } from "./validate-catalog.ts";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "../..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const COUNT = Number(arg("--count") ?? 4000);
const SEED = Number(arg("--seed") ?? 1);
const CASES_PATH = resolve(ROOT, "crates/card3d-engine/tests/data/validate-cases.json");

// ── the catalog must be current ──
if (readFileSync(CATALOG_PATH, "utf8") !== catalogText()) {
  console.error("catalog.json is stale: run node crates/card3d-tools/validate-catalog.ts");
  process.exit(1);
}
const CAT = catalog() as {
  materials: string[];
  textures: string[];
  holoStyles: string[];
  foilTextures: string[];
  fonts: string[];
  lighting: string[];
  shaders: { id: string; params: { key: string; type: string; options?: number[] }[] }[];
  effects: { id: string; params: { key: string; type: string; options?: string[] }[] }[];
  fields: Record<string, string[]>;
  recipeControls: { key: string }[];
};

// ── a seeded PRNG ──
let state = SEED >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (n: number) => Math.floor(rand() * n);
const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
const chance = (p: number) => rand() < p;

// ── value pools ──
// 3.14159 is a test value for the validators' number handling, not π.
/* oxlint-disable oxc/approx-constant */
const NUMBERS = [
  0,
  1,
  -1,
  0.5,
  1.5,
  2.5,
  -2.5,
  -0.5,
  100,
  400,
  25,
  1e21,
  1.5e21,
  1e-7,
  1.234e-7,
  123456789.123,
  0.1 + 0.2,
  3.14159,
  Number.MAX_VALUE,
  5e-324,
  1e300,
  0.0001,
  0.00049,
  0.00051,
  0.29,
  359.95,
  360,
  720.04,
  -720.04,
  -30,
  2.88,
  3.18,
  3.48,
  3.1805,
  0.02,
  0.12,
  0.4,
  0.019,
  1.2,
  1.21,
  0.25,
  3,
  3.004,
  0.9999,
  0.99995,
  1.00004,
  700,
  900,
  450,
  100.5,
  1000,
  20000,
  3600,
  3601,
  48,
  64,
  0.005,
  0.015,
  0.125,
  -0.0004,
  1e-10,
  0.6,
  0.61,
  -0.05,
  -0.06,
  2,
  2.004,
  0.3333333333333333,
  2 / 3,
  1 / 7,
  255,
  256,
  12,
  6,
  7,
  1.00001,
  0.71,
  4.5,
  10,
  11,
  2.5000000001,
];
/* oxlint-enable oxc/approx-constant */
const ID_STRINGS = [
  ...CAT.materials,
  ...CAT.textures,
  ...CAT.holoStyles,
  ...CAT.foilTextures,
  ...CAT.fonts,
  ...CAT.lighting,
  ...CAT.shaders.map((s) => s.id),
  ...CAT.effects.map((e) => e.id),
  "custom",
  "skin",
  "overlay",
  "front",
  "back",
  "both",
  "normal",
  "add",
  "multiply",
  "screen",
  "embossed",
  "engraved",
  "etched",
  "default",
  "metal",
  "anodized",
  "match",
  "lanyard",
  "notch",
  "window",
  "portrait",
  "landscape",
  "inlay",
  "printed",
  "none",
  "orbit",
  "cover",
  "tile",
  "sweep",
  "gradient",
  "environment",
  "evenodd",
  "nonzero",
  "corner",
  "top-right",
  "center",
  "bottom-right",
  "bottom-left",
  "top",
  "left",
  "right",
  "wgsl",
  "glsl",
  "auto",
  "procedural",
  "studio",
  "Studio",
  "night-city",
  "a".repeat(41),
  "a".repeat(42),
  "-abc",
  "Silver",
  "GLASS",
  "liquid-metal",
  "true",
];
const STRINGS = [
  "",
  " ",
  "  x  ",
  "#ABCDEF",
  "#abcdef",
  "#abc",
  "abc",
  "abc123",
  " #a1b2c3 ",
  "#gg0000",
  "#12345",
  "#1234567",
  "a1b2c3",
  "#FFF",
  "https://fonts.example.com/a/B%20c-d_e.woff2",
  "http://localhost:8080/x.ttf",
  "http://127.0.0.1/f.otf",
  "http://127.1/f.otf",
  "http://[::1]/f.woff",
  "http://example.com/f.woff",
  "https://user:pw@x.com/f.woff",
  "https://user@x.com/f.woff",
  "javascript:alert(1)",
  "//cdn.x/f.woff",
  "fonts/brand.woff2",
  "/fonts/Brand_Sans-Bold.woff2?v=1",
  "HTTPS://EXAMPLE.COM/a/../b/./c.woff2",
  "https://例え.jp/フォント.woff2",
  "https://xn--r8jz45g.jp/a.woff",
  "https:example.com/x.woff",
  "https://exa mple.com",
  "https://x.com:443/a%zz.woff",
  "https://x.com/%E2%82%AC_x.ttf",
  "https://x.com/%C0%AF.otf",
  "https://x.com/a%.woff",
  "https://x.com/(a).woff",
  "ftp://x.com/a.woff",
  "https://x.com:99999/a.woff",
  "https://[::ffff:1.2.3.4]/f.woff",
  "https://0x7f.1/f.woff",
  "data:font/woff2;base64,d09GMgABAAAA",
  "data:font/woff2;base64,d09GMgABAAAA===",
  "data:application/octet-stream;base64,AAEAAA==",
  "data:font/ttf;base64,",
  "data:image/png;base64,iVBORw0KGgo=",
  "DATA:IMAGE/GIF;BASE64,R0lGOD",
  "data:image/svg+xml;base64,PHN2Zz4=",
  "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
  "/env/a.HDR",
  "./x.webp?y=1",
  "../a.hdr#t",
  "https://x.com/a.webp",
  "https://x.com/a.hdr.png",
  "https://x.com/a.webpx",
  "/a b.hdr",
  '/a.hdr?x="',
  ".../a.hdr",
  "http:/x.hdr",
  "/x.webp#",
  "assets/sticker.png",
  "sticker.gif",
  "https://x.com/s.GIF?x=1",
  "google:Fraunces",
  "google:Playfair+Display@900",
  "GOOGLE:Noto Sans JP@700",
  "google:Bad@abc",
  "google:x@450",
  "google:@700",
  "google:A  b@0700",
  "google:x@1000",
  "google:Inter@100",
  " google:Inter ",
  "google:Ü",
  "google:a@b@700",
  "Ångström",
  "名前",
  "😀".repeat(30),
  "a😀".repeat(20),
  "x".repeat(47) + "😀",
  " ",
  "a\r\nb",
  "a\n\n\rb",
  "﻿x﻿",
  " nbsp ",
  "tab\there",
  "x".repeat(32),
  "x".repeat(33),
  "y".repeat(49),
  "z".repeat(65),
  "Brand Sans — Bold!",
  "  Lots   of   space  ",
  "कार्ड",
  "Ⅻ ½ ²",
  "a.b_c-d",
  "M0 0L10 10Z",
  "M0,0 l1e2,1E-2z",
  "M0 0 X",
  " ",
  "M 0 0   L 1 1",
  "constructor",
  "__proto__",
  "toString",
];
const KEYS = [
  ...CAT.fields.design,
  "ownerName",
  "unknownKey",
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
  "0",
  "12",
  "4294967294",
  "4294967295",
  "01",
  "-1",
  ...CAT.recipeControls.map((c) => c.key),
  ...Object.values(CAT.fields).flat(),
  "id",
  "src",
  "aspect",
  "x",
  "y",
  "width",
  "rotation",
  "scale",
  "crop",
  "flip",
  "tint",
  "adjust",
  "opacity",
  "w",
  "h",
  "v",
  "color",
  "amount",
  "brightness",
  "contrast",
  "saturation",
  "time",
  "nameFontHeight",
  "nameBottom",
  ...CAT.effects.flatMap((e) => e.params.map((p) => p.key)),
  ...CAT.shaders.flatMap((s) => s.params.map((p) => p.key)),
  "source",
  "family",
  "weight",
];

const randomNumber = () => (chance(0.5) ? pick(NUMBERS) : chance(0.5) ? (rand() - 0.3) * pick([1, 2, 10, 100, 1000]) : int(1000) - 100);
const randomString = () => (chance(0.5) ? pick(ID_STRINGS) : pick(STRINGS));
function randomValue(depth = 0): unknown {
  const r = rand();
  if (r < 0.3) return randomNumber();
  if (r < 0.6) return randomString();
  if (r < 0.7) return chance(0.5);
  if (r < 0.76) return null;
  if (depth > 2) return randomNumber();
  if (r < 0.88) {
    if (chance(0.4)) return [randomNumber(), randomNumber(), ...(chance(0.5) ? [randomNumber()] : [])];
    return Array.from({ length: int(4) }, () => randomValue(depth + 1));
  }
  const o: Record<string, unknown> = {};
  for (let i = int(4); i > 0; i--) o[pick(KEYS)] = randomValue(depth + 1);
  return o;
}

// ── custom shader code ──
const TYPES = ["f32", "i32", "bool", "vec2f", "vec3f", "vec2<f32>", "vec3 < f32 >", "mat3x3f", "constructor", "toString", "", " ", "vec4f", "f32 = 1.0"];
const NAMES = ["uSpeed", "uCount", "uGlow", "uCenter", "uTint", "uMode", "uX", "uTime", "uSource", "uArtwork", "card3dGuard", "u_a1", "__proto__", "uSpeed"];
const TOKENS = [
  "0",
  "1",
  "5",
  "-1",
  "2",
  "0.5",
  ".5",
  "5.",
  "1e3",
  "0x1F",
  "0b11",
  "0o7",
  "Infinity",
  "-Infinity",
  "NaN",
  "abc",
  "1_000",
  "+3",
  "",
  "min=0",
  "max=10",
  "MIN=2",
  "max=a",
  "default=1",
  "default=true",
  "default=maybe",
  "default=1",
  "default=0.5,0.5",
  "default=(1, 2)",
  "default=[1 2 3]",
  "default=1,2,3,4",
  "default= ",
  'default=""',
  "default=#ff8800",
  "default=#f80",
  "default=ff8800",
  "default=#ggg",
  'label="Speed it up"',
  "label='x y'",
  'options="Soft:0,Hard:1"',
  "options=A:0,B:1",
  'options="A:0, :1,B=2,C:x,D:1.2.3,E:-3, F : 4 "',
  "options=",
  "step=.1",
  "step=x",
  'help="h"',
  '"quoted tok"',
  '"unclosed',
  "'single'",
  "key = value",
  "a=",
  "=b",
  "__proto__=1",
  "toString=2",
  "#ff0000",
  "#fff",
  "true",
  "FALSE",
  "1",
];
const WGSL_MAIN = [
  "fn mainImage(uv: vec2f) -> vec4f { return vec4f(uTint, 1.0); }",
  "fn mainImage( p : vec2<f32> ) -> vec4< f32 > { return vec4f(1.0); }",
  "fn  mainImage(uv: vec2f)->vec4f{return vec4f(0.0);}",
  "fn mainImage(uv: vec3f) -> vec4f { return vec4f(0.0); }",
  "fnmainImage(uv: vec2f) -> vec4f {}",
  "// fn mainImage(uv: vec2f) -> vec4f {}",
  "@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }",
  "@vertexx fn x() {}",
  "/* @compute */ fn y() {}",
];
function annotationLine(wgsl: boolean): string {
  const name = pick(NAMES);
  const decl = wgsl
    ? `${pick(["", " ", "\t"])}var${pick(["", " "])}<${pick(["", " "])}private${pick(["", " "])}>${pick([" ", ""])}${name}${pick(["", " "])}:${pick([" ", ""])}${pick(TYPES)};`
    : `${pick(["", "  "])}uniform ${pick(["", "highp ", "lowp ", "mediump "])}${pick(["float", "int", "bool", "vec2", "vec3", "vec4", "mat3", "constructor", "highp"])} ${name}${pick(["", "[3]", " [2] ", "["])};`;
  const kind = pick(["@param", "@color", "@params", "@ param", "@colors", "@param:"]);
  const toks = Array.from({ length: int(5) }, () => pick(TOKENS)).join(pick([" ", "  ", "\t"]));
  const comment = chance(0.85) ? ` ${pick(["//", "// ", "//\t", "// x // "])}${kind}${chance(0.8) ? " " : ""}${toks}` : "";
  return `${decl}${comment}${chance(0.05) ? "\r" : ""}`;
}
function randomCode(wgsl: boolean): string {
  const lines: string[] = [];
  for (let i = int(7); i >= 0; i--) {
    const r = rand();
    if (r < 0.65) lines.push(annotationLine(wgsl));
    else if (r < 0.75) lines.push(pick(["/* a", "block */", "/* one */ var<private> uB: f32; // @param 0 1", "// var<private> uC: f32; // @param", "*/"]));
    else if (r < 0.85) lines.push("// @replaces-artwork");
    else lines.push(pick(WGSL_MAIN));
  }
  if (chance(0.7)) lines.push(wgsl ? pick(WGSL_MAIN.slice(0, 3)) : "vec4 mainImage(vec2 uv) { return vec4(1.0); }");
  return lines.join(chance(0.1) ? "\r\n" : "\n");
}
function randomLayer(): Record<string, unknown> {
  const custom = chance(0.45);
  const def = pick(CAT.shaders);
  const l: Record<string, unknown> = { id: custom ? "custom" : chance(0.95) ? def.id : pick(["nope", "Custom", ""]) };
  const wgsl = chance(0.7);
  if (custom) {
    l.code = chance(0.03) ? "x".repeat(20001) : chance(0.03) ? "  \n " : randomCode(wgsl);
    if (wgsl || chance(0.2)) l.language = wgsl ? "wgsl" : pick(["glsl", "WGSL"]);
  }
  for (const k of ["side", "target", "blend", "opacity", "animated", "time", "enabled"])
    if (chance(0.3)) l[k] = chance(0.6) ? pick(["front", "back", "both", "skin", "overlay", "normal", "add", "screen", "multiply", "xor"]) : randomValue(2);
  if (chance(0.8)) {
    const params: Record<string, unknown> = {};
    const keys = custom ? NAMES : def.params.map((p) => p.key);
    for (let i = int(6); i > 0; i--) {
      const key = chance(0.85) ? pick(keys) : pick(["9bad", "ok_key", "x".repeat(65), "__proto__", "constructor", "a-b"]);
      params[key] = chance(0.5)
        ? randomValue(2)
        : pick([true, false, 0, 1, 2, 2.5, "#ff8800", "#f80", "ff8800", "  #ABC ", [1, 0.5, 0], [1, 2], [1, 2, 3, 4], "x".repeat(33), 6, 7, -1]);
    }
    l.params = params;
  }
  return l;
}

// ── the corpus ──
type Case = { name: string; text: string };
const cases: Case[] = [];
const fixtureDir = resolve(HERE, "designs");
const bases: unknown[] = [];
for (const f of readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const text = readFileSync(resolve(fixtureDir, f), "utf8");
  cases.push({ name: `fixture ${f}`, text });
  bases.push(JSON.parse(text));
}
for (const p of CARD_PRESETS) {
  const input = { ...presetExtras(p), recipe: presetRecipe(p), cardholderName: "Ada Lovelace" };
  cases.push({ name: `preset ${p.id}`, text: JSON.stringify(input) });
  bases.push(input);
}
const HAND: string[] = [
  "",
  "null",
  "[]",
  "42",
  '"text"',
  "{",
  "{}",
  '{"a":1}',
  '{"material":"glass"}',
  '{"recipe":{}}',
  '{"recipe":[]}',
  '{"decals":5}',
  '{"recipe":{},"b":1,"2":0,"1":0,"bespokeParams":{"z":1,"10":2,"2":3,"a":[1e400,-1e400],"-0":-0}}',
  '{"recipe":{"material":"glass","material":"oxide"},"cardholderName":"A","cardholderName":"B"}',
  '{"recipe":{},"cardholderName":"\\ud83d","cardholderBio":"\\ud83d\\ude00 \\udc00 \\ud800\\u0041"}',
  '{"recipe":{"grain":1e400,"polish":-0,"relief":-1e-400}}',
  '{"recipe":{},"constructor":1,"toString":2,"__proto__":{"x":1},"hasOwnProperty":3}',
  '{"material":"glass","constructor":1,"__proto__":3,"valueOf":true,"color":"#000"}',
  '{"recipe":{"constructor":1,"toString":"x","__proto__":null}}',
  '{"recipe":{},"scene":{"floor":true,"constructor":1},"edge":{"toString":1},"addons":{"shine":{"constructor":1},"vines":true}}',
  '{"recipe":{},"effectParams":{"constructor":1,"toString":2,"loops":3,"coverage":0.1}}',
  '{"recipe":{},"shaders":[{"id":"constructor"},{"id":"toString"},{"id":"__proto__"},{"id":"halftone","params":{"__proto__":[1,2],"constructor":1,"source":2}}]}',
  '{"recipe":{},"textLines":[{"text":"' + "x".repeat(47) + '\\ud83d\\ude00tail"},{"text":"a\\r\\n\\nb"},{"text":1},{"text":"c"},{"text":"d"}]}',
  '{"recipe":{},"font":"google:Inter","decals":[{"src":"a.png"},{"src":""},{"src":"b.gif","id":""},{"src":"c.png","id":"keep"}]}',
  '{"recipe":{},"shaders":[{"id":"custom","language":"wgsl","code":"var<private> uA: f32; // @param 0 1\\r\\nfn mainImage(uv: vec2f) -> vec4f {}"}]}',
  '{"recipe":{},"shaders":[{"id":"custom","language":"wgsl","code":"var<private> uA: f32; // @param 0 1\\u2028x\\nvar<private> uB: f32; // @param 0 1\\u2028 // @param 2 3\\nfn mainImage(uv: vec2f) -> vec4f {}"}]}',
  '{"recipe":{},"logo":{"path":"M0 0L1 1","viewBox":[10,10],"origin":[-0,0],"scale":1.004,"position":"corner"}}',
  '  {"recipe":{}}  ',
  '{"recipe":{}} x',
  '{"recipe":{"grain":1.}}',
  '{"recipe":{"grain":01}}',
];
for (const [i, text] of HAND.entries()) cases.push({ name: `hand ${i}`, text });

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
function nodes(v: unknown, out: (Record<string, unknown> | unknown[])[] = []): (Record<string, unknown> | unknown[])[] {
  if (v && typeof v === "object") {
    out.push(v as Record<string, unknown>);
    for (const x of Object.values(v)) nodes(x, out);
  }
  return out;
}
function mutate(d: Record<string, unknown>): void {
  const all = nodes(d);
  const node = chance(0.35) ? d : pick(all);
  if (Array.isArray(node)) {
    const r = rand();
    if (r < 0.3 && node.length) node.splice(int(node.length), 1);
    else if (r < 0.5 && node.length) node.push(clone(pick(node)));
    else if (r < 0.8 && node.length) node[int(node.length)] = randomValue(1);
    else node.push(randomValue(1));
    return;
  }
  const keys = Object.keys(node);
  const r = rand();
  if (r < 0.2 && keys.length) delete node[pick(keys)];
  else if (r < 0.55 && keys.length) {
    const k = pick(keys);
    const v = node[k];
    if (typeof v === "number" && chance(0.6)) node[k] = pick([v * 10, -v, v + 0.5, Math.round(v), v / 3, v + 1e-10, 0]);
    else if (typeof v === "string" && chance(0.6)) node[k] = pick([v.toUpperCase(), ` ${v} `, v.slice(0, Math.max(0, v.length - 1)), v + v, `#${v}`]);
    else node[k] = randomValue(1);
  } else if (r < 0.65) node.shaders = Array.from({ length: int(10) }, randomLayer);
  else if (r < 0.7 && Array.isArray(node.shaders)) node.shaders.push(randomLayer());
  else node[pick(KEYS)] = randomValue(1);
}
for (let i = 0; i < COUNT; i++) {
  const base = chance(0.08) ? {} : clone(pick(bases));
  const d = (base && typeof base === "object" && !Array.isArray(base) ? base : {}) as Record<string, unknown>;
  for (let k = 1 + int(4); k > 0; k--) mutate(d);
  cases.push({ name: `mutation ${i}`, text: JSON.stringify(d) });
}

// ── TypeScript ──
type Report = { design: string | null; errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] };
const tsReport = (text: string): Report => {
  const l = lintDesign(text);
  return {
    design: l.design ? JSON.stringify(l.design) : null,
    errors: l.errors.map((e) => ({ path: e.path, message: e.message })),
    warnings: l.warnings.map((e) => ({ path: e.path, message: e.message })),
  };
};
/** Equal-able form: well-formed strings, made-up sticker ids masked, JSON syntax errors' wording dropped. */
function normal(r: Report): string {
  const wf = (s: string) => s.toWellFormed();
  // JSON.stringify writes a lone surrogate as an escape (messages quote values as JSON); Rust has U+FFFD.
  const lone = (s: string) => s.replace(/\\ud[89a-f][0-9a-f]{2}/gi, "\uFFFD");
  const deep = (v: unknown): unknown =>
    typeof v === "string"
      ? wf(v)
      : Array.isArray(v)
        ? v.map(deep)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [wf(k), deep(x)]))
          : v;
  let design = r.design;
  if (design) {
    const d = deep(JSON.parse(design)) as { decals?: { id?: unknown }[] };
    for (const x of d.decals ?? []) if (typeof x.id === "string" && /^sticker-\d+-[a-z0-9]*$/.test(x.id)) x.id = x.id.replace(/-[a-z0-9]*$/, "-*");
    design = JSON.stringify(d);
  }
  const issues = (xs: Report["errors"]) =>
    xs.map((e) => ({ path: wf(e.path), message: e.message.startsWith("not valid JSON:") ? "not valid JSON" : lone(wf(e.message)) }));
  return JSON.stringify({ design, errors: issues(r.errors), warnings: issues(r.warnings) });
}

// ── Rust ──
let bin = arg("--bin");
if (!bin) {
  execFileSync("cargo", ["build", "-q", "-p", "card3d-tools", "--bin", "validate"], { cwd: ROOT, stdio: "inherit" });
  bin = resolve(ROOT, "target/debug/validate");
}
const input = cases.map((c) => JSON.stringify(c.text)).join("\n") + "\n";
const run = spawnSync(bin, [], { input, maxBuffer: 1 << 30, encoding: "utf8" });
if (run.status !== 0) {
  console.error(run.stderr);
  process.exit(1);
}
const rust: Report[] = run.stdout
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l));

let failed = 0;
const kinds = new Map<string, number>();
/** FNV-1a (64-bit) of the UTF-8 bytes, hex: the committed sample stores designs by hash. */
const fnv = (s: string) => {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(s)) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, "0");
};
type Sample = { input?: string; fixture?: string; design: string | null; errors: Report["errors"]; warnings: Report["warnings"] };
const sample: Sample[] = [];
let mutationsKept = 0;
for (const [i, c] of cases.entries()) {
  const ts = tsReport(c.text);
  const a = normal(ts);
  const b = normal(rust[i]);
  const kind = c.name.split(" ")[0];
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  if (a !== b) {
    if (failed < 8) {
      console.error(`✗ ${c.name}\n  input: ${c.text.slice(0, 400)}\n  ts:    ${a.slice(0, 1500)}\n  rust:  ${b.slice(0, 1500)}`);
    }
    failed++;
  }
  // The committed sample (kept small): every fixture by file name, the hand cases and 100 short mutated
  // designs, each with its design's hash and its issues. Designs with made-up sticker ids are left out.
  if (!/"sticker-\d+-/.test(ts.design ?? "")) {
    const n = JSON.parse(normal(ts));
    const entry = { design: n.design === null ? null : fnv(n.design), errors: n.errors, warnings: n.warnings };
    if (kind === "fixture") sample.push({ fixture: c.name.slice("fixture ".length), ...entry });
    else if (kind === "hand" || (kind === "mutation" && c.text.length < 400 && mutationsKept < 100 && ++mutationsKept))
      sample.push({ input: c.text, ...entry });
  }
}
const summary = [...kinds].map(([k, n]) => `${n} ${k}s`).join(", ");
if (failed) {
  console.error(`${failed} of ${cases.length} differ (${summary})`);
  process.exit(1);
}
console.log(`identical on all ${cases.length} designs (${summary})`);
if (process.argv.includes("--write-cases")) {
  mkdirSync(resolve(CASES_PATH, ".."), { recursive: true });
  writeFileSync(CASES_PATH, `[\n${sample.map((x) => JSON.stringify(x)).join(",\n")}\n]\n`);
  console.log(`wrote ${sample.length} cases to ${CASES_PATH}`);
}
