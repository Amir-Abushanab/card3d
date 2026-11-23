/**
 * Sticker picture tools (PowerPoint style): the selection frame on the card (rotate handle, corner
 * resize), crop mode, the recolour gallery, undo / redo, autosave and a share link; and
 * `<metal-card>` drawing edited stickers (crop, flip, tint) like the studio.
 */
import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { EXAMPLE_PORT } from "../playwright.config.ts";
import { canvasShot, expect, folder, historyLabels, imageStats, openFolder, openStudio, settle, showHistory, test } from "./fixtures.ts";

type Decal = Record<string, unknown> & { x: number; y: number; width: number; aspect: number; rotation: number };

/** The autosaved working design's stickers (autosave lands ~0.7 s after an edit). */
async function savedDecals(page: Page, settleMs = 1000): Promise<Decal[]> {
  await page.waitForTimeout(settleMs);
  return page.evaluate(() => JSON.parse(localStorage.getItem("card-studio:autosave") ?? "{}").design?.decals ?? []);
}

/** Mean absolute difference of two same-sized images inside a fractional region, 0..255. */
async function regionDiff(page: Page, a: Buffer, b: Buffer, r: { x: number; y: number; w: number; h: number }): Promise<number> {
  return page.evaluate(
    async ({ a, b, r }) => {
      const load = async (b64: string) => {
        const bin = atob(b64);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([u]));
        const [x, y, w, h] = [r.x * bmp.width, r.y * bmp.height, r.w * bmp.width, r.h * bmp.height].map(Math.round);
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

/** The "Sticker" section (not "Stickers"). */
const stickerSection = (page: Page) =>
  page
    .locator("#panel .tp-fldv")
    .filter({ has: page.locator(":scope > .tp-fldv_b .tp-fldv_t", { hasText: /^Sticker$/ }) })
    .first();

const centre = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/** Mean |r − g| + |g − b| over a region: 0 for grey pixels. */
async function chroma(page: Page, shot: Buffer, r: { x: number; y: number; w: number; h: number }): Promise<number> {
  const s = await imageStats(page, shot, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
  return Math.abs(s.rgb[0] - s.rgb[1]) + Math.abs(s.rgb[1] - s.rgb[2]);
}

test("sticker picture tools: rotate and resize on the card, crop, grayscale — undo/redo, autosave, share link", async ({ page, browser }) => {
  test.setTimeout(150_000);
  await openStudio(page);
  const stickers = await openFolder(page, "Stickers");
  await expect(stickerSection(page)).toBeHidden();
  await stickers.locator("button.c3-lib[title*='Rainbow']").click();
  await settle(page, 300);

  // Selected on the card: the frame with eight resize handles, the rotate handle and the mini toolbar;
  // the Sticker section shows its values.
  await expect(page.locator(".c3-sticker-handle--resize")).toHaveCount(8);
  await expect(page.locator(".c3-sticker-handle--rotate")).toBeVisible();
  await expect(page.locator(".c3-sticker-bar-btn--crop")).toBeVisible();
  const section = stickerSection(page);
  await expect(section).toBeVisible();
  await expect(section.locator(".c3-sticker-title")).toContainText("Sticker 1 · front");
  const [added] = await savedDecals(page);
  expect(added.src).toMatch(/rainbow\.svg$/);

  // Rotate with the handle: a quarter turn around the sticker's centre.
  const mid = await centre(page.locator(".c3-sticker-outline"));
  const knob = await centre(page.locator(".c3-sticker-handle--rotate"));
  await drag(page, knob, { x: mid.x + (mid.y - knob.y), y: mid.y + (knob.x - mid.x) });
  await settle(page);
  const [rotated] = await savedDecals(page);
  expect(Math.abs(rotated.rotation - added.rotation), "turned about 90°").toBeGreaterThan(60);

  // Resize from a corner: bigger, same proportions.
  const corner = await centre(page.locator(".c3-sticker-handle--resize[data-hx='1'][data-hy='-1'] .c3-hit"));
  await drag(page, corner, { x: corner.x + (corner.x - mid.x) * 0.4, y: corner.y + (corner.y - mid.y) * 0.4 });
  await settle(page);
  const [resized] = await savedDecals(page);
  expect(resized.width).toBeGreaterThan(rotated.width * 1.15);
  expect(resized.aspect).toBe(rotated.aspect);
  expect(resized.rotation).toBe(rotated.rotation);

  // Crop mode: the picture dimmed outside the crop and black handles; drag one edge in, Enter applies.
  await page.locator(".c3-sticker-bar-btn--crop").click();
  await expect(page.locator("#stage")).toHaveClass(/is-cropping/);
  await expect(page.locator(".c3-crop-bar")).toBeVisible();
  await expect(page.locator(".c3-sticker-handle--crop")).toHaveCount(8);
  const edge = await centre(page.locator(".c3-sticker-handle--crop[data-hx='1'][data-hy='0'] .c3-hit"));
  const cropMid = await centre(page.locator(".c3-crop-rect"));
  await drag(page, edge, { x: edge.x + (cropMid.x - edge.x) * 0.45, y: edge.y + (cropMid.y - edge.y) * 0.45 });
  await page.keyboard.press("Enter");
  await expect(page.locator("#stage")).not.toHaveClass(/is-cropping/);
  await settle(page);
  const [cropped] = await savedDecals(page);
  const crop = cropped.crop as { x: number; y: number; w: number; h: number };
  expect(crop.w).toBeGreaterThan(0.45);
  expect(crop.w).toBeLessThan(0.85);
  expect(crop.h).toBe(1);
  expect(cropped.width, "the visible width shrinks with the crop").toBeLessThan(resized.width * 0.9);
  await expect(section.locator(".c3-sticker-title")).toContainText("cropped");

  // Recolour: Grayscale from the gallery (live in the shader: the sticker loses its colour).
  const region = async () => {
    const box = (await page.locator("#card-canvas").boundingBox())!;
    const s = (await page.locator(".c3-sticker-outline").boundingBox())!;
    return { x: s.x - box.x + s.width * 0.3, y: s.y - box.y + s.height * 0.3, w: s.width * 0.4, h: s.height * 0.4 };
  };
  const r = await region();
  const colourful = await chroma(page, await canvasShot(page), r);
  await section.locator("button.c3-tint[data-tint='grayscale']").click();
  await settle(page, 200);
  await expect(section.locator("button.c3-tint[data-tint='grayscale']")).toHaveAttribute("aria-checked", "true");
  const grey = await chroma(page, await canvasShot(page), r);
  expect(colourful, "the rainbow is colourful").toBeGreaterThan(20);
  expect(grey, "grayscale").toBeLessThan(colourful * 0.35);
  const [tinted] = await savedDecals(page);
  expect(tinted.tint).toEqual({ color: "#808080", amount: 1 });

  // A slider gesture is one undo step.
  const slider = section
    .locator(".tp-lblv")
    .filter({ hasText: /^\s*Brightness/ })
    .locator(".tp-sldv_t");
  const sb = (await slider.boundingBox())!;
  await drag(page, { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 }, { x: sb.x + sb.width * 0.8, y: sb.y + sb.height / 2 });
  await settle(page);
  const [bright] = await savedDecals(page);
  expect((bright.adjust as { brightness: number }).brightness).toBeGreaterThan(0.2);
  await showHistory(page);
  const labels = await historyLabels(page);
  expect(labels).toEqual(
    expect.arrayContaining(["add sticker", "rotate sticker", "resize sticker", "crop sticker", "sticker color grayscale", "sticker corrections"]),
  );
  expect(labels.filter((l) => l === "sticker corrections")).toHaveLength(1);

  // Undo walks back through brightness, the tint and the crop; redo brings them back.
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  await undo.click();
  await settle(page);
  expect((await savedDecals(page))[0].adjust).toBeUndefined();
  await undo.click();
  await settle(page);
  expect((await savedDecals(page))[0].tint).toBeUndefined();
  await undo.click();
  await settle(page);
  expect((await savedDecals(page))[0].crop).toBeUndefined();
  for (let i = 0; i < 3; i++) {
    await redo.click();
    await settle(page);
  }
  const [redone] = await savedDecals(page);
  expect(redone.crop).toEqual(crop);
  expect(redone.tint).toEqual({ color: "#808080", amount: 1 });

  // Esc deselects (and hides the section); the share link reproduces the sticker in a fresh profile.
  await page.locator("#stage").focus();
  await page.keyboard.press("Escape");
  await expect(stickerSection(page)).toBeHidden();
  await expect(page.locator(".c3-sticker-overlay")).toBeHidden();
  await settle(page, 300);
  const mine = await canvasShot(page);
  await openFolder(page, "Save & share");
  await folder(page, "Save & share")
    .getByRole("button", { name: /Copy share link/ })
    .click();
  await expect(page).toHaveURL(/#d=/);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const viewer = await ctx.newPage();
  await openStudio(viewer, page.url());
  await settle(viewer, 600);
  await openFolder(viewer, "Save & share");
  const saved = viewer.waitForEvent("download");
  await folder(viewer, "Save & share")
    .getByRole("button", { name: /Save design/ })
    .click();
  const shared = JSON.parse(await readFile((await (await saved).path())!, "utf8")) as { decals: Decal[] };
  const { id: _id, ...expected } = redone;
  expect(shared.decals).toHaveLength(1);
  expect(shared.decals[0]).toMatchObject(expected);
  const theirs = await canvasShot(viewer);
  // The card, away from the history list and the toolbars over the canvas.
  expect(await regionDiff(viewer, mine, theirs, { x: 0.3, y: 0.15, w: 0.62, h: 0.6 }), "the shared card looks the same").toBeLessThan(1);
  await ctx.close();
});

test("sticker crop mode: Esc cancels, aspect presets, double-click enters it", async ({ page }) => {
  test.setTimeout(120_000);
  await openStudio(page);
  const stickers = await openFolder(page, "Stickers");
  await stickers.locator("button.c3-lib[title*='Planet']").click();
  await settle(page, 300);
  const [start] = await savedDecals(page);
  const mid = await centre(page.locator(".c3-sticker-outline"));

  // Double-click the sticker: crop mode; 1:1 then Esc leaves the sticker as it was.
  await page.mouse.dblclick(mid.x, mid.y);
  await expect(page.locator("#stage")).toHaveClass(/is-cropping/);
  await page.locator(".c3-crop-bar [data-aspect='1:1']").click();
  await expect(page.locator(".c3-crop-bar [data-aspect='1:1']")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#stage")).not.toHaveClass(/is-cropping/);
  await expect(page.locator(".c3-sticker-outline")).toBeVisible(); // still selected
  expect((await savedDecals(page))[0]).toEqual(start);

  // 1:1 applied with Done: a square crop of the wide picture.
  await stickerSection(page).getByRole("button", { name: /Crop/ }).first().click();
  await page.locator(".c3-crop-bar [data-aspect='1:1']").click();
  await page.locator(".c3-sticker-bar-btn--done").click();
  await settle(page);
  const [square] = await savedDecals(page);
  const c = square.crop as { w: number; h: number };
  expect((start.aspect * c.w) / c.h).toBeCloseTo(1, 2);
  // Reset picture brings the whole picture back.
  await stickerSection(page)
    .getByRole("button", { name: /Reset picture/ })
    .click();
  await settle(page);
  const [reset] = await savedDecals(page);
  expect(reset.crop).toBeUndefined();
  expect(reset.width).toBeCloseTo(start.width, 1);
});

test("<metal-card> draws edited stickers: crop, flip and tint", async ({ page }) => {
  await page.goto(`http://localhost:${EXAMPLE_PORT}/`);
  // A sticker that is red on the left half and blue on the right.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="100" height="100" fill="#e0302a"/><rect x="100" width="100" height="100" fill="#2a50e0"/></svg>`;
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const sticker = { id: "s", side: "front", src, aspect: 2, x: 50, y: 50, width: 44, rotation: 0, scale: 1 };
  const designs = {
    plain: [sticker],
    // The left (red) half, mirrored: only red shows, where the right half sat it is now red too.
    crop: [{ ...sticker, crop: { x: 0, y: 0, w: 0.5, h: 1 }, width: 22, flip: { h: true } }],
    grey: [{ ...sticker, tint: { color: "#808080", amount: 1 } }],
  };
  await page.evaluate((designs) => {
    const html = Object.entries(designs)
      .map(
        ([id, decals]) =>
          `<metal-card id="st-${id}" class="st" lazy="false" style="width:420px" design='${JSON.stringify({ recipe: { material: "silver" }, cardholderName: "Grace Hopper", decals })}'></metal-card>`,
      )
      .join("");
    document.querySelector("main")!.insertAdjacentHTML("afterbegin", `<div style="display:flex;flex-wrap:wrap">${html}</div>`);
  }, designs);
  for (const id of Object.keys(designs)) {
    await expect.poll(() => page.locator(`#st-${id}`).evaluate((el) => (el as unknown as { ready: boolean }).ready), { timeout: 45_000 }).toBe(true);
  }
  await page.waitForTimeout(400);
  const measure = async (id: string, fx: number) => {
    const c = page.locator(`#st-${id}`);
    const b = (await c.boundingBox())!;
    const shot = await c.screenshot();
    return imageStats(page, shot, {
      x: Math.round(b.width * fx),
      y: Math.round(b.height * 0.46),
      w: Math.round(b.width * 0.06),
      h: Math.round(b.height * 0.08),
    });
  };
  // Sample left and right of the sticker's centre.
  const plainL = await measure("plain", 0.4);
  const plainR = await measure("plain", 0.54);
  expect(plainL.rgb[0], "plain: red on the left").toBeGreaterThan(plainL.rgb[2] + 40);
  expect(plainR.rgb[2], "plain: blue on the right").toBeGreaterThan(plainR.rgb[0] + 40);
  const crop = await measure("crop", 0.47);
  expect(crop.rgb[0], "cropped to the red half").toBeGreaterThan(crop.rgb[2] + 40);
  for (const fx of [0.4, 0.54]) {
    const g = await measure("grey", fx);
    expect(Math.abs(g.rgb[0] - g.rgb[2]), "grayscale tint").toBeLessThan(12);
  }
  const d = await page.locator("#st-crop").evaluate((el) => (el as unknown as { design: { decals: unknown[] } }).design.decals[0]);
  expect(d).toMatchObject({ crop: { x: 0, y: 0, w: 0.5, h: 1 }, flip: { h: true } });
});
