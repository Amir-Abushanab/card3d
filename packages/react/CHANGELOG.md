# @card3d/react

## 0.1.2

### Patch Changes

- [#4](https://github.com/Amir-Abushanab/card3d/pull/4) [`ee282f9`](https://github.com/Amir-Abushanab/card3d/commit/ee282f94808be4de47ae4d7a5671996bef9fef60) Thanks [@Amir-Abushanab](https://github.com/Amir-Abushanab)! - Faster, lighter cards: a page with several cards no longer mistakes its own WebGPU start for a crash (it used to download the WebGL build as well and record WebGPU as failed); the engine downloads while a design's fonts and images load; decoded images are shared between cards and rebuilds; paused cards stop decoding animated GIF stickers and listening on the window. The parts of the engine a design needs download together with the main module instead of one after another; on WebGPU a page's cards share one GPU device (pipelines, maps and environments made once for all of them; a lost device moves every card to the WebGL build); a card's shaders and pipelines are made while it is built and kept for the next card; the marquee draws its cards in one pass.
- Updated dependencies [[`ee282f9`](https://github.com/Amir-Abushanab/card3d/commit/ee282f94808be4de47ae4d7a5671996bef9fef60)]:
  - @card3d/element@0.1.2

## 0.1.1

### Patch Changes

- [`2c7037a`](https://github.com/Amir-Abushanab/card3d/commit/2c7037a31dcbc38455c35082490ed3e661cbe9c2) Thanks [@Amir-Abushanab](https://github.com/Amir-Abushanab)! - Card Studio's links now point to https://card3d-studio.pages.dev (the READMEs and the bundled agent skills).
- Updated dependencies [[`2c7037a`](https://github.com/Amir-Abushanab/card3d/commit/2c7037a31dcbc38455c35082490ed3e661cbe9c2)]:
  - @card3d/element@0.1.1

## 0.1.0

### Minor Changes

- [`0135a41`](https://github.com/Amir-Abushanab/card3d/commit/0135a412774ef82fd86609ff04d67241cf540c4e) Thanks [@Amir-Abushanab](https://github.com/Amir-Abushanab)! - Agent skills ([TanStack Intent](https://github.com/TanStack/intent)) ship in each package's `skills/`: `card-design-json` (the design model, with field tables, presets and examples generated from the engine's catalogs), `custom-face-shaders-wgsl` and `engine-stage` in `@card3d/core`; `embed-metal-card` in `@card3d/element`; `metal-card-react` in `@card3d/react`. In a project that uses them: `pnpm dlx @tanstack/intent@latest list`, then `load @card3d/core#card-design-json` (or another skill).

- [`0135a41`](https://github.com/Amir-Abushanab/card3d/commit/0135a412774ef82fd86609ff04d67241cf540c4e) Thanks [@Amir-Abushanab](https://github.com/Amir-Abushanab)! - First release: 3D metal cards drawn by a Rust engine on wgpu, shipped in `@card3d/core` as two wasm builds (WebGPU, and WebGL 2 for browsers without it). No three.js: no package depends on it or bundles it.
  
  - `@card3d/core`: the engine API (`createEngineStage` for a live card on a canvas, `createOffscreenStage` for PNG frames, thumbnails and video along camera paths, AR export as USDZ / GLB) and the design model (`CardDesign`, presets, `ensureDesign`, `lintDesign`, Card Studio share tokens). Subpaths `/model`, `/engine`, `/editor`, `/describe`, `/print` (production artwork: `bakePrint`, the dieline), `/marquee` and `/standalone` (one-file CDN build), plus the self-hosted OFL card fonts and the CC0 scene environments. Custom face shaders are WGSL; GLSL layers are skipped.
  - `@card3d/element`: `<metal-card>`, the drop-in custom element for any page, from npm or the CDN bundles (`dist/standalone/metal-card.js`, ES module, and `metal-card.iife.js`), with a shared pool of GPU contexts for pages with many cards.
  - `@card3d/react`: `<MetalCard>`, a thin wrapper over `<metal-card>` (React 18 or later).

### Patch Changes

- Updated dependencies [[`0135a41`](https://github.com/Amir-Abushanab/card3d/commit/0135a412774ef82fd86609ff04d67241cf540c4e), [`0135a41`](https://github.com/Amir-Abushanab/card3d/commit/0135a412774ef82fd86609ff04d67241cf540c4e)]:
  - @card3d/element@0.1.0
