# Serving `<metal-card>`: self-hosting, caching and Content-Security-Policy

## What a page loads

| file | when |
| --- | --- |
| `metal-card.js` (or `metal-card.iife.js`) | always: the element, the design model and the engine's loader |
| `engine/pkg/card3d_web.js` + `card3d_web_bg.<hash>.wasm` | the WebGPU build, on browsers with WebGPU |
| `engine/pkg-webgl/…` | the WebGL 2 build, on the others (or after a WebGPU failure) |
| `engine/pkg*/split_<part>.<hash>.wasm`, `chunk_<n>.<hash>.wasm` | the optional parts a design uses (holo, stickers, shapes, shaders, effects, scenes, AR, print…) |
| `fonts/*.woff2` | the card fonts a design uses |
| `environments/*.webp` | a scene's HDRI, when a design or `environment` picks one |
| `metal-card-ar-<hash>.js`, `metal-card-marquee-<hash>.js` | AR export and `loadMarquee()`, on first use (inlined in the IIFE build) |

## Self-hosting

Copy the whole `dist/standalone/` folder from the package (about 6 MB on disk, nearly all of it the
two engine builds, of which a visitor downloads one) and keep its layout and file names. The chunks
import the bundle as `./metal-card.js`, so a renamed copy (including a CDN's generated
`metal-card.min.js`) makes them load a second copy. The IIFE build inlines both chunks but still needs
`engine/`, `fonts/` and `environments/` next to it.

- Serve `.wasm` as `application/wasm`. Otherwise the engine falls back to a slower path and logs a
  warning.
- Every engine file except `card3d_web.js` carries a content hash: cache those for a long time
  (`immutable`), revalidate `metal-card.js` and `card3d_web.js`, and keep the previous deploy's files
  for a while so open pages can finish loading their parts.
- Cross-origin hosting (the bundle on a CDN, the page elsewhere) works as long as the files are
  served with CORS (`Access-Control-Allow-Origin`), as the public npm CDNs do.

## Content-Security-Policy

What the element does, and the directive each needs (add the origin you serve the bundle from, e.g.
`https://cdn.jsdelivr.net`, wherever "bundle origin" appears):

| what | directive |
| --- | --- |
| loads `metal-card.js`, the engine glue and lazy chunks (`import()`) | `script-src` bundle origin |
| compiles WebAssembly | `script-src 'wasm-unsafe-eval'` |
| fetches the `.wasm` files, a `src` design JSON, `.hdr` / `.webp` environments, `font-url` files | `connect-src` bundle origin and those hosts |
| loads design images (artwork, stickers, logos) through `<img crossorigin>`; decodes an environment through a `blob:` image where `createImageBitmap` can't | `img-src` their hosts, `data:` (inline images) and `blob:` |
| registers the card fonts with `FontFace(url)` | `font-src` bundle origin |
| `google:` fonts: fetches the CSS from `fonts.googleapis.com`, then the files from `fonts.gstatic.com` | `connect-src https://fonts.googleapis.com`, `font-src https://fonts.gstatic.com` |
| puts a `<style>` element in its shadow root | `style-src 'unsafe-inline'` (or the element renders unstyled) |

A starting point for a page that loads the element from jsDelivr and uses its own images:

```text
script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval';
connect-src 'self' https://cdn.jsdelivr.net;
img-src 'self' data: blob:;
font-src 'self' https://cdn.jsdelivr.net;
style-src 'self' 'unsafe-inline';
```

Check the browser console after loading a page with the policy: a blocked request names the directive
to extend. Designs with custom WGSL face shaders need nothing extra (the shader code is compiled by
the GPU driver, not evaluated as script), but they run as written: only embed designs you trust.
