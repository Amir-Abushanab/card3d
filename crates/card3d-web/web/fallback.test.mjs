// Checks the WebGPU → WebGL fallbacks of packages/core/wasm/loader.js in Chrome (build-web.sh first):
//   node crates/card3d-web/web/fallback.test.mjs
//   CARD3D_SWIFTSHADER=1 node crates/card3d-web/web/fallback.test.mjs   # no GPU: headless, on SwiftShader (CI)
// 1. a normal start uses WebGPU and clears its "starting" mark; leaving early is not a crash;
// 2. a device loss after the first frames moves the card to WebGL, and later loads skip WebGPU; the
//    page's cards share one device, so every card on it moves;
// 3. a load that finds the "starting" mark (the last start crashed the tab) goes straight to WebGL;
// 4. a lazily loaded part of the engine that fails to download once is retried; one that keeps
//    failing rejects with Card3dLoadError and counts nothing against WebGPU;
// 5. a fall-over keeps the card's pose; 6. the WebGL build survives a lost context.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { launchWebChrome } from "../../card3d-tools/web-chrome.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
// playwright comes from the comparison tools' dev dependencies (crates/card3d-tools/package.json).
const req = createRequire(resolve(ROOT, "crates/card3d-tools/package.json"));
const pw = await import(pathToFileURL(req.resolve("playwright")).href);
const chromium = pw.chromium ?? pw.default.chromium;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".woff2": "font/woff2", ".json": "application/json" };
const server = createServer(async (q, s) => {
  let p = decodeURIComponent(new URL(q.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  try {
    const body = await readFile(resolve(ROOT, "." + p));
    s.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" }).end(body);
  } catch {
    s.writeHead(404).end();
  }
}).listen(0);
const url = `http://localhost:${server.address().port}/crates/card3d-web/web/?w=400&h=250`;
// Chrome on the GPU; CARD3D_SWIFTSHADER=1: headless Chromium on SwiftShader (CI, crates/card3d-tools/web-chrome.mjs).
const browser = await launchWebChrome(chromium);
const page = await (await browser.newContext()).newPage();
// Every "starting" mark a load writes, so the checks don't depend on reading it within its 2 s (a slow
// software start, as on CI's SwiftShader, can be past them by the time the card is ready).
await page.addInitScript(() => {
  window.__marks = [];
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (k === "card3d:webgpu") window.__marks.push(String(v));
    return set.call(this, k, v);
  };
});
const markedStarting = () => page.evaluate(() => window.__marks.some((m) => m.startsWith("starting:")));
const ready = async () => {
  await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__ready), true);
};
const stored = () => page.evaluate(() => localStorage.getItem("card3d:webgpu"));
const opaquePixels = () =>
  page.evaluate(async () => {
    const png = window.__render([0, 0, 0]);
    const img = new Image();
    img.src = png;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height).getContext("2d");
    c.drawImage(img, 0, 0);
    return c.getImageData(0, 0, img.width, img.height).data.filter((_, i) => i % 4 === 3 && _ > 0).length;
  });
