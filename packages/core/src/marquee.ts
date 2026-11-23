/**
 * `@card3d/core/marquee`: the card carousel (`mountMarquee`, on the Rust engine) and the pure strip, pose and
 * order helpers it is built from. A subpath of its own so single-card pages and the CDN bundle don't
 * carry it (the CDN bundle loads it with `loadMarquee()`).
 */
export * from "./marquee/index.ts";
