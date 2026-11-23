import { readFile } from "node:fs/promises";
import {
  cardCentre,
  canvasShot,
  contextLosses,
  diff,
  expect,
  folder,
  folderTitle,
  historyLabels,
  imageStats,
  openFolder,
  openStudio,
  row,
  settle,
  showHistory,
  test,
} from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

const presetTile = (page: Page, id: string) => page.locator(`.c3-tile[data-preset="${id}"]`);

async function applyPreset(page: Page, category: string, id: string): Promise<void> {
  await page.locator(`.c3-tabs-chips .c3-chip[data-value="${category}"]`).click();
  await presetTile(page, id).click();
  await expect(presetTile(page, id)).toHaveClass(/is-on/);
  await settle(page);
}

const checkbox = (r: Locator) => r.locator("input[type=checkbox]");
async function setCheckbox(r: Locator, on: boolean): Promise<void> {
  if ((await checkbox(r).isChecked()) !== on) await r.locator("label").first().click();
  await expect(checkbox(r)).toBeChecked({ checked: on });
}

/** Commit a Tweakpane text / number field. */
async function setText(r: Locator, value: string): Promise<void> {
  const input = r.locator("input.tp-txtv_i").first();
  await input.fill(value);
  await input.press("Enter");
}

/** Replace the shader editor's whole document by typing (CodeMirror keeps its own undo history). */
async function replaceCode(page: Page, code: string): Promise<void> {
  const cm = page.locator(".c3-drawer .cm-content");
  await cm.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(code);
}

const SOLID_RED = `// e2e: solid red face
fn mainImage(uv: vec2f) -> vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
`;

async function addCustomShader(page: Page): Promise<void> {
  await openFolder(page, "Shaders");
  await page.locator("#panel .c3-mini--add", { hasText: "Add shader layer" }).click();
  const picker = page.locator(".c3-picker[open]");
  await picker.locator(".c3-shp", { has: page.locator(".c3-shp-name", { hasText: /^Blank custom shader$/ }) }).click();
  await expect(page.locator(".c3-drawer .cm-content")).toBeVisible();
  await settle(page);
}

test("boots with public assets: card rendered, no local-pack requests", async ({ page }) => {
  await openStudio(page);
  await expect(page).toHaveTitle(/Card Studio/);
  const shot = await imageStats(page, await canvasShot(page));
  expect(shot.std, "the canvas shows a card, not a flat background").toBeGreaterThan(8);
  expect(shot.colours).toBeGreaterThan(40);
  // the default card is light silver: its face is much brighter than the dark backdrop
  expect((await cardCentre(page)).mean).toBeGreaterThan(120);
});

test("presets apply, across categories", async ({ page }) => {
  await openStudio(page);
  const before = await canvasShot(page);
  await applyPreset(page, "dark", "hero-black");
  expect((await cardCentre(page)).mean, "a black card").toBeLessThan(60);
  await applyPreset(page, "effects", "sunset-mesh");
  const after = await canvasShot(page);
  expect(await diff(page, before, after)).toBeGreaterThan(4);
  const c = await cardCentre(page);
  expect(c.colours, "a gradient, not a flat metal").toBeGreaterThan(6);
  await showHistory(page);
  expect(await historyLabels(page)).toEqual(expect.arrayContaining(["Hero Black Nickel", "Sunset Mesh Gradient"]));
});

test("adds a built-in shader layer", async ({ page }) => {
  await openStudio(page);
  const before = await canvasShot(page);
  await openFolder(page, "Shaders");
  await page.locator("#panel .c3-mini--add", { hasText: "Add shader layer" }).click();
  const picker = page.locator(".c3-picker[open]");
  expect(await picker.locator(".c3-shp").count(), "built-ins and starters").toBeGreaterThan(10);
  await picker.locator(".c3-shp", { has: page.locator(".c3-shp-name", { hasText: /^Halftone$/ }) }).click();
  await expect(picker).toHaveCount(0);
  await settle(page);
  await expect(page.locator(".c3-layer-name").first()).toHaveText(/^1\. Halftone/);
  await expect(folderTitle(page, "Shaders")).toHaveText(/1 layer/);
  expect(await diff(page, before, await canvasShot(page))).toBeGreaterThan(2);
});

