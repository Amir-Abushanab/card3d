/// <reference types="vite/client" />

/** Hash of the engine sources (vite.config.ts `engineBuild`; live on a dev server): versions the thumbnail cache. */
declare module "virtual:card3d-build" {
  export const ENGINE_BUILD: string;
}

/** The local plugin's module (vite.config.ts `localPlugin`; src/local-plugin.ts). `null` without one. */
declare module "virtual:card3d-local-plugin" {
  const plugin: import("./local-plugin.ts").LocalPlugin | null;
  export default plugin;
}

/**
 * True only on a dev server that found the local asset pack (`.reference/pack/`); false in every
 * build. Set by the local-pack plugin (packages/core/dev/local-pack.mjs).
 */
declare const __CARD3D_LOCAL_PACK__: boolean;

/** True only on a dev server that found the local plugin module (src/local-plugin.ts); false in every build. */
declare const __CARD3D_LOCAL_PLUGIN__: boolean;

/** @card3d/element's version (vite.config.ts): the version line the Embed snippets' CDN URL pins. */
declare const __CARD3D_ELEMENT_VERSION__: string;

interface ImportMetaEnv {
  /** "1" turns on "Describe a finish…" for this build (src/describe/flag.ts). */
  readonly VITE_DESCRIBE_FINISH?: string;
  /** A server-side proxy for "Describe a finish…" (DEPLOY.md); unset: bring-your-own key only. */
  readonly VITE_DESCRIBE_FINISH_PROXY?: string;
}
