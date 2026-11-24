/**
 * Card body and typography beyond the standard card: shapes and cutouts, edges, the contactless mark,
 * mark finishes and extra text lines — through the panel, the live card, history, autosave, share
 * links and exports — and `<metal-card fit>` on the example page.
 */
import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { EXAMPLE_PORT } from "../playwright.config.ts";
import { canvasShot, diff, expect, folder, historyLabels, imageStats, openFolder, openStudio, row, settle, showHistory, test } from "./fixtures.ts";

/** Bounding box (fractions of the image) of the pixels with alpha > 8: the card in a transparent export. */
async function alphaBox(page: Page, bytes: Buffer): Promise<{ w: number; h: number; aspect: number }> {
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u]));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let x0 = bmp.width,
      y0 = bmp.height,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < bmp.height; y++)
      for (let x = 0; x < bmp.width; x++)
        if (d[(y * bmp.width + x) * 4 + 3] > 8) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
    const w = x1 - x0 + 1,
      h = y1 - y0 + 1;
    return { w: w / bmp.width, h: h / bmp.height, aspect: w / h };
  }, bytes.toString("base64"));
}

/** The autosaved working design (the built studio has no debug handle; autosave lands ~0.7 s after an edit). */
async function savedDesign(page: Page, settleMs = 1000): Promise<Record<string, unknown>> {
  await page.waitForTimeout(settleMs);
  return page.evaluate(() => JSON.parse(localStorage.getItem("card-studio:autosave") ?? "{}").design ?? {});
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

/** Share of an element screenshot's pixels that differ from the example page's background (#0b0b10). */
async function cardShare(page: Page, c: Locator): Promise<number> {
  const b64 = (await c.screenshot()).toString("base64");
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([buf]));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 11) + Math.abs(d[i + 1] - 11) + Math.abs(d[i + 2] - 16) > 24) n++;
    return n / (d.length / 4);
  }, b64);
}

const seg = (scope: Locator, label: string) => scope.locator("button.c3-seg-btn", { hasText: new RegExp(`^${label}$`) }).first();

async function exportPng(page: Page): Promise<Buffer> {
  const exp = await openFolder(page, "Export");
  const download = page.waitForEvent("download");
  await exp.getByRole("button", { name: /Export image/ }).click();
  return readFile((await (await download).path())!);
}

