# @card3d/element

`<metal-card>`: a drop-in 3D metal card for any page, plain HTML, Vue, Svelte or anything else. Design
one in [Card Studio](https://card3d-studio.pages.dev), then **Export → Embed…** and paste the snippet.

## From a CDN

One script of 118.5 KB minified (40.0 KB gzipped) with the design model, the element and the card
engine's loader, plus the engine from `engine/`: its WebGPU build (a 166 KB gzipped main module, and
about 24 KB of glue code) on browsers with WebGPU, its WebGL 2 build (793 KB) on the others, and a few KB
per optional part a design uses (holo foils, stickers, card shapes, edges, finished marks, glass, face
shaders, add-ons, scenes). The card fonts load from `fonts/` and the scene environments
from `environments/` when a card first uses them. Two small chunks next to the bundle load on first use:
the AR export (`ar`) and the marquee (`loadMarquee()`).

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@card3d/element@0.1/dist/standalone/metal-card.js"></script>

<metal-card preset="brass-orbit-guilloche" name="Ada Lovelace" style="width: 480px"></metal-card>
```

Without modules, the classic-script build defines the element the same way (and a `MetalCard` global):

```html
<script src="https://cdn.jsdelivr.net/npm/@card3d/element@0.1/dist/standalone/metal-card.iife.js" defer></script>
```

unpkg serves the same files: `https://unpkg.com/@card3d/element@0.1/dist/standalone/metal-card.js`.
Pin an exact version (`@0.1.0`) in production.

**Self-hosting:** copy the whole `dist/standalone/` folder, not just `metal-card.js`, and keep the file
names. The engine loads from `engine/` next to the bundle, and the chunks import the bundle as
`./metal-card.js`: a renamed copy (including a CDN's generated `metal-card.min.js`; the file is already
minified) makes them load a second copy of it. `metal-card.iife.js` inlines both chunks (141 KB
minified, 49 KB gzipped); it still needs `engine/` (and `fonts/`, `environments/`) next to it. Serve
`.wasm` files as `application/wasm`.

