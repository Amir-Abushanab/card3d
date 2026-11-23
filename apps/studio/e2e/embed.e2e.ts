/**
 * The embeds: `<metal-card>` from the built CDN bundle on the example pages (apps/embed-example,
 * served CDN-style on EXAMPLE_PORT), and the studio's Embed dialog whose snippet renders there.
 */
import type { Locator, Page } from "@playwright/test";
import { EXAMPLE_PORT } from "../playwright.config.ts";
import { contextLosses, expect, imageStats, openFolder, openStudio, test, type ImageStats } from "./fixtures.ts";

const EXAMPLE = `http://localhost:${EXAMPLE_PORT}`;

interface CardProbe {
  ready: boolean;
  stage: unknown;
  design: { cardholderName: string; recipe: { material: string } } | null;
}
interface MetalCardClass {
  maxContexts: number;
  liveContexts: number;
}

/** Count the WebGL contexts the page holds: created, minus lost (each released context is lost). */
async function countContexts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __gl: { live: number; peak: number } };
    w.__gl = { live: 0, peak: 0 };
    const orig = HTMLCanvasElement.prototype.getContext;
    const seen = new WeakSet<object>();
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      const ctx = (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      if (ctx && /webgl/.test(type) && !seen.has(ctx as object)) {
        seen.add(ctx as object);
        w.__gl.live++;
        w.__gl.peak = Math.max(w.__gl.peak, w.__gl.live);
        // A context counts until it is lost: at loseContext() (synchronous; the event comes later) or
        // at the event for a loss the page didn't ask for.
        let lost = false;
        const drop = () => {
          if (!lost) w.__gl.live--;
          lost = true;
        };
        this.addEventListener("webglcontextlost", drop, { once: true });
        const gl = ctx as WebGLRenderingContext;
        const getExtension = gl.getExtension.bind(gl);
        gl.getExtension = ((name: string) => {
          const ext = getExtension(name);
          if (name === "WEBGL_lose_context" && ext && !(ext as { __wrapped?: boolean }).__wrapped) {
            const lose = (ext as WEBGL_lose_context).loseContext.bind(ext);
            (ext as WEBGL_lose_context).loseContext = () => {
              drop();
              lose();
            };
            (ext as { __wrapped?: boolean }).__wrapped = true;
          }
          return ext;
        }) as typeof gl.getExtension;
      }
      return ctx;
    } as typeof orig;
  });
}
/** Share of an element screenshot's pixels that differ from the page background (#0b0b10): the card. */
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

const glCount = (page: Page) => page.evaluate(() => (window as unknown as { __gl: { live: number; peak: number } }).__gl);

const card = (page: Page, selector: string) => page.locator(selector);
const probe = (c: Locator) => c.evaluate((el) => ({ ready: (el as unknown as CardProbe).ready, live: !!(el as unknown as CardProbe).stage }));
const waitReady = (c: Locator) => expect.poll(async () => (await probe(c)).ready, { timeout: 45_000 }).toBe(true);
const shot = async (page: Page, c: Locator): Promise<ImageStats> => imageStats(page, await c.screenshot());