test("card body: portrait, cutouts, anodised edge and contactless — live, undo, autosave, share link, export", async ({ page, browser }) => {
  // Many rebuilds, an export, a reload and a second browser context on software GL: 40–50 s under load.
  test.slow();
  await openStudio(page);
  const before = await canvasShot(page);
  const body = await openFolder(page, "Card body");
  await seg(body, "Portrait").click();
  await settle(page);
  await body.locator("button.c3-chip", { hasText: "Lanyard slot" }).click();
  await settle(page);
  await body.locator("button.c3-chip", { hasText: "Window" }).click();
  await settle(page);
  await expect(body.locator("button.c3-chip", { hasText: "Window" })).toHaveAttribute("aria-pressed", "true");
  await seg(body, "Anodised").click();
  await row(body, "Chamfer").locator(".tp-ckbv_w").click();
  await row(body, "Mark").locator(".tp-ckbv_w").click();
  await settle(page, 300);

  const design = () => savedDesign(page);
  const d = await design();
  expect(d.shape).toEqual({ orientation: "portrait", cutouts: ["lanyard", "window"] });
  expect(d.edge).toEqual({ finish: "anodized", chamfer: true });
  expect(d.contactless).toEqual({});
  const after = await canvasShot(page);
  expect(await diff(page, before, after), "the live card changed shape").toBeGreaterThan(3);
  // The window is see-through: it shows the page, not metal. It sits at its ISO-clear place on the body
  // (above the number line, centred on the card's width), which on a portrait card is at mid-height,
  // a little right of centre: find it along the middle row.
  const box = (await page.locator("#card-canvas").boundingBox())!;
  const metal = await imageStats(page, after, {
    x: Math.round(box.width * 0.48),
    y: Math.round(box.height * 0.25),
    w: Math.round(box.width * 0.04),
    h: Math.round(box.height * 0.04),
  });
  let seen = 0;
  for (let k = 0; k <= 8; k++) {
    const hole = await imageStats(page, after, {
      x: Math.round(box.width * (0.46 + 0.01 * k)),
      y: Math.round(box.height * 0.48),
      w: Math.round(box.width * 0.02),
      h: Math.round(box.height * 0.04),
    });
    seen = Math.max(seen, Math.abs(hole.mean - metal.mean));
  }
  expect(seen, "the window shows what is behind the card").toBeGreaterThan(25);

  await showHistory(page);
  expect(await historyLabels(page)).toEqual(expect.arrayContaining(["orientation portrait", "window on", "edge anodized", "contactless on"]));

  // Undo walks back through the body edits, redo brings them back.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await settle(page);
  expect((await design()).contactless).toBeUndefined();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await settle(page);
  expect((await design()).contactless).toEqual({});

  // A transparent export of a portrait card is taller than wide.
  const png = await exportPng(page);
  const ab = await alphaBox(page, png);
  expect(ab.aspect).toBeLessThan(0.75);
  expect(ab.h).toBeGreaterThan(0.6);

  // Autosave survives a reload.
  await page.waitForTimeout(900);
  await openStudio(page);
  expect((await design()).shape).toEqual({ orientation: "portrait", cutouts: ["lanyard", "window"] });

  // The share link carries the body to a fresh profile.
  await openFolder(page, "Save & share");
  await folder(page, "Save & share")
    .getByRole("button", { name: /Copy share link/ })
    .click();
  await expect(page).toHaveURL(/#d=/);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const viewer = await ctx.newPage();
  await openStudio(viewer, page.url());
  await openFolder(viewer, "Save & share");
  const saved = viewer.waitForEvent("download");
  await folder(viewer, "Save & share")
    .getByRole("button", { name: /Save design/ })
    .click();
  const shared = JSON.parse(await readFile((await (await saved).path())!, "utf8")) as Record<string, unknown>;
  expect(shared.edge).toEqual({ finish: "anodized", chamfer: true });
  expect(shared.contactless).toEqual({});
  await ctx.close();
});

/** Luma along a horizontal band of an image (rows y ± 3 px averaged), one value per column. */
async function rowLuma(page: Page, bytes: Buffer, yFrac: number): Promise<number[]> {
  return page.evaluate(
    async ({ b64, yFrac }) => {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([u]));
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const y0 = Math.round(bmp.height * yFrac) - 3;
      const d = ctx.getImageData(0, y0, bmp.width, 7).data;
      const out: number[] = [];
      for (let x = 0; x < bmp.width; x++) {
        let s = 0;
        for (let r = 0; r < 7; r++) {
          const i = (r * bmp.width + x) * 4;
          s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        }
        out.push(s / 7);
      }
      return out;
    },
    { b64: bytes.toString("base64"), yFrac },
  );
}

const meanOf = (a: number[], from: number, to: number) => {
  const s = a.slice(Math.max(0, Math.round(from)), Math.round(to) + 1);
  return s.reduce((x, y) => x + y, 0) / s.length;
};