test("custom shader: a compile error is reported with its line, the fix applies", async ({ page }) => {
  await openStudio(page);
  await addCustomShader(page);
  const pill = page.locator(".c3-drawer .c3-status-pill");
  await expect(pill).toHaveText(/Running/);

  await replaceCode(page, `fn mainImage(uv: vec2f) -> vec4f {\n  let broken = undefinedThing * 2.0;\n  return vec4f(1.0);\n}\n`);
  const err = page.locator(".c3-errlist .c3-err").first();
  await expect(err).toBeVisible();
  await expect(err.locator(".c3-err-line")).toHaveText("Line 2");
  await expect(err.locator(".c3-err-msg")).toContainText("undefinedThing");
  await expect(pill).not.toHaveText(/Running/);

  await replaceCode(page, SOLID_RED);
  await expect(page.locator(".c3-errlist .c3-err")).toHaveCount(0);
  await expect(pill).toHaveText(/Running/);
  await page.locator(".c3-drawer [aria-label='Close the shader editor']").click();
  await settle(page, 300);
  const [r, g, b] = (await cardCentre(page)).rgb;
  expect(r, "the face is red").toBeGreaterThan(g + 40);
  expect(r).toBeGreaterThan(b + 40);
});

test("a GLSL custom layer is skipped with a hint, and rewriting it in WGSL runs it", async ({ page }) => {
  await openStudio(page);
  // A design saved before custom shaders became WGSL: its layer is GLSL (no language).
  await page.evaluate(() => {
    const code = "// old GLSL\nvec4 mainImage(vec2 uv) {\n  return vec4(1.0, 0.0, 0.0, 1.0);\n}\n";
    const design = { shaders: [{ id: "custom", side: "front", target: "skin", code }] };
    localStorage.setItem("card-studio:autosave", JSON.stringify({ savedAt: Date.now(), design }));
  });
  await openStudio(page);
  await expect(page.locator(".c3-toast", { hasText: "in GLSL" })).toBeVisible();
  const skipped = await cardCentre(page);
  expect(skipped.rgb[0], "the GLSL layer doesn't draw").toBeLessThan(skipped.rgb[1] + 40);
  await openFolder(page, "Shaders");
  await expect(page.locator(".c3-layer-warn").first()).toHaveAttribute("title", /GLSL.*Rewrite it in WGSL/);

  await page.locator(".c3-layer-main").first().dblclick();
  const pill = page.locator(".c3-drawer .c3-status-pill");
  await expect(pill).toHaveText(/GLSL · skipped/);
  await expect(page.locator(".c3-errlist .c3-err").first()).toContainText("Rewrite it in WGSL");

  await replaceCode(page, SOLID_RED);
  await expect(pill).toHaveText(/Running/);
  await expect(page.locator(".c3-errlist .c3-err")).toHaveCount(0);
  await page.locator(".c3-drawer [aria-label='Close the shader editor']").click();
  await settle(page, 300);
  const [r, g] = (await cardCentre(page)).rgb;
  expect(r, "rewritten in WGSL: red").toBeGreaterThan(g + 40);
  const saved = await page.evaluate(
    () => new Promise<unknown>((r) => setTimeout(() => r(JSON.parse(localStorage.getItem("card-studio:autosave")!).design.shaders[0]), 900)),
  );
  expect(saved).toMatchObject({ id: "custom", language: "wgsl" });
  await expect(page.locator(".c3-layer-warn")).toHaveCount(0);
});

test("effects: shine, vines frozen", async ({ page }) => {
  await openStudio(page);
  const fx = await openFolder(page, "Effects");

  await setCheckbox(row(fx, "Shine"), true);
  await settle(page);
  await expect(folderTitle(page, "Effects")).toHaveText("Effects · Shine");

  await setCheckbox(row(fx, "Shine"), false);
  await setCheckbox(row(fx, "Vines"), true);
  await settle(page);
  await expect(folderTitle(page, "Effects")).toHaveText("Effects · Vines");
  // freeze the grow / wither cycle fully grown at 30 s: the card then holds still between frames
  // optional param: an enable toggle, then its (unlabelled) value row
  const frozen = row(fx, "Frozen at (s)");
  await setCheckbox(frozen, true);
  await setText(frozen.locator("xpath=following-sibling::div[contains(@class,'tp-lblv')][1]"), "30");
  await settle(page, 600);
  const a = await canvasShot(page);
  await page.waitForTimeout(700);
  const b = await canvasShot(page);
  expect(await diff(page, a, b), "frozen vines don't move").toBeLessThan(0.5);
  expect((await imageStats(page, b)).colours).toBeGreaterThan(80);

  await showHistory(page);
  expect(await historyLabels(page)).toEqual(expect.arrayContaining(["add shine", "remove shine", "add vines"]));
});

