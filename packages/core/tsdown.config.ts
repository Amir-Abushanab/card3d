import { defineConfig } from "tsdown";

// The publishable @card3d/core build: one output module per source module (unbundled), so each entry
// (the root, model, engine, editor, describe, print, marquee) carries only what it imports. Font files
// are not bundled: dist/fonts.js keeps its `new URL("../assets/fonts/…", import.meta.url)` literals,
// which resolve to the package's shipped assets/fonts/ (same depth as src/), so consumers' bundlers emit
// them as hashed assets. The single-file CDN build is separate: vite.standalone.config.ts. The
// local-pack loader (src/reference.ts) is workspace-only and not an entry.
export default defineConfig({
  entry: ["src/index.ts", "src/standalone.ts", "src/engine.ts", "src/model.ts", "src/editor.ts", "src/describe.ts", "src/print.ts", "src/marquee.ts"],
  format: "esm",
  dts: true,
  sourcemap: true,
  unbundle: true,
  // The Rust engine (wasm/: the loader and its builds) stays beside dist/ like the fonts: dist/engine.js
  // keeps `../wasm/loader.js`, which resolves to the shipped wasm/ (same depth as src/).
  deps: { neverBundle: [/\/wasm\/(loader|marquee|ar)\.js$/] },
  platform: "browser",
  target: "es2022",
  outDir: "dist",
  // ~90 modules: the per-file size table would bury the build log.
  report: false,
});
