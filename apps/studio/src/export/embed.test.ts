import { describe, expect, it } from "vitest";
import { decodeDesignToken, ensureDesign } from "@card3d/core/model";
import { defaultDesign } from "../state/design.ts";
import { CDN_URL, EMBED_INLINE_LIMIT, generateEmbed, planMedia } from "./embed.ts";
import { describeMedia } from "../ui/embed-dialog.ts";
import { generateSnippet } from "./code.ts";

const fontUrl = (chars: number) => "data:font/woff2;base64," + "A".repeat(chars - 23);

const dataUrl = (chars: number) => "data:image/png;base64," + "A".repeat(chars - 22);

function design() {
  const d = defaultDesign();
  d.cardholderName = "Rosalind O'Brien & Co";
  d.lighting = "dark";
  d.recipe.material = "brass";
  d.scene = { environment: "softbox", backdrop: "sweep", floor: { reflectivity: 0.6 } };
  d.shaders = [{ id: "custom", side: "front", target: "skin", code: "vec4 mainImage(vec2 uv) { return vec4(uv, 0.5, 1.0); } // it's 'quoted'" }];
  return d;
}

/** The design attribute of a CDN snippet, as the browser would read it. */
function attribute(code: string): unknown {
  const m = code.match(/design='([^']*)'/);
  if (!m) throw new Error("no design attribute");
  return JSON.parse(m[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
}

describe("embed snippets", () => {
  it("CDN: one module script and <metal-card> carrying the design (round-trips)", async () => {
    const d = design();
    const { code, media } = await generateEmbed(d, "cdn");
    expect(code).toContain(`<script type="module" src="${CDN_URL}"></script>`);
    expect(CDN_URL).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@card3d\/element@\d+\.\d+\/dist\/standalone\/metal-card\.js$/);
    expect(code).toMatch(/<metal-card\n\s+design='/);
    expect(code).toContain("\n  backdrop\n"); // a lighting preset brings its backdrop
    expect(media).toEqual([]);
    const back = ensureDesign(attribute(code));
    expect(back.cardholderName).toBe(d.cardholderName);
    expect(back.recipe).toEqual(d.recipe);
    expect(back.lighting).toBe("dark");
    expect(back.scene).toEqual({ environment: "softbox", backdrop: "sweep", floor: { reflectivity: 0.6 } });
    expect(back.shaders?.[0].code).toBe(d.shaders![0].code);
  });

  it("npm element and React snippets set the design object", async () => {
    const d = design();
    const el = (await generateEmbed(d, "element")).code;
    expect(el).toContain('import "@card3d/element";');
    expect(el).toContain("card.design = {");
    expect(el).toContain("pnpm add @card3d/element\n");
    expect(el).not.toContain("three");
    const react = (await generateEmbed(d, "react")).code;
    expect(react).toContain('import { MetalCard } from "@card3d/react";');
    expect(react).toContain("<MetalCard design={design} backdrop style={{ width: 480 }} />");
    expect(react).toContain('cardholderName: "Rosalind O\'Brien & Co"');
  });

  it("inlines uploads within the limit, replaces the rest with placeholders and says so", async () => {
    const d = design();
    d.logo = { src: dataUrl(30_000), aspect: 2 };
    d.surfaceSources.front = dataUrl(200_000);
    d.surfaceSources.back = dataUrl(100_000); // would pass the 256 KB total
    d.decals.push({ id: "s", side: "front", src: dataUrl(5_000), aspect: 1, x: 50, y: 50, width: 20, rotation: 0, scale: 1 });
    const plan = planMedia(d);
    expect(plan.media.map((m) => [m.what, m.inlined, m.placeholder ?? null])).toEqual([
      ["Logo", true, null],
      ["Front artwork", true, null],
      ["Back artwork", false, "/card/back-artwork.png"],
      ["Sticker 1", true, null],
    ]);
    const { code, media } = await generateEmbed(d, "cdn");
    const back = ensureDesign(attribute(code));
    expect(back.surfaceSources.front).toBe(d.surfaceSources.front);
    expect(back.surfaceSources.back).toBe("/card/back-artwork.png");
    expect(back.decals[0].src).toBe(d.decals[0].src);
    expect(back.logo?.src).toBe(d.logo.src);
    expect(code).toContain("Too large to inline");
    expect(code).toContain("/card/back-artwork.png (Back artwork)");
    const { warn, info } = describeMedia(media, 0);
    expect(warn).toMatch(/Back artwork \(98 KB\) → \/card\/back-artwork\.png/);
    expect(info).toMatch(/Logo \(29 KB\), Front artwork \(195 KB\), Sticker 1 \(5 KB\)/);
    expect(EMBED_INLINE_LIMIT).toBe(256 * 1024);
  });

  it("stickers keep their picture edits (crop, flip, tint, corrections, opacity) in every snippet", async () => {
    const d = design();
    const picture = {
      crop: { x: 0.1, y: 0, w: 0.6, h: 0.9 },
      flip: { h: true },
      tint: { color: "#808080", amount: 1 },
      adjust: { contrast: 0.2 },
      opacity: 0.7,
    };
    d.decals.push({ id: "s", side: "front", src: "/stickers/star.svg", aspect: 1, x: 40, y: 50, width: 20, rotation: 30, scale: 1, ...picture });
    d.decals.push({ id: "u", side: "back", src: dataUrl(2_000), aspect: 2, x: 50, y: 50, width: 20, rotation: 0, scale: 1, ...picture });
    for (const kind of ["element", "react"] as const) expect((await generateEmbed(d, kind)).code).toMatch(/tint: \{\s*color: "#808080",\s*amount: 1/);
    // Export code (.json): the same fields, the upload as a placeholder path.
    const json = JSON.parse(generateSnippet(d, "json").code) as { decals: Record<string, unknown>[] };
    expect(json.decals.map((x) => ({ crop: x.crop, flip: x.flip, tint: x.tint, adjust: x.adjust, opacity: x.opacity }))).toEqual([picture, picture]);
    const back = ensureDesign(attribute((await generateEmbed(d, "cdn")).code));
    expect(back.decals.map((x) => ({ crop: x.crop, flip: x.flip, tint: x.tint, adjust: x.adjust, opacity: x.opacity }))).toEqual([picture, picture]);
    const compact = (await generateEmbed(d, "cdn", { compact: true })).code.match(/share="([A-Za-z0-9_-]+)"/)![1];
    expect((await decodeDesignToken(compact)).decals).toEqual([d.decals[0]]); // the upload stays out of a token
  });

  it("blob: URLs are never inlined", () => {
    const d = design();
    d.surfaceSources.front = "blob:http://localhost/123";
    expect(planMedia(d).media).toEqual([{ what: "Front artwork", chars: 25, inlined: false, placeholder: "/card/front-artwork.png" }]);
  });

  it("compact: a share token instead of JSON, with a warning for the uploads it drops", async () => {
    const d = design();
    d.surfaceSources.front = dataUrl(1000);
    const { code, stripped, media } = await generateEmbed(d, "cdn", { compact: true });
    const token = code.match(/share="([A-Za-z0-9_-]+)"/)![1];
    const back = await decodeDesignToken(token);
    expect(back.recipe).toEqual(d.recipe);
    expect(back.surfaceSources.front).toBeUndefined();
    expect(stripped).toBe(1);
    expect(describeMedia(media, stripped).warn).toMatch(/leaves out 1 uploaded image/);
    expect((await generateEmbed(d, "react", { compact: true })).code).toContain(`<MetalCard share="${token}" backdrop`);
  });

  it("carries custom fonts: Google and URL as written, an upload inlined or as a hosted file", async () => {
    const d = design();
    d.font = { source: "google", family: "Fraunces", weight: 600 };
    expect(ensureDesign(attribute((await generateEmbed(d, "cdn")).code)).font).toEqual(d.font);
    d.font = { source: "url", family: "Brand Sans", src: "https://cdn.example.com/brand.woff2" };
    expect(ensureDesign(attribute((await generateEmbed(d, "cdn")).code)).font).toEqual(d.font);

    const small = { source: "upload" as const, family: "Brand Sans", src: fontUrl(40_000) };
    d.font = small;
    const inlined = await generateEmbed(d, "cdn");
    expect(inlined.media).toEqual([{ what: "Font", chars: 40_000, inlined: true }]);
    expect(ensureDesign(attribute(inlined.code)).font).toEqual(small);

    d.font = { ...small, src: fontUrl(300_000) };
    const hosted = await generateEmbed(d, "cdn");
    expect(hosted.media).toEqual([{ what: "Font", chars: 300_000, inlined: false, placeholder: "/card/font.woff2" }]);
    expect(ensureDesign(attribute(hosted.code)).font).toEqual({ source: "url", family: "Brand Sans", src: "/card/font.woff2" });
    expect(hosted.code).toContain("/card/font.woff2 (Font)");

    const compact = await generateEmbed(d, "cdn", { compact: true });
    expect((await decodeDesignToken(compact.code.match(/share="([A-Za-z0-9_-]+)"/)![1])).font).toEqual({ source: "upload", family: "Brand Sans" });
    expect(describeMedia(compact.media, compact.stripped).warn).toMatch(/leaves out the uploaded font file/);

    // Export code: never inlines the font file
    const json = generateSnippet(d, "json");
    expect(JSON.parse(json.code).font).toEqual({ source: "url", family: "Brand Sans", src: "/card/font.woff2" });
    expect(json.placeholders).toEqual(["/card/font.woff2"]);
    expect(generateSnippet(d, "vanilla").code).toContain('font: {\n    source: "url",\n    family: "Brand Sans",\n    src: "/card/font.woff2"');
  });
});
