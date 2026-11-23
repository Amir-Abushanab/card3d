# Stage API (`@card3d/core`, `@card3d/core/engine`)

The types are in the package's `dist/engine.d.ts`; this is the map. Angles are degrees unless noted.

## `createEngineStage(canvas, options?)` → `EngineStage`

| option | default | what |
| --- | --- | --- |
| `quality` | `"performance"` | `"full"`: up to 2× pixel ratio and finer face textures |
| `fit` | `"studio"` | `"contain"`: the card fills the canvas with a small margin and stays whole as it turns |
| `interactive` | `true` | drag to turn, click / Enter / Space to flip, double-click / Esc / Home to reset |
| `intro` | `interactive` | the one-shot intro on the first card of the page (skipped under reduced motion) |
| `element` | the canvas | element that receives input and the accessibility attributes |
| `label` | `"Metal card"` | accessible name (the stage appends "; showing front / back") |
| `pixelRatio` | device, clamped by quality | a fixed ratio |
| `adaptiveResolution` | off | `true` or `{ frameBudgetMs, minPixelRatio, step }`: lower the ratio while frames run long |
| `autoRender` | `true` | `false`: nothing draws until `render()` (capture) |
| `backend` | the loader's choice | force `"webgpu"` or `"webgl"` |
| `assets` | the public provider | `{ nameFontFamily, resolveUrl? }` (a whole `AssetProvider` fits) |
| `resolveUrl` | `assets.resolveUrl`, else as given | maps a design's image `src` to a URL |
| `defaultRotation`, `fitToViewport` | | the rest pose; framing against the viewport |

Callbacks: `onRotationChange(rot)`, `onFlippedChange(flipped)`, `onPixelRatioChange(change)`,
`onCanvas(canvas)` (the engine moved to its WebGL build on a fresh canvas that replaced the old one in
the DOM), `onFallback(why)`, `onContextLost()`, `onContextRestored()` (rebuilt in the same pose).

| member | what |
| --- | --- |
| `setDesign(design)` | starts the engine (first call) or swaps the design; resolves once the card is built |
| `backend` | `"webgpu"`, `"webgl"`, or null before the first design |
| `canvas` | the canvas drawn on now (changes on a WebGL fall-over) |
| `flip()`, `reset()` | turn over; back to the rest pose |
| `interaction` | `{ rot, flipped, setRotation, toggleFlip, setFlipped, reset, setActive, restore, setLabel }`, or null |
| `setQuality(q)` (async), `setFit(f)`, `fit` | |
| `setPaused(p)`, `paused` | stop rendering and clocks (also automatic in hidden tabs) |
| `render()`, `invalidate()` | draw now; schedule one coalesced frame |
| `animated` | the card moves by itself now (live shaders, add-ons, a flip) |
| `setRotation([x, y, z])` | radians, Euler XYZ, on the card's slot (camera paths); independent of the interaction |
| `setLift(y)`, `setCameraOrbit({ azimuth, elevation, distance } \| null)`, `setCameraDistance(z \| null)` | camera paths and page framing |
| `view()` | model and view matrices, eye, fov, aspect, pose quaternion: for drawing over the card |
| `setSticker(index, pose?)` | move a sticker live without a rebuild (editors) |
| `checkShader(code)`, `shaderErrors()` | custom WGSL checks (see custom-face-shaders-wgsl) |
| `exportAr({ format, size?, upright? })` | the design on screen as GLB or USDZ bytes (see exports) |
| `contextLost`, `pixelRatio` | state |
| `dispose()`, `released` | free the stage; `released` settles once its GPU context is gone |

## `createOffscreenStage(options?)` → `OffscreenStage`

Options: `quality` (default `"full"`), `backend`, `assets`, `resolveUrl`. No interaction, pixel ratio
1, no frame loop: its clocks advance only by each frame's `dt`, so the same calls give the same frames.

| member | what |
| --- | --- |
| `setDesign(design)` | build a design |
| `frame({ width, height, quaternion?, cameraDistance?, orbit?, lift?, dt? })` | draw; returns a 2D canvas the stage reuses |
| `frameImageData(o)`, `frameBlob(o, type?, quality?)` | the same frame as pixels (straight alpha) or encoded (PNG default) |
| `advance(seconds)` | run the clocks without drawing |
| `printJob(design)` | used by `bakePrint` |
| `exportAr(design, { format, size?, upright? })` | AR model of any design |
| `animated`, `contextLost`, `backend`, `shaderErrors()`, `dispose()` | |

Frames are transparent where the card isn't (a glass card and a staged scene are opaque).

## Other exports of the root entry

- Design model: everything in `@card3d/core/model` (see card-design-json).
- `engineDraws(design)`: false when the design has a legacy GLSL layer or an id the engine doesn't
  know. `ENGINE_FACE_SHADERS`, `ENGINE_ADDONS`: what it draws.
- `CAMERA_PATHS`, `getCameraPath(id)`, `cameraPathPose(id, t, options?)`, `cameraPathTime(id, i, frames)`, `ease`.
- `SCENE_ENVIRONMENTS`, `getSceneEnvironment(id)`; `createPublicAssets()`, `PUBLIC_FONT_FAMILY`, `GENERIC_MARK`.
- `quaternionToEuler(q)`.

## Entry points

| import | what |
| --- | --- |
| `@card3d/core` | stages, design model, camera paths, environments, public assets |
| `@card3d/core/model` | design model only (no engine loader): server-safe |
| `@card3d/core/engine` | stages only |
| `@card3d/core/editor` | editor catalogs: shader definitions and parser, WGSL starters, effect params, geometry and print constants, sticker placement |
| `@card3d/core/describe` | `lintDesign`, `describeDesignSpace`, examples |
| `@card3d/core/print` | print layout, dieline, `bakePrint` |
| `@card3d/core/marquee` | `mountMarquee` and its helpers |
| `@card3d/core/standalone` | the root API in one file for a CDN, plus `loadMarquee()` |
