/**
 * The public asset provider (`createPublicAssets`),
 * without three.js: neutral defaults we can ship — procedural geometry (no `cardModelUrl`), a generic
 * corner mark (`GENERIC_MARK`) and a self-hosted open font (`DEFAULT_CARD_FONT`, Inter).
 */
import type { AssetProvider } from "../types.ts";
import { DEFAULT_CARD_FONT, getCardFont } from "../fonts.ts";
import { GENERIC_MARK } from "../card/generic-mark.ts";

/**
 * The public provider's name/bio family: `DEFAULT_CARD_FONT` (Inter, self-hosted, OFL), registered
 * with `document.fonts` and loaded on first use (`loadCardFont`).
 */
export const PUBLIC_FONT_FAMILY = getCardFont(DEFAULT_CARD_FONT)!.family;

export { GENERIC_MARK };

export function createPublicAssets(overrides: Partial<AssetProvider> = {}): AssetProvider {
  return {
    brandMark: GENERIC_MARK,
    nameFontFamily: PUBLIC_FONT_FAMILY,
    resolveUrl: (src) => src,
    ...overrides,
  };
}
