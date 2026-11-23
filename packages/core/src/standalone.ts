/**
 * The single-file CDN / standalone build entry (vite.standalone.config.ts): the public API (the card
 * engine's stage and the design model) for a plain `<script type="module">` from a CDN. The engine's
 * builds load from the package's `wasm/` (`../../wasm/` next to the bundle) and the card fonts from
 * `../../assets/fonts/`: the package layout a CDN serves.
 */
import type * as Marquee from "./marquee.ts";

export * from "./index.ts";

/**
 * The card marquee (`@card3d/core/marquee`), loaded on demand: it isn't in this bundle, so a
 * single card doesn't download it. `const { mountMarquee } = await loadMarquee();`
 */
export const loadMarquee = (): Promise<typeof Marquee> => import("./marquee.ts");