test("example page: three cards from the CDN bundle (share link, JSON, attributes) render", async ({ page }) => {
  const fonts: string[] = [];
  page.on("request", (r) => r.url().endsWith(".woff2") && fonts.push(new URL(r.url()).pathname));
  await countContexts(page);
  await page.goto(`${EXAMPLE}/`);
  for (const id of ["#hero", "#json", "#attrs"]) await waitReady(card(page, id));

  // A non-blank canvas: the card is there, with structure and colour.
  const hero = await shot(page, card(page, "#hero"));
  expect(hero.std).toBeGreaterThan(10);
  expect(hero.colours).toBeGreaterThan(40);
  const json = await shot(page, card(page, "#json"));
  const share = await cardShare(page, card(page, "#json"));
  expect(share, "the card covers a good part of the element").toBeGreaterThan(0.25);
  expect(share, "the canvas is transparent around it").toBeLessThan(0.8);
  expect(json.rgb[0], "brass is warm").toBeGreaterThan(json.rgb[2] + 15);
  expect((await shot(page, card(page, "#attrs"))).std).toBeGreaterThan(5);

  // Each card got its design from its own source.
  const designs = await page.evaluate(() =>
    ["#hero", "#json", "#attrs"].map((s) => {
      const d = (document.querySelector(s) as unknown as CardProbe).design!;
      return [d.cardholderName, d.recipe.material];
    }),
  );
  expect(designs).toEqual([
    ["Grace Hopper", "brass"],
    ["Ada Lovelace", "brass"],
    ["Katherine Johnson", "titanium"],
  ]);
  await expect(card(page, "#hero")).toHaveAttribute("aria-label", "Grace Hopper, 3D metal card; showing front");
  await expect(card(page, "#attrs")).toHaveAttribute("aria-label", /^Titanium card, turning slowly; /);
  await expect(card(page, "#attrs")).toHaveAttribute("role", "button");

  // The fonts come from next to the bundle, only the faces in use.
  expect(fonts.length).toBeGreaterThan(0);
  for (const f of fonts) expect(f).toMatch(/^\/npm\/@card3d\/element\/dist\/standalone\/fonts\/(space-grotesk|playfair|unbounded|inter)-/);

  // Lazy: the grid below the fold has no context yet.
  const grid = page.locator("#presets metal-card");
  await expect(grid).toHaveCount(6);
  for (const c of await grid.all()) expect(await probe(c)).toEqual({ ready: false, live: false });
  expect(await page.evaluate(() => (customElements.get("metal-card") as unknown as MetalCardClass).liveContexts)).toBe(3);
  expect((await glCount(page)).live).toBe(3);

  // Scrolled into view, they start.
  await page.locator("#presets").scrollIntoViewIfNeeded();
  for (const c of await grid.all()) await waitReady(c);
  const box = (await grid.nth(4).boundingBox())!; // sunset-mesh: a gradient mesh shader
  const s = await imageStats(page, await grid.nth(4).screenshot(), {
    x: Math.round(box.width * 0.35),
    y: Math.round(box.height * 0.35),
    w: Math.round(box.width * 0.3),
    h: Math.round(box.height * 0.3),
  });
  const [r, g, b] = s.rgb;
  expect(Math.max(r, g, b) - Math.min(r, g, b), "the effect preset kept its shader").toBeGreaterThan(20);
  expect(await contextLosses(page)).toBe(0);
});

test("example page: drag flips, the turntable spins, reduced motion holds it still", async ({ page }) => {
  await page.goto(`${EXAMPLE}/`);
  const hero = card(page, "#hero");
  const attrs = card(page, "#attrs");
  await waitReady(hero);
  await waitReady(attrs);

  // drag mode: click flips, keyboard Escape resets
  await hero.click();
  await expect(hero).toHaveAttribute("aria-label", /showing back$/);
  await hero.press("Escape");
  await expect(hero).toHaveAttribute("aria-label", /showing front$/);

  // auto-rotate: the turntable card moves between two frames
  const a = await attrs.screenshot();
  await page.waitForTimeout(700);
  const b = await attrs.screenshot();
  expect(a.equals(b), "auto-rotate turns the card").toBe(false);

  // prefers-reduced-motion: no auto-rotation
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(300);
  const c = await attrs.screenshot();
  await page.waitForTimeout(700);
  expect(c.equals(await attrs.screenshot()), "still under reduced motion").toBe(true);
});

