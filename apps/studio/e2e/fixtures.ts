/**
 * Shared fixtures for the e2e suite: every page is watched for console errors, page errors, failed
 * or 4xx/5xx requests and any request to the dev-only local asset pack (`/@ref/`); a test fails if
 * one shows up. WebGL context losses are counted too (`contextLosses`).
 */
import { test as base, expect, type Locator, type Page } from "@playwright/test";

/** Driver chatter from software GL and three's notice that parallel shader compile is unavailable. */
// "No available adapters": Chrome, when WebGPU has no adapter (SwiftShader); the engine then uses its WebGL build.
const BENIGN_WARNINGS = [
  /GL Driver Message/,
  /GPU stall due to ReadPixels/,
  /KHR_parallel_shader_compile/,
  /Automatic fallback to software WebGL/,
  /No available adapters/,
];

export interface PageWatch {
  problems: string[];
  /** Forget a problem the test provoked on purpose (matched by regex). */
  allow(re: RegExp): void;
}

export const test = base.extend<{ watch: PageWatch }>({
  watch: [
    async ({ page }, use) => {
      const problems: string[] = [];
      const allowed: RegExp[] = [];
      page.on("console", (m) => {
        const text = m.text();
        if (m.type() === "error") problems.push(`console.error: ${text}`);
        else if (m.type() === "warning" && !BENIGN_WARNINGS.some((re) => re.test(text))) problems.push(`console.warn: ${text}`);
      });
      page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
      page.on("requestfailed", (r) => {
        // downloads of blob: URLs and aborted navigations are not failures of the app
        if (r.url().startsWith("blob:") || r.failure()?.errorText === "net::ERR_ABORTED") return;
        problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`);
      });
      page.on("response", (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.url()}`));
      page.on("request", (r) => r.url().includes("/@ref/") && problems.push(`local-pack request: ${r.url()}`));
      await page.addInitScript(() => {
        const w = window as unknown as { __contextLosses: number };
        w.__contextLosses = 0;
        // webglcontextlost doesn't bubble, but a capturing listener on window sees every canvas's.
        window.addEventListener("webglcontextlost", () => w.__contextLosses++, true);
      });
      await use({ problems, allow: (re) => allowed.push(re) });
      const left = problems.filter((p) => !allowed.some((re) => re.test(p)));
      expect(left, "console errors, failed requests or local-pack requests").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export const contextLosses = (page: Page) => page.evaluate(() => (window as unknown as { __contextLosses: number }).__contextLosses);

// ── studio ─────────────────────────────────────────────────────────────────

/** Open the studio and wait for the first card and its one-shot intro. */
export async function openStudio(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await page.locator("#panel .tp-rotv").waitFor();
  await settle(page);
  await introDone(page);
}

/**
 * The first card's intro turns it into place over 3.6 s from its first frame, so a shot taken soon
 * after `openStudio` can catch it mid-turn (seen with Playwright 1.65's Chromium). The card has no idle
 * motion, so wait until two canvas shots in a row are identical; a design that animates on its own
 * never is, so give up after the intro's length plus a margin.
 */
async function introDone(page: Page): Promise<void> {
  let last = await canvasShot(page);
  for (const end = Date.now() + 5_000; Date.now() < end;) {
    await page.waitForTimeout(150);
    const shot = await canvasShot(page);
    if (shot.equals(last)) return;
    last = shot;
  }
}

/** Wait until the live card has (re)built and drawn a couple of frames. */
export async function settle(page: Page, extraMs = 0): Promise<void> {
  await page.waitForTimeout(120);
  await page.waitForFunction(() => !document.body.dataset.building, null, { timeout: 45_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  if (extraMs) await page.waitForTimeout(extraMs);
}

/** A top-level panel folder by its title (titles can carry a suffix, e.g. "Effects · Shine"). */
export function folder(page: Page, title: string): Locator {
  return page
    .locator("#panel .tp-fldv")
    .filter({ has: page.locator(":scope > .tp-fldv_b .tp-fldv_t", { hasText: new RegExp(`^${title}`) }) })
    .first();
}

export async function openFolder(page: Page, title: string): Promise<Locator> {
  const f = folder(page, title);
  if (!(await f.evaluate((el) => el.classList.contains("tp-fldv-expanded")))) await f.locator(":scope > .tp-fldv_b").click();
  await expect(f).toHaveClass(/tp-fldv-expanded/);
  return f;
}

export const folderTitle = (page: Page, title: string) => folder(page, title).locator(":scope > .tp-fldv_b .tp-fldv_t");

/** A Tweakpane row (label + value) by its exact label. */
export function row(scope: Locator, label: string): Locator {
  return scope
    .locator(".tp-lblv")
    .filter({ has: scope.page().locator(":scope > .tp-lblv_l", { hasText: new RegExp(`^\\s*${label.replace(/[()]/g, "\\$&")}\\s*$`) }) })
    .first();
}

/** Labels of the history list, newest last. */
export async function historyLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll(".c3-hist-label")].map((e) => e.textContent ?? ""));
}

/** Open the history list once, so `historyLabels` can read it. */
export async function showHistory(page: Page): Promise<void> {
  const list = page.locator(".c3-hist-panel");
  if (await list.isHidden()) await page.getByRole("button", { name: "History", exact: true }).click();
}

// ── pixels ─────────────────────────────────────────────────────────────────

export interface ImageStats {
  width: number;
  height: number;
  /** share of pixels with alpha > 8 */
  coverage: number;
  /** mean / std of luma over covered pixels, 0..255 */
  mean: number;
  std: number;
  /** mean r, g, b over covered pixels */
  rgb: [number, number, number];
  /** distinct colours, quantised to 4 bits per channel */
  colours: number;
}

/** Decode an image (PNG, JPEG, …) in the page and measure it. */
export async function imageStats(page: Page, bytes: Buffer, crop?: { x: number; y: number; w: number; h: number }): Promise<ImageStats> {
  return page.evaluate(
    async ({ b64, crop }) => {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([buf]));
      const c = crop ?? { x: 0, y: 0, w: bmp.width, h: bmp.height };
      const cv = new OffscreenCanvas(c.w, c.h);
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(bmp, -c.x, -c.y);
      const d = ctx.getImageData(0, 0, c.w, c.h).data;
      let n = 0,
        s = 0,
        s2 = 0,
        r = 0,
        g = 0,
        bl = 0;
      const q = new Set<number>();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] <= 8) continue;
        n++;
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        s += l;
        s2 += l * l;
        r += d[i];
        g += d[i + 1];
        bl += d[i + 2];
        q.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
      }
      const mean = n ? s / n : 0;
      return {
        width: bmp.width,
        height: bmp.height,
        coverage: n / (d.length / 4),
        mean,
        std: n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : 0,
        rgb: (n ? [r / n, g / n, bl / n] : [0, 0, 0]) as [number, number, number],
        colours: q.size,
      };
    },
    { b64: bytes.toString("base64"), crop },
  );
}

/** Screenshot of the studio's live canvas. */
export const canvasShot = (page: Page) => page.locator("#card-canvas").screenshot();

/** Centre region of the card in the live canvas (the default pose shows the face head-on). */
export async function cardCentre(page: Page): Promise<ImageStats> {
  const shot = await canvasShot(page);
  const box = (await page.locator("#card-canvas").boundingBox())!;
  const w = Math.round(box.width * 0.2),
    h = Math.round(box.height * 0.12);
  return imageStats(page, shot, { x: Math.round(box.width * 0.4), y: Math.round(box.height * 0.32), w, h });
}

/** Mean absolute difference between two same-sized screenshots, 0..255. */
export async function diff(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ({ a, b }) => {
      const load = async (b64: string) => {
        const bin = atob(b64);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([u]));
        const cv = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = cv.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      };
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.length !== y.length) return 255;
      let s = 0;
      for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]);
      return s / x.length;
    },
    { a: a.toString("base64"), b: b.toString("base64") },
  );
}