test("undo and redo", async ({ page }) => {
  await openStudio(page);
  const name = row(await openFolder(page, "Identity"), "Name").locator("input");
  await expect(name).toHaveValue("Ada Lovelace");
  await name.fill("Grace Hopper");
  await name.press("Enter");
  await settle(page);
  await applyPreset(page, "dark", "hero-black");

  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  await undo.click();
  await settle(page);
  expect((await cardCentre(page)).mean, "back to the light card").toBeGreaterThan(120);
  await undo.click();
  await settle(page);
  await expect(name).toHaveValue("Ada Lovelace");

  await redo.click();
  await settle(page);
  await expect(name).toHaveValue("Grace Hopper");
  // keyboard redo works outside text fields
  await page.locator("#card-canvas").hover();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await settle(page);
  expect((await cardCentre(page)).mean, "the black preset again").toBeLessThan(60);
});

test("share link round-trip pauses custom code until the viewer runs it", async ({ page, browser }) => {
  await openStudio(page);
  const name = row(await openFolder(page, "Identity"), "Name").locator("input");
  await name.fill("Shared Card");
  await name.press("Enter");
  await addCustomShader(page);
  await replaceCode(page, SOLID_RED);
  await expect(page.locator(".c3-drawer .c3-status-pill")).toHaveText(/Running/);
  await page.locator(".c3-drawer [aria-label='Close the shader editor']").click();
  await settle(page);

  await openFolder(page, "Save & share");
  await folder(page, "Save & share")
    .getByRole("button", { name: /Copy share link/ })
    .click();
  await expect(page).toHaveURL(/#d=/);
  const link = page.url();

  // a different viewer: fresh browser storage
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const viewer = await ctx.newPage();
  const errors: string[] = [];
  viewer.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  viewer.on("pageerror", (e) => errors.push(e.message));
  await openStudio(viewer, link);
  await expect(row(await openFolder(viewer, "Identity"), "Name").locator("input")).toHaveValue("Shared Card");
  const banner = viewer.locator(".c3-banner");
  await expect(banner).toContainText("This design contains custom shader code");
  await openFolder(viewer, "Shaders");
  const layerOn = viewer.locator(".c3-layer-on").first();
  await expect(layerOn).not.toBeChecked();
  const paused = await cardCentre(viewer);
  expect(paused.rgb[0], "paused: not red yet").toBeLessThan(paused.rgb[1] + 40);

  await banner.getByRole("button", { name: "Run it" }).click();
  await expect(banner).toHaveCount(0);
  await expect(layerOn).toBeChecked();
  await settle(viewer, 300);
  const [r, g] = (await cardCentre(viewer)).rgb;
  expect(r, "running: red").toBeGreaterThan(g + 40);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("PNG export has the requested size and real content", async ({ page }) => {
  await openStudio(page);
  const exp = await openFolder(page, "Export");
  await row(exp, "Size").locator("select").selectOption({ label: "Custom…" });
  await setText(row(exp, "Width"), "640");
  await setText(row(exp, "Height"), "400");
  const download = page.waitForEvent("download");
  await exp.getByRole("button", { name: /Export image/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/-640x400\.png$/);
  const bytes = await readFile((await file.path())!);
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([640, 400]);
  const s = await imageStats(page, bytes);
  expect(s.coverage, "transparent background, the card covers a good part of the frame").toBeGreaterThan(0.25);
  expect(s.coverage).toBeLessThan(0.98);
  expect(s.std).toBeGreaterThan(5);
  expect(s.colours).toBeGreaterThan(30);
});

test("no WebGL context loss over a 15 s animated run", async ({ page }) => {
  test.setTimeout(90_000);
  await openStudio(page);
  await applyPreset(page, "effects", "gold-shine");
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number };
    w.__frames = 0;
    const tick = () => {
      w.__frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const first = await canvasShot(page);
  await page.waitForTimeout(15_000);
  const last = await canvasShot(page);
  expect(await contextLosses(page)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __frames: number }).__frames), "the page kept animating").toBeGreaterThan(60);
  expect(await diff(page, first, last), "the shine moved").toBeGreaterThan(0.2);
  expect((await imageStats(page, last)).std).toBeGreaterThan(8);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test("boots at 390 px", async ({ page }) => {
    await openStudio(page);
    const s = await imageStats(page, await canvasShot(page));
    expect(s.std).toBeGreaterThan(8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal scroll").toBe(true);
  });
});