test("many cards: the context pool parks off-screen cards and never exceeds its limit", async ({ page }) => {
  await countContexts(page);
  await page.goto(`${EXAMPLE}/`);
  for (const id of ["#hero", "#json", "#attrs"]) await waitReady(card(page, id));
  await page.evaluate(() => ((customElements.get("metal-card") as unknown as MetalCardClass).maxContexts = 4));

  // Six cards come into view with room for four: the three above the fold are parked (their last
  // frame stays as a still), four grid cards start, two wait.
  await page.locator("#presets").scrollIntoViewIfNeeded();
  const grid = page.locator("#presets metal-card");
  await expect.poll(async () => (await Promise.all((await grid.all()).map(probe))).filter((p) => p.ready).length, { timeout: 45_000 }).toBe(4);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (customElements.get("metal-card") as unknown as MetalCardClass).liveContexts)).toBe(4);
  const gl = await glCount(page);
  expect(gl.live, "released contexts are lost at once, not left to the GC").toBe(4);
  expect(gl.peak).toBeLessThanOrEqual(4);
  for (const id of ["#hero", "#json", "#attrs"]) {
    expect(await probe(card(page, id))).toEqual({ ready: false, live: false });
    expect(await card(page, id).evaluate((el) => !!el.shadowRoot!.querySelector("canvas.still")), `${id} keeps a still frame`).toBe(true);
  }

  // Back up: the parked cards take contexts again and rebuild.
  await page.evaluate(() => scrollTo(0, 0));
  for (const id of ["#hero", "#json", "#attrs"]) await waitReady(card(page, id));
  expect((await shot(page, card(page, "#json"))).std).toBeGreaterThan(10);
  expect((await glCount(page)).peak).toBeLessThanOrEqual(4);

  // Removing a card releases its context.
  const before = (await glCount(page)).live;
  await card(page, "#json").evaluate((el) => el.remove());
  await expect.poll(async () => (await glCount(page)).live).toBe(before - 1);
});

test("example page: the classic-script (IIFE) build", async ({ page }) => {
  await page.goto(`${EXAMPLE}/iife.html`);
  const c = card(page, "#card");
  await waitReady(c);
  const s = await shot(page, c);
  expect(s.std).toBeGreaterThan(10);
  expect(await page.evaluate(() => document.fonts.check('700 40px "card3d Manrope"', "HEDY LAMARR"))).toBe(true);
  expect(await page.evaluate(() => typeof (window as unknown as { MetalCard?: { MetalCardElement?: unknown } }).MetalCard?.MetalCardElement)).toBe("function");
});

test("studio: Embed gives CDN, npm and React snippets that carry the design", async ({ page }) => {
  await openStudio(page);
  const exp = await openFolder(page, "Export");
  await exp.getByRole("button", { name: /Embed/ }).click();
  const dialog = page.getByRole("dialog", { name: "Embed" });
  await expect(dialog).toBeVisible();
  const code = dialog.getByLabel("Embed snippet");
  await expect(code).toContainText('<script type="module" src="https://cdn.jsdelivr.net/npm/@card3d/element@');
  await expect(code).toContainText("<metal-card");
  const cdn = (await code.textContent())!;
  const design = cdn.match(/design='([^']*)'/)![1];

  await dialog.getByRole("tab", { name: "npm · <metal-card>" }).click();
  await expect(code).toContainText('import "@card3d/element";');
  await expect(code).toContainText("card.design = {");
  await dialog.getByRole("tab", { name: "React" }).click();
  await expect(code).toContainText('import { MetalCard } from "@card3d/react";');
  await dialog.getByLabel(/Compact/).check();
  await expect(code).toContainText(/<MetalCard share="[A-Za-z0-9_-]+"/);
  await dialog.getByRole("tab", { name: "HTML · CDN" }).click();
  const compact = (await code.textContent())!.match(/share="([A-Za-z0-9_-]+)"/)![1];
  await page.screenshot({ path: test.info().outputPath("embed-dialog.png") });

  // Both forms render the studio's card on a page with the built element.
  await page.goto(`${EXAMPLE}/`);
  await page.evaluate(
    ({ design, compact }) => {
      const html = (attr: string) => `<metal-card class="from-studio" lazy="false" ${attr} style="width:400px"></metal-card>`;
      document.querySelector("main")!.insertAdjacentHTML("afterbegin", html(`design='${design}'`) + html(`share="${compact}"`));
    },
    { design, compact },
  );
  for (const c of await page.locator(".from-studio").all()) {
    await waitReady(c);
    const d = await c.evaluate((el) => (el as unknown as CardProbe).design!);
    expect(d.cardholderName).toBe("Ada Lovelace");
    expect((await shot(page, c)).std).toBeGreaterThan(10);
  }
});

/** Any JS chunk of the bundle: it draws every design itself; only the marquee and the AR export's page side are chunks. */
const FEATURE_CHUNK = /^metal-card-/;

