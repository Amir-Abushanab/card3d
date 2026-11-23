# `<metal-card>` attributes and API

## Design sources (the most specific one wins)

| attribute / property | what |
| --- | --- |
| `design` property | an object (any design Card Studio can open) or its JSON; reads back the resolved `CardDesign` |
| `design` | design JSON, as Card Studio's **Export → Embed…** or **Design JSON** writes it (inline images included) |
| `share` | a Card Studio share link, its `#d=…` hash, or the bare token (uploads are not in links) |
| `src` | URL of a design JSON, e.g. a saved `.card.json` (fetched with `fetch`: same origin or CORS) |
| `preset` | a `CARD_PRESETS` id, e.g. `pearl-guilloche`, `hero-black`, `sunset-mesh`, `brass-orbit-guilloche` |

## Overrides (applied over the base design)

| attribute | values |
| --- | --- |
| `material` | `silver`, `nickel`, `titanium`, `brass`, `oxide`, `carbon`, `glass` (ids, not colours: the hue is `color`) |
| `texture` | `none`, `brushed`, `guilloche`, `crosshatch`, `hammered`, `sandblasted`, `pinpoint`, `linen`, `carbon-fiber` |
| `pattern` | `none`, `orbit` |
| `color` | `#rrggbb` or `#rgb` |
| `name`, `bio` | the cardholder name and bio line |
| `font` | `inter` (default), `manrope`, `space-grotesk`, `unbounded`, `playfair`, `plex-mono` (or the label, e.g. "Playfair Display"); `google:<Family>[@<weight>]` (e.g. `google:Fraunces`, `google:Playfair Display@900`); with `font-url`, that file's family name |
| `font-url` | a woff2 / woff / ttf / otf file: an https URL (with CORS) or a path on your site. A font that can't load falls back to Inter and fires `metal-card-error` |
| `lighting` | `studio` (default), `dramatic`, `warm`, `cool`, `dark`, `light` |
| `environment` | `softbox`, `cyclorama`, `loft`, `warm-hall`, `sunset` (bundled CC0 HDRIs), the URL of an equirectangular `.hdr`, or `studio` (the built-in light rig, no HDRI) |
| `floor` | a reflective floor with a contact shadow: `floor`, a reflectivity `floor="0.7"` (0–1), `floor="false"` removes a design's floor |

A design's own `scene` (Card Studio's **Scene** panel: environment, backdrop, floor) is staged too;
scenes load on first use. A floor keeps transparency; a backdrop fills the element.

## Behaviour

| attribute | default | what |
| --- | --- | --- |
| `interaction` | `drag` | `drag`: drag to turn, click or Enter to flip, double-click or Esc to reset. `turntable`: drag or ←/→ spins about the vertical axis with momentum, click flips, vertical page scrolling still works. `none`: a still card |
| `auto-rotate` | off | `auto-rotate` (20°/s) or degrees per second, negative the other way (±360 max). Pauses while you interact; off under reduced motion |
| `quality` | `full` | `full` (up to 2× pixel ratio) or `performance` |
| `fit` | `contain` | `contain`: fills the element and stays whole as it turns. `studio`: Card Studio's camera. Also the `fit` property |
| `lazy` | on | start only within 200 px of the viewport; `lazy="false"` starts at once |
| `paused` | off | stop rendering and animating |
| `label` | "‹name›, 3D metal card" | accessible name |
| `backdrop` | off | paint the lighting preset's backdrop behind the card |
| `ar` | off | **View in AR** button where available (iOS / iPadOS; Android with `ar-src`) |
| `ar-src` | | hosted `.glb` for Android's Scene Viewer (public https URL) |
| `ios-src` | | hosted `.usdz` to open instead of making one in the page |

Boolean attributes read `"false"`, `"0"`, `"off"` and `"no"` as false.

## Element API

- `card.design` (get / set), `card.fit`, `card.stage` (the live `EngineStage`, or null without a
  context), `card.ready`, `card.flip()`, `card.reset()`, `card.viewInAr()` (from a user gesture;
  resolves false where there is no AR viewer).
- Events: `metal-card-ready` (`detail: { design, stage }`), `metal-card-ar`
  (`detail: { viewer: "quick-look" | "scene-viewer", url }`), `metal-card-error` (`detail: { message }`).
- `MetalCardElement.maxContexts` (default 12) and `MetalCardElement.liveContexts`.
- `::part(canvas)`, `::part(backdrop)`, `::part(ar-button)` style the internals.
- Accessibility: a focusable button (`role="img"` with `interaction="none"`) whose `aria-label` says
  which side shows; the canvas is `aria-hidden`.
- Module exports: `register(tag?)` (importing registers `metal-card`), `MetalCardElement`,
  `resolveDesign(sources)` (the element's design resolution, without an element), the attribute
  parsers (`parseFont`, `parseFit`, …), and the types `CardDesign`, `EngineStage`, `MetalCardReadyDetail`.
- The CDN bundle also exports the design model (`ensureDesign`, `CARD_PRESETS`, share tokens, fonts…),
  `createEngineStage`, `engineDraws` and `loadMarquee()`:

```html
<script type="module">
  import { CARD_PRESETS } from "https://cdn.jsdelivr.net/npm/@card3d/element@0.1.0/dist/standalone/metal-card.js";
  for (const p of CARD_PRESETS.slice(0, 6)) {
    const card = document.createElement("metal-card");
    card.setAttribute("preset", p.id);
    document.body.append(card);
  }
</script>
```
