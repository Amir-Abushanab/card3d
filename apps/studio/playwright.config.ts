import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests of the built studio (`vite build`, served by `vite preview`), i.e. exactly what a
 * deploy ships: public assets only (a build never includes a local asset pack), and of the
 * embed example (`<metal-card>` from the built standalone bundle, apps/embed-example/serve.mjs).
 *
 * WebGL runs on SwiftShader (software) so CI and laptops render the same way; set E2E_GL=gpu to use
 * the local GPU instead (faster, but output depends on the machine).
 */
const PORT = Number(process.env.E2E_PORT ?? 4180);
/** The embed example (apps/embed-example): <metal-card> from the built CDN bundle, served CDN-style. */
export const EXAMPLE_PORT = Number(process.env.E2E_EXAMPLE_PORT ?? 4181);
const gpu = process.env.E2E_GL === "gpu";

export default defineConfig({
  testDir: "./e2e",
  // *.e2e.ts, so vitest (which collects *.spec.ts / *.test.ts) leaves them alone
  testMatch: "**/*.e2e.ts",
  outputDir: "./e2e/.results",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Software rendering is CPU-bound: a couple of workers is the sweet spot.
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 2,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: gpu ? ["--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  webServer: [
    {
      command: `pnpm exec vite preview --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `node ../embed-example/serve.mjs --port ${EXAMPLE_PORT}`,
      url: `http://localhost:${EXAMPLE_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
