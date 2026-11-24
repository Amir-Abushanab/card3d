---
name: metal-card-react
description: 'Use when rendering a 3D metal card in a React, Next.js or Remix
  app with <MetalCard> from @card3d/react: its props (design object or JSON,
  share, src, preset, overrides, interaction, autoRotate, fit, quality, lazy,
  paused), onReady and onError, the ref to the underlying <metal-card> element
  (flip, reset, stage, viewInAr), server rendering and "use client", and the
  element attributes the component does not expose (ar, environment, floor). For
  the element behaviour see embed-metal-card; for the design JSON see
  card-design-json.'
metadata:
  purpose: "Use the <metal-card> element from React through the thin <MetalCard>
    wrapper, including SSR and imperative control."
  type: framework
  framework: react
  domain: embedding
  library: "@card3d/react"
  library_version: "0.1.2"
requires:
  - "@card3d/element#embed-metal-card"
sources:
  - src/index.tsx
  - README.md
---

# `<MetalCard>` (React)

`<MetalCard>` renders the `<metal-card>` custom element from `@card3d/element` (installed with this
package). Its behaviour (lazy start, pausing off screen, reduced motion, the GPU context limit, AR,
serving the engine files) is the element's: see the `embed-metal-card` skill in `@card3d/element`.
The design object is a `CardDesign`: see `card-design-json` in `@card3d/core`.

## Setup

```sh
pnpm add @card3d/react
```

`react` 18 or 19 is the only peer dependency. In Card Studio, **Export → Embed… → React** gives a
ready component with the design inlined.

## Render a card

```tsx
import { MetalCard } from "@card3d/react";

const design = { recipe: { material: "silver", texture: "guilloche", pattern: "orbit", color: "#e8c27a" }, cardholderName: "Ada Lovelace" };

export function Hero() {
  return <MetalCard design={design} autoRotate fit="contain" style={{ width: "100%", maxWidth: 480 }} onError={(d) => console.warn(d.message)} />;
}
```

- `design`: an object (set as the element's property; a new object with the same content doesn't
  rebuild the card, the wrapper compares its JSON) or a JSON string. It wins over `share`, `src` and
  `preset`.
- `share` (a Card Studio share link or token), `src` (URL of a design JSON), `preset` (a
  `CARD_PRESETS` id). Overrides on top: `material`, `texture`, `pattern`, `color`, `name`, `bio`,
  `font`, `fontUrl` (the element's `font-url`), `lighting`.
- Behaviour: `interaction` (`"drag"` | `"turntable"` | `"none"`), `autoRotate` (`true` = 20°/s, or
  degrees per second), `quality` (`"full"` | `"performance"`), `fit` (`"contain"` default |
  `"studio"`), `lazy` (default true), `paused`, `label`, `backdrop`, plus `id`, `className`, `style`.
- `onReady(detail)` (`{ design, stage }`, each time a design is on screen) and `onError(detail)`
  (`{ message }`). Changing the callbacks never re-attaches listeners.
- Size it with CSS; the default is 360 px wide at 8:5.

## Control it through the ref

The ref is the `<metal-card>` element itself:

```tsx
import { useRef } from "react";
import { MetalCard, type MetalCardElement } from "@card3d/react";

export function FlipCard() {
  const card = useRef<MetalCardElement | null>(null);
  return (
    <>
      <MetalCard ref={card} preset="hero-black" name="Grace Hopper" />
      <button onClick={() => card.current?.flip()}>Flip</button>
      <button onClick={() => card.current?.reset()}>Reset</button>
    </>
  );
}
```

`card.current.stage` is the live `EngineStage` (null until the card has a GPU context): exports such
as `stage.exportAr({ format: "glb" })` are in the `engine-stage` skill of `@card3d/core`.

## Attributes the component doesn't expose

`ar`, `ar-src`, `ios-src`, `environment` and `floor` are not props. Put staging in the design
(`design.scene`: `environment`, `backdrop`, `floor`), and set the AR attributes on the element:

```tsx
import { useEffect, useRef } from "react";
import { MetalCard, type MetalCardElement } from "@card3d/react";

export function ArCard({ glbUrl }: { glbUrl: string }) {
  const card = useRef<MetalCardElement | null>(null);
  useEffect(() => {
    card.current?.setAttribute("ar", "");
    card.current?.setAttribute("ar-src", glbUrl); // Android's Scene Viewer needs a hosted GLB
  }, [glbUrl]);
  return <MetalCard ref={card} preset="pearl-guilloche" />;
}
```

## Server rendering

The module is marked `"use client"` and renders a bare `<metal-card>` on the server (no GPU there);
importing it under Node is safe. The card starts on the client when it scrolls into view; no
`dynamic(…, { ssr: false })` is needed. In the Next.js App Router a server component may render
`<MetalCard>` with serialisable props (a plain design object, strings, booleans); `onReady`,
`onError` and `ref` need a client component of your own (`"use client"`), since functions don't cross
the server / client boundary.

## Common mistakes

- Building a new design object from scratch every render is fine (compared by JSON), but a design
  holding multi-MB data-URL images is re-serialised each render: memoise it (`useMemo`) or host the
  images.
- Passing `onReady` / `onError` from a server component: functions can't be serialised; wrap the
  card in a client component.
- Expecting `environment` or `floor` props: use `design.scene`.
- `fontUrl` and `font` together: `font` is then the family name of that file.

## Completion

The card draws (`onReady` fires; `onError` doesn't), it hydrates without warnings, and imperative
calls go through the ref.