test("cutouts are see-through from the back: the lanyard slot and a portrait card's window", async ({ page }) => {
  await openStudio(page);
  const body = await openFolder(page, "Card body");
  const side = page.locator("#side-toggle");

  /** Cut the hole, find it on the card's middle row from the front, then look for it from the back. */
  const throughBothSides = async (what: string, cut: Locator) => {
    const solid = await rowLuma(page, await canvasShot(page), 0.5);
    await cut.click();
    await settle(page, 300);
    await expect(cut).toHaveAttribute("aria-pressed", "true");
    const front = await rowLuma(page, await canvasShot(page), 0.5);
    const w = front.length;
    const backdrop = meanOf(front, w * 0.02, w * 0.06); // the page beside the card, same row
    const onCard = solid.map((l, x) => (l > backdrop + 50 ? x : -1)).filter((x) => x >= 0);
    const [left, right] = [onCard[0]!, onCard[onCard.length - 1]!];
    const centre = (left + right) / 2;
    // The hole: where cutting it changed the row most (metal → the page behind).
    let hole = -1;
    let most = -Infinity;
    for (let x = left + 3; x <= right - 3; x++) {
      const change = meanOf(solid, x - 3, x + 3) - meanOf(front, x - 3, x + 3);
      if (change > most) [most, hole] = [change, x];
    }
    expect(meanOf(front, hole - 3, hole + 3) - backdrop, `${what}: the hole shows the page from the front (x ${hole} of ${w})`).toBeLessThan(25);

    await side.click();
    await expect(side).toHaveAttribute("data-side", "back");
    await settle(page, 900); // the flip takes 620 ms
    const back = await rowLuma(page, await canvasShot(page), 0.5);
    // Turned about the vertical axis, the hole is mirrored about the card's centre on screen.
    const mirrored = 2 * centre - hole;
    expect(
      meanOf(back, mirrored - 3, mirrored + 3) - backdrop,
      `${what}: from the back, the page shows through the hole where it is (x ${mirrored.toFixed(0)} of ${w})`,
    ).toBeLessThan(25);
    // …and the face away from it is metal (not a hole widened over the whole card).
    const away = mirrored < centre ? (centre + right) / 2 : (left + centre) / 2;
    expect(meanOf(back, away - 3, away + 3) - backdrop, `${what}: the back is metal away from the hole`).toBeGreaterThan(60);
    await side.click();
    await expect(side).toHaveAttribute("data-side", "front");
    await settle(page, 900);
  };

  const lanyard = body.locator("button.c3-chip", { hasText: "Lanyard slot" });
  await throughBothSides("lanyard slot", lanyard);
  await lanyard.click();
  await seg(body, "Portrait").click();
  await settle(page, 300);
  await throughBothSides("portrait window", body.locator("button.c3-chip", { hasText: "Window" }));
});

test("finishes and text lines: emboss, engrave, a card number line, code and glTF export", async ({ page }) => {
  await openStudio(page);
  const NAME = { x: 0.16, y: 0.6, w: 0.34, h: 0.14 };
  const print = await canvasShot(page);
  const identity = await openFolder(page, "Identity");
  const nameRow = identity
    .locator(".c3-row", { hasText: /^Name/ })
    .filter({ has: page.locator(".c3-seg") })
    .first();
  await nameRow.locator("button", { hasText: "Engrave" }).click();
  await settle(page, 200);
  const engraved = await canvasShot(page);
  expect(await regionDiff(page, print, engraved, NAME), "the engraved name looks different from the print").toBeGreaterThan(0.8);
  await nameRow.locator("button", { hasText: "Emboss" }).click();
  await settle(page, 200);
  expect(await diff(page, engraved, await canvasShot(page))).toBeGreaterThan(0.05);

  const lines = await openFolder(page, "Text lines");
  await lines.getByRole("button", { name: "＋ Card number" }).click();
  await settle(page, 200);
  await expect(folder(page, "Text lines").locator(".tp-fldv_t", { hasText: /^Line 1 · •••• 4242/ })).toBeVisible();
  const withLine = await canvasShot(page);
  expect(await diff(page, engraved, withLine)).toBeGreaterThan(0.1);
  const d = await savedDesign(page);
  expect(d.finish).toEqual({ name: "embossed" });
  expect(d.textLines).toEqual([{ text: "•••• 4242", size: 0.9, tracking: 0.12 }]);

  // Code export (Design JSON) carries the new fields.
  const exp = await openFolder(page, "Export");
  await exp.getByRole("button", { name: /Export code/ }).click();
  const dialog = page.locator("dialog[open]");
  await dialog
    .getByRole("tab", { name: "Design JSON" })
    .click()
    .catch(async () => dialog.getByRole("button", { name: "Design JSON" }).click());
  await expect(dialog).toContainText('"textLines"');
  await expect(dialog).toContainText('"finish"');
  await page.keyboard.press("Escape");

  // glTF export still works with finished marks (normal maps) on the card.
  const download = page.waitForEvent("download");
  await exp.getByRole("button", { name: /Export glTF/ }).click();
  const glb = await readFile((await (await download).path())!);
  expect(glb.subarray(0, 4).toString("ascii")).toBe("glTF");
  expect(glb.length).toBeGreaterThan(20_000);
});

