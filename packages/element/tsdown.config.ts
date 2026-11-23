import { defineConfig } from "tsdown";

// @card3d/element: one ESM entry with types; @card3d/core stays external (a dependency). src/standalone.ts is an entry only for its .d.ts: the ./standalone export's code is the vite
// single-file build (vite.standalone.config.ts), which runs after this (tsdown empties dist/ first).
export default defineConfig({
  entry: ["src/index.ts", "src/standalone.ts"],
  format: "esm",
  dts: true,
  sourcemap: true,
  deps: { neverBundle: ["@card3d/core", /^@card3d\/core\//] },
  platform: "browser",
  target: "es2022",
  outDir: "dist",
});
