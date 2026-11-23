/**
 * @card3d/element: the `<metal-card>` custom element. Importing this module registers it.
 */
import { register } from "./element.ts";

export { MetalCardElement, register, type MetalCardReadyDetail } from "./element.ts";
export {
  resolveDesign,
  applyPatch,
  presetDesign,
  accessibleLabel,
  parseBool,
  parseAutoRotate,
  parseInteraction,
  parseQuality,
  parseFit,
  parseHexColor,
  parseFont,
  parseLighting,
  DEFAULT_AUTO_ROTATE,
  type DesignSources,
  type DesignPatch,
  type ResolvedDesign,
  type Interaction,
} from "./attributes.ts";
export type { CardDesign, EngineStage } from "@card3d/core";

// Self-register on import so a bare `import "@card3d/element"` makes <metal-card> work. A no-op
// under Node (SSR).
register();
