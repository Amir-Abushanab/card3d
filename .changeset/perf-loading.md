---
"@card3d/core": patch
"@card3d/element": patch
"@card3d/react": patch
---

Faster, lighter cards: a page with several cards no longer mistakes its own WebGPU start for a crash (it used to download the WebGL build as well and record WebGPU as failed); the engine downloads while a design's fonts and images load; decoded images are shared between cards and rebuilds; paused cards stop decoding animated GIF stickers and listening on the window. The parts of the engine a design needs download together with the main module instead of one after another; on WebGPU a page's cards share one GPU device (pipelines, maps and environments made once for all of them; a lost device moves every card to the WebGL build); a card's shaders and pipelines are made while it is built and kept for the next card; the marquee draws its cards in one pass.
