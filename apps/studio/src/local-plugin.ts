/**
 * The local plugin hook (dev only). A dev server loads `.reference/studio-plugin.ts` when that
 * gitignored module exists (vite.config.ts `localPlugin`). Its default export, a `LocalPlugin`, can add
 * blocks to the Presets folder, tools to the stage and designs to the showcase.
 *
 * Without the module, as in a fresh clone or CI, and in every build, there is no plugin.
 * `__CARD3D_LOCAL_PLUGIN__` is false there, so the import below is dropped, and the virtual module is
 * empty in a build anyway.
 */
import type { CardDesign } from "@card3d/core/model";
import type { ThumbScheduler } from "./export/thumbs.ts";
import type { Block } from "./panel/blocks.ts";
import type { ShowcaseDesign } from "./showcase/designs.ts";

interface StudioPluginHost {
  params: URLSearchParams;
  /** The studio's thumbnail renderer (persistent cache, one render per idle slot). */
  thumbs: ThumbScheduler;
  /** Load a design into the studio as one undoable edit. */
  openDesign(design: CardDesign, label: string): void;
  /** The stage toolbar's flip button: a plugin's tools go before it. */
  toolbarAnchor: Element | null;
}

interface StudioPluginParts {
  /** Blocks at the end of the Presets folder. */
  presetBlocks?: Block[];
  /** Called once the studio is running (for example to act on the plugin's own URL parameters). */
  ready?(): void;
}

interface ShowcasePluginHost {
  params: URLSearchParams;
  /** The nav's link list. */
  nav: Element | null;
}

export interface LocalPlugin {
  /** True when this URL asks for the local asset pack (used even when the saved preference is "public"). */
  wantsLocalAssets?(params: URLSearchParams): boolean;
  /** Studio additions, called once the stage and thumbnails exist and before the panel is built. */
  studio?(host: StudioPluginHost): StudioPluginParts | Promise<StudioPluginParts>;
  /** Showcase designs in strip order, when the showcase uses the local asset pack; none: the public designs. */
  showcase?(host: ShowcasePluginHost): ShowcaseDesign[] | Promise<ShowcaseDesign[]>;
}

/** The local plugin, or null (no module, a build, or the module failed to load). */
export async function loadLocalPlugin(): Promise<LocalPlugin | null> {
  try {
    const mod = import.meta.env.DEV && __CARD3D_LOCAL_PLUGIN__ ? await import("virtual:card3d-local-plugin") : null;
    return mod?.default ?? null;
  } catch (err) {
    console.warn("[studio] the local plugin failed to load", err);
    return null;
  }
}
