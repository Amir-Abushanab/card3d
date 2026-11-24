---
name: embed-metal-card
description: "Use when putting a 3D metal card on a web page with the
  <metal-card> custom element from @card3d/element, by CDN script tag or npm, in
  plain HTML, Vue, Svelte, Angular, Astro or another non-React stack: choosing
  the design source (design JSON, Card Studio share link, src URL, preset) and
  attribute overrides, sizing and fit, interaction and auto-rotate, View in AR,
  scene environment and floor, the metal-card-ready / metal-card-error events,
  many cards on one page and the GPU context limit, self-hosting the bundle,
  serving wasm and Content-Security-Policy. For React use metal-card-react; for
  the design JSON itself use card-design-json."
metadata:
  purpose: "Embed Card Studio designs as live 3D cards on any page with the
    <metal-card> element, served from a CDN, a bundler or your own host."
  type: core
  domain: embedding
  library: "@card3d/element"
  library_version: "0.1.0"
sources:
  - src/**
  - README.md
  - vite.standalone.config.ts
---

# `<metal-card>`

A drop-in 3D metal card. It starts when scrolled near the viewport, pauses off screen and in hidden
tabs, respects reduced motion, and keeps the page's GPU contexts bounded. The design JSON it draws is
covered by the `card-design-json` skill in `@card3d/core` (installed with this package).

## Setup

From a CDN, one module script (118.5 KB, 40.0 KB gzipped) plus the engine it loads from `engine/`
next to it (about 166 KB gzipped of wasm with WebGPU, 793 KB for the WebGL 2 build other browsers
get, and a few KB per optional part a design uses):

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@card3d/element@0.1.0/dist/standalone/metal-card.js"></script>

<metal-card preset="brass-orbit-guilloche" name="Ada Lovelace" auto-rotate style="width: 480px"></metal-card>
```

- Pin an exact version in production. unpkg serves the same paths
  (`https://unpkg.com/@card3d/element@<version>/dist/standalone/metal-card.js`).
- Without modules: `<script src="…/dist/standalone/metal-card.iife.js" defer></script>` (also defines
  a `MetalCard` global).

With a bundler:

```sh
pnpm add @card3d/element
```

```ts
import "@card3d/element"; // registers <metal-card>; a no-op under Node (SSR)
```

- Vue: `compilerOptions.isCustomElement = (tag) => tag === "metal-card"`. Angular: add
  `CUSTOM_ELEMENTS_SCHEMA` to the component. Svelte, Astro, Lit and plain HTML need nothing.
- React: use `@card3d/react` (metal-card-react).
- Vite dev server: if engine or font files 404 in dev, exclude the engine from dependency
  pre-bundling: `optimizeDeps: { exclude: ["@card3d/core"] }`.

## 1. Give it a design

The quickest path: design the card in Card Studio, then **Export → Embed…** copies a snippet (CDN,
npm or React) that carries the design. By hand, the base design is the most specific one given:

`design` property › `design` attribute (JSON) › `share` (a Card Studio share link, its `#d=…` hash,
or the token) › `src` (URL of a design JSON) › `preset` › the default card.

```html
<metal-card share="https://card3d-studio.pages.dev/#d=H4sIA…"></metal-card>
<metal-card src="/cards/ada.card.json"></metal-card>
<metal-card design='{"recipe":{"material":"silver","color":"#e2c27a"},"cardholderName":"Ada Lovelace"}'></metal-card>
```

```ts
const card = document.querySelector("metal-card")!;
card.design = { recipe: { material: "oxide", color: "#2b4a6f" }, cardholderName: "Grace Hopper" };
```

On top of the base, the override attributes apply: `material`, `texture`, `pattern`, `color`,
`name`, `bio`, `font` (+ `font-url`), `lighting`, `environment`, `floor`. Every design is validated
like a Card Studio share link (unknown values dropped, numbers clamped). A source that can't be read
is skipped with a console warning and a `metal-card-error` event, and the next one is used.

Every attribute, its values and defaults: [attributes and API](references/attributes.md).

## 2. Size and behaviour

- Size it with CSS: `inline-block`, 360 px wide at 8:5 by default; `width: 100%` fills its container.
  A portrait design (`shape.orientation: "portrait"`) wants a portrait box
  (`style="width: 300px; aspect-ratio: 5 / 8"`).
- `fit="contain"` (default) fills the box; `fit="studio"` is Card Studio's camera.
- `interaction`: `drag` (default), `turntable` (spins about the vertical axis; page scrolling still
  works over it) or `none`. `auto-rotate` or `auto-rotate="45"` (degrees per second).
- `quality="performance"` for grids and phones; `full` is the default.
- `backdrop` paints the lighting preset's backdrop; otherwise the canvas is transparent.

## 3. Events and scripting

```ts
import type { MetalCardElement, MetalCardReadyDetail } from "@card3d/element";

const card = document.querySelector<MetalCardElement>("metal-card")!;
card.addEventListener("metal-card-ready", (e) => {
  const { stage } = (e as CustomEvent<MetalCardReadyDetail>).detail;
  console.log("drawn with", stage.backend); // "webgpu" | "webgl"
});
card.addEventListener("metal-card-error", (e) => console.warn((e as CustomEvent<{ message: string }>).detail.message));
card.flip();
```

`metal-card-ready` fires whenever a design is on screen (again after each design change).
`card.stage` is the live `EngineStage` (null while the card has no GPU context); see the
`engine-stage` skill in `@card3d/core` for what it can do.

## 4. AR, many cards, serving

- `ar` shows a **View in AR** button where the device has a viewer: iPhone and iPad (a USDZ made from
  the card on screen when tapped, or `ios-src`), Android only with `ar-src` (a GLB at a public https
  URL; Card Studio's **Export → View in AR…** makes one). Hidden on desktop. `card.viewInAr()` does the
  same from your own button's click.
- At most 12 cards hold a live GPU context at once (`customElements.get("metal-card").maxContexts`);
  the one that left the viewport longest ago hands its context over and keeps its last frame as a
  still. Lower the limit if the page has other WebGL.
- Self-hosting, MIME types, caching and Content-Security-Policy: read
  [serving and CSP](references/serving-and-csp.md) before deploying.

## Common mistakes

- Self-hosting only `metal-card.js`, or renaming it: copy the whole `dist/standalone/` folder and keep
  the names (the chunks import `./metal-card.js`, the engine loads from `engine/`).
- Writing a design as an HTML attribute with double quotes inside double quotes: wrap the JSON in
  single quotes and escape `'` as `&#39;` and `&` as `&amp;`, or set the `design` property instead.
- Images on another origin without CORS headers: they are skipped (console warning).
- A custom WGSL layer in a design from an untrusted source: face shaders run as written; only embed
  designs you trust. Legacy GLSL layers are skipped with one `metal-card-error`.
- `font="google:Fraunces"` fetches from fonts.googleapis.com when the card starts, which sends
  visitors' IP addresses to Google; self-host the file with `font-url` where that matters (GDPR).
- Expecting `auto-rotate` under `prefers-reduced-motion: reduce`: it stays off, flips are instant.

## Completion

The card draws (a `metal-card-ready` event; no `metal-card-error` in the console), `.wasm` responses
are `application/wasm`, and the page works in a browser without WebGPU (the WebGL 2 build).
