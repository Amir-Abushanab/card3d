/**
 * Reference renders from the three.js engine for the Rust engine's comparison harness
 * (crates/card3d-tools/compare.mjs). The engine is the local archive's (`@three-engine/…`:
 * .archive/three-engine/packages/core/src, see ../three-archive.mjs); the design model is the live one. `?design=<url>` a CardDesign JSON (run through ensureDesign);
 * `?w=&h=` canvas size (CSS px, pixel ratio 1). Layers the Rust engine does not draw yet are hidden
 * (`PORTED`), so a design is compared on what has been ported.
 *
 *   window.__ready        true once built (else an error string)
 *   window.__render(e)    Euler XYZ radians → PNG data URL
 *   window.__dumpEnv()    three's PMREM atlas of the studio environment (see dump_env)
 */
import { createCardStage } from "@three-engine/scene/stage.ts";
import { createPublicAssets } from "../../../packages/core/src/scene/assets.ts";
import { ensureDesign } from "../../../packages/core/src/design/design.ts";
import * as THREE from "three";
import { createStudioEnvironment } from "@three-engine/scene/quality-env.ts";

declare global {
  interface Window {
    __ready?: true | string;
    __render?(euler: [number, number, number]): string;
  }
}

/**
 * Meshes the Rust engine draws so far (grows each phase; removed once everything is ported). The scene
 * staging's meshes and background sit outside the card (only the card's meshes are filtered).
 */
const PORTED = new Set([
  "face shader skins",
  "Glass card body",
  "chip module tape",
  "chip mould cap",
  "antenna pad",
  "antenna coil",
  "antenna lead",
  "card body",
  "front face",
  "back face",
  "chip",
  "chip detail",
  "logo",
  "cardholder name",
  "cardholder bio",
  "contactless mark",
  "front design",
  "back design",
  "front chip decal depth mask",
  "shine aura",
  "shine streak",
  "shine rainbow streak",
  "shine glint",
  "leaf shadows front",
  "leaf shadows back",
  "ivy stems",
  "ivy leaves",
  "liquid metal surface",
  "staging floor",
  "staging sweep",
]);
const ported = (name: string) =>
  PORTED.has(name) || /^(text line \d+|sticker decal \d+|Holo foil (face|bevel) \((front|back)\)|face shader overlay \d+ \((front|back)\))$/.test(name);

/** three's PMREM atlas of the studio environment (768 × 1024 half floats, RGBA), base64. */
function dumpEnvironment(quality: "full" | "performance" = "full"): string {
  const renderer = new THREE.WebGLRenderer({ canvas: document.createElement("canvas") });
  const env = createStudioEnvironment(renderer, quality);
  const rt = new THREE.PMREMGenerator(renderer).fromCubemap(env.texture);
  const px = new Uint16Array(rt.width * rt.height * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, px);
  const bytes = new Uint8Array(px.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `${rt.width}x${rt.height}:${btoa(bin)}`;
}

async function main() {
  const q = new URLSearchParams(location.search);
  (window as unknown as { __dumpEnv: unknown }).__dumpEnv = dumpEnvironment;
  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  canvas.style.width = `${q.get("w") ?? 1200}px`;
  canvas.style.height = `${q.get("h") ?? 750}px`;
  const designUrl = new URL(q.get("design") ?? "/crates/card3d-tools/designs/brushed-silver.json", location.href);
  const json = await (await fetch(designUrl)).json();
  // The fixture's asset provider (`__harness.assets`): its name font. The design's `src`s are relative
  // to the design.
  const h = json.__harness as
    | {
        orbit?: { azimuth: number; elevation: number; distance: number };
        lift?: number;
        assets?: { nameFontFamily?: string };
      }
    | undefined;
  const assets = createPublicAssets({
    ...(h?.assets?.nameFontFamily ? { nameFontFamily: h.assets.nameFontFamily } : {}),
    resolveUrl: (src) => (/^(?:[a-z]+:|\/)/i.test(src) ? src : new URL(src, designUrl).href),
  });
  const stage = createCardStage(canvas, assets, {
    quality: q.get("quality") === "performance" ? "performance" : "full",
    lighting: "studio",
    fit: q.get("fit") === "contain" ? "contain" : "studio",
    interactive: false,
    intro: false,
    pixelRatio: 1,
    preserveDrawingBuffer: true,
  });
  // The archive's shine reads its still clock from `bespokeParams.time` (designs/generate.ts writes it),
  // a key `ensureDesign` no longer keeps.
  const clock = json.bespokeParams ? { bespokeParams: json.bespokeParams } : {};
  await stage.setDesign({ ...ensureDesign(json), ...clock });
  // A camera path frozen at a moment (designs/generate.ts): the camera's orbit and the card's lift.
  if (h?.orbit) {
    stage.setCameraOrbit(h.orbit);
    stage.setLift(h.lift ?? 0);
  }
  stage.card!.object.traverse((o) => {
    if ((o as { isMesh?: boolean }).isMesh && !ported(o.name)) o.visible = false;
  });
  // ?nolight: switch the key light off (debugging the port's lighting terms).
  if (q.has("nolight")) {
    let scene = stage.card!.object as { parent: unknown; traverse?: unknown };
    while ((scene as { parent: unknown }).parent) scene = (scene as { parent: typeof scene }).parent;
    (scene as unknown as { traverse(f: (o: { isDirectionalLight?: boolean; intensity: number }) => void): void }).traverse((o) => {
      if (o.isDirectionalLight) o.intensity = 0;
    });
  }
  window.__render = (euler) => {
    stage.setRotation(euler);
    stage.render();
    return canvas.toDataURL("image/png");
  };
  window.__render([0, 0, 0]);
  window.__ready = true;
}
main().catch((e) => (window.__ready = String(e?.stack ?? e)));
