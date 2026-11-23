// Writes the comparison's design set into the directory given as the first argument, every design as
// `ensureDesign` returns it (what the engines receive in production): one per public preset (as
// <metal-card preset="…"> builds it), and each hand fixture named after it (designs/*.json).
// Run with Node (type stripping): node designs/generate.ts <dir>
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { CARD_PRESETS, presetExtras, presetRecipe } from "../../../packages/core/src/presets.ts";
import { ensureDesign } from "../../../packages/core/src/design/design.ts";
import { cameraPathPose, type CameraPathId } from "../../../packages/core/src/scene/camera-paths.ts";

/**
 * Face shader layers and add-ons run their clocks from page load, so a comparison freezes each one at
 * a fixed moment (its `time`): both engines then draw the same frame (and no tilt-spring or vine
 * motion). The three.js archive's shine reads its clock from `bespokeParams.time` instead (the
 * engine ignores that key), so the shine's time is written there too.
 */
const FROZEN_TIME = 2.5;
const frozen = <T extends { shaders?: unknown; addons?: object }>(design: T): T => {
  const shaders = Array.isArray(design.shaders) ? design.shaders.map((s) => (typeof s?.time === "number" ? s : { ...s, time: FROZEN_TIME })) : design.shaders;
  if (!design.addons || !Object.keys(design.addons).length) return { ...design, shaders };
  const addons: Record<string, { time?: unknown }> = {};
  for (const [id, v] of Object.entries(design.addons)) {
    const o = typeof v === "object" && v ? (v as { time?: unknown }) : {};
    addons[id] = typeof o.time === "number" ? o : { ...o, time: FROZEN_TIME };
  }
  const time = addons.shine?.time ?? addons.vines?.time;
  return { ...design, shaders, addons, bespokeParams: { time } };
};

const dir = resolve(process.argv[2] ?? "out/designs");
mkdirSync(dir, { recursive: true });
for (const p of CARD_PRESETS) {
  const design = ensureDesign({ ...presetExtras(p), recipe: presetRecipe(p), cardholderName: "Ada Lovelace" });
  writeFileSync(resolve(dir, `preset-${p.id}.json`), JSON.stringify(frozen(design)));
}
const fixtures = readdirSync(import.meta.dirname).filter((f) => f.endsWith(".json"));
/**
 * A fixture's harness settings (not part of the design), applied in every engine (`__harness`):
 * - `cameraPath: { id, t }`: the camera path's pose at normalised time t, frozen (the camera orbit and
 *   the card's lift; each pose's rotation stays the harness's);
 * - `assets: { nameFontFamily? }`: the asset provider's name font.
 */
const harness = (raw: { cameraPath?: { id: CameraPathId; t: number }; assets?: object }) => {
  const h: Record<string, unknown> = {};
  if (raw.cameraPath) {
    const pose = cameraPathPose(raw.cameraPath.id, raw.cameraPath.t);
    Object.assign(h, { orbit: pose.camera, lift: pose.card.lift });
  }
  if (raw.assets) h.assets = raw.assets;
  return Object.keys(h).length ? { __harness: h } : {};
};
for (const f of fixtures) {
  const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, f), "utf8"));
  const design = ensureDesign(raw);
  writeFileSync(resolve(dir, basename(f)), JSON.stringify({ ...frozen(design), ...harness(raw) }));
}
console.log(`${CARD_PRESETS.length} preset designs and ${fixtures.length} fixtures → ${dir}`);
