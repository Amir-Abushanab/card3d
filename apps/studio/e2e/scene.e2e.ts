/**
 * Product-shot staging and AR: the Scene panel (HDRI environments loaded only when picked, backdrops,
 * the reflective floor and its alpha in a transparent export, share links), a camera-path GIF export
 * (frame count, byte-identical across two exports of an animated card), the AR model (USDZ: a valid,
 * 64-byte-aligned zip with the stage, geometry and baked textures; GLB), and `<metal-card>`'s
 * `environment` / `floor` / `ar` from the CDN bundle (the extras chunk loads only when used).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { EXAMPLE_PORT } from "../playwright.config.ts";
import { canvasShot, cardCentre, diff, expect, folder, historyLabels, imageStats, openFolder, openStudio, row, settle, showHistory, test } from "./fixtures.ts";

const EXAMPLE = `http://localhost:${EXAMPLE_PORT}`;

const sceneChip = (scene: Locator, id: string) => scene.locator(`.c3-chips--env .c3-chip[data-value="${id}"]`);
const segment = (scene: Locator, value: string) => scene.locator(`.c3-seg-btn[data-value="${value}"]`);

async function setText(r: Locator, value: string): Promise<void> {
  const input = r.locator("input.tp-txtv_i").first();
  await input.fill(value);
  await input.press("Enter");
}

async function smallExport(page: Page, w = 640, h = 400): Promise<Locator> {
  const exp = await openFolder(page, "Export");
  await row(exp, "Size").locator("select").selectOption({ label: "Custom…" });
  await setText(row(exp, "Width"), String(w));
  await setText(row(exp, "Height"), String(h));
  return exp;
}

async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const d = page.waitForEvent("download", { timeout: 120_000 });
  await click();
  const file = await d;
  return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
}

/** Local file entries of a zip: name, compression, offset of the data. */
function zipEntries(buf: Buffer): { name: string; method: number; dataOffset: number; size: number }[] {
  const out: { name: string; method: number; dataOffset: number; size: number }[] = [];
  let o = 0;
  while (o + 30 <= buf.length && buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8);
    const size = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString("utf8");
    const dataOffset = o + 30 + nameLen + extraLen;
    out.push({ name, method, dataOffset, size });
    o = dataOffset + size;
  }
  return out;
}

/** Checks a USDZ: an uncompressed zip, model.usda first, data 64-byte aligned, a real-scale stage with geometry and textures. */
function checkUsdz(bytes: Buffer): string {
  const entries = zipEntries(bytes);
  expect(entries.length).toBeGreaterThan(4);
  expect(entries[0]!.name).toBe("model.usda");
  for (const e of entries) {
    expect(e.method, `${e.name} stored`).toBe(0);
    expect(e.dataOffset % 64, `${e.name} aligned`).toBe(0);
  }
  expect(entries.filter((e) => /^geometries\/.+\.usda$/.test(e.name)).length).toBe(3);
  const pngs = entries.filter((e) => /^textures\/.+\.png$/.test(e.name));
  expect(pngs.length, "baked colour, roughness/metalness and normal maps, front and back").toBe(6);
  for (const p of pngs) expect(bytes.subarray(p.dataOffset + 1, p.dataOffset + 4).toString("latin1")).toBe("PNG");
  const usda = bytes.subarray(entries[0]!.dataOffset, entries[0]!.dataOffset + entries[0]!.size).toString("utf8");
  expect(usda).toContain("metersPerUnit = 1");
  expect(usda).toContain('upAxis = "Y"');
  expect(usda).toContain('preliminary:anchoring:type = "plane"');
  expect(usda, "inches → metres").toContain("0.0254");
  expect(usda).toMatch(/float4 inputs:bias = \(-1, -1, -1, 0\)/);
  expect(usda).not.toContain("token inputs:varname");
  return usda;
}

