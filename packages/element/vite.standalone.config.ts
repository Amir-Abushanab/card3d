import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SCRIPT_URL_VAR,
  STANDALONE_CODE_SPLITTING,
  standaloneBanner,
  standaloneEngine,
  standaloneFonts,
  standaloneIntro,
  standaloneLazyChunks,
} from "../core/build/standalone.mjs";

// The CDN builds of <metal-card>: the element, the design model and the card engine's page side in ONE
// file, selected by CARD3D_STANDALONE:
//   (default) dist/standalone/metal-card.js       ES module: <script type="module" src="…">
//   iife      dist/standalone/metal-card.iife.js  classic script: <script src="…" defer>, global `MetalCard`
// The ES build draws any card from the one file; the marquee and the AR export's page side are chunks
// next to it, loaded on first use (the IIFE, which can't load chunks, inlines them). The card fonts and
// scene environments are copied to dist/standalone/fonts/ and environments/ and load from there,
// relative to the bundle, on first use. So are the card engine's builds (engine/pkg: WebGPU,
// engine/pkg-webgl: the WebGL 2 fallback), from which a page downloads one build and the parts its
// designs use.
const iife = process.env.CARD3D_STANDALONE === "iife";

/** The repository's third-party notices next to the bundle (the folder is what gets self-hosted). */
const notices = (): Plugin => ({
  name: "card3d-standalone-notices",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "THIRD_PARTY_NOTICES.md",
      source: readFileSync(resolve(import.meta.dirname, "../../THIRD_PARTY_NOTICES.md"), "utf8"),
    });
  },
});

export default defineConfig({
  plugins: [
    standaloneFonts({ base: "./fonts/", copyTo: "fonts", envBase: "./environments/", envCopyTo: "environments", scriptUrl: iife ? SCRIPT_URL_VAR : undefined }),
    standaloneEngine({ base: "./engine/", copyTo: iife ? undefined : "engine", scriptUrl: iife ? SCRIPT_URL_VAR : undefined }),
    // ES: the lazily loaded features stay separate chunks (standaloneLazyChunks).
    ...(iife ? [] : [standaloneLazyChunks(), notices()]),
  ],
  build: {
    outDir: "dist/standalone",
    emptyOutDir: !iife, // the second pass must not delete the first artifact
    target: "es2022",
    reportCompressedSize: false,
    lib: {
      entry: resolve(import.meta.dirname, "src/standalone.ts"),
      name: "MetalCard",
      fileName: () => (iife ? "metal-card.iife.js" : "metal-card.js"),
      formats: [iife ? "iife" : "es"],
    },
    rolldownOptions: {
      // The lazy chunks import what they share with the bundle from the bundle itself (no common chunks).
      preserveEntrySignatures: "allow-extension",
      // Lib mode keeps whitespace in ES output (for consumers' tree-shaking); a CDN bundle is final.
      output: {
        codeSplitting: iife ? false : STANDALONE_CODE_SPLITTING,
        chunkFileNames: "metal-card-[name]-[hash].js",
        minify: true,
        postBanner: standaloneBanner("@card3d/element"),
        ...(iife ? { intro: standaloneIntro() } : {}),
      },
    },
  },
});