**Content-Security-Policy:** the engine compiles WebAssembly (`script-src 'wasm-unsafe-eval'`, plus the
bundle's origin), fetches its `.wasm` parts, a `src` design and environment files (`connect-src`), loads
design images through `<img>`, an environment sometimes from a `blob:` URL (`img-src`, with `data:` and
`blob:`), registers the card fonts from the bundle's origin (`font-src`), and styles its shadow root with
a `<style>` element (`style-src 'unsafe-inline'`). `google:` fonts also need
`connect-src https://fonts.googleapis.com` and `font-src https://fonts.gstatic.com`.

## From npm

```sh
pnpm add @card3d/element
```

```js
import "@card3d/element"; // registers <metal-card>
```

`@card3d/core` (with the engine's wasm builds) comes with it; there are no peer dependencies. In Vue, tell the compiler it is a custom
element: `compilerOptions.isCustomElement = (tag) => tag === "metal-card"`. For React, use
[`@card3d/react`](../react).

## The design

| attribute | what |
| --- | --- |
| `design` | design JSON, as Card Studio's Embed / "Design JSON" export writes it (inline images included) |
| `share` | a Card Studio share link, its `#d=…` hash, or just the token |
| `src` | URL of a design JSON (e.g. a saved `.card.json`) |
| `preset` | a preset id, e.g. `pearl-guilloche`, `hero-black`, `sunset-mesh` (`CARD_PRESETS` in @card3d/core) |
| `material`, `texture`, `pattern`, `color` | recipe overrides: `silver` `nickel` `titanium` `brass` `oxide` `carbon` `glass`; `brushed`, `guilloche`, …; `orbit`; `#rrggbb` |
| `name`, `bio` | the cardholder name and bio line |
| `font` | `inter` (default), `manrope`, `space-grotesk`, `unbounded`, `playfair`, `plex-mono` (or the name: "Playfair Display"); any Google Fonts family as `google:<Family>[@<weight>]`, e.g. `google:Fraunces` or `google:Playfair Display@900` (fetched from fonts.googleapis.com when the card starts, which sends your visitors' IP addresses to Google; if that matters for your site (GDPR), self-host the file and use `font-url`); or, with `font-url`, the family name of that file |
| `font-url` | a web font file (woff2, woff, ttf, otf): an https URL (its server must allow CORS) or a path on your own site, e.g. `font="Brand Sans" font-url="/fonts/brand-sans.woff2"`. A font that can't be loaded falls back to Inter and fires `metal-card-error` |
| `lighting` | `studio` (default), `dramatic`, `warm`, `cool`, `dark`, `light` |
| `environment` | light the card with an HDRI: `softbox`, `cyclorama`, `loft`, `warm-hall`, `sunset` (CC0, Poly Haven; served from `environments/` next to the bundle), the URL of an equirectangular `.hdr`, or `studio` (the default: the built-in studio light rig, no HDRI) |
| `floor` | stand the card on a reflective floor with a soft contact shadow: `floor`, or a reflectivity `floor="0.7"` (0–1); `floor="false"` removes a design's floor |

The base design is the most specific one given: the `design` **property** › `design` › `share` › `src` ›
`preset` › the default card. The overrides apply on top of it. Every design is validated like Card
Studio's own share links (unknown values dropped, numbers clamped); a source that can't be read is
skipped with a console warning and a `metal-card-error` event. Custom face shaders are WGSL and run as
written: embed designs you trust. A custom face shader layer in GLSL (from designs made for the earlier
three.js engine) is skipped: the rest of the card draws, and the element fires `metal-card-error` once
per design.

A design's `scene` (Card Studio's **Scene** panel) is staged too: the environment and floor above, plus a
backdrop (`sweep`, `gradient` or the blurred `environment`). Scenes load on first use: a page whose cards
have none never downloads them. The floor keeps transparency; a backdrop fills the element.

A design can also carry the card body and typography fields Card Studio writes: `shape` (corner
radius, `orientation: "portrait"`, `cutouts`: `lanyard`, `notch`, `window`), `edge` (`metal`,
`anodized` or `match`, a `color`, a `chamfer`), `finish` (per mark: `embossed`, `engraved`, `etched`),
`contactless` and up to three `textLines`. A portrait card wants a portrait box, e.g.
`style="width: 300px; aspect-ratio: 5 / 8"`.

The `design` property takes an object (or JSON), and reads back the resolved design:

```js
const card = document.querySelector("metal-card");
card.design = { recipe: { material: "oxide", color: "#2b4a6f" }, cardholderName: "Grace Hopper" };
```

## Behaviour

| attribute | what |
| --- | --- |
| `interaction` | `drag` (default): drag to turn, click or Enter to flip, double-click or Esc to reset. `turntable`: drag (or ←/→) spins it about its vertical axis, with momentum; click to flip; vertical page scrolling still works over it. `none`: a still card |
| `auto-rotate` | spin continuously: `auto-rotate` (20°/s) or `auto-rotate="45"` (degrees per second, negative = the other way). Pauses while you interact |
| `quality` | `full` (default: up to 2× pixel ratio, finer textures) or `performance` (cheaper: grids, phones) |
| `fit` | `contain` (default): the card fills the element with a small margin at rest, and the camera backs off only as far as a turn or tilt needs to keep every corner in view. `studio`: Card Studio's fixed camera (the card about 65 % of the width, room for a full turn). Also the `fit` property |
| `lazy` | default on: the card starts only when it comes within 200 px of the viewport. `lazy="false"` starts it at once |
| `paused` | stop rendering and animating |
| `label` | accessible name (default "‹name›, 3D metal card") |
| `backdrop` | paint the lighting preset's backdrop behind the card (the canvas is otherwise transparent) |
| `ar` | a **View in AR** button where the device has an AR viewer: iPhone and iPad (AR Quick Look; the USDZ is made from the card on screen, real size, when tapped) and Android with `ar-src`. Hidden on desktop. The exporter loads only on the tap |
| `ar-src` | a hosted `.glb` for Android's Scene Viewer (it downloads the model itself, so it must be a public https URL; Card Studio's **View in AR…** exports one) |
| `ios-src` | a hosted `.usdz` to open instead of making one in the page |

- **Off screen** the card stops rendering (and in background tabs); it resumes where it was.
- **Reduced motion**: with `prefers-reduced-motion: reduce`, no auto-rotation, flips are instant and
  animated shaders hold still.
- **Accessible**: the element is a focusable button (`role="img"` with `interaction="none"`) with an
  `aria-label` that says which side is showing; the canvas is `aria-hidden`.
- **Size** it with CSS: it is `inline-block`, 360 px wide by default at an 8:5 aspect ratio
  (`width: 100%` fills its container). The canvas follows it (ResizeObserver).
- **Removing it** releases everything: the GPU context, observers and listeners.
- `::part(canvas)`, `::part(backdrop)` and `::part(ar-button)` style the internals.
- **AR limits**: the model is the card at ISO size (85.60 × 53.98 × 0.76 mm, portrait and cutouts
  included) with its faces baked into colour, roughness / metalness and normal maps: holo foils and
  face shaders become a static texture (their look face-on) and an animated card exports the frame on
  screen.

### Many cards on a page

Every live card has its own GPU context (a WebGL one on browsers without WebGPU), and browsers allow a page about 16 WebGL contexts (past that, the oldest is
lost). `<metal-card>` keeps at most **12** live at once (`MetalCardElement.maxContexts`): a card only takes
a context near the viewport, and when another needs one, the card that left the viewport longest ago
hands its context over, leaving its last frame on screen as a still. It rebuilds when it scrolls back.
If more than 12 are visible at once, the extra ones wait for a free context. Use `quality="performance"`
for grids, and lower the limit if your page has other WebGL:

```js
customElements.get("metal-card").maxContexts = 8;
```

## API

- `card.design` (get: the resolved design; set: an object or JSON), `card.fit` (`"contain"` | `"studio"`), `card.stage` (the live
  stage, an `EngineStage` from `@card3d/core`, or null without a context; `stage.exportAr()` makes the AR
  model), `card.ready`, `card.flip()`, `card.reset()`, `card.viewInAr()`
  (from a user gesture; resolves false where there is no AR viewer).
- Events: `metal-card-ready` (`detail: { design, stage }`) whenever a design is on screen,
  `metal-card-ar` (`detail: { viewer: "quick-look" | "scene-viewer", url }`), `metal-card-error`
  (`detail: { message }`).
- `register(tag?)` defines the element under another name; importing the package registers
  `metal-card`. Importing under Node (SSR) is a no-op.
- `resolveDesign(sources)` and the attribute parsers are exported too.
- The CDN bundle also exports the design model (`@card3d/core/model`: `ensureDesign`, presets, share
  tokens, fonts…), `createEngineStage` and `engineDraws`; `await loadMarquee()` gives the marquee
  (`@card3d/core/marquee`).

## For AI agents

This package ships an agent skill, `embed-metal-card` (`skills/`), and `@card3d/core` ships the design
model's; with [TanStack Intent](https://github.com/TanStack/intent):
`pnpm dlx @tanstack/intent@latest load @card3d/element#embed-metal-card`.

## Licence

MIT. The card engine includes code ported from three.js and drei (MIT), Earcut (ISC) and Paper Shaders
(Apache-2.0), and the card fonts are under the SIL Open Font License 1.1; see `THIRD_PARTY_NOTICES.md`.
