/**
 * Tasteful randomize: a finish drawn from the same neighbourhood as the presets
 * (mostly silver, a few dark metals, the colour palette below, foil on about one card in four).
 * Identity, artwork and stickers are kept. Effects, add-ons and shader layers are kept too unless the
 * caller opts in (`withEffects`), which rolls a fresh set of them.
 */
import { HOLO_STYLES, FOIL_TEXTURES, type CardDesign, type MaterialPreset, type Recipe, type SurfaceTexture } from "@card3d/core/model";
import { BUILTIN_SHADERS } from "@card3d/core/editor";
import { cloneDesign } from "./design.ts";
import { newBuiltinLayer } from "./fx.ts";

/** The colour grid: a palette of finish colours, light to dark-ish. */
export const COLOR_GRID = [
  "#d9d6cc",
  "#ffffff",
  "#c9c5bc",
  "#dfc9aa",
  "#cda874",
  "#e39a4a",
  "#e66b4c",
  "#e65f2e",
  "#c80e0e",
  "#ec008c",
  "#ff9eed",
  "#fad1ff",
  "#ab3f84",
  "#654fb5",
  "#476585",
  "#7293a1",
  "#8da6bb",
  "#a8cfe0",
  "#b8f1ff",
  "#85f1ff",
  "#c1d2d2",
  "#7abfff",
  "#5cc9ff",
  "#00aaff",
  "#2495ff",
  "#75caff",
  "#e4f222",
  "#898b83",
  "#7c797b",
  "#3d3e3c",
  "#150b0f",
  "#000000",
] as const;

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
const weighted = <T>(xs: readonly (readonly [T, number])[]): T => {
  let r = Math.random() * xs.reduce((s, [, w]) => s + w, 0);
  for (const [x, w] of xs) if ((r -= w) <= 0) return x;
  return xs[xs.length - 1][0];
};
const int = (a: number, b: number) => Math.round(a + Math.random() * (b - a));
/** Mostly at an end of the range, sometimes in between: how finishes tend to use sliders. */
const lever = (lo: number, hi: number) => (Math.random() < 0.35 ? lo : Math.random() < 0.3 ? hi : int(lo, hi));

const MATERIALS: readonly (readonly [MaterialPreset, number])[] = [
  ["silver", 10],
  ["brass", 2],
  ["oxide", 1.5],
  ["nickel", 1.5],
  ["titanium", 1.5],
  ["carbon", 1],
  ["glass", 0.4],
];
const TEXTURES: readonly (readonly [SurfaceTexture, number])[] = [
  ["none", 8],
  ["brushed", 2],
  ["guilloche", 1.5],
  ["crosshatch", 1.5],
  ["pinpoint", 1],
  ["sandblasted", 1],
  ["hammered", 0.7],
  ["linen", 0.5],
  ["carbon-fiber", 0.5],
];

function randomizeRecipe(prev: Recipe): Recipe {
  const texture = weighted(TEXTURES);
  const holo = Math.random() < 0.25;
  const r: Recipe = {
    ...prev,
    material: weighted(MATERIALS),
    texture,
    pattern: texture === "guilloche" && Math.random() < 0.7 ? "orbit" : "none",
    color: pick(COLOR_GRID),
    grain: lever(0, 100),
    polish: int(10, 90),
    relief: lever(0, 100),
    spectrum: lever(0, 100),
    frontHolo: holo,
    matchHoloSides: true,
    holoStyle: pick(HOLO_STYLES),
    foilTexture: pick(FOIL_TEXTURES),
    foilIntensity: int(45, 100),
    holoGlare: int(0, 70),
    holoMotion: true,
    foilScale: pick([25, 50, 75, 100, 100, 117]),
    foilCoverage: Math.random() < 0.8 ? "cover" : "tile",
  };
  return {
    ...r,
    backHolo: holo,
    backHoloStyle: r.holoStyle,
    backFoilTexture: r.foilTexture,
    backFoilIntensity: r.foilIntensity,
    backHoloGlare: r.holoGlare,
    backHoloMotion: true,
    backFoilScale: r.foilScale,
    backFoilCoverage: r.foilCoverage,
  };
}

/**
 * A new finish (recipe; the material override is part of the finish, so it is cleared). Add-ons and
 * shader layers are kept, unless `withEffects`, which replaces them with a random set (usually one
 * item: an add-on or a built-in shader; sometimes none).
 */
export function randomizeDesign(d: CardDesign, opts: { withEffects?: boolean } = {}): CardDesign {
  const next = cloneDesign(d);
  next.recipe = randomizeRecipe(d.recipe);
  delete next.materialOverride;
  if (opts.withEffects) randomizeEffects(next);
  return next;
}

function randomizeEffects(d: CardDesign): void {
  delete d.addons;
  delete d.shaders;
  const glass = d.recipe.material === "glass";
  const roll = weighted<"none" | "shader" | "addon">([
    ["none", 1],
    ["shader", 5],
    ["addon", 2],
  ]);
  if (roll === "addon") {
    d.addons = Math.random() < 0.5 ? { shine: { tone: pick(["gold", "ice"] as const) } } : { vines: {} };
  } else if (roll === "shader") {
    // Skins don't render on glass: only overlay-capable shaders there.
    const defs = BUILTIN_SHADERS.filter((s) => !glass || s.targets.includes("overlay"));
    const def = pick(defs);
    const layer = newBuiltinLayer(def, Math.random() < 0.6 ? "both" : "front", d);
    if (glass) layer.target = "overlay";
    d.shaders = [layer];
  }
}
