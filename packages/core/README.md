# @card3d/core

The engine behind [Card Studio](https://card3d-studio.pages.dev): 3D metal cards drawn by a Rust engine on
wgpu, shipped as two wasm builds (WebGPU, and WebGL 2 for browsers without it). Brushed, guilloché and
hammered metals, holo foils, inlaid artwork and stickers, face shaders, lighting presets, scenes, AR and
print exports, and the design model (recipes, presets, validation, share tokens).

For a drop-in card, use [`@card3d/element`](../element) (`<metal-card>`) or [`@card3d/react`](../react)
(`<MetalCard>`). This package is for building your own page around the engine.

## Install

```sh
pnpm add @card3d/core
```

No peer dependencies.

## Usage

```ts
import { createEngineStage, ensureDesign } from "@card3d/core";

const canvas = document.querySelector("canvas")!; // size it with CSS; the stage follows it
const stage = createEngineStage(canvas, { quality: "full" });
await stage.setDesign(
  ensureDesign({ recipe: { material: "brass", texture: "guilloche", pattern: "orbit", color: "#e8c27a" }, cardholderName: "Ada Lovelace" }),
);
// stage.flip(), stage.reset(), stage.setPaused(true), stage.dispose()
```

- `ensureDesign(json)` takes anything Card Studio exports ("Design JSON", a saved `.card.json`, a bare
  recipe) and returns a complete, validated `CardDesign`. `decodeDesignToken(link)` reads a Card Studio
  share link (`…#d=<token>`), and `encodeDesignToken(design)` makes one.
- `createEngineStage(canvas, options)` starts the engine with the first `setDesign`: the WebGPU build
  where it works, else the WebGL 2 build (on a fresh canvas: `stage.canvas`, `onCanvas`). Options:
  `quality` (`"performance"` default, or `"full"`), `fit` (`"studio"` default, or `"contain"`: the card
  fills the canvas), `interactive` (drag, click and keyboard flip; default true), `intro`, `element`
  (where input and the accessibility attributes go), `label`, `pixelRatio`, `adaptiveResolution`,
  `autoRender`, `backend` (force `"webgpu"` or `"webgl"`), `assets` (an asset provider: its name font and
  licensed files), `resolveUrl`, and the callbacks `onRotationChange`, `onFlippedChange`,
  `onPixelRatioChange`, `onCanvas`, `onFallback`, `onContextLost`, `onContextRestored`.
- The stage: `setDesign`, `setQuality`, `setFit`, `setPaused`, `flip`, `reset`, `interaction`,
  `setRotation` / `setLift` / `setCameraOrbit` / `setCameraDistance` (camera paths, framing by the page),
  `render` / `invalidate`, `view()` and `setSticker()` (for pages that draw over the card),
  `shaderErrors()` and `checkShader(code)` (custom WGSL face shaders), `exportAr`, `dispose` and
  `released`. `backend` says which build runs.
- `createOffscreenStage(options)` draws frames on demand for exports and thumbnails: `frame`,
  `frameImageData`, `frameBlob` at a size, pose, camera orbit and lift, with its clocks advanced only by
  each frame's `dt`; plus `printJob` and `exportAr`.
- `createPublicAssets()` is the default asset provider: a procedural card body and contact chip, a
  generic corner mark, and six self-hosted SIL OFL card fonts (Inter, Manrope, Space Grotesk, Unbounded,
  Playfair Display, IBM Plex Mono). Nothing is fetched from third parties unless a design asks for it
  (a Google Fonts family or a web font URL as `CardDesign.font`: `{ source: "google", family: "Fraunces" }`).
- `CARD_PRESETS`, `LIGHTING_PRESETS`, `CARD_FONTS`, `SCENE_ENVIRONMENTS` list what designs can use; the
  face shader library is in `@card3d/core/editor` (`BUILTIN_SHADERS`).
- Beyond the standard card, a design may set `shape` (corner radius within ISO/IEC 7810, portrait, cutouts), `edge`
  (coloured / anodised side walls, a chamfer), `finish` (embossed, engraved or laser-etched marks),
  `contactless` and `textLines`; absent, the card is exactly the standard one.
- A design's `scene` stages it for product shots: `environment` (a bundled CC0 HDRI id, or a `.hdr` /
  gain-mapped `.webp` URL), `backdrop` (`sweep`, `gradient`, the blurred `environment`) and a reflective
  `floor` with a contact shadow. The engine downloads that part and the HDRI on first use; without a
  scene nothing changes. The design's `lighting` preset grades an HDRI too; `"studio"` uses it as loaded.
  `CAMERA_PATHS` and `cameraPathPose(path, t)` give the poses for `setRotation`, `setLift` and
  `setCameraOrbit`.
- Custom face shaders are WGSL (`FaceShader { id: "custom", language: "wgsl", code }`). Layers in GLSL,
  from designs made before the engine moved to Rust, are skipped (the rest of the card draws), and
  `engineDraws(design)` returns false for such a design.
- AR: `arSupport()`, `openQuickLook(url)`, `sceneViewerUrl(glbUrl)`; `stage.exportAr({ format: "usdz" })`
  (or `"glb"`) bakes the card on screen into a real-size model (85.60 × 53.98 × 0.76 mm) with colour,
  roughness / metalness and normal maps per face. The engine's AR part loads on first use.

### The engine's files, fonts, environments and bundlers