/** GIF frames (image descriptors), walking the block structure. */
function gifFrames(b: Buffer): number {
  expect(b.subarray(0, 6).toString("latin1")).toMatch(/^GIF8[79]a$/);
  let o = 13;
  if (b[10]! & 0x80) o += 3 * 2 ** ((b[10]! & 7) + 1);
  const skipSubBlocks = () => {
    while (b[o]) o += b[o]! + 1;
    o++;
  };
  let frames = 0;
  while (o < b.length) {
    const t = b[o++];
    if (t === 0x3b) break;
    if (t === 0x21) {
      o++; // label
      skipSubBlocks();
    } else if (t === 0x2c) {
      frames++;
      const flags = b[o + 8]!;
      o += 9;
      if (flags & 0x80) o += 3 * 2 ** ((flags & 7) + 1);
      o++; // LZW minimum code size
      skipSubBlocks();
    } else throw new Error(`bad GIF block 0x${t?.toString(16)} at ${o - 1}`);
  }
  return frames;
}

test("scene: Softbox by default, other HDRIs only when picked; sweep, floor and a transparent export with the floor's alpha; share link", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const envRequests: string[] = [];
  page.on("request", (r) => /\/assets\/(softbox|cyclorama|loft|warm-hall|sunset)-[\w-]+\.webp$/.test(r.url()) && envRequests.push(new URL(r.url()).pathname));
  await openStudio(page);
  const scene = await openFolder(page, "Scene");
  await expect(scene.locator(".c3-chips--env .c3-chip")).toHaveCount(6);
  await expect(sceneChip(scene, "softbox")).toHaveAttribute("aria-checked", "true");
  expect(envRequests.length, "a new design is lit by the Softbox HDRI, and only that one is fetched").toBe(1);
  expect(envRequests[0]).toMatch(/softbox-/);

  const softboxStart = await canvasShot(page);
  await sceneChip(scene, "studio").click();
  await settle(page, 400);
  const studio = await canvasShot(page);
  expect(await diff(page, softboxStart, studio), "the built-in rig lights the card differently").toBeGreaterThan(1.5);
  await sceneChip(scene, "softbox").click();
  await settle(page, 400);
  expect(envRequests.length, "switching back reuses the loaded HDRI").toBe(1);
  const softbox = await canvasShot(page);
  expect(await diff(page, studio, softbox), "the HDRI relights the card").toBeGreaterThan(1.5);

  // Floor: the reflection and contact shadow under the card.
  await row(scene, "Reflective floor").locator("label").first().click();
  await settle(page, 300);
  const floored = await canvasShot(page);
  expect(await diff(page, softbox, floored)).toBeGreaterThan(0.3);

  // Transparent PNG with the floor: the frame is mostly transparent, the floor under the card keeps partial alpha.
  const exp = await smallExport(page);
  const png = await download(page, () => exp.getByRole("button", { name: /Export image/ }).click());
  const whole = await imageStats(page, png.bytes);
  expect(whole.coverage, "transparent around the card").toBeLessThan(0.85);
  const corner = await imageStats(page, png.bytes, { x: 0, y: 0, w: 32, h: 32 });
  expect(corner.coverage).toBe(0);
  const floorAlpha = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u]), { premultiplyAlpha: "none" });
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    // Under the card: the band just below its lower edge, across the middle.
    const d = ctx.getImageData(Math.round(bmp.width * 0.3), Math.round(bmp.height * 0.74), Math.round(bmp.width * 0.4), Math.round(bmp.height * 0.16)).data;
    let partial = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 8 && d[i]! < 250) partial++;
    return partial / (d.length / 4);
  }, png.bytes.toString("base64"));
  expect(floorAlpha, "the floor's reflection / shadow is semi-transparent in the export").toBeGreaterThan(0.05);

  // Sweep: an opaque backdrop fills the frame.
  await segment(scene, "sweep").click();
  await settle(page, 300);
  const swept = await download(page, () => exp.getByRole("button", { name: /Export image/ }).click());
  expect((await imageStats(page, swept.bytes, { x: 0, y: 0, w: 32, h: 32 })).coverage, "the sweep fills the corners").toBe(1);

  await showHistory(page);
  expect(await historyLabels(page)).toEqual(expect.arrayContaining(["environment softbox", "floor on", "backdrop sweep"]));

  // The scene travels in the share link.
  await openFolder(page, "Save & share");
  await folder(page, "Save & share")
    .getByRole("button", { name: /Copy share link/ })
    .click();
  await expect(page).toHaveURL(/#d=/);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const v = await ctx.newPage();
  await openStudio(v, page.url());
  const vScene = await openFolder(v, "Scene");
  await expect(sceneChip(vScene, "softbox")).toHaveAttribute("aria-checked", "true");
  await expect(segment(vScene, "sweep")).toHaveAttribute("aria-checked", "true");
  await ctx.close();
});

