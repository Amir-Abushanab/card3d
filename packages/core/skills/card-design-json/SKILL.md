---
name: card-design-json
description: "Use when writing, editing, validating or explaining a Card Studio
  card design (the CardDesign JSON that @card3d/core, <metal-card> and
  <MetalCard> draw): picking a preset or recipe (material, colour, texture,
  grain, polish, relief, spectrum), holo foil, built-in face shader layers,
  add-ons, the card body (shape, edge, finish, contactless, text lines, logo),
  lighting and scene staging; checking a design with ensureDesign or lintDesign;
  reading or making Card Studio share links. For writing custom WGSL face
  shaders use custom-face-shaders-wgsl; for showing a card on a page use
  embed-metal-card."
metadata:
  purpose: "The design model every card3d host draws: what a CardDesign holds, how
    to write one that renders as intended, and how to validate untrusted designs
    and share links."
  type: core
  domain: design-model
  library: "@card3d/core"
  library_version: "0.1.1"
sources:
  - src/types.ts
  - src/design/**
  - src/describe/**
  - src/presets.ts
  - src/recipe/defaults.ts
---

# Card designs (`CardDesign` JSON)

A card is one JSON object, a `CardDesign`. Every host reads it through `ensureDesign`: the web
engine (`createEngineStage`), `<metal-card>`, `<MetalCard>`, Card Studio, and the Swift and Android
libraries (the same rules, in Rust). `ensureDesign` fills defaults, drops unknown fields and ids and
clamps numbers, so a design that loads can still differ from what was written. Check it with
`lintDesign`, which says what was dropped or clamped.

## Setup

```sh
pnpm add @card3d/core   # also installed as a dependency of @card3d/element and @card3d/react
```

- `@card3d/core/model`: types, defaults, presets, `ensureDesign`, share tokens (no engine; safe on a server).
- `@card3d/core/describe`: `lintDesign`, `describeDesignSpace()` (the whole design space as Markdown,
  generated from the installed version's catalogs) and `DESIGN_EXAMPLES`.

## 1. Start from a preset or an example

Pick the closest preset ([presets](references/presets.md)) or example
([examples](references/examples.md)) and change only what the request needs. A minimal design is a
recipe plus a name; every other field is optional and absent means the standard card:

```json
{
  "recipe": { "material": "silver", "color": "#e2c27a", "texture": "brushed", "grain": 40, "polish": 70, "relief": 40 },
  "cardholderName": "Ada Lovelace"
}
```

A preset as a whole design (its recipe plus, for effect presets, its shaders or add-ons):

```ts
import { defaultDesign, getPreset, presetExtras, presetRecipe } from "@card3d/core/model";

const preset = getPreset("brass-orbit-guilloche");
if (!preset) throw new Error("unknown preset");
const design = { ...defaultDesign(), recipe: presetRecipe(preset), ...presetExtras(preset) };
```

## 2. Write the recipe

Read [design fields](references/design-fields.md) before setting any field you haven't used here; it
lists every field, range and option of the installed version. The rules that trip people up:

- **Hue is `recipe.color`, for every material.** `material` sets the metal's character only, and the
  ids are internal names: `brass` is "Obsidian" (warm black, glassy), `titanium` is "Graphite",
  `nickel` is "Black nickel". Gold, bronze, copper and rose are `silver` with that `color`.
- **Flat metal needs `grain: 0` and `relief: 0`.** `texture: "none"` with the default grain (30) and
  relief (72) still renders brushed.
- Recipe numbers are 0–100 integers (`foilScale` 25–400). `polish` is gloss, `spectrum` an iridescent
  tint on the metal itself.
- Holo foil is a separate layer: `frontHolo: true`, then `holoStyle`, `foilTexture`, `foilIntensity`
  (15–35 reads as faint, 78 is the default). `matchHoloSides: true` (default) mirrors it on the back
  and ignores the `back*` fields.
- Textures are physical micro-textures: at card size most read as a sheen; the detail shows close up.

## 3. Add only the optional parts the request asks for

| want | field | details |
| --- | --- | --- |
| an animated or printed look the recipe can't do | `shaders` (≤ 8 layers) | built-ins in [shaders and add-ons](references/shaders-and-effects.md); own code: custom-face-shaders-wgsl |
| drifting lights and a glint (shine), growing vines | `addons` | [shaders and add-ons](references/shaders-and-effects.md) "Add-ons" |
| name / bio / logo engraved, embossed, etched | `finish` | [design fields](references/design-fields.md) "Card body and branding" |
| coloured edge, chamfer | `edge` | same |
| portrait, corner radius, lanyard slot, notch, window | `shape` | same; a portrait card wants a portrait box in the page |
| contactless mark, card number / extra lines | `contactless`, `textLines` (≤ 3) | same |
| own logo | `logo` (one SVG path + `viewBox`, or a raster `src` mask) | same |
| font | `font` (a `CARD_FONTS` id, or `{ "source": "google", "family": "Fraunces" }`) | "Lighting, scene and fonts" |
| lighting, HDRI, backdrop, floor | `lighting`, `scene` | same |
| artwork or stickers | `surfaceSources`, `surfaceTreatments`, `decals` | image URLs or data URLs; see below |

Images (`surfaceSources`, `decals[].src`, `logo.src`) are fetched by the page: a URL on another
origin must send CORS headers (`Access-Control-Allow-Origin`), or the image is skipped with a console
warning. Never put real people's or brands' names, logos or trademarks into a design you generate.

## 4. Validate

```ts
import { lintDesign } from "@card3d/core/describe";

const input = '{"recipe":{"material":"silver","color":"#e2c27a"},"cardholderName":"Ada Lovelace"}';
const { design, errors, warnings } = lintDesign(input); // an object or JSON text
for (const e of errors) console.error(`${e.path}: ${e.message}`); // fix these: the design isn't what was written
for (const w of warnings) console.warn(`${w.path}: ${w.message}`); // clamped values, likely mistakes
```

- `errors` empty means `design` is what was written (warnings list clamping). `design` is null when
  nothing could be read.
- `ensureDesign(input)` (`@card3d/core/model`) is the reader itself: it returns a complete
  `CardDesign` and throws only when the input isn't an object with recipe or design fields. Use it for
  untrusted input (uploads, URLs); use `lintDesign` while authoring.
- WGSL compile errors need a GPU: `lintDesign` reports annotation errors only (custom-face-shaders-wgsl).

## 5. Share links and files

- Card Studio's **Save & share → Copy share link** gives `https://card3d-studio.pages.dev/#d=<token>`
  (gzip + base64url of the design). `decodeDesignToken(linkOrHashOrToken)` returns a validated design;
  `encodeDesignToken(design)` resolves `{ token, stripped }`.
- Links leave inline uploads out (data-URL artwork and stickers, an uploaded font's file): `stripped`
  counts them. Use the design JSON (**Export → Embed… → Design JSON**, or **Save design (.json)**) to
  keep them, or host the images and reference them by URL.
- `ensureDesign` also reads a bare recipe object (`{ "material": "brass", … }` at the top level) and
  the older `ownerName` field.

## Common mistakes

- Setting `material: "brass"` for a gold card: renders near-black. Use `silver` with a gold `color`.
- `texture: "none"` without `grain: 0, relief: 0`: renders brushed, not flat.
- A custom shader layer without `"language": "wgsl"`: treated as legacy GLSL and skipped (the rest of
  the card draws; `engineDraws(design)` is false and `<metal-card>` fires `metal-card-error`).
- Unknown fields or misspelt ids: silently dropped by `ensureDesign`, reported by `lintDesign`. That
  includes keys older designs may still carry (`bespoke`, `bespokeParams`, `frontEffect`,
  `objectStyle`, `effectParams`): the card loads as the standard card; leave them out of new designs.
- Expecting a share link to carry uploaded images: it doesn't (see 5).

## Completion

`lintDesign` returns no errors and the warnings are understood; the design renders as described
(Card Studio's **Save & share → Open design (.json)**, or a `<metal-card design='…'>` on a page). Inside
the card3d repository, `pnpm finish check <file>` and `pnpm finish render <file>` do both from the
terminal.

To read the whole design space for the installed version (every preset, shader parameter and
example), print it from the project (`@card3d/core` must resolve from there: under pnpm, a direct
dependency):

```sh
node --input-type=module -e "import('@card3d/core/describe').then((m) => console.log(m.describeDesignSpace()))"
```