The engine ships in `wasm/`: the loader (`loader.js`) and the two builds (`pkg/` for WebGPU, about
166 KB gzipped for its main module; `pkg-webgl/`, 793 KB). A page downloads one of them, and each
optional part of a card (holo foils, stickers, shaped bodies, edges, finished marks, glass, face shaders,
add-ons, scenes, the marquee, print and AR) only when a design uses it, the parts a design needs all
together as it is set. `dist/engine.js`
imports `../wasm/loader.js`, and the loader imports each build by a literal path, so bundlers emit the
files as assets of your build. Serve `.wasm` as `application/wasm` (faster start). Every file except
`card3d_web.js` has a content hash in its name: cache those for long, and keep the previous build's
files for a while after a deploy so open pages can finish loading.

The card fonts ship in `assets/fonts/` and are referenced as
`new URL("../assets/fonts/<file>.woff2", import.meta.url)`, so Vite, Rollup, webpack 5 and esbuild emit
them as assets of your build, and native ESM loads them next to the package. They load only when a
card uses them. The scene environments (`assets/environments/*.webp`, 28–93 KB each) work the same
way and load only when a scene picks one. (If a dev server's dependency pre-bundling breaks those URLs,
exclude the package from it, e.g. Vite's `optimizeDeps.exclude: ["@card3d/core"]`.)

## Standalone (CDN) build

`@card3d/core/standalone` is the whole root API and the engine's loader in one ES module
(`dist/standalone/card3d.standalone.js`, 109 KB minified, 37 KB gzipped), plus two chunks next to it:
the AR export's page side, and the marquee (`const { mountMarquee } = await loadMarquee()`). The engine's
builds load from the package's `wasm/` (`../../wasm/` from the bundle) and the fonts and environments
from `assets/`, so it works straight from a package CDN. Self-hosted, keep the package layout
(`dist/standalone/`, `wasm/`, `assets/`) and the file names (the chunks import the bundle by name):

```html
<script type="module">
  import { createEngineStage, ensureDesign } from "https://cdn.jsdelivr.net/npm/@card3d/core@0.1/dist/standalone/card3d.standalone.js";
</script>
```

(unpkg: `https://unpkg.com/@card3d/core@0.1/dist/standalone/card3d.standalone.js`.)

## Exports

| entry | what |
| --- | --- |
| `@card3d/core` | the engine's stages (`createEngineStage`, `createOffscreenStage`, `engineDraws`, camera paths) and the design model, the scene environments' catalog and `createPublicAssets` (ESM + types) |
| `@card3d/core/standalone` | the same API in one file for a CDN (+ the AR and marquee chunks); `loadMarquee()` for the marquee |
| `@card3d/core/model` | the design model without the engine's loader (types, presets, validation, share tokens, fonts, lighting presets, AR support) |
| `@card3d/core/engine` | the stages alone |
| `@card3d/core/editor` | what a design editor needs: the face shader library's definitions, the custom-shader parser and WGSL starters, add-on parameters, material resolution, geometry and print constants, sticker placement, staging ranges |
| `@card3d/core/describe` | the design-space description, `lintDesign` and the describe-a-finish prompt |
| `@card3d/core/print` | production artwork: mm ↔ px registration, the dieline, the flat print bake (`bakePrint(offscreenStage, design)`) |
| `@card3d/core/marquee` | the card carousel (`mountMarquee`; its handle has `backend` and no three.js objects) and its strip, pose and order helpers |
| `@card3d/core/assets/fonts/*` | the card font files (and `licenses/`) |
| `@card3d/core/assets/environments/*` | the scene environments (CC0 HDRIs from Poly Haven, gain-mapped WebP) |

## Moving from the three.js engine

Earlier versions drew the card with three.js. That engine is gone from the package; the root export is
now the engine API and the design model.

- Kept subpaths: `/model`, `/engine`, `/editor`, `/describe`, `/print`, `/marquee`, `/standalone`,
  `/assets/*`. Removed: `/scene` (its environment catalog and camera paths are in the root export).
- Removed with three.js: `createCardStage` and `CardStage` (use `createEngineStage`), `buildMetalCard`,
  `applyLightingPreset`, `loadSceneStaging`, `loadCardAr` (use `EngineStage.exportAr` /
  `OffscreenStage.exportAr`), `bakePrintThree` (use `bakePrint` on an offscreen stage),
  `ensureBuiltins`, the GLSL face-shader classes, `registerShader`, `guardLoops`,
  `CUSTOM_SHADER_EXAMPLES` (now `WGSL_SHADER_EXAMPLES`) and `PRELUDE_GLSL` (the names are
  `WGSL_PRELUDE_NAMES`).
- The one-off cards and front effects are gone: `CardDesign` has no `bespoke`, `bespokeParams`,
  `frontEffect`, `objectStyle` or `effectParams`, `AssetProvider` no `bespokeAssets`, and the editor's
  `EFFECT_CATALOG` / `EFFECT_PARAMS` list the add-ons only. A design that still has those keys loads as the
  standard card (`ensureDesign` drops them like any other unknown key).
- `ShaderDefinition` lost `fragment`, `runtime` and `declareUniforms`: the engine has the built-ins'
  code. Custom face shaders are WGSL; GLSL layers are skipped.
- The marquee's handle has `backend` and no three.js objects (`renderer`, `scene`, `camera`, the slots'
  `group`).

## For AI agents

This package ships agent skills in `skills/`: `card-design-json` (the design model, with field tables
generated from the engine's catalogs), `custom-face-shaders-wgsl` and `engine-stage`. With
[TanStack Intent](https://github.com/TanStack/intent): `pnpm dlx @tanstack/intent@latest list` in your
project, then `… load @card3d/core#card-design-json`.

## Licence

MIT. The engine includes code ported from three.js and drei (MIT), Earcut (ISC) and Paper Shaders
(Apache-2.0); the fonts are under the SIL Open Font License 1.1. See `THIRD_PARTY_NOTICES.md`.