test("lighting presets grade the Softbox HDRI: the card itself warms, cools, darkens, brightens and goes low-key", async ({ page }) => {
  await openStudio(page);
  await expect(sceneChip(await openFolder(page, "Scene"), "softbox")).toHaveAttribute("aria-checked", "true");
  const st = await openFolder(page, "Stage");
  // The face's centre only (not the page backdrop, which every preset tints anyway).
  const card = async (id: string) => {
    await st.locator(`.c3-chips--light .c3-chip[data-value="${id}"]`).click();
    await settle(page, 300);
    return cardCentre(page);
  };
  const studio = await cardCentre(page);
  const warm = await card("warm");
  const cool = await card("cool");
  const dark = await card("dark");
  const light = await card("light");
  const dramatic = await card("dramatic");
  const back = await card("studio");
  const tone = (s: { rgb: [number, number, number] }) => s.rgb[0] - s.rgb[2];
  expect(tone(warm) - tone(studio), "warm light on the card").toBeGreaterThan(8);
  expect(tone(studio) - tone(cool), "cool light on the card").toBeGreaterThan(8);
  expect(studio.mean - dark.mean, "dark").toBeGreaterThan(10);
  expect(light.mean - studio.mean, "light").toBeGreaterThan(6);
  expect(studio.mean - dramatic.mean, "dramatic: the face sits in low light").toBeGreaterThan(10);
  // Studio is the HDRI as loaded: back to exactly where it started.
  expect(Math.abs(back.mean - studio.mean)).toBeLessThan(0.5);
  expect(Math.abs(tone(back) - tone(studio))).toBeLessThan(0.5);
});

test("video: a camera-path GIF of an animated card has the right frame count and is identical across exports", async ({ page }) => {
  test.setTimeout(240_000);
  await openStudio(page);
  // An animated card (the shine add-on) on a staged floor.
  await page.locator('.c3-tabs-chips .c3-chip[data-value="effects"]').click();
  await page.locator('.c3-tile[data-preset="gold-shine"]').click();
  await settle(page);
  const scene = await openFolder(page, "Scene");
  await row(scene, "Reflective floor").locator("label").first().click();
  await settle(page, 200);

  const exp = await smallExport(page, 240, 160);
  const clip = exp.locator(".c3-group", { hasText: "VIDEO / GIF" });
  await row(clip, "path").locator("select").selectOption({ label: "Hero push-in" });
  await row(clip, "format").locator("select").selectOption({ label: "GIF" });
  await setText(row(clip, "seconds"), "2");
  await expect(clip.getByRole("button", { name: /Record hero push-in/ })).toBeVisible();

  // The preview plays the path on the live card.
  await clip.getByRole("button", { name: /Preview path/ }).click();
  await expect(page.locator("body")).toHaveAttribute("data-previewing", "push-in");
  const a = await canvasShot(page);
  await page.waitForTimeout(700);
  expect(await diff(page, a, await canvasShot(page)), "the preview moves").toBeGreaterThan(0.2);
  await clip.getByRole("button", { name: /Stop preview/ }).click();
  await expect(page.locator("body")).not.toHaveAttribute("data-previewing", /.*/);

  const record = () => download(page, () => clip.getByRole("button", { name: /Record hero push-in/ }).click());
  const first = await record();
  expect(first.name).toMatch(/-push-in\.gif$/);
  expect(gifFrames(first.bytes), "2 s at 25 fps").toBe(50);
  const second = await record();
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  expect(hash(second.bytes), "frame-exact and repeatable").toBe(hash(first.bytes));
});

test("AR: the dialog explains AR on desktop and exports a real-scale USDZ and GLB", async ({ page }) => {
  test.setTimeout(120_000);
  await openStudio(page);
  await (await openFolder(page, "Export")).getByRole("button", { name: /View in AR/ }).click();
  const dialog = page.locator("dialog.c3-ar-dialog[open]");
  await expect(dialog).toContainText("AR needs a phone or tablet");
  await expect(dialog).toContainText("85.6 × 54 × 0.76 mm");
  const usdz = await download(page, () => dialog.getByRole("button", { name: "Download .usdz" }).click());
  expect(usdz.name).toMatch(/-ar\.usdz$/);
  checkUsdz(usdz.bytes);
  const glb = await download(page, () => dialog.getByRole("button", { name: "Download .glb" }).click());
  expect(glb.bytes.subarray(0, 4).toString("latin1")).toBe("glTF");
  const json = JSON.parse(glb.bytes.subarray(20, 20 + glb.bytes.readUInt32LE(12)).toString("utf8")) as { materials: unknown[]; images: unknown[] };
  expect(json.materials.length).toBe(3);
  expect(json.images.length, "colour, metal-rough and normal per face").toBe(6);
});