test("metal-card fit: contain fills the element, studio keeps the studio camera; card body from the design", async ({ page }) => {
  await page.goto(`http://localhost:${EXAMPLE_PORT}/body.html`);
  // Each in view first: a card only starts near the viewport, and how far down the last one sits
  // depends on the platform's fonts (on Linux it is past the fold).
  const ready = async (sel: string) => {
    await page.locator(sel).scrollIntoViewIfNeeded();
    await expect.poll(() => page.locator(sel).evaluate((el) => (el as unknown as { ready: boolean }).ready), { timeout: 45_000 }).toBe(true);
  };
  for (const sel of ["#contain", "#studio", "#portrait", "#window"]) await ready(sel);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const contain = await cardShare(page, page.locator("#contain"));
  const studio = await cardShare(page, page.locator("#studio"));
  expect(contain, "contain fills more of the box").toBeGreaterThan(studio * 1.5);
  expect(contain, "with a margin").toBeLessThan(0.85);
  const fit = await page.locator("#studio").evaluate((el) => (el as unknown as { fit: string }).fit);
  expect(fit).toBe("studio");
  // Switching the attribute reframes the live card.
  await page.locator("#studio").evaluate((el) => el.setAttribute("fit", "contain"));
  await page.waitForTimeout(400);
  expect(await cardShare(page, page.locator("#studio"))).toBeGreaterThan(studio * 1.5);

  // The portrait card fills its portrait box and keeps its design fields.
  const portrait = await page.locator("#portrait").evaluate((el) => (el as unknown as { design: Record<string, unknown> }).design);
  expect(portrait.shape).toEqual({ orientation: "portrait", cornerRadius: 0.125, cutouts: ["lanyard"] });
  expect(portrait.edge).toEqual({ finish: "metal", color: "#d4af37", chamfer: true });
  // A black card on a dark page: its bright marks (chip, etched name, the gold rim) show it rendered.
  expect((await imageStats(page, await page.locator("#portrait").screenshot())).std).toBeGreaterThan(8);
  expect(await cardShare(page, page.locator("#window")), "the landscape card fills its box").toBeGreaterThan(0.5);
  expect((await imageStats(page, await page.locator("#window").screenshot())).std).toBeGreaterThan(5);
});

test("the contactless mark draws over a sticker placed on it", async ({ page }) => {
  test.slow();
  await openStudio(page);
  // An opaque block sticker centred on the mark's place (right of the ISO chip): 30 % of the card wide.
  const sticker = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    g.fillStyle = "#1d4fd8";
    g.fillRect(0, 0, 64, 64);
    return c.toDataURL("image/png");
  });
  const base = await savedDesign(page, 0);
  const chooser = page.waitForEvent("filechooser");
  await (await openFolder(page, "Save & share")).getByRole("button", { name: /Open design/ }).click();
  await (
    await chooser
  ).setFiles({
    name: "contactless.card.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ ...base, decals: [{ id: "s1", side: "front", src: sticker, aspect: 1, x: 31, y: 44, width: 30, rotation: 0, scale: 1 }] }),
    ),
  });
  await settle(page, 1500);
  const covered = await canvasShot(page);
  const body = await openFolder(page, "Card body");
  await row(body, "Mark").locator(".tp-ckbv_w").click();
  await settle(page, 600);
  const marked = await canvasShot(page);
  if (process.env.C3_SHOTS) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${process.env.C3_SHOTS}/covered.png`, covered);
    await writeFile(`${process.env.C3_SHOTS}/marked.png`, marked);
  }
  // Where the mark is (right of the chip, inside the sticker): it changed the picture, so it is on top.
  expect(await regionDiff(page, covered, marked, { x: 0.32, y: 0.42, w: 0.08, h: 0.1 }), "the mark shows on top of the sticker").toBeGreaterThan(5);
});
