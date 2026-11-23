// The AR model on the engine (`card3d_engine::ar`: the card baked into a light, real-scale model,
// written as GLB or USDZ by the engine's `ar` part). A module of its own, loaded on first use, so pages
// that never export AR don't carry it: packages/core/src/engine.ts imports it.

import { BUILD } from "./loader.js";

/**
 * The AR model of `json` (a `CardDesign`), built on `card`'s GPU (a `createCard` card): the file's
 * bytes. `format` "glb" (Scene Viewer, glTF viewers) or "usdz" (AR Quick Look); `size` the longest side
 * of each baked map (px, default 2048); `upright` stands the card instead of laying it face up;
 * `fontFamily` as for `setDesign`.
 */
export async function arModel(card, json, { fontFamily, format = "glb", size = 2048, upright = false } = {}) {
  const flags = (upright ? 1 : 0) | (format === "usdz" ? 2 : 0);
  // The WebGL build reads the baked maps back on polls of its device (WebGPU calls back by itself).
  let done = false;
  const poll = () => {
    if (done) return;
    card.stage?.poll();
    setTimeout(poll, 4);
  };
  setTimeout(poll, 4);
  try {
    return await card.build(BUILD.AR, json, { fontFamily }, size, flags);
  } finally {
    done = true;
  }
}
