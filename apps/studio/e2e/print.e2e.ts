/**
 * Export → Print files…: the production package. The default card, then a card with an engraved name,
 * a sticker and a lanyard cutout (non-payment, so the dialog asks to confirm the sticker shows no
 * network marks): unzip the package, check its files, the raster sizes and resolution, the masks'
 * registration against the artwork and the dieline, spec.json, and that both PDFs open.
 */
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import { PDFDocument } from "pdf-lib";
import { decodePng, type DecodedPng } from "../src/export/print/png.ts";
import { expect, openFolder, openStudio, test } from "./fixtures.ts";

/** A 64 × 64 red disc on transparent, as a PNG data URL (the sticker). */
async function stickerDataUrl(page: Page): Promise<string> {
  return page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    g.fillStyle = "#d22";
    g.beginPath();
    g.arc(32, 32, 30, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL("image/png");
  });
}

async function openDesign(page: Page, design: Record<string, unknown>): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await (await openFolder(page, "Save & share")).getByRole("button", { name: /Open design/ }).click();
  await (await chooser).setFiles({ name: "print-test.card.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(design)) });
}

async function openPrintDialog(page: Page) {
  await (await openFolder(page, "Export")).getByRole("button", { name: /Print files/ }).click();
  const dialog = page.locator("dialog.c3-print-dialog");
  await expect(dialog).toBeVisible();
  // The preview bake and preflight have run.
  await expect(dialog.locator(".c3-print-issues li").first()).toBeVisible({ timeout: 60_000 });
  return dialog;
}

async function exportPackage(page: Page, dialog: ReturnType<Page["locator"]>): Promise<Record<string, Uint8Array>> {
  const button = dialog.locator('[data-action="export-print"]');
  await expect(button).toBeEnabled({ timeout: 60_000 });
  const download = page.waitForEvent("download", { timeout: 180_000 });
  await button.click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/-print\.zip$/);
  const bytes = await readFile((await d.path())!);
  return unzipSync(new Uint8Array(bytes));
}

const find = (files: Record<string, Uint8Array>, re: RegExp) => Object.keys(files).find((n) => re.test(n));

/** Bounding box of the pixels where `on(i)` holds. */
function box(img: DecodedPng, on: (i: number) => boolean) {
  let x0 = img.width,
    y0 = img.height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (on(y * img.width + x)) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return { x0, y0, x1, y1 };
}

async function checkCommon(files: Record<string, Uint8Array>) {
  const specName = find(files, /\/spec\.json$/)!;
  expect(specName).toBeTruthy();
  const spec = JSON.parse(strFromU8(files[specName]!));
  expect(spec.spec).toBe("card3d-print/1");
  expect(spec.card.standard).toBe("ISO/IEC 7810 ID-1");
  expect(spec.card.trim_mm).toEqual([85.6, 53.98]);
  expect(spec.card.corner_mm).toBeCloseTo(3.18, 2);
  expect(spec.artwork.dpi).toBe(600);
  expect(spec.bleed_mm).toBeCloseTo(3.175, 3);
  // Every file the spec lists is in the zip.
  for (const f of spec.files as string[]) expect(Object.keys(files)).toContain(f);
  const [W, H] = spec.artwork.size_px as [number, number];
  expect(W).toBe(Math.round((85.6 + 2 * 3.175) * (600 / 25.4)));
  expect(H).toBe(Math.round((53.98 + 2 * 3.175) * (600 / 25.4)));
  for (const side of ["front", "back"]) {
    const comp = decodePng(files[find(files, new RegExp(`-${side}-composite\\.png$`))!]!);
    expect([comp.width, comp.height, comp.channels, comp.dpi]).toEqual([W, H, 3, 600]);
    // The cut mask registers with the artwork: the card's material spans exactly the trim box.
    const cut = decodePng(files[find(files, new RegExp(`-${side}-cut\\.png$`))!]!);
    expect([cut.width, cut.height, cut.bits]).toEqual([W, H, 1]);
    const b = box(cut, (i) => cut.data[i] === 0);
    const t = spec.artwork.trim_box_px;
    expect(Math.abs(b.x0 - t.x)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.y0 - t.y)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.x1 + 1 - (t.x + t.width))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.y1 + 1 - (t.y + t.height))).toBeLessThanOrEqual(1.5);
    expect(find(files, new RegExp(`-${side}-dieline\\.svg$`))).toBeTruthy();
    expect(find(files, new RegExp(`proof-${side}\\.png$`))).toBeTruthy();
  }
  // Both PDFs open: the master has a page per side with its trim box; the proof at least three pages.
  const master = await PDFDocument.load(files[find(files, /-print\.pdf$/)!]!);
  expect(master.getPageCount()).toBe(2);
  const trim = master.getPage(0).getTrimBox();
  expect(trim.width).toBeCloseTo((85.6 * 72) / 25.4, 1);
  expect(trim.height).toBeCloseTo((53.98 * 72) / 25.4, 1);
  const proof = await PDFDocument.load(files[find(files, /-proof\.pdf$/)!]!);
  expect(proof.getPageCount()).toBeGreaterThanOrEqual(3);
  expect(find(files, /\/README\.txt$/)).toBeTruthy();
  expect(find(files, /\/fonts\/inter-OFL\.txt$/)).toBeTruthy();
  return { spec, W, H };
}

test.describe.configure({ timeout: 300_000 });

