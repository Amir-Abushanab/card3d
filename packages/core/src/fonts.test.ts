import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CARD_FONTS, DEFAULT_CARD_FONT, cardFontByFamily, designFontFamily, getCardFont } from "./fonts.ts";
import { createPublicAssets, PUBLIC_FONT_FAMILY } from "./scene/assets.ts";

describe("card fonts", () => {
  it("are self-hosted woff2 files with an OFL licence each, under unique families", () => {
    expect(CARD_FONTS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(CARD_FONTS.map((f) => f.id)).size).toBe(CARD_FONTS.length);
    expect(new Set(CARD_FONTS.map((f) => f.family)).size).toBe(CARD_FONTS.length);
    for (const f of CARD_FONTS) {
      expect(f.licence).toBe("OFL-1.1");
      expect(f.family.startsWith("card3d ")).toBe(true);
      // the rasteriser draws 700: static faces must be bold, variable ones must span it
      expect(f.weight === "700" || /^\d+ \d+$/.test(f.weight)).toBe(true);
      for (const file of f.files) {
        const path = fileURLToPath(file.url);
        expect(path.endsWith(".woff2")).toBe(true);
        expect(existsSync(path), path).toBe(true);
        expect(readFileSync(path).subarray(0, 4).toString("latin1")).toBe("wOF2");
        expect(file.unicodeRange).toMatch(/^U\+/);
      }
      const stem = f.files[0].url.match(/fonts\/([a-z-]+?)-latin-/)![1];
      expect(existsSync(fileURLToPath(new URL(`../assets/fonts/licenses/${stem}-OFL.txt`, import.meta.url))), `${stem} licence`).toBe(true);
    }
  });

  it("the public provider rasterises with the default font; a design's font wins, unknown ids fall back", () => {
    const assets = createPublicAssets();
    expect(assets.nameFontFamily).toBe(PUBLIC_FONT_FAMILY);
    expect(cardFontByFamily(PUBLIC_FONT_FAMILY)?.id).toBe(DEFAULT_CARD_FONT);
    expect(designFontFamily({}, assets)).toBe(PUBLIC_FONT_FAMILY);
    expect(designFontFamily({ font: "playfair" }, assets)).toBe(getCardFont("playfair")!.family);
    expect(designFontFamily({ font: "nope" }, assets)).toBe(PUBLIC_FONT_FAMILY);
    // a host family (a local pack's, say) is untouched without a design font
    expect(designFontFamily({}, { nameFontFamily: "Host Grotesk" })).toBe("Host Grotesk");
  });
});
