/**
 * Custom card fonts: an uploaded file, a Google Fonts family (fonts.googleapis.com and
 * fonts.gstatic.com are routed to the fixture: no real network), the fallback to Inter when a font
 * can't be loaded, share links without the uploaded file, and `<metal-card font-url>` on the example
 * page. The fixture is Chakra Petch 700, latin subset (SIL OFL 1.1, apps/embed-example/fonts/OFL.txt).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { EXAMPLE_PORT } from "../playwright.config.ts";
import { canvasShot, expect, historyLabels, openFolder, openStudio, settle, showHistory, test } from "./fixtures.ts";

const EXAMPLE = `http://localhost:${EXAMPLE_PORT}`;
const FIXTURE = fileURLToPath(new URL("../../embed-example/fonts/chakra-petch-700-latin.woff2", import.meta.url));
const FONT_BYTES = readFileSync(FIXTURE);
/** Where the cardholder name sits on the studio's live canvas (fractions). */
const NAME = { x: 0.16, y: 0.6, w: 0.34, h: 0.14 };
const CORS = { "access-control-allow-origin": "*" };

/** Serve Google Fonts from the fixture; returns the CSS2 requests seen. */
async function mockGoogleFonts(page: Page, opts: { cssStatus?: number } = {}): Promise<string[]> {
  const seen: string[] = [];
  await page.route("https://fonts.googleapis.com/**", (route) => {
    seen.push(route.request().url());
    if (opts.cssStatus) return route.fulfill({ status: opts.cssStatus, headers: CORS, contentType: "text/plain", body: "error" });
    return route.fulfill({
      headers: CORS,
      contentType: "text/css",
      body: `/* latin */\n@font-face {\n  font-family: 'Fraunces';\n  font-style: normal;\n  font-weight: 700;\n  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/fixture/v1/latin.woff2) format('woff2');\n  unicode-range: U+0000-00FF, U+0131, U+0152-0153;\n}\n`,
    });
  });
  await page.route("https://fonts.gstatic.com/**", (route) => route.fulfill({ headers: CORS, contentType: "font/woff2", body: FONT_BYTES }));
  return seen;
}

/** The autosaved working design (autosave lands ~0.7 s after an edit). */
async function savedDesign(page: Page): Promise<Record<string, unknown>> {
  await page.waitForTimeout(1000);
  return page.evaluate(() => JSON.parse(localStorage.getItem("card-studio:autosave") ?? "{}").design ?? {});
}