test("print files: the default card", async ({ page }) => {
  await openStudio(page);
  const dialog = await openPrintDialog(page);
  await expect(dialog.locator('select[name="preset"]')).toHaveValue("generic");
  await expect(dialog.locator('input[name="print-mode"][value="non-payment"]')).toBeChecked();
  // Two previews with guides; nothing blocks the default card.
  await expect(dialog.locator(".c3-print-preview canvas")).toHaveCount(2);
  await expect(dialog.locator(".c3-print-issues li[data-blocking]")).toHaveCount(0);
  const files = await exportPackage(page, dialog);
  const { spec } = await checkCommon(files);
  expect(spec.mode).toBe("non-payment");
  expect(spec.features.chip).toBe("contact (unconfirmed)");
  expect(spec.preflight.warnings.some((w: { rule: string }) => w.rule === "non-payment:chip")).toBe(true);
  expect(spec.colour.colours[0].role).toBe("body");
  expect(spec.colour.colours[0].hex).toMatch(/^#[0-9a-f]{6}$/);
  // The surface texture of the default finish is a reference greyscale, not a plate.
  expect(spec.plates.some((p: { name: string }) => p.name === "Cut")).toBe(true);
});

test("print files: engraved name, sticker, lanyard cutout", async ({ page }) => {
  await openStudio(page);
  const sticker = await stickerDataUrl(page);
  const base = await page.evaluate(() => JSON.parse(localStorage.getItem("card-studio:autosave") ?? "{}").design);
  await openDesign(page, {
    ...base,
    cardholderName: "ADA LOVELACE",
    finish: { name: "engraved" },
    shape: { cutouts: ["lanyard"] },
    decals: [{ id: "s1", side: "front", src: sticker, aspect: 1, x: 70, y: 40, width: 14, rotation: 0, scale: 1 }],
  });
  await page.waitForTimeout(1500);
  const dialog = await openPrintDialog(page);
  // A sticker on a non-payment card: the marks confirmation blocks until ticked.
  await expect(dialog.locator('.c3-print-issues li[data-rule="non-payment:marks"][data-blocking]')).toBeVisible();
  await expect(dialog.locator('[data-action="export-print"]')).toBeDisabled();
  await dialog.locator('input[name="no-network-marks"]').check();
  await dialog.locator('input[name="decorative-chip"]').check();
  await expect(dialog.locator(".c3-print-issues li[data-blocking]")).toHaveCount(0, { timeout: 60_000 });
  const files = await exportPackage(page, dialog);
  const { spec, W, H } = await checkCommon(files);
  expect(spec.features.chip).toBe("decorative");
  expect(spec.card.cutouts.map((c: { type: string }) => c.type)).toEqual(["lanyard-slot"]);
  const cutSvg = strFromU8(files[find(files, /-front-cut\.svg$/)!]!);
  expect(cutSvg).toContain('id="cutout-lanyard"');
  // Engrave and colour-fill plates, each a 1-bit PNG and an SVG.
  for (const plate of ["engrave", "colorfill-[0-9a-f]{6}"]) {
    expect(find(files, new RegExp(`-front-${plate}\\.png$`))).toBeTruthy();
    expect(find(files, new RegExp(`-front-${plate}\\.svg$`))).toBeTruthy();
  }
  const engraveName = find(files, /-front-engrave\.png$/)!;
  const engrave = decodePng(files[engraveName]!);
  expect([engrave.width, engrave.height, engrave.bits]).toEqual([W, H, 1]);
  expect(strFromU8(files[find(files, /-front-engrave\.svg$/)!]!)).toMatch(/<path fill="#000" fill-rule="evenodd" d="M/);
  // Registration: the engraved name (black in the mask) is where the artwork shows the engraving's
  // darker floor, and the face around it isn't.
  const comp = decodePng(files[find(files, /-front-composite\.png$/)!]!);
  const lum = (i: number) => 0.2126 * comp.data[i * 3]! + 0.7152 * comp.data[i * 3 + 1]! + 0.0722 * comp.data[i * 3 + 2]!;
  const b = box(engrave, (i) => engrave.data[i] === 0);
  expect(b.x1).toBeGreaterThan(b.x0);
  let face = 0,
    faceN = 0;
  for (let x = b.x0; x <= b.x1; x++)
    for (const y of [b.y0 - 12, b.y1 + 12]) {
      face += lum(y * W + x);
      faceN++;
    }
  face /= faceN;
  let darkIn = 0,
    nIn = 0;
  for (let y = b.y0; y <= b.y1; y++)
    for (let x = b.x0; x <= b.x1; x++) {
      const i = y * W + x;
      if (engrave.data[i] !== 0) continue;
      nIn++;
      if (lum(i) < face - 8) darkIn++;
    }
  expect(darkIn / nIn).toBeGreaterThan(0.6);
  // The sticker is placed where the design puts it (x 70 %, y 40 % of the card) and lands in its layer list.
  const layer = spec.layers.find((l: { kind: string }) => l.kind === "sticker");
  expect(layer).toBeTruthy();
  expect((layer.box_mm.x0 + layer.box_mm.x1) / 2).toBeCloseTo(0.7 * 85.6, 0);
  expect((layer.box_mm.y0 + layer.box_mm.y1) / 2).toBeCloseTo(0.4 * 53.98, 0);
  // …and in the artwork: red there.
  const sx = Math.round(spec.artwork.trim_box_px.x + (0.7 * 85.6 * 600) / 25.4);
  const sy = Math.round(spec.artwork.trim_box_px.y + (0.4 * 53.98 * 600) / 25.4);
  const si = (sy * W + sx) * 3;
  expect(comp.data[si]!).toBeGreaterThan(150);
  expect(comp.data[si + 1]!).toBeLessThan(90);
  // The lanyard slot is filled (bleed into the cutout), not left transparent.
  expect(comp.channels).toBe(3);
  // The text outlines exist for the engraved name.
  expect(strFromU8(files[find(files, /-front-text\.svg$/)!]!)).toContain('data-finish="engraved"');
});
