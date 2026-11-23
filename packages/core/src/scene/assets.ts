/**
 * Asset providers.
 *
 * - `createPublicAssets()`: neutral defaults we can ship — procedural geometry (no `cardModelUrl`),
 *   a generic corner mark (`GENERIC_MARK`) and a self-hosted open font (`DEFAULT_CARD_FONT`, Inter).
 * - The local asset pack's provider lives in `../reference.ts` (workspace only: it is not
 *   part of the published package).
 */
import type { AssetProvider, CardDesign } from "../types.ts";
import { validLogo } from "../card/branding-layout.ts";

export { PUBLIC_FONT_FAMILY, createPublicAssets } from "./public-assets.ts";
/** @archive the local three.js archive (.archive/three-engine) imports it */
export { GENERIC_MARK } from "./public-assets.ts";

/** A web font face to register (`loadFontFaces`). */
export interface FontFaceSpec {
  family: string;
  weight: number | string;
  style?: string;
  url: string;
}

/** Arity of each absolute SVG path command and which arguments are x (1) / y (2) / other (0). */
const AXES: Record<string, number[]> = {
  M: [1, 2],
  L: [1, 2],
  T: [1, 2],
  H: [1],
  V: [2],
  C: [1, 2, 1, 2, 1, 2],
  S: [1, 2, 1, 2],
  Q: [1, 2, 1, 2],
  A: [0, 0, 0, 0, 0, 1, 2],
  Z: [],
};

/**
 * Translate an SVG path by (dx, dy). Absolute commands are shifted, and a leading relative `m`'s
 * first pair (which SVG treats as absolute); other relative commands are left as they are.
 */
export function translateSvgPath(d: string, dx: number, dy: number): string {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let cmd = "";
  let argi = 0;
  let commands = 0;
  for (const t of tokens) {
    if (/[a-zA-Z]/.test(t)) {
      cmd = t;
      argi = 0;
      commands++;
      out.push(t);
      continue;
    }
    const axes = AXES[cmd.toUpperCase()] ?? [];
    // A path's leading `m` is absolute for its first pair (SVG paths §9.3.3).
    const absolute = cmd === cmd.toUpperCase() || (commands === 1 && cmd === "m" && argi < 2);
    const axis = axes.length && absolute ? axes[argi % axes.length] : 0;
    const v = Number(t) + (axis === 1 ? dx : axis === 2 ? dy : 0);
    out.push(String(Math.round(v * 1e5) / 1e5));
    argi++;
  }
  return out.join(" ").replace(/ ?([a-zA-Z]) ?/g, "$1");
}

/** Load `FontFace`s and add them to `document.fonts` (resolves when all are usable). */
export async function loadFontFaces(faces: readonly FontFaceSpec[]): Promise<void> {
  if (typeof FontFace === "undefined" || typeof document === "undefined") return;
  await Promise.all(
    faces.map(async (f) => {
      const face = new FontFace(f.family, `url(${JSON.stringify(f.url)})`, { weight: String(f.weight), style: f.style ?? "normal" });
      await face.load();
      document.fonts.add(face);
    }),
  );
}

/**
 * The provider a design's card is built with: a design with a single-path `logo` passes it as the
 * `brandMark`, so what draws the mark itself (the liquid-metal "brand mark" mask) shows the user's
 * logo too. Anything else: `assets` unchanged.
 */
export function assetsForDesign(assets: AssetProvider, design: Pick<CardDesign, "logo">): AssetProvider {
  const logo = validLogo(design.logo);
  if (!logo?.path || !logo.viewBox) return assets;
  const [ox, oy] = logo.origin ?? [0, 0];
  return { ...assets, brandMark: { path: ox || oy ? translateSvgPath(logo.path, -ox, -oy) : logo.path, viewBox: logo.viewBox } };
}