/** Custom faces registered and loaded in the page (`card3d custom …`). */
const loadedCustomFaces = (page: Page) =>
  page.evaluate(() => [...document.fonts].filter((f) => f.family.replace(/"/g, "").startsWith("card3d custom") && f.status === "loaded").length);

/** Mean absolute difference of two same-sized images inside a fractional region, 0..255. */
async function regionDiff(page: Page, a: Buffer, b: Buffer, r = NAME): Promise<number> {
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

async function openCustomFont(page: Page, tab: "Upload" | "Google Fonts" | "URL"): Promise<Locator> {
  const identity = await openFolder(page, "Identity");
  await identity.locator("button.c3-font-more").click();
  const dialog = page.locator("dialog.c3-font-dialog[open]");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: tab }).click();
  return dialog;
}

test("upload a font: validated, previewed, one undo step, kept by autosave, left out of share links", async ({ page, browser, watch }) => {
  // the broken file is refused on purpose (the browser's font sanitiser and the loader say so)
  watch.allow(/OTS parsing error/);
  watch.allow(/the font "broken" \(upload\) could not be loaded/);
  await openStudio(page);
  const before = await canvasShot(page);
  const dialog = await openCustomFont(page, "Upload");
  await expect(dialog.getByText("Only use a font you have the right to use")).toBeVisible();

  // A file that isn't a font is refused, with a reason.
  let chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose font file…" }).click();
  await (await chooser).setFiles({ name: "notes.woff2", mimeType: "font/woff2", buffer: Buffer.from("these are not the glyphs you are looking for") });
  await expect(dialog.locator(".c3-font-status")).toHaveText(/isn't a font file/);
  await expect(dialog.getByRole("button", { name: "Use this font" })).toBeDisabled();
  // So is a file that looks like one but doesn't load.
  chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose font file…" }).click();
  await (await chooser).setFiles({ name: "broken.woff2", mimeType: "font/woff2", buffer: Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(64, 7)]) });
  await expect(dialog.locator(".c3-font-status")).toHaveText(/isn't a font this browser can load/);
  await expect(dialog.getByRole("button", { name: "Use this font" })).toBeDisabled();

  chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose font file…" }).click();
  await (await chooser).setFiles(FIXTURE);
  await expect(dialog.locator(".c3-font-status")).toHaveText(/chakra petch 700 latin · uploaded file/);
  await expect(dialog.locator(".c3-font-preview")).toHaveClass(/is-loaded/);
  await dialog.getByRole("textbox", { name: "Family name" }).fill("Chakra Petch");
  await dialog.getByRole("button", { name: "Use this font" }).click();
  await expect(dialog).toBeHidden();
  await settle(page, 200);

  const font = (await savedDesign(page)).font as { source: string; family: string; src: string };
  expect(font.source).toBe("upload");
  expect(font.family).toBe("Chakra Petch");
  expect(font.src.startsWith("data:font/woff2;base64,d09GMg")).toBe(true);
  expect(await loadedCustomFaces(page)).toBeGreaterThan(0);
  const identity = await openFolder(page, "Identity");
  await expect(identity.locator("button.c3-font-more")).toHaveAttribute("aria-checked", "true");
  await expect(identity.locator(".c3-font-custom-text")).toHaveText(/Chakra Petch · Uploaded/);
  const uploaded = await canvasShot(page);
  expect(await regionDiff(page, before, uploaded), "the name is drawn in the uploaded font").toBeGreaterThan(0.8);

  // One undo step, and redo brings it back.
  await showHistory(page);
  expect(await historyLabels(page)).toContain("font Chakra Petch");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await settle(page);
  expect((await savedDesign(page)).font).toBeUndefined();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await settle(page);
  expect(((await savedDesign(page)).font as { family: string }).family).toBe("Chakra Petch");

  // Engraved, the custom face still cuts into the metal.
  const nameRow = identity
    .locator(".c3-row", { hasText: /^Name/ })
    .filter({ has: page.locator(".c3-seg") })
    .first();
  await nameRow.locator("button", { hasText: "Engrave" }).click();
  await settle(page, 200);
  expect(await regionDiff(page, uploaded, await canvasShot(page)), "engraving changes the custom-font name").toBeGreaterThan(0.5);

  // A share link names the font but can't carry the file: the recipient sees Inter, a note and a way to add it.
  await openFolder(page, "Save & share");
  await page.getByRole("button", { name: /Copy share link/ }).click();
  await expect(page.locator(".c3-toast")).toContainText("the uploaded font “Chakra Petch”");
  await expect(page).toHaveURL(/#d=/);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const viewer = await ctx.newPage();
  const problems: string[] = [];
  viewer.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await openStudio(viewer, page.url());
  await expect(viewer.locator(".c3-toast")).toContainText("an uploaded font whose file isn't included");
  const viewerIdentity = await openFolder(viewer, "Identity");
  await expect(viewerIdentity.locator(".c3-font-custom-text")).toHaveText(
    /“Chakra Petch” is an uploaded font whose file isn't in this design .* showing Inter/,
  );
  await expect(viewerIdentity.locator(".c3-font-custom")).toHaveClass(/is-warn/);
  // …and supplying the file brings the font back.
  await viewerIdentity.getByRole("button", { name: "Add the font file…" }).click();
  const vDialog = viewer.locator("dialog.c3-font-dialog[open]");
  await expect(vDialog.getByRole("tab", { name: "Upload" })).toHaveAttribute("aria-selected", "true");
  await expect(vDialog.getByRole("textbox", { name: "Family name" })).toHaveValue("Chakra Petch");
  const vChooser = viewer.waitForEvent("filechooser");
  await vDialog.getByRole("button", { name: "Choose font file…" }).click();
  await (await vChooser).setFiles(FIXTURE);
  await vDialog.getByRole("button", { name: "Use this font" }).click();
  await settle(viewer, 200);
  await expect(viewerIdentity.locator(".c3-font-custom-text")).toHaveText(/Chakra Petch · Uploaded/);
  expect(await loadedCustomFaces(viewer)).toBeGreaterThan(0);
  expect(problems).toEqual([]);
  await ctx.close();
});

test("a Google Fonts family by name, fetched through the CSS2 API only when used", async ({ page }) => {
  const requests = await mockGoogleFonts(page);
  await openStudio(page);
  expect(requests, "nothing is requested before a design uses the font").toEqual([]);
  const before = await canvasShot(page);
  const dialog = await openCustomFont(page, "Google Fonts");
  await expect(dialog.getByText("Only use a font you have the right to use")).toBeHidden();
  const family = dialog.getByRole("textbox", { name: "Google Fonts family" });
  await family.fill("Fraunces&family=Evil");
  await expect(dialog.locator(".c3-font-status")).toHaveText(/letters, digits and spaces only/);
  expect(requests).toEqual([]);
  await family.fill("Fraunces");
  await dialog.getByRole("combobox", { name: "Weight" }).selectOption("600");
  await expect(dialog.locator(".c3-font-status")).toHaveText("Fraunces · Google Fonts · 600");
  expect(requests.at(-1)).toBe("https://fonts.googleapis.com/css2?family=Fraunces:wght@600&display=swap");
  await dialog.getByRole("button", { name: "Use this font" }).click();
  await settle(page, 200);
  expect((await savedDesign(page)).font).toEqual({ source: "google", family: "Fraunces", weight: 600 });
  expect(await regionDiff(page, before, await canvasShot(page)), "the name is drawn in the Google font").toBeGreaterThan(0.8);
  const identity = await openFolder(page, "Identity");
  await expect(identity.locator(".c3-font-custom-text")).toHaveText("Fraunces · Google Fonts · 600");

  // Back to a built-in font in one click.
  await identity.locator("button.c3-font", { hasText: "Manrope" }).click();
  await settle(page);
  expect((await savedDesign(page)).font).toBe("manrope");
});

test("a font that can't be loaded falls back to Inter with a warning", async ({ page, watch }) => {
  watch.allow(/could not be loaded/);
  watch.allow(/HTTP 4\d\d: https:\/\/fonts\.googleapis\.com/);
  watch.allow(/Failed to load resource: the server responded with a status of 400/);
  await mockGoogleFonts(page, { cssStatus: 400 });
  await openStudio(page);
  const dialog = await openCustomFont(page, "Google Fonts");
  await dialog.getByRole("textbox", { name: "Google Fonts family" }).fill("Not A Real Family");
  await expect(dialog.locator(".c3-font-status")).toHaveText(/Couldn't load Not A Real Family: no such Google Fonts family/);
  await expect(dialog.getByRole("button", { name: "Use this font" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // The same font from a design file (or a link): the card is drawn with Inter and the studio says why.
  await openFolder(page, "Save & share");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /Open design/ }).click();
  await (
    await chooser
  ).setFiles({
    name: "font.card.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        recipe: {},
        cardholderName: "Ada Lovelace",
        cardholderBio: "Member since 1843",
        font: { source: "google", family: "Not A Real Family" },
      }),
    ),
  });
  await settle(page, 300);
  await expect(page.locator(".c3-toast")).toContainText("Couldn't load the font “Not A Real Family”");
  await expect(page.locator(".c3-toast")).toContainText("uses Inter");
  const identity = await openFolder(page, "Identity");
  await expect(identity.locator(".c3-font-custom-text")).toHaveText(/Couldn't load .* showing Inter/);
  expect(await loadedCustomFaces(page)).toBe(0);
  expect(await page.evaluate(() => document.fonts.check('700 100px "card3d Inter"', "ADA"))).toBe(true);
});

test("<metal-card font-url> renders a web font served next to the page; google: and bad URLs too", async ({ page, watch }) => {
  watch.allow(/could not be loaded/);
  watch.allow(/HTTP 404: .*missing\.woff2/);
  watch.allow(/Failed to load resource: the server responded with a status of 404/);
  const google = await mockGoogleFonts(page);
  const fontRequests: number[] = [];
  page.on("response", (r) => r.url().endsWith("/fonts/chakra-petch-700-latin.woff2") && fontRequests.push(r.status()));
  await page.goto(`${EXAMPLE}/fonts.html`);
  const urlCard = page.locator("#url-font");
  await expect.poll(() => urlCard.evaluate((el) => (el as unknown as { ready: boolean }).ready), { timeout: 45_000 }).toBe(true);
  expect(fontRequests).toEqual([200]);
  const design = await urlCard.evaluate((el) => (el as unknown as { design: unknown }).design);
  expect((design as { font: unknown }).font).toEqual({ source: "url", family: "Chakra Petch", src: "fonts/chakra-petch-700-latin.woff2" });
  const googleCard = page.locator("#google-font");
  await expect.poll(() => googleCard.evaluate((el) => (el as unknown as { ready: boolean }).ready), { timeout: 45_000 }).toBe(true);
  expect(google).toEqual(["https://fonts.googleapis.com/css2?family=Fraunces:wght@600&display=swap"]);
  expect(await loadedCustomFaces(page)).toBe(2);

  // A URL that 404s: the card still renders (in Inter) and the element reports it.
  const error = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const el = document.createElement("metal-card");
        el.setAttribute("name", "Ada Lovelace");
        el.setAttribute("font", "Missing Sans");
        el.setAttribute("font-url", "fonts/missing.woff2");
        el.setAttribute("lazy", "false");
        el.style.width = "300px";
        el.addEventListener("metal-card-error", (e) => resolve((e as CustomEvent<{ message: string }>).detail.message));
        document.querySelector("main")!.append(el);
      }),
  );
  expect(error).toMatch(/font "Missing Sans" \(url\): HTTP 404; showing the default font/);

  // URLs that aren't allowed are ignored (reported), never fetched.
  const ignored = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const el = document.createElement("metal-card");
        el.setAttribute("font-url", "javascript:alert(1)");
        el.addEventListener("metal-card-error", (e) => resolve((e as CustomEvent<{ message: string }>).detail.message));
        document.querySelector("main")!.append(el);
      }),
  );
  expect(ignored).toBe('ignored font-url="javascript:alert(1)"');
  watch.allow(/ignored font-url/);
});