try {
  // 1. Normal start.
  await page.goto(url);
  await ready();
  assert.equal(await page.evaluate(() => window.__card.backend), "webgpu");
  assert.ok(await markedStarting(), "a starting mark while WebGPU starts");
  await page.waitForTimeout(2600); // ≥ 30 frames and 2 s
  assert.equal(await stored(), null, "the starting mark is cleared after a good start");
  console.log("ok: WebGPU start, mark cleared");

  // 1b. Leaving (or reloading) before the start is confirmed is not a crash.
  await page.reload();
  await ready();
  assert.ok(await markedStarting(), "a starting mark while WebGPU starts");
  await page.reload(); // within the 2 s on a GPU: pagehide clears the mark
  await ready();
  assert.equal(await page.evaluate(() => window.__card.backend), "webgpu", "a quick reload is not a crash");
  await page.waitForTimeout(2600);
  console.log("ok: quick reload stays on WebGPU");

  // 2. Device loss → WebGL, remembered; a second card on the page shares the device and moves too.
  await page.evaluate(async (loader) => {
    const { createCard } = await import(loader);
    const canvas = Object.assign(document.createElement("canvas"), { width: 200, height: 125 });
    document.body.append(canvas);
    const design = await (await fetch("/crates/card3d-tools/designs/holo-front.json")).text();
    window.__second = await createCard(canvas, design);
    window.__second.render();
  }, "/packages/core/wasm/loader.js");
  assert.equal(await page.evaluate(() => window.__second.backend), "webgpu");
  await page.evaluate(() => window.__card.simulateDeviceLoss());
  await page.waitForFunction(() => window.__card.backend === "webgl" && window.__second.backend === "webgl", null, { timeout: 15000 });
  await page.waitForTimeout(500);
  assert.ok((await opaquePixels()) > 1000, "the WebGL card draws");
  assert.match((await stored()) ?? "", /^failed:/);
  await page.reload();
  await ready();
  assert.equal(await page.evaluate(() => window.__card.backend), "webgl", "later loads skip WebGPU");
  console.log("ok: device loss → WebGL for every card on the page, remembered");

  // 3. Crash recovery: the mark from a start that never finished.
  await page.evaluate(() => localStorage.setItem("card3d:webgpu", `starting:${Date.now()}`));
  await page.reload();
  await ready();
  assert.equal(await page.evaluate(() => window.__card.backend), "webgl");
  console.log("ok: crashed start → WebGL");

  // And a cleared store starts on WebGPU again.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ready();
  assert.equal(await page.evaluate(() => window.__card.backend), "webgpu");
  console.log("ok: cleared → WebGPU");

  // 4. Download failures of a lazily loaded part (a shaped card needs split_shape.wasm).
  const shaped = `${url}&design=/crates/card3d-tools/designs/body-shape-notch.json`;
  let failures = 1;
  await page.route("**/split_shape.*.wasm", (r) => (failures-- > 0 ? r.abort() : r.continue()));
  await page.goto(shaped);
  await ready();
  assert.equal(await page.evaluate(() => window.__card.backend), "webgpu", "a failed download is retried on WebGPU");
  console.log("ok: a part that failed to download once is retried");
  await page.waitForTimeout(2600);
  failures = Infinity;
  await page.reload();
  await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 30000 });
  assert.match(String(await page.evaluate(() => window.__ready)), /couldn't download the card engine's shape part/);
  assert.equal(await stored(), null, "a download failure is not held against WebGPU");
  await page.unroute("**/split_shape.*.wasm");
  await page.reload();
  await ready();
  assert.equal(await page.evaluate(() => window.__card.backend), "webgpu");
  console.log("ok: a part that can't be downloaded fails the card, not WebGPU");

  // 5. A fall-over keeps the interaction's pose (interactive page: no fixed size).
  await page.evaluate(() => localStorage.clear());
  await page.goto(url.replace("?w=400&h=250", "?"));
  await ready();
  await page.waitForTimeout(4200); // past the intro
  await page.evaluate(() => {
    const s = window.__card.stage;
    s.toggleFlip(performance.now());
  });
  await page.waitForTimeout(900);
  const before = await page.evaluate(() => [window.__card.stage.flipped(), window.__card.stage.rotationY()]);
  assert.equal(before[0], true);
  await page.evaluate(() => window.__card.simulateDeviceLoss());
  await page.waitForFunction(() => window.__card.backend === "webgl" && window.__card.stage, null, { timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => [window.__card.stage.flipped(), window.__card.stage.rotationY()]), before, "flipped and turned as before");
  console.log("ok: a fall-over keeps the card's pose");

  // 6. WebGL build: a lost context is restored and the card rebuilt.
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${url}&backend=webgl`);
  await ready();
  await page.evaluate(() => (window.__lose = window.__card.canvas.getContext("webgl2").getExtension("WEBGL_lose_context")).loseContext());
  await page.waitForFunction(() => window.__card.contextLost === true);
  await page.evaluate(() => window.__lose.restoreContext());
  await page.waitForFunction(() => window.__card.contextLost === false && window.__card.stage, null, { timeout: 15000 });
  assert.ok((await opaquePixels()) > 1000, "the rebuilt card draws");
  console.log("ok: WebGL context lost and restored");
} finally {
  await browser.close();
  server.close();
}
