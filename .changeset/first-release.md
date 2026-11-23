---
"@card3d/core": minor
"@card3d/element": minor
"@card3d/react": minor
---

First release: 3D metal cards drawn by a Rust engine on wgpu, shipped in `@card3d/core` as two wasm builds (WebGPU, and WebGL 2 for browsers without it). No three.js: no package depends on it or bundles it.

- `@card3d/core`: the engine API (`createEngineStage` for a live card on a canvas, `createOffscreenStage` for PNG frames, thumbnails and video along camera paths, AR export as USDZ / GLB) and the design model (`CardDesign`, presets, `ensureDesign`, `lintDesign`, Card Studio share tokens). Subpaths `/model`, `/engine`, `/editor`, `/describe`, `/print` (production artwork: `bakePrint`, the dieline), `/marquee` and `/standalone` (one-file CDN build), plus the self-hosted OFL card fonts and the CC0 scene environments. Custom face shaders are WGSL; GLSL layers are skipped.
- `@card3d/element`: `<metal-card>`, the drop-in custom element for any page, from npm or the CDN bundles (`dist/standalone/metal-card.js`, ES module, and `metal-card.iife.js`), with a shared pool of GPU contexts for pages with many cards.
- `@card3d/react`: `<MetalCard>`, a thin wrapper over `<metal-card>` (React 18 or later).
