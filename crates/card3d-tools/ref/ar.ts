/**
 * The three.js engine's AR export (the local archive's packages/core/src/ar/, through `@three-engine/`:
 * ../three-archive.mjs) for the AR comparison
 * (crates/card3d-tools/ar-compare.mjs). `?design=<url>` a CardDesign JSON (run through ensureDesign).
 *
 *   window.__ready        true once built (else an error string)
 *   window.__ar(format)   "glb" | "usdz" → the file, base64
 */
import { createCardStage } from "@three-engine/scene/stage.ts";
import { createPublicAssets } from "../../../packages/core/src/scene/assets.ts";
import { ensureDesign } from "../../../packages/core/src/design/design.ts";
import { exportCardGlb, exportCardUsdz } from "@three-engine/ar/index.ts";

declare global {
  interface Window {
    __ready?: true | string;
    __ar?(format: "glb" | "usdz"): Promise<string>;
  }
}

async function main() {
  const q = new URLSearchParams(location.search);
  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  const stage = createCardStage(canvas, createPublicAssets(), {
    quality: "full",
    lighting: "studio",
    fit: "studio",
    interactive: false,
    intro: false,
    pixelRatio: 1,
  });
  const design = ensureDesign(await (await fetch(q.get("design")!)).json());
  await stage.setDesign(design);
  // Draw once: face-shader skins and the like render on first draw (as Studio's AR export does).
  stage.render();
  window.__ar = async (format) => {
    const card = stage.card!.object;
    const bytes = new Uint8Array(format === "usdz" ? await exportCardUsdz(stage.renderer, card, design) : await exportCardGlb(stage.renderer, card, design));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  window.__ready = true;
}
main().catch((e) => (window.__ready = String(e?.stack ?? e)));
