---
name: custom-face-shaders-wgsl
description: 'Use when writing, porting or debugging a custom WGSL face shader
  layer on a Card Studio card (@card3d/core): a FaceShader with id "custom" and
  language "wgsl", the prelude it runs in (mainImage, uTime, uTilt, facePos,
  viewDir, chipDistance, artwork), // @param and // @color annotations that
  become params, skin vs overlay targets and blends, and annotation or compile
  errors from lintDesign, EngineStage.checkShader or shaderErrors. Also when
  converting a GLSL or Shadertoy shader for the card. For the built-in shader
  library and the rest of the design use card-design-json.'
metadata:
  purpose: "Write custom WGSL face shader layers that compile on the card engine
    (WebGPU and its WebGL 2 build), expose editable parameters, and stay cheap
    enough for phones."
  type: core
  domain: face-shaders
  library: "@card3d/core"
  library_version: "0.1.1"
requires:
  - card-design-json
sources:
  - src/shaders/**
  - src/design/sanitize.ts
  - Amir-Abushanab/card3d:crates/card3d-engine/shaders/face/prelude.wgsl
  - Amir-Abushanab/card3d:crates/card3d-engine/src/face_custom.rs
---

# Custom WGSL face shaders

Read card-design-json first for the rest of the design. A custom layer is one entry of
`CardDesign.shaders` (at most 8 layers, each `code` at most 20 000 characters). The engine wraps the
code in a prelude and draws it on the face; GLSL is not translated.

## Setup: the layer

```json
{
  "id": "custom",
  "language": "wgsl",
  "side": "front",
  "target": "skin",
  "params": { "uSpeed": 0.6 },
  "code": "var<private> uSpeed: f32; // @param 0 3 0.6 label=\"Speed\"\n\nfn mainImage(uv: vec2f) -> vec4f {\n  let v = 0.5 + 0.5 * sin(facePos.x * 8.0 + uTime * uSpeed);\n  return vec4f(mix(uBaseColor, vec3f(1.0), v * 0.3), 1.0);\n}"
}
```

- `language: "wgsl"` is required. Without it the layer is legacy GLSL and is skipped.
- `side`: `front`, `back` or `both`. `opacity` 0–1 and `blend` (`normal`, `add`, `multiply`,
  `screen`; overlays) scale the layer. `animated: false` or `time: <s>` freezes the clock.
- `target: "skin"` renders into the face texture under the metal lighting (polish, clearcoat, holo
  and branding still apply on top): prints, anodised patterns. Skins don't render on glass cards.
  `target: "overlay"` is drawn over the face and gets the view direction:
  glints, sheens, parallax. Use `screen` or `add` to brighten, `multiply` to darken.

## Core patterns

### Write `mainImage`

Read the [contract and prelude](references/prelude.md) (generated from the engine: every uniform,
global, helper and the starter shaders) before writing code. In short:

- Define `fn mainImage(uv: vec2f) -> vec4f` returning display-sRGB colour with straight alpha
  (alpha 0 shows what's below). Helper `fn`s and `const`s are fine; entry points (`@fragment`) and
  redeclaring a prelude name are errors.
- `uv` is (0,0) bottom-left of the face as you look at it. Use `facePos` (aspect-correct, centred,
  y in −0.5…0.5) for patterns, `cardUv` for front-card space through both faces.
- Keep the chip area calm: `mix(uBaseColor, col, smoothstep(0.0, 0.06, chipDistance(uv)))`.
- Using `uTime` or `uTilt` makes the layer animated (live frames; held still under reduced motion);
  `uPointer` makes it follow the pointer. `// @replaces-artwork` anywhere hides the face's artwork,
  for shaders that redraw it through `artwork(uv)`.

### Expose parameters

Annotated module-scope declarations become the layer's params; the key in `params` is the variable
name. Unannotated declarations stay 0. `// @param min max default` (plus `step=`, `label="…"`,
`description="…"`) on `f32`, `i32`, `bool`, `vec2f`, `vec3f`; `options="Label:value,…"` for a select;
`default=x,y` for vectors and `default=true` for bools; `// @color #rrggbb` on a `vec3f` (the value
arrives as display sRGB). One annotation per declaration, on its line:

```wgsl
var<private> uSpeed: f32;    // @param 0 3 1 label="Speed"
var<private> uCount: i32;    // @param 1 12 6
var<private> uGlow: bool;    // @param default=true label="Glow"
var<private> uMode: f32;     // @param options="Soft:0,Hard:1" default=1
var<private> uCenter: vec2f; // @param 0 1 default=0.5,0.5
var<private> uTint: vec3f;   // @color #ff8800 label="Tint"
```

### Check it

1. Annotations, without a GPU: `lintDesign(design)` from `@card3d/core/describe` reports them as
   `shaders[i].code:<line>`; `parseCustomShader(code, "wgsl")` from `@card3d/core/editor` returns
   `{ params, errors }` for the code alone.
2. Compile errors need the engine. On a live stage, after its first `setDesign` (before that it
   returns `[]`):

```ts
import { createEngineStage, ensureDesign, type EngineStage } from "@card3d/core";

async function checkLayer(stage: EngineStage, code: string): Promise<boolean> {
  const errors = await stage.checkShader(code); // [{ line, message }], lines of `code`; 0 = not tied to a line
  for (const e of errors) console.error(`line ${e.line}: ${e.message}`);
  return errors.length === 0;
}

const canvas = document.querySelector("canvas")!;
const stage = createEngineStage(canvas);
await stage.setDesign(ensureDesign({ recipe: { material: "silver" }, cardholderName: "Ada Lovelace" }));
await checkLayer(stage, "fn mainImage(uv: vec2f) -> vec4f { return vec4f(uv, 0.0, 1.0); }");
```

3. After `setDesign` with the layer, `stage.shaderErrors()` lists layers that were dropped
   (`{ index, side, errors }`); the rest of the card still draws. `<metal-card>` exposes the same
   stage as `card.stage` once `metal-card-ready` fired.

Inside the card3d repository, `pnpm finish render design.json` compiles every custom layer on the
engine and renders previews; Card Studio's custom shader editor (**Shaders**, then a Custom WGSL layer) checks as you type.

### Port GLSL / Shadertoy

| GLSL | WGSL here |
| --- | --- |
| `void mainImage(out vec4 c, in vec2 fragCoord)` | `fn mainImage(uv: vec2f) -> vec4f` (uv already 0–1; `uResolution` is the face texture size) |
| `iTime`, `iMouse` | `uTime`, `uPointer` (xy uv, z = 1 while over the face) |
| `vec2`, `vec3`, `vec4`, `float`, `int` | `vec2f`, `vec3f`, `vec4f`, `f32`, `i32` |
| `float x = 1.0;` / mutable | `let x = 1.0;` / `var x = 1.0;` |
| `mod(x, y)` | `mod1` / `mod2` / `mod3` (WGSL's `%` truncates) |
| `c ? a : b` | `select(b, a, c)` |
| `1` where a float is expected | `1.0` (no implicit int → float) |
| `uniform float uX;` | `var<private> uX: f32; // @param …` |

## Common mistakes

- Missing `"language": "wgsl"`: the layer is skipped, `engineDraws(design)` is false and
  `<metal-card>` fires `metal-card-error` once per design.
- Declaring `uTime`, `facePos`, `PI` or another prelude name: "is provided by the face shader prelude".
- Heavy per-pixel work: loops are capped at 10 000 iterations per pixel, but an expensive shader can
  still stall or reset the GPU, and it runs on phones. No ray marching with big step counts.
- Calling `checkShader` before the stage's first design: it resolves `[]` (nothing checked).
- A skin on a glass card: not drawn; use an overlay.
- Custom code runs as written in every visitor's browser: only embed designs you trust.

## Completion

`lintDesign` has no errors for the layer, `checkShader(code)` resolves `[]` on a started stage, and
`stage.shaderErrors()` is empty after `setDesign`; the card shows the effect on the side(s) set.
