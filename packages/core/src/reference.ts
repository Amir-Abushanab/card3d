/**
 * The local asset pack's provider: a card model, brand mark and name font served by the dev server at
 * `/@ref/` (`.reference/pack/provider.json` + `brand-mark.json`, gitignored), with its font faces loaded
 * through `FontFace` before anything is rasterised.
 *
 * Workspace only: reachable as `@card3d/core/reference` inside this repository (the studio's dev server,
 * local tooling), never built into or exported from the published package.
 */
import type { AssetProvider } from "./types.ts";
import { loadFontFaces, translateSvgPath, type FontFaceSpec } from "./scene/assets.ts";

interface ProviderJson {
  cardModelUrl?: string;
  nameFontFamily: string;
  fontFaces?: FontFaceSpec[];
}
interface BrandMarkJson {
  path: string;
  viewBox: [number, number];
  /** x of the mark's left edge inside `path` (the source path is not at the origin). */
  originX?: number;
  originY?: number;
}

/** True when the dev server exposes the local pack. */
export async function hasReferencePack(base = "/@ref/"): Promise<boolean> {
  try {
    const r = await fetch(`${base}pack/provider.json`, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

/** The local pack's AssetProvider (its glTF card, brand mark and name font; local only). */
export async function loadReferenceAssets(base = "/@ref/"): Promise<AssetProvider> {
  const get = async <T>(file: string): Promise<T> => {
    const r = await fetch(`${base}pack/${file}`);
    if (!r.ok) throw new Error(`local pack: ${file} → HTTP ${r.status}`);
    return (await r.json()) as T;
  };
  const [provider, mark] = await Promise.all([get<ProviderJson>("provider.json"), get<BrandMarkJson>("brand-mark.json")]);
  await loadFontFaces(provider.fontFaces ?? []);
  const path = mark.originX || mark.originY ? translateSvgPath(mark.path, -(mark.originX ?? 0), -(mark.originY ?? 0)) : mark.path;
  return {
    cardModelUrl: provider.cardModelUrl,
    brandMark: { path, viewBox: mark.viewBox },
    nameFontFamily: provider.nameFontFamily,
    // Pack designs already reference `/@ref/...`; anything relative is resolved against the pack root.
    resolveUrl: (src) => (/^(?:[a-z]+:|\/)/i.test(src) ? src : `${base}${src}`),
  };
}
