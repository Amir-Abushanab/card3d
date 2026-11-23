/**
 * Branding on the public build: the open-font picker, logo upload (path and raster SVGs) and the
 * lighting / backdrop presets — each through the live card, history, share links, autosave and export.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canvasShot, expect, folder, historyLabels, imageStats, openFolder, openStudio, row, settle, showHistory, test } from "./fixtures.ts";
import type { Browser, Locator, Page } from "@playwright/test";

const asset = (name: string) => fileURLToPath(new URL(`./assets/${name}`, import.meta.url));

/** Regions of the live canvas (fractions), for the default face-on pose. */
const NAME = { x: 0.16, y: 0.6, w: 0.34, h: 0.14 };
const CORNER = { x: 0.13, y: 0.22, w: 0.17, h: 0.17 };
const CENTRE = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };

/** Mean absolute difference of two same-sized images inside a fractional region, 0..255. */
async function regionDiff(page: Page, a: Buffer, b: Buffer, r: { x: number; y: number; w: number; h: number }): Promise<number> {
  return page.evaluate(
    async ({ a, b, r }) => {
      const load = async (b64: string) => {
        const bin = atob(b64);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([u]));
        const x = Math.round(bmp.width * r.x),
          y = Math.round(bmp.height * r.y);
        const w = Math.round(bmp.width * r.w),
          h = Math.round(bmp.height * r.h);
        const cv = new OffscreenCanvas(w, h);
        const ctx = cv.getContext("2d")!;
        ctx.drawImage(bmp, -x, -y);
        return ctx.getImageData(0, 0, w, h).data;
      };
      const [x, y] = await Promise.all([load(a), load(b)]);
      let s = 0;
      for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]);
      return s / x.length;
    },
    { a: a.toString("base64"), b: b.toString("base64"), r },
  );
}

async function uploadLogo(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".c3-logo-thumb").click();
  await (await chooser).setFiles(file);
  await expect(page.locator(".c3-logo-thumb")).toHaveClass(/has-art/);
  await settle(page, 300);
}

