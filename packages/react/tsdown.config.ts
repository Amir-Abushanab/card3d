import { defineConfig } from "tsdown";

// @card3d/react: one ESM entry with types. react and @card3d/element (and through it @card3d/core)
// stay external.
export default defineConfig({
  entry: ["src/index.tsx"],
  format: "esm",
  dts: true,
  sourcemap: true,
  deps: { neverBundle: ["react", "react/jsx-runtime", "@card3d/element", "@card3d/core", /^@card3d\//] },
  platform: "browser",
  target: "es2022",
  outDir: "dist",
});
