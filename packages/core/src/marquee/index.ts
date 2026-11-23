/**
 * The marquee: `mountMarquee` (on the Rust engine: no three.js) plus the pure strip /
 * pose / order helpers it is built from.
 */
export { mountMarquee, type MarqueeOptions, type MarqueeHandle, type MarqueeSlotInfo } from "./mount.ts";
export { marqueePointerLock, type IntroPhase } from "./shared.ts";
export * from "./strip.ts";
export * from "./pose.ts";
export { shuffleMarqueeOrder, resolveMarqueePin, fisherYates, type PinnableDesign } from "./designs.ts";
export {
  MARQUEE,
  VIEWPORT_H,
  PERSP,
  hash as marqueeHash,
  seekEase,
  smoothstep as marqueeSmoothstep,
  smootherstep as marqueeSmootherstep,
  easeInOutCubic,
  easeOutQuart,
  quadBezier,
  mulberry32,
} from "./constants.ts";
