import { defineConfig } from "vite";
import { resolve } from "node:path";
import { STANDALONE_CODE_SPLITTING, standaloneBanner, standaloneEngine, standaloneFonts, standaloneLazyChunks } from "./build/standalone.mjs";

// The CDN / standalone build of @card3d/core: dist/standalone/card3d.standalone.js, one file with the
// card engine's page side and the design model. The engine's builds are the package's own wasm/ (loaded
// from `../../wasm/` next to the bundle: a page downloads one build and only the parts its designs use),
// the fonts and scene environments its assets/. The marquee and the AR export's page side are chunks
// next to it (standaloneLazyChunks). tsdown builds the tree-shakeable package (tsdown.config.ts). Runs
// after tsdown, which empties dist/ first.
export default defineConfig({
  plugins: [standaloneFonts(), standaloneEngine({ base: "../../wasm/" }), standaloneLazyChunks()],
  build: {
    outDir: "dist/standalone",
    emptyOutDir: true,
    target: "es2022",
    reportCompressedSize: false,
    lib: {
      entry: resolve(import.meta.dirname, "src/standalone.ts"),
      fileName: () => "card3d.standalone.js",
      formats: ["es"],
    },
    rolldownOptions: {
      // The lazy chunks import what they share with the bundle from the bundle itself (no common chunks).
      preserveEntrySignatures: "allow-extension",
      // Lib mode keeps whitespace in ES output (for consumers' tree-shaking); a CDN bundle is final, so minify fully.
      output: {
        codeSplitting: STANDALONE_CODE_SPLITTING,
        chunkFileNames: "card3d-[name]-[hash].js",
        minify: true,
        postBanner: standaloneBanner("@card3d/core"),
      },
    },
  },
});