test("metal-card: environment and floor from the CDN bundle; the extras chunk and AR exporter load only when used", async ({ page }) => {
  test.setTimeout(120_000);
  const extras: string[] = [];
  const ar: string[] = [];
  const envs: string[] = [];
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (/metal-card-extras-[\w-]+\.js$/.test(p)) extras.push(p);
    // The engine's AR export: its page side (a chunk) and its wasm part.
    if (/metal-card-ar-[\w-]+\.js$/.test(p) || /\/split_ar\.[0-9a-f]+\.wasm$/.test(p)) ar.push(p);
    if (/\/environments\/[\w-]+\.webp$/.test(p)) envs.push(p);
  });
  // AR Quick Look "available", and every link click recorded instead of followed.
  await page.addInitScript(() => {
    const w = window as unknown as { __arLinks: string[] };
    w.__arLinks = [];
    const supports = DOMTokenList.prototype.supports;
    DOMTokenList.prototype.supports = function (token: string) {
      return token === "ar" ? true : supports.call(this, token);
    };
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.rel === "ar") w.__arLinks.push(this.href);
    };
  });

  // A page without scenes never loads the extras chunk, even with an AR button on screen.
  await page.goto(`${EXAMPLE}/`);
  await expect.poll(() => page.evaluate(() => (document.querySelector("#hero") as unknown as { ready: boolean }).ready), { timeout: 45_000 }).toBe(true);
  await page.evaluate(() => document.querySelector("#hero")!.setAttribute("ar", ""));
  const button = page.locator("#hero").locator("button.ar");
  await expect(button).toBeVisible();
  await page.waitForTimeout(500);
  expect(extras, "nothing loaded for a plain card").toEqual([]);
  expect(ar, "nothing loaded for a plain card").toEqual([]);
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __arLinks: string[] }).__arLinks.length), { timeout: 60_000 }).toBe(1);
  expect(ar.length, "the engine's exporter (page side and wasm part) loaded on the tap").toBe(2);
  expect(extras, "no three.js exporter").toEqual([]);
  const href = await page.evaluate(() => (window as unknown as { __arLinks: string[] }).__arLinks[0]!);
  expect(href).toMatch(/^blob:.*#allowsContentScaling=0$/);
  const b64 = await page.evaluate(async (u) => {
    const buf = new Uint8Array(await (await fetch(u.split("#")[0]!)).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, href);
  checkUsdz(Buffer.from(b64, "base64"));

  // The scene page: environments from next to the bundle, a floor, and the AR button.
  await page.goto(`${EXAMPLE}/scene.html`);
  for (const id of ["#staged", "#sunset"]) {
    await expect.poll(() => page.evaluate((s) => (document.querySelector(s) as unknown as { ready: boolean }).ready, id), { timeout: 45_000 }).toBe(true);
  }
  expect(envs.sort()).toEqual([
    "/npm/@card3d/element/dist/standalone/environments/softbox.webp",
    "/npm/@card3d/element/dist/standalone/environments/sunset.webp",
  ]);
  const scenes = await page.evaluate(() =>
    ["#staged", "#sunset"].map((s) => (document.querySelector(s) as unknown as { design: { scene?: unknown } }).design.scene),
  );
  expect(scenes).toEqual([
    { environment: "softbox", floor: {} },
    { environment: "sunset", floor: { reflectivity: 0.7 } },
  ]);
  const staged = await imageStats(page, await page.locator("#sunset").screenshot());
  expect(staged.std).toBeGreaterThan(8);
  await expect(page.locator("#sunset").locator("button.ar")).toHaveCount(0);
  // The button sits above the canvas (created before it): a tap reaches it and opens Quick Look.
  await page.locator("#staged").locator("button.ar").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __arLinks: string[] }).__arLinks.length), { timeout: 60_000 }).toBe(1);
});
