---
name: engine-stage
description: "Use when building your own page, editor or export pipeline on the
  @card3d/core card engine instead of the drop-in element: createEngineStage on
  a canvas (options, setDesign, flip, pause, fit, quality, backend fallback,
  context loss, dispose), createOffscreenStage for PNG frames, thumbnails and
  video along camera paths, AR export (USDZ / GLB) and AR viewers, print
  production files (bakePrint from @card3d/core/print), the marquee carousel,
  asset providers, and bundling or serving the engine wasm and font files. For a
  card on a page without custom code use embed-metal-card."
metadata:
  purpose: "Drive the Rust + wgpu card engine directly from TypeScript: live
    stages, deterministic offscreen frames, AR and print exports, and the files
    a bundler or server must deliver."
  type: core
  domain: engine
  library: "@card3d/core"
  library_version: "0.1.1"
requires:
  - card-design-json
sources:
  - src/engine.ts
  - src/index.ts
  - src/standalone.ts
  - src/scene/camera-paths.ts
  - src/print.ts
  - src/marquee/**
  - src/ar/**
  - README.md
---

# The card engine (`createEngineStage`, `createOffscreenStage`)

The engine is Rust on wgpu, shipped as two wasm builds: WebGPU, and WebGL 2 for browsers without it.
A page downloads one build (about 166 KB gzipped for the WebGPU main module, 793 KB for WebGL 2) and
each optional part of a card (holo, stickers, shapes, shaders, effects, scenes, AR, print) the first
time a design uses it. The download starts when the first stage is created, while the design's fonts
and images load: create the stage as early as the page knows it will show a card. Read card-design-json for the designs it draws. If a drop-in card is enough,
`<metal-card>` (embed-metal-card) does all of this for you.

## Setup

```sh
pnpm add @card3d/core
```

Bundlers (Vite, Rollup, webpack 5, esbuild) emit the wasm builds, card fonts and scene environments as
assets: the package references them with literal `import()` paths and `new URL(…, import.meta.url)`.
In Vite's dev server, exclude the package from dependency pre-bundling or those URLs break:

```ts
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({ optimizeDeps: { exclude: ["@card3d/core"] } });
```

Serve `.wasm` as `application/wasm` (else a slower fallback path, with a console warning). Every
engine file except `card3d_web.js` has a content hash in its name: cache them long, and keep the
previous deploy's files for a while. Without a bundler, import
`https://cdn.jsdelivr.net/npm/@card3d/core@<version>/dist/standalone/card3d.standalone.js` (the root
API in one file; the engine loads from the package's `wasm/` next to it).

## Mount a card

```ts
import { createEngineStage, ensureDesign } from "@card3d/core";

let canvas = document.querySelector<HTMLCanvasElement>("#card")!; // sized by CSS
const stage = createEngineStage(canvas, {
  quality: "full",          // "performance" (default) for grids and phones
  fit: "contain",           // the card fills the canvas; "studio" (default) is Card Studio's camera
  label: "Ada's card",
  onCanvas: (next) => (canvas = next), // the WebGL fallback replaced the canvas in the DOM
  onFallback: (why) => console.info("engine fell back:", why),
});
await stage.setDesign(ensureDesign({ recipe: { material: "silver", color: "#e2c27a" }, cardholderName: "Ada Lovelace" }));
console.log(stage.backend); // "webgpu" | "webgl"

stage.flip();
stage.setPaused(true); // e.g. off screen; hidden tabs pause by themselves
stage.dispose();
await stage.released; // the GPU context is gone
```

- The engine starts on the first `setDesign`; `backend` is null until then. Each later `setDesign`
  swaps the design on the same stage. Give it a design from `ensureDesign` (or `lintDesign`).
- The drawing buffer follows the canvas's CSS size (ResizeObserver) at the device pixel ratio,
  clamped by the quality tier; `adaptiveResolution: true` lowers it while frames run over budget.
- Interaction (drag to turn, click / Enter to flip, double-click / Esc to reset) is on by default;
  `interactive: false` for a still card, `element` to take input and the accessibility attributes on a
  wrapper instead of the canvas.
- Every option, member and callback: [stage API](references/stage-api.md).

## Export images, video, AR and print files

Read [exports](references/exports.md) when making any file from a design: PNG / WebP frames and
thumbnails (`createOffscreenStage`, deterministic clocks), video frames along `CAMERA_PATHS`, AR models
(`exportAr` → USDZ for AR Quick Look, GLB for Scene Viewer, plus `arSupport`, `openQuickLook`,
`sceneViewerUrl`), and print production rasters (`bakePrint`, `cardDieline`, `dielineSvg` from
`@card3d/core/print`).

## Many cards, the marquee and asset providers

- Each stage holds its own GPU context; browsers allow a page about 16 WebGL contexts and drop the
  oldest past that. For more than a few cards use `<metal-card>` (it pools contexts, 12 by default) or
  the marquee, which draws many cards on one canvas:

```ts
import { createPublicAssets } from "@card3d/core";
import { mountMarquee } from "@card3d/core/marquee";
import { CARD_PRESETS, defaultDesign, presetExtras, presetRecipe } from "@card3d/core/model";

const designs = CARD_PRESETS.slice(0, 12).map((p) => ({ ...defaultDesign(), recipe: presetRecipe(p), ...presetExtras(p) }));
const marquee = mountMarquee(document.querySelector<HTMLElement>("#hero")!, { designs, assets: createPublicAssets() });
await marquee.ready();
// marquee.dispose() when the hero goes away
```

- `assets` (on stages and the marquee) is an asset provider: `nameFontFamily` (the font for designs
  without their own) and `resolveUrl(src)` (map a design's image `src` to a fetchable URL, e.g. a CDN
  prefix). `createPublicAssets(overrides)` is the default.

## Common mistakes

- Keeping a reference to the original canvas: after a fall-over to WebGL the stage draws on a new
  canvas (`stage.canvas`, `onCanvas`). Re-attach your own listeners and styles to it.
- A stage per card in a long grid: contexts run out and the oldest card goes blank
  (`onContextLost`). Pool them, pause and dispose off-screen stages, or use `<metal-card>`.
- `exportAr` and `checkShader` before the first `setDesign`: `exportAr` rejects, `checkShader`
  resolves `[]`.
- Importing `@card3d/core` (the engine) in server code: use `@card3d/core/model` there; create
  stages only in the browser.
- Reading `offscreen.frame(...)`'s canvas after the next frame: the stage reuses it. Copy it or use
  `frameBlob` / `frameImageData`.

## Completion

The card draws and responds on the target browsers (check `stage.backend`, and a browser without
WebGPU for the WebGL path), `.wasm` files arrive as `application/wasm`, and stages are disposed when
their canvas goes away (`stage.released` settles).
