/**
 * The single-file CDN build (vite.standalone.config.ts): `<metal-card>` with the design model and the
 * card engine's loader (its builds load from `engine/` next to the bundle). Loading it registers the
 * element. The design model and `createEngineStage` are exported for scripts; the marquee loads on
 * demand: `loadMarquee()`.
 */
export * from "./index.ts";
export * from "@card3d/core/model";
export { createEngineStage, engineDraws, type EngineStageOptions, type EngineInteraction, type EngineFit } from "@card3d/core/engine";

/**
 * The card marquee (`@card3d/core/marquee`), on demand: its page side is
 * a chunk of its own and the engine's `marquee` part downloads when one mounts.
 * `const { mountMarquee } = await loadMarquee();`
 */
export const loadMarquee = (): Promise<typeof import("@card3d/core/marquee")> => import("@card3d/core/marquee");
