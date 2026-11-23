---
"@card3d/core": minor
"@card3d/element": minor
"@card3d/react": minor
---

Agent skills ([TanStack Intent](https://github.com/TanStack/intent)) ship in each package's `skills/`: `card-design-json` (the design model, with field tables, presets and examples generated from the engine's catalogs), `custom-face-shaders-wgsl` and `engine-stage` in `@card3d/core`; `embed-metal-card` in `@card3d/element`; `metal-card-react` in `@card3d/react`. In a project that uses them: `pnpm dlx @tanstack/intent@latest list`, then `load @card3d/core#card-design-json` (or another skill).
