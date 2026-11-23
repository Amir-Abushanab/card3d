/**
 * Where the scene environments load from (`CardDesign.scene.environment`): the catalog's files
 * (`assets/environments/<id>.webp`) and `.hdr` / `.webp` URLs. Free of three.js: the engine stage's
 * page side (`../../engine.ts`) loads it for designs with a scene, and `./environment.ts` re-exports it.
 */
// Literal `new URL(…, import.meta.url)` so bundlers emit the files (as for the card fonts); the
// standalone builds rewrite them to sit next to the bundle (build/standalone.mjs).
const FILES: Record<string, () => string> = {
  softbox: () => new URL("../../../assets/environments/softbox.webp", import.meta.url).href,
  cyclorama: () => new URL("../../../assets/environments/cyclorama.webp", import.meta.url).href,
  loft: () => new URL("../../../assets/environments/loft.webp", import.meta.url).href,
  "warm-hall": () => new URL("../../../assets/environments/warm-hall.webp", import.meta.url).href,
  sunset: () => new URL("../../../assets/environments/sunset.webp", import.meta.url).href,
};

/** The URL an environment id or URL loads from (null for "studio" and unknown ids). */
export function environmentUrl(env: string, resolveUrl: (src: string) => string = (s) => s): string | null {
  if (!env || env === "studio") return null;
  const file = FILES[env];
  if (file) return file();
  return /\.(hdr|webp)([?#].*)?$/i.test(env) ? resolveUrl(env) : null;
}
