<p align="center"><img src="apps/studio/public/favicon.svg" width="96" alt="Card Studio"></p>

<h1 align="center">Card Studio</h1>

Design 3D metal cards in your browser, then put them on any page, in an iOS, macOS or Android app, or
in front of a card maker. Card Studio is the editor; the cards are drawn by a Rust engine on wgpu
(WebGPU in the browser, with a WebGL 2 fallback; Metal, Vulkan or GLES natively) and ship as
`<metal-card>`, React's `<MetalCard>`, a TypeScript engine API, a Swift package and an Android
library. A card is one JSON design, so the same card looks the same everywhere.

Inspired by the 3D cards Ramp showcases on [ramp.design](https://ramp.design).

**[Open the studio](https://card3d-studio.pages.dev)** · [Packages](#quick-start) · [AI agents](#ai-agents) · [Contributing](#contributing) · [Docs](#docs)

## Features

- **Metals**: seven materials (silver, black nickel, graphite, obsidian, anodised, matte, clear glass)
  in any colour, eight surface textures (brushed, guilloché, crosshatch, hammered, sandblasted,
  pinpoint, linen, carbon fibre), gloss, relief, an iridescent spectrum, and 15 holographic foil styles.
- **Artwork and stickers**: inlaid or printed face artwork; stickers moved, resized, rotated and
  cropped right on the card, recoloured or tinted.
- **Face shaders**: eleven built-ins (thermal, liquid metal, caustics, lens, vinyl, wood, oil slick,
  gradient mesh, foil flakes, halftone, scanlines) or your own WGSL with live parameters.
- **Add-ons**: shine (drifting lights and a glint) and vines that grow over the card.
- **The card itself**: laid out to the ISO card standards (ID-1 size, chip contacts, embossing areas);
  corner radius within ISO/IEC 7810, portrait, a lanyard slot, a corner notch or a window; coloured or
  anodised edges and a chamfer.
- **Branding**: emboss, engrave or laser-etch the name, extra text lines, your logo (SVG or PNG) and a
  contactless mark, in one of six open-licence fonts or your own (an upload, any Google Font, a web
  font URL).
- **Light and stage**: six lighting presets; product shots with HDRI environments, a seamless sweep
  or gradient backdrop, and a reflective floor with a contact shadow.
- **Export**: images; video or GIF along a camera path (spin, orbit, hero push-in, flip reveal, glint
  pass, floating hover); glTF; real-size USDZ / GLB for AR (View in AR on iPhone, iPad and Android);
  code and embed snippets; and **Print files…**, a production package for a card maker (flat artwork
  with bleed, 1-bit separation plates and SVGs, an ISO dieline with keep-outs, a print-ready PDF, a
  proof and `spec.json`, with preflight and vendor presets).

## Quick start

The packages aren't on npm yet; the snippets below work once they are (until then, build them from
this repository: [Contributing](#contributing)).

| you want | use |
| --- | --- |
| a card on any page, no build step | [`<metal-card>` from a CDN](#from-a-cdn) |
| a card in Vue, Svelte, Angular, Astro or plain HTML with a bundler | [`@card3d/element`](#with-a-bundler) |
| a card in React or Next.js | [`@card3d/react`](#react) |
| your own viewer, editor or exports | [the engine API, `@card3d/core`](#the-engine-api) |
| an iOS, iPadOS or macOS app | [the Swift package](./apple/README.md) |
| an Android app | [the Android library](./android/README.md) |

The fastest way to a snippet: design a card in the studio, then **Export → Embed…** copies one for
the CDN, npm or React, with the design in it.

### From a CDN

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@card3d/element@0.1/dist/standalone/metal-card.js"></script>

<metal-card preset="brass-orbit-guilloche" name="Ada Lovelace" auto-rotate style="width: 480px"></metal-card>
<metal-card share="https://card3d-studio.pages.dev/#d=H4sIA…"></metal-card>   <!-- a studio share link -->
<metal-card preset="pearl-guilloche" environment="softbox" floor ar></metal-card>  <!-- HDRI, floor, View in AR -->
```

One script of 118.5 KB (40.0 KB gzipped) plus the card engine, which it loads from `engine/` next to
it: one of two wasm builds (166 KB gzipped for WebGPU, 793 KB for the WebGL 2 build other browsers
get) and a few KB per optional part a design uses. `metal-card.iife.js` is the classic-script build;
unpkg serves the same paths. Pin an exact version in production. Self-hosting, MIME types and
Content-Security-Policy are in the [element's README](./packages/element/README.md).

### With a bundler

```sh
pnpm add @card3d/element
```

```js
import "@card3d/element"; // registers <metal-card>

document.querySelector("metal-card").design = {
  recipe: { material: "oxide", color: "#2b4a6f" },
  cardholderName: "Grace Hopper",
};
```

A card takes its design from the `design` property or attribute (JSON), `share` (a studio share
link), `src` (a design JSON URL) or `preset`, with `material`, `color`, `name`, `font`, `lighting` …
on top. It starts when scrolled into view, pauses off screen, respects reduced motion, and keeps the
page's GPU contexts bounded. In Vue, declare it a custom element
(`compilerOptions.isCustomElement = (tag) => tag === "metal-card"`). Every attribute:
[packages/element](./packages/element/README.md).

### React

```sh
pnpm add @card3d/react
```

```tsx
import { MetalCard } from "@card3d/react";

export function Hero() {
  return (
    <MetalCard
      design={{ recipe: { material: "silver", texture: "guilloche", color: "#e8c27a" }, cardholderName: "Ada Lovelace" }}
      autoRotate
      style={{ width: 480 }}
    />
  );
}
```

Server rendering works (the card starts on the client). See [packages/react](./packages/react/README.md).

### The engine API

For your own page, editor or export pipeline (PNG, video frames, AR models, print rasters):

```sh
pnpm add @card3d/core
```

```ts
import { createEngineStage, ensureDesign } from "@card3d/core";

const canvas = document.querySelector("canvas")!; // size it with CSS; the stage follows it
const stage = createEngineStage(canvas, { quality: "full" });
await stage.setDesign(
  ensureDesign({
    recipe: { material: "silver", texture: "guilloche", pattern: "orbit", color: "#e8c27a" },
    cardholderName: "Ada Lovelace",
    font: "space-grotesk", // a CARD_FONTS id
    logo: { path: "M0 0H48L24 40Z", viewBox: [48, 40] },
    lighting: "warm", // a LIGHTING_PRESETS id
  }),
);
// stage.flip(), stage.setPaused(true), stage.exportAr({ format: "usdz" }), stage.dispose()
```

`createOffscreenStage` draws frames on demand for exports; `@card3d/core/print` bakes print
rasters; `@card3d/core/marquee` is the card carousel. See
[packages/core](./packages/core/README.md).

### iOS, macOS and Android

The same engine, natively: a SwiftUI `CardView` over Metal ([apple/](./apple/README.md)) and an
Android `CardView` on Vulkan or GLES ([android/](./android/README.md)). Both take the same design
JSON and validate it the way the web does.

```swift
@State private var stage = CardStage(options: .init(quality: .performance, fit: .contain))

var body: some View {
    CardView(stage: stage).task { try? await stage.setDesign(json: json) }
}
```

```kotlin
val stage = CardStage(context, CardStage.Options(quality = CardQuality.PERFORMANCE, fit = CardFit.CONTAIN))
findViewById<CardView>(R.id.card).stage = stage
lifecycleScope.launch { stage.setDesign(json) }
```

## Designs

A design is one JSON object, a `CardDesign`: a `recipe` (material, colour, texture, foil), the
cardholder's name and bio, and optional parts (face shader layers, add-ons, stickers and artwork, the
card's shape and edge, text lines, a logo, a font, lighting and a scene). Absent parts leave the
standard card.

- **Get one from the studio**: **Save & share → Copy share link** (a `#d=` link; it leaves inline
  uploads out), **Save design (.json)**, or the **Design JSON** tab of **Export → Embed…**.
- **Use it**: `share="…"`, `src="design.json"`, the `design` attribute or property, `stage.setDesign`,
  or `setDesign(json:)` natively.
- **Validate it**: every host reads designs through `ensureDesign` (`@card3d/core/model`), which fills
  defaults, drops unknown values and clamps numbers, so untrusted designs are safe to load.
  `lintDesign` (`@card3d/core/describe`) says what it changed. In this repository,
  `pnpm finish check design.json` lints a file and prints studio links.
- **Write one**: `describeDesignSpace()` (`@card3d/core/describe`) prints every field, range, preset
  and shader parameter, generated from the engine's catalogs; the `card-design-json` agent skill
  carries the same tables.

Custom face shaders are WGSL and run as written: only embed designs you trust.

## AI agents

The packages ship [Agent Skills](https://agentskills.io) for your coding agent, versioned with the
code (via [TanStack Intent](https://github.com/TanStack/intent)):

| package | skill | for |
| --- | --- | --- |
| `@card3d/core` | `card-design-json` | writing and validating designs; presets, fields, shaders, add-ons (generated from the engine's catalogs); share links |
| `@card3d/core` | `custom-face-shaders-wgsl` | custom WGSL face shaders: the prelude, `@param` annotations, errors, porting GLSL |
| `@card3d/core` | `engine-stage` | `createEngineStage`, offscreen frames, video, AR and print exports, bundling and serving the engine |
| `@card3d/element` | `embed-metal-card` | `<metal-card>` from a CDN or npm, attributes, events, many cards, self-hosting and CSP |
| `@card3d/react` | `metal-card-react` | `<MetalCard>`: props, the ref, server rendering |

In your project, after installing a package:

```sh
pnpm dlx @tanstack/intent@latest install   # once, interactive: pick the packages whose skills your agent may
                                           # load; writes the loading guidance into AGENTS.md
pnpm dlx @tanstack/intent@latest list      # the skills your dependencies ship
pnpm dlx @tanstack/intent@latest load @card3d/element#embed-metal-card   # print one
```

Installing `@card3d/element` or `@card3d/react` brings `@card3d/core`'s skills too. Claude Code reads
`CLAUDE.md`, not `AGENTS.md`: add the line `@AGENTS.md` to your `CLAUDE.md` so it picks up the
guidance, and optionally run `intent hooks install --agents claude` for a hook that surfaces and
enforces skill loading.

**In this repository** (contributors), Claude Code has `/describe-finish`: run
`/describe-finish smoked bronze with a fine hairline brush and a faint oil-slick holo` and the
skill (`.claude/skills/describe-finish`) reads the design space (`pnpm finish describe`), writes and
validates a design (`pnpm finish check`), renders and inspects previews (`pnpm finish render`; once:
`pnpm --filter card-studio e2e:install`) and hands back a studio link and the JSON. No API key needed.
The studio's own "Describe…" button is behind a feature flag ([DEPLOY.md](./DEPLOY.md)).

Maintaining the shipped skills: they live in `packages/<pkg>/skills/`, their planning records in
`_artifacts/`. `pnpm skills:refs` regenerates the references built from the engine's catalogs,
`pnpm check:skills` checks they are current and runs `intent validate` (part of `pnpm check`; it also
typechecks every TypeScript example), and `pnpm skills:stale` asks Intent for stale skills (online).

## Contributing

### Toolchain

- **Node 26** (what CI uses) and **pnpm** (the version is pinned in `package.json`'s `packageManager`).
- **Rust** (CI uses 1.100.0) with the `wasm32-unknown-unknown` target, plus the tools
  `crates/card3d-web/build-web.sh` names: `wasm-bindgen-cli` 0.2.130,
  `wasm_split_cli_support` 0.2.5 (`--features build-binary`, gives `wasm-split-cli`), `wasm-opt`
  (binaryen; CI uses version_133) and `brotli` for its size report.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130
cargo install wasm_split_cli_support --version 0.2.5 --features build-binary --locked
brew install binaryen brotli   # or your platform's packages
```

- For the native hosts: Xcode (`apple/`), or the Android SDK with an NDK and JDK 17+ (`android/`).

### Run it

```sh
pnpm install
crates/card3d-web/build-web.sh   # the engine's two web builds into packages/core/wasm/ (once, and after Rust changes)
pnpm dev                         # the studio at http://localhost:5180, the marquee showcase at /showcase.html
pnpm check                       # format, lint, typecheck, knip, module boundaries, Rust crates' notices, agent skills, unit tests
pnpm format                      # oxfmt (pnpm lint: oxlint; pnpm knip; pnpm depcruise: dependency-cruiser)
pnpm e2e                         # end-to-end tests of the built studio and embeds (once: pnpm --filter card-studio e2e:install)
pnpm build:packages              # the publishable @card3d packages (tsdown) and their CDN bundles
pnpm pack:check                  # what each package would ship (packs to a temp dir; publishes nothing)
pnpm --filter card3d-embed-example serve   # the built CDN bundle on plain pages, served CDN-style
```

`pnpm check` is what CI's TypeScript job runs. The configs: `.oxfmtrc.json` (Prettier-style, 160
columns; Markdown and HTML are left as written), `.oxlintrc.json`, `knip.jsonc` and
`.dependency-cruiser.cjs` (the package boundaries: no cycles, packages never import apps, the wrappers
use only `@card3d/core`'s entry points, no three.js outside `crates/card3d-tools`). `pnpm deps:outdated`
lists newer dependencies and `pnpm deps:update` applies them (npm-check-updates, `.ncurc.cjs`), both
with the same 3-day cooldown as `pnpm install`.

The Rust side: `pnpm check:rust` (`scripts/check-rust.sh`: the Rust lints and checks; needs the cargo
tools it names), `cargo test --workspace`, `cargo clippy --workspace --all-targets`. The comparison
harness renders every test design and preset with each backend and compares them:
`node crates/card3d-tools/compare.mjs [--web] [--webgl] [--only <names>]` (in a fresh clone it checks
the web builds against the native render). Native:
`apple/build-xcframework.sh` and `apple/test.sh`; `android/build.sh` and `android/test.sh`. CI runs all
of this ([DEPLOY.md](./DEPLOY.md)).

### Changes and releases

- A PR that changes a published package adds a changeset: `pnpm changeset` (CI warns when one is
  missing; `pnpm changeset --empty` when the change needs no release).
- Merged changesets collect in a "chore: version packages" PR; merging it publishes the new versions to
  npm from CI once CI passes on `main` (trusted publishing, with provenance). [DEPLOY.md](./DEPLOY.md)
  has the flow and the one-time setup.
- Changing a package's sources, its README or the engine reopens the review of the agent skills that
  cover them (TanStack Intent, [AGENTS.md](./AGENTS.md)): the Check Skills PR check fails until the review
  is recorded (`pnpm exec intent maintainer review`, then commit `.intent/review-state.json`).

### Layout

| path | what |
| --- | --- |
| `packages/core` | `@card3d/core`: the engine's web builds and their TypeScript page side, the design model (recipes, presets, validation, share tokens), fonts, environments, AR and print exports, the marquee; agent skills in `skills/` |
| `packages/element` | `@card3d/element`: `<metal-card>` and its single-file CDN bundles |
| `packages/react` | `@card3d/react`: `<MetalCard>`, a thin wrapper around the element |
| `apps/studio` | Card Studio (Tweakpane and custom pickers), the marquee showcase, the `pnpm finish` CLI and the Playwright e2e tests |
| `apps/embed-example` | minimal pages using the built CDN bundle |
| `crates/` | the engine (`card3d-engine`), its web binding (`card3d-web`), the native C ABI (`card3d-ffi`), a native host (`card3d-native`) and the comparison tools (`card3d-tools`) |
| `apple/`, `android/` | the Swift package and the Android library |
| `scripts/` | pack check, notices, publishing and the Version PR guard, skill references and versions |
| `_artifacts/`, `.intent/` | planning and review records for the shipped agent skills (not shipped) |

## Docs

- [DEPLOY.md](./DEPLOY.md): CI, the Cloudflare Pages deploy, releases to npm, the agent skills' checks.
- The packages: [core](./packages/core/README.md), [element](./packages/element/README.md),
  [react](./packages/react/README.md); natively: [apple](./apple/README.md), [android](./android/README.md).

## Local material

An optional local folder, `.reference/` (gitignored), can hold an asset pack (served at `/@ref/` by
the dev server) and a dev-only studio plugin (`.reference/studio-plugin.ts`, see
`apps/studio/src/local-plugin.ts`). Neither is ever committed or shipped, and nothing needs them: the
public build uses its own procedural card and chip, a generic mark and Inter.

## License

[MIT](./LICENSE). The card engine includes code ported from three.js (MIT), drei (MIT) and Earcut
(ISC). The liquid-metal shader is ported from Paper Shaders (Apache-2.0), and the card fonts (Inter,
Manrope, Space Grotesk, Unbounded, Playfair Display, IBM Plex Mono) are under the SIL Open Font
License 1.1; the scene environments are CC0 HDRIs from Poly Haven. See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