async function shareLink(page: Page): Promise<string> {
  await openFolder(page, "Save & share");
  await folder(page, "Save & share")
    .getByRole("button", { name: /Copy share link/ })
    .click();
  await expect(page).toHaveURL(/#d=/);
  return page.url();
}

/** Open a link in a fresh browser profile (no autosave). */
async function viewer(browser: Browser, link: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await openStudio(page, link);
  return { page, close: () => ctx.close() };
}

async function exportPng(page: Page, exp: Locator): Promise<Buffer> {
  const download = page.waitForEvent("download");
  await exp.getByRole("button", { name: /Export image/ }).click();
  return readFile((await (await download).path())!);
}

async function smallExport(page: Page): Promise<Locator> {
  const exp = await openFolder(page, "Export");
  await row(exp, "Size").locator("select").selectOption({ label: "Custom…" });
  for (const [label, v] of [
    ["Width", "640"],
    ["Height", "400"],
  ]) {
    const input = row(exp, label).locator("input.tp-txtv_i").first();
    await input.fill(v);
    await input.press("Enter");
  }
  return exp;
}

test("font picker: the name re-rasterises in the picked open font, self-hosted", async ({ page, browser }) => {
  const fonts: string[] = [];
  page.on("request", (r) => /\.woff2(\?|$)/.test(r.url()) && fonts.push(r.url()));
  await openStudio(page);
  const id = await openFolder(page, "Identity");
  await expect(id.locator(".c3-font")).toHaveCount(6);
  await expect(id.locator('.c3-font[data-value="inter"]')).toHaveAttribute("aria-checked", "true");
  // the default card already uses the bundled Inter, loaded before the name was rasterised
  expect(await page.evaluate(() => document.fonts.check('700 100px "card3d Inter"', "ADA LOVELACE"))).toBe(true);

  const before = await canvasShot(page);
  await id.locator('.c3-font[data-value="unbounded"]').click();
  await settle(page, 300);
  expect(await page.evaluate(() => document.fonts.check('700 100px "card3d Unbounded"', "ADA LOVELACE"))).toBe(true);
  const after = await canvasShot(page);
  expect(await regionDiff(page, before, after, NAME), "the name changed").toBeGreaterThan(2);
  expect(await regionDiff(page, before, after, CENTRE), "nothing else did").toBeLessThan(0.5);

  expect(fonts.length).toBeGreaterThan(0);
  for (const u of fonts) expect(new URL(u).origin, "fonts are served by the site itself").toBe(new URL(page.url()).origin);
  await showHistory(page);
  expect(await historyLabels(page)).toContain("font Unbounded");

  const v = await viewer(browser, await shareLink(page));
  await expect((await openFolder(v.page, "Identity")).locator('.c3-font[data-value="unbounded"]')).toHaveAttribute("aria-checked", "true");
  await v.close();
});

test("logo upload: SVG mask and vector path, placement, autosave, share link and export", async ({ page, browser }) => {
  test.setTimeout(90_000);
  await openStudio(page);
  const id = await openFolder(page, "Identity");
  const hint = id.locator(".c3-logo-hint");
  await expect(hint).toHaveText("Replaces the corner mark");
  const before = await canvasShot(page);

  // A multi-shape SVG is rasterised to a mask and replaces the corner mark.
  await uploadLogo(page, asset("logo-shapes.svg"));
  await expect(hint).toHaveText("Image mask");
  const raster = await canvasShot(page);
  expect(await regionDiff(page, before, raster, CORNER), "the corner shows the logo").toBeGreaterThan(3);

  // Elsewhere on the face.
  await id.locator('.c3-seg-btn[data-value="center"]').click();
  await settle(page, 300);
  const centred = await canvasShot(page);
  expect(await regionDiff(page, raster, centred, CENTRE), "now in the middle").toBeGreaterThan(2);

  // A single-path SVG keeps its vector path (and the placement).
  await uploadLogo(page, asset("logo-path.svg"));
  await expect(hint).toHaveText("Vector path");
  await expect(id.locator('.c3-seg-btn[data-value="center"]')).toHaveAttribute("aria-checked", "true");
  await showHistory(page);
  expect(await historyLabels(page)).toEqual(expect.arrayContaining(["logo", "logo position"]));

  // Export: the logo is in the image (compare with the same export after removing it).
  const exp = await smallExport(page);
  const withLogo = await exportPng(page, exp);
  const link = await shareLink(page);

  // Autosave (debounced): once it holds the path logo, a reload restores it.
  await expect.poll(() => page.evaluate(() => localStorage.getItem("card-studio:autosave")?.includes("M50 2a48") ?? false), { timeout: 10_000 }).toBe(true);
  await openStudio(page);
  await expect((await openFolder(page, "Identity")).locator(".c3-logo-hint")).toHaveText("Vector path");

  // Share link: a fresh viewer gets it.
  const v = await viewer(browser, link);
  const vid = await openFolder(v.page, "Identity");
  await expect(vid.locator(".c3-logo-hint")).toHaveText("Vector path");
  await expect(vid.locator('.c3-seg-btn[data-value="center"]')).toHaveAttribute("aria-checked", "true");
  await v.close();

  await (await openFolder(page, "Identity")).getByRole("button", { name: "Remove", exact: true }).first().click();
  await settle(page, 300);
  const without = await exportPng(page, await smallExport(page));
  expect(await regionDiff(page, withLogo, without, CENTRE), "the export carried the logo").toBeGreaterThan(2);
});

test("lighting presets: stage, page backdrop, share link and a backdrop export", async ({ page, browser }) => {
  await openStudio(page);
  const st = await openFolder(page, "Stage");
  const chip = (id: string) => st.locator(`.c3-chips--light .c3-chip[data-value="${id}"]`);
  await expect(st.locator(".c3-chips--light .c3-chip")).toHaveCount(6);
  await expect(chip("studio")).toHaveAttribute("aria-checked", "true");
  const studio = await imageStats(page, await canvasShot(page), undefined);
  const warmth = (s: { rgb: [number, number, number] }) => s.rgb[0] - s.rgb[2];

  await chip("warm").click();
  await settle(page, 300);
  const warm = await imageStats(page, await canvasShot(page));
  expect(warmth(warm) - warmth(studio), "warm light").toBeGreaterThan(8);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--stage-backdrop"))).toContain("#4a3328");

  await chip("light").click();
  await settle(page, 300);
  await expect(page.locator("html")).toHaveAttribute("data-tone", "light");
  await showHistory(page);
  expect(await historyLabels(page)).toEqual(expect.arrayContaining(["lighting Warm", "lighting Light"]));

  // Export over the preset's backdrop: the frame's corners are the light backdrop, not transparent.
  const exp = await smallExport(page);
  await row(exp, "Background").locator("select").selectOption({ label: "Lighting backdrop" });
  const png = await exportPng(page, exp);
  const corner = await imageStats(page, png, { x: 0, y: 0, w: 24, h: 24 });
  expect(corner.coverage).toBe(1);
  expect(corner.mean, "the light backdrop").toBeGreaterThan(190);

  const v = await viewer(browser, await shareLink(page));
  await expect(v.page.locator("html")).toHaveAttribute("data-tone", "light");
  await expect((await openFolder(v.page, "Stage")).locator('.c3-chips--light .c3-chip[data-value="light"]')).toHaveAttribute("aria-checked", "true");
  await v.close();
});
