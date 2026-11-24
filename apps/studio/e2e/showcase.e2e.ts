import { contextLosses, expect, imageStats, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";

interface MarqueeProbe {
  __marquee?: { introPhase: string; designs: { cardholderName: string; shaders?: unknown[]; addons?: object }[] };
}

async function openShowcase(page: Page, query = ""): Promise<void> {
  await page.goto(`/showcase.html${query}`);
  await page.waitForFunction(() => (window as unknown as MarqueeProbe).__marquee?.introPhase === "done", null, { timeout: 0 }); // bounded by the test's timeout
  await page.waitForTimeout(800);
}

test("showcase: a marquee of the public presets, effects included", async ({ page }) => {
  await openShowcase(page);
  const designs = await page.evaluate(() =>
    (window as unknown as MarqueeProbe).__marquee!.designs.map((d) => ({
      name: d.cardholderName,
      fx: !!(d.shaders?.length || (d.addons && Object.keys(d.addons).length)),
    })),
  );
  expect(designs.length, "one card per preset").toBeGreaterThan(50);
  expect(designs.filter((d) => d.fx).length, "the Effects presets keep their effects").toBeGreaterThanOrEqual(10);

  const shot = await imageStats(page, await page.locator(".card-marquee__stage canvas").screenshot());
  expect(shot.std, "cards on the strip").toBeGreaterThan(10);
  expect(shot.colours).toBeGreaterThan(40);
  expect(await contextLosses(page)).toBe(0);
});

test("showcase: ?card pins an effect card to the centre", async ({ page }) => {
  await openShowcase(page, "?card=sunset-mesh");
  const box = (await page.locator(".card-marquee__stage canvas").boundingBox())!;
  const shot = await page.locator(".card-marquee__stage canvas").screenshot();
  const centre = await imageStats(page, shot, {
    x: Math.round(box.width * 0.42),
    y: Math.round(box.height * 0.3),
    w: Math.round(box.width * 0.16),
    h: Math.round(box.height * 0.12),
  });
  const [r, g, b] = centre.rgb;
  expect(Math.max(r, g, b) - Math.min(r, g, b), "the gradient mesh is colourful, not silver").toBeGreaterThan(30);
});

test("showcase: cardholder names, open fonts and the lighting switcher", async ({ page }) => {
  await openShowcase(page);
  const designs = await page.evaluate(() => (window as unknown as { __marquee: { designs: { cardholderName: string; font?: string }[] } }).__marquee.designs);
  expect(Math.max(...designs.map((d) => d.cardholderName.length)), "short cardholder names, not preset names").toBeLessThanOrEqual(18);
  expect(new Set(designs.map((d) => d.font).filter(Boolean)).size, "the open fonts appear on the strip").toBeGreaterThanOrEqual(4);

  const root = page.locator(".sc-root");
  await expect(root).toHaveAttribute("data-tone", "dark");
  const canvas = page.locator(".card-marquee__stage canvas");
  const before = await imageStats(page, await canvas.screenshot());
  await page.locator('.sc-lighting__btn[data-value="light"]').click();
  await expect(root).toHaveAttribute("data-tone", "light");
  await expect(page).toHaveURL(/[?&]lighting=light/);
  // the marquee re-renders its environment and redraws on a later frame
  await expect
    .poll(async () => Math.abs((await imageStats(page, await canvas.screenshot())).mean - before.mean), {
      message: "the cards are lit differently",
    })
    .toBeGreaterThan(1);

  await page.goto("/showcase.html?lighting=warm");
  await expect(page.locator('.sc-lighting__btn[data-value="warm"]')).toHaveAttribute("aria-checked", "true");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test("showcase at 390 px", async ({ page }) => {
    await openShowcase(page);
    const shot = await imageStats(page, await page.locator(".card-marquee__stage canvas").screenshot());
    expect(shot.std).toBeGreaterThan(10);
    await expect(page.locator(".card-marquee__title")).toBeVisible();
    // every lighting preset is on screen: the switcher wraps instead of overflowing
    const sw = page.locator(".sc-lighting");
    await expect(sw.locator(".sc-lighting__btn")).toHaveCount(6);
    for (const b of await sw.locator(".sc-lighting__btn").all()) {
      const r = (await b.boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(390);
    }
    expect(await sw.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // Scrolled: the nav gets an opaque bar, so the card canvas never shows through its links.
    // The scroll handler runs on the next animation frame (slow under software GL) and the bar fades in:
    // wait for the hand-off state, then for the transition to have run.
    await page.evaluate(() => (document.querySelector(".sc-root")!.scrollTop = 500));
    await expect(page.locator(".sc-root")).toHaveAttribute("data-handedoff", "");
    await expect.poll(() => page.locator(".sc-nav").evaluate((el) => getComputedStyle(el).backgroundColor), { timeout: 5000 }).not.toBe("rgba(0, 0, 0, 0)");
    await expect.poll(() => page.locator(".sc-nav").evaluate((el) => el.getAnimations().length), { timeout: 5000 }).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal scroll").toBe(true);
  });
});
