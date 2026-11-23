# @card3d/react

`<MetalCard>`: a 3D metal card for React, a thin wrapper around the [`<metal-card>`](../element) custom
element. Design one in [Card Studio](https://card-studio.pages.dev), then **Export → Embed… → React**.

## Install

```sh
pnpm add @card3d/react
```

`react` (18 or 19) is the only peer dependency.

## Usage

```tsx
import { MetalCard } from "@card3d/react";

export function Hero() {
  return (
    <MetalCard
      design={{ recipe: { material: "brass", texture: "guilloche", color: "#e8c27a" }, cardholderName: "Ada Lovelace" }}
      autoRotate
      style={{ width: 480 }}
    />
  );
}
```

Props mirror the element's attributes: `design` (an object, or JSON), `share` (a Card Studio share link
or token), `src`, `preset`, `material`, `texture`, `pattern`, `color`, `name`, `bio`, `font`, `fontUrl` (the element's `font-url`), `lighting`,
`interaction` (`"drag"` | `"turntable"` | `"none"`), `autoRotate` (`true` or degrees per second),
`quality`, `fit` (`"contain"`, the default, fills the box; `"studio"` is Card Studio's camera), `lazy`, `paused`, `label`, `backdrop`, plus `className`, `style`, `onReady` and `onError`.
The `ref` is the `<metal-card>` element (`ref.current.flip()`, `.reset()`, `.stage`).

It renders `<metal-card>` on the server too (no GPU there); the card starts on the client when it
scrolls into view. The module is marked `"use client"`. See the
[element's README](../element/README.md) for behaviour: lazy start, pausing off screen, reduced motion
and the GPU context limit.

## For AI agents

This package ships an agent skill, `metal-card-react` (`skills/`); `@card3d/element` and
`@card3d/core` ship theirs. With [TanStack Intent](https://github.com/TanStack/intent):
`pnpm dlx @tanstack/intent@latest load @card3d/react#metal-card-react`.

## Licence

MIT.
