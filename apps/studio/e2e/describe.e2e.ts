/**
 * "Describe a finish…" (feature-flagged, src/describe/): hidden by default, shown with the local
 * override, the unconfigured state points at the Claude Code skill, and with a key the answer is
 * applied as one undoable step. The Messages API is mocked with page.route: no network.
 */
import { expect, historyLabels, openStudio, settle, showHistory, test } from "./fixtures.ts";

const describeButton = (page: import("@playwright/test").Page) => page.locator("#panel .c3-mini--describe");

test("Describe a finish is off by default", async ({ page }) => {
  await openStudio(page);
  await expect(page.locator("#panel .c3-mini", { hasText: "Randomize" })).toBeVisible();
  await expect(describeButton(page)).toHaveCount(0);
  await expect(page.locator("dialog.c3-describe")).toHaveCount(0);
});

test("the flag shows it; unconfigured, it offers the Claude Code skill", async ({ page }) => {
  await openStudio(page, "/?describe-finish=1");
  await expect(describeButton(page)).toBeVisible();
  await describeButton(page).click();
  const dialog = page.locator("dialog.c3-describe[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("describe-unconfigured")).toBeVisible();
  const cmd = dialog.getByTestId("describe-skill-command");
  await expect(cmd).toHaveText(/^\/describe-finish \S/);
  await dialog.getByRole("textbox", { name: "Describe the finish" }).fill("brushed rose gold with a faint oil-slick holo");
  await expect(cmd).toHaveText("/describe-finish brushed rose gold with a faint oil-slick holo");
  await expect(dialog.getByRole("button", { name: "Describe", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("textbox", { name: "Anthropic API key" })).toHaveAttribute("type", "password");

  // The override is remembered locally until ?describe-finish=0.
  await openStudio(page, "/");
  await expect(describeButton(page)).toBeVisible();
  await openStudio(page, "/?describe-finish=0");
  await expect(describeButton(page)).toHaveCount(0);
});

test("with a key, the model's design is applied as one undoable step", async ({ page }) => {
  const key = "sk-ant-api03-e2e-test-key-not-real-000000000000-abcd";
  await page.addInitScript((k) => localStorage.setItem("card-studio.anthropic-api-key", k), key);
  const design = {
    recipe: { material: "oxide", color: "#16181a", texture: "sandblasted", grain: 40, polish: 18, relief: 35, spectrum: 0 },
    cardholderName: "Ada Lovelace",
    cardholderBio: "",
    decals: [],
    surfaceSources: {},
    surfaceTreatments: {},
    finish: { name: "engraved" },
    edge: { finish: "anodized", color: "#2f6fd6" },
    lighting: "light",
  };
  const requests: { auth: string; body: Record<string, unknown> }[] = [];
  await page.route("https://api.anthropic.com/**", async (route) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const h = route.request().headers();
    requests.push({ auth: h["authorization"] ?? h["x-api-key"] ?? "", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify({ summary: "Matte black anodised slab.", design_json: JSON.stringify(design) }) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    });
  });

  await openStudio(page, "/?describe-finish=1");
  await describeButton(page).click();
  const dialog = page.locator("dialog.c3-describe[open]");
  await expect(dialog.getByTestId("describe-provider")).toContainText("sk-ant-…abcd");
  await expect(dialog).not.toContainText(key);
  await dialog.getByRole("textbox", { name: "Describe the finish" }).fill("matte black anodised slab, bright high-key light");
  await dialog.getByRole("button", { name: "Describe", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Matte black anodised slab.");
  expect(requests).toHaveLength(1);
  expect(requests[0].auth).toContain(key);
  expect(requests[0].body.model).toBe("claude-opus-5-5");
  expect(JSON.stringify(requests[0].body.messages)).toContain("matte black anodised slab");
  expect(page.url()).not.toContain(key);

  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await settle(page);
  await showHistory(page);
  const labels = await historyLabels(page);
  expect(
    labels.filter((l) => l.startsWith("Describe")),
    "one history step",
  ).toEqual([expect.stringMatching(/^Describe: matte black anodised slab/)]);
  await expect(page.locator("html")).toHaveAttribute("data-tone", "light"); // the design's "light" preset

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await settle(page);
  await expect(page.locator("html")).toHaveAttribute("data-tone", "dark"); // back to the studio preset
});
