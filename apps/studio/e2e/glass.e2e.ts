/**
 * The clear (glass) card in the studio and in `<metal-card>`: the backdrop reads through the slab,
 * and the card renders (transmission passes, chip module, front-only print) without errors.
 */
import type { Page } from "@playwright/test";
import { EXAMPLE_PORT } from "../playwright.config.ts";
import { cardCentre, expect, imageStats, openFolder, openStudio, settle, test } from "./fixtures.ts";

const EXAMPLE = `http://localhost:${EXAMPLE_PORT}`;

async function pickGlass(page: Page): Promise<void> {
  const f = await openFolder(page, "Material");
  await f.locator(".c3-mat[data-value='glass']").click();
  await expect(f.locator(".c3-mat[data-value='glass']")).toHaveAttribute("aria-checked", "true");
  await settle(page, 300);
}

test("clear glass: the backdrop reads through the card", async ({ page }) => {
  await openStudio(page);
  const metal = await cardCentre(page);
  await pickGlass(page);
  const glass = await cardCentre(page);
  const [r, g, b] = glass.rgb;
  // The glass backdrop (#3d84c4) seen through the slab, slightly tinted: clear, not a frosted slab.
  expect(b, "blue backdrop through the glass").toBeGreaterThan(r + 50);
  expect(b).toBeGreaterThan(g + 15);
  expect(Math.abs(glass.mean - metal.mean), "the card changed").toBeGreaterThan(5);
});

test("clear glass: <metal-card> renders a glass design", async ({ page }) => {
  await page.goto(`${EXAMPLE}/`);
  await page.evaluate(() => {
    const design = JSON.stringify({ recipe: { material: "glass" }, cardholderName: "Clear Card", cardholderBio: "Member since 1843" });
    document
      .querySelector("main")!
      .insertAdjacentHTML("afterbegin", `<metal-card id="glass" lazy="false" design='${design}' style="width:400px"></metal-card>`);
  });
  const c = page.locator("#glass");
  await expect.poll(() => c.evaluate((el) => (el as unknown as { ready: boolean }).ready), { timeout: 45_000 }).toBe(true);
  const s = await imageStats(page, await c.screenshot());
  expect(s.std, "a card, not a blank box").toBeGreaterThan(10);
  expect(await c.evaluate((el) => (el as unknown as { design: { recipe: { material: string } } }).design.recipe.material)).toBe("glass");
});