test("CDN bundle: a plain card loads one file; scenes, face shaders, glass, the marquee and AR load their own parts when used; custom GLSL layers are skipped with an error", async ({
  page,
  watch,
}) => {
  test.setTimeout(120_000);
  const chunks: string[] = [];
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (/\/metal-card-[\w.-]+\.js$/.test(p)) chunks.push(p.split("/").pop()!);
  });
  await page.goto(`${EXAMPLE}/`);
  // The cards on screen (off-screen ones wait for the context pool): built from the one file.
  await expect
    .poll(() => page.evaluate(() => ["#hero", "#attrs"].every((q) => (document.querySelector(q) as unknown as { ready: boolean }).ready)), { timeout: 60_000 })
    .toBe(true);
  await page.waitForTimeout(500);
  expect(chunks, "no feature chunk for plain cards").toEqual([]);

  // The engine's optional parts are wasm files of their own, fetched the first time a card uses them;
  // none needs a JS chunk.
  const parts: string[] = [];
  const files: string[] = [];
  page.on("request", (r) => {
    const m = /\/(split_\w+)\.[0-9a-f]+\.wasm$/.exec(r.url());
    if (m) parts.push(m[1]!);
    files.push(new URL(r.url()).pathname.split("/").pop()!);
  });
  // A staged scene (an HDRI environment as backdrop, a floor): the `scene` part and the environment's file.
  await page.evaluate(() => {
    const el = document.querySelector("#attrs") as unknown as { design: Record<string, unknown> };
    el.design = { ...el.design, scene: { environment: "softbox", backdrop: "environment", floor: {} } };
  });
  await expect.poll(() => parts.includes("split_scene"), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => (document.querySelector("#attrs") as unknown as { ready: boolean }).ready), { timeout: 30_000 }).toBe(true);
  expect(
    files.some((f) => /^softbox[\w.-]*\.webp$/.test(f)),
    "the environment's file",
  ).toBe(true);
  expect(
    chunks.filter((c) => FEATURE_CHUNK.test(c)),
    "no chunk for a scene",
  ).toEqual([]);

  // Face shader layers: the `faces` part.
  chunks.length = 0;
  await page.evaluate(() => {
    const el = document.querySelector("#attrs") as unknown as { design: Record<string, unknown> };
    el.design = { ...el.design, scene: undefined, shaders: [{ id: "oil-slick", side: "front", target: "overlay" }] };
  });
  await expect.poll(() => parts.includes("split_faces"), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => (document.querySelector("#attrs") as unknown as { ready: boolean }).ready), { timeout: 30_000 }).toBe(true);
  expect(
    chunks.filter((c) => FEATURE_CHUNK.test(c)),
    "no chunk for a face shader",
  ).toEqual([]);

  // A glass card's slab and chip module (this card's material is an attribute).
  chunks.length = 0;
  await page.evaluate(() => {
    const el = document.querySelector("#attrs") as unknown as HTMLElement & { design: Record<string, unknown> };
    el.design = { ...el.design, shaders: [] };
    el.setAttribute("material", "glass");
  });
  await expect.poll(() => parts.filter((p) => p === "split_glass").length, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => page.evaluate(() => (document.querySelector("#attrs") as unknown as { ready: boolean }).ready), { timeout: 30_000 }).toBe(true);
  expect(
    chunks.filter((c) => FEATURE_CHUNK.test(c)),
    "no chunk for glass",
  ).toEqual([]);

  // The marquee isn't in the bundle: loadMarquee() fetches its page side (one chunk), and mounting it
  // the engine's `marquee` part.
  chunks.length = 0;
  const mounted = await page.evaluate(async () => {
    const src = document.querySelector<HTMLScriptElement>('script[src$="/metal-card.js"]')!.src;
    type Mount = (el: HTMLElement, o: object) => { ready(): Promise<void>; slots(): { ready: boolean }[]; dispose(): void };
    const m = (await import(/* @vite-ignore */ src)) as {
      loadMarquee: () => Promise<{ mountMarquee: Mount }>;
      CARD_PRESETS: { id: string }[];
      presetRecipe: (p: unknown) => unknown;
    };
    const { mountMarquee } = await m.loadMarquee();
    const el = Object.assign(document.createElement("div"), { style: "width:640px;height:320px" });
    document.body.append(el);
    const designs = m.CARD_PRESETS.slice(7, 12).map((p) => ({
      recipe: m.presetRecipe(p),
      cardholderName: "Ada Lovelace",
      cardholderBio: "",
      decals: [],
      surfaceSources: {},
      surfaceTreatments: {},
    }));
    const marquee = mountMarquee(el, {
      designs,
      assets: { nameFontFamily: "card3d Inter", resolveUrl: (s: string) => s },
      shuffle: false,
      intro: false,
      animate: false,
      quality: "performance",
    });
    await marquee.ready();
    const ready = marquee.slots().filter((s) => s.ready).length;
    marquee.dispose();
    el.remove();
    return ready;
  });
  expect(mounted, "the marquee's cards are built").toBeGreaterThan(0);
  expect(chunks.filter((c) => c.startsWith("metal-card-marquee-"))).toHaveLength(1);
  expect(parts).toContain("split_marquee");
  expect(
    chunks.filter((c) => !c.startsWith("metal-card-marquee-")),
    "no other chunk for the marquee",
  ).toEqual([]);

  // AR on the engine: the `ar` attribute keeps the card on the engine's stage; its model (the engine's
  // `ar` part, with the `print` part's passes, and a page-side chunk) loads only when it is made.
  chunks.length = 0;
  await page.evaluate(() => {
    const el = document.querySelector("#attrs") as unknown as HTMLElement;
    el.setAttribute("material", "titanium");
    el.setAttribute("ar", "");
  });
  await expect.poll(() => page.evaluate(() => (document.querySelector("#attrs") as unknown as { ready: boolean }).ready), { timeout: 45_000 }).toBe(true);
  await page.waitForTimeout(500);
  expect(chunks, "nothing loads for the `ar` attribute").toEqual([]);
  const usdz = await page.evaluate(async () => {
    const el = document.querySelector("#attrs") as unknown as {
      stage: { backend?: string; exportAr(o: { format: "usdz" | "glb"; size?: number }): Promise<Uint8Array> };
    };
    const b = await el.stage.exportAr({ format: "usdz", size: 512 }); // small maps: software GL
    return { backend: el.stage.backend, length: b.length, magic: [b[0], b[1]] };
  });
  expect(usdz.backend, "the engine's stage").toBeTruthy();
  expect(usdz.magic, "a zip").toEqual([0x50, 0x4b]);
  expect(usdz.length).toBeGreaterThan(10_000);
  expect(parts).toContain("split_ar");
  expect(
    chunks.filter((c) => !c.startsWith("metal-card-ar-")),
    "no other chunk for AR",
  ).toEqual([]);

  // A custom GLSL face layer (the three.js engine's): the engine runs WGSL, so it skips the layer,
  // draws the rest of the card and says so in a `metal-card-error`; nothing more loads.
  chunks.length = 0;
  watch.allow(/<metal-card>: face shader layer 0: custom GLSL/);
  const errors: string[] = [];
  await page.exposeFunction("__glslError", (m: string) => errors.push(m));
  await page.evaluate(() => {
    const el = document.querySelector("#attrs") as unknown as HTMLElement & { design: Record<string, unknown> };
    el.addEventListener("metal-card-error", (e) =>
      (window as unknown as { __glslError(m: string): void }).__glslError((e as CustomEvent<{ message: string }>).detail.message),
    );
    el.design = { ...el.design, shaders: [{ id: "custom", side: "front", target: "skin", code: "vec4 mainImage(vec2 uv) { return vec4(uv, 0.5, 1.0); }" }] };
  });
  await expect.poll(() => errors.find((m) => /GLSL/.test(m)), { timeout: 30_000, message: "the skipped layer's error" }).toBeTruthy();
  await expect.poll(() => page.evaluate(() => (document.querySelector("#attrs") as unknown as { ready: boolean }).ready), { timeout: 45_000 }).toBe(true);
  expect(
    await page.evaluate(() => !!(document.querySelector("#attrs") as unknown as { stage: { backend?: string } }).stage.backend),
    "still the engine's stage",
  ).toBe(true);
  expect(chunks, "nothing loads for a GLSL layer").toEqual([]);
});
