---
"@card3d/core": patch
"@card3d/element": patch
"@card3d/react": patch
---

Faster, lighter cards: a page with several cards no longer mistakes its own WebGPU start for a crash (it used to download the WebGL build as well and record WebGPU as failed); the engine downloads while a design's fonts and images load; decoded images are shared between cards and rebuilds; paused cards stop decoding animated GIF stickers and listening on the window; `<MetalCard>` serialises a design object only when it changes.
