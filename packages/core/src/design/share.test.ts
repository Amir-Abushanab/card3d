import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeDesignToken, encodeDesignToken, shareToken } from "./share.ts";
import { cloneDesign, countEmbeddedMedia, defaultDesign, ensureDesign, stripEmbeddedMedia } from "./design.ts";

/** A token made the way the studio's share links are (gzip → base64url), independently of encodeDesignToken. */
const studioToken = (json: unknown) => gzipSync(Buffer.from(JSON.stringify(json))).toString("base64url");

describe("share tokens", () => {
  it("round-trips a design, leaving inline uploads out", async () => {
    const d = defaultDesign();
    d.cardholderName = "Grace Hopper";
    d.font = "space-grotesk";
    d.lighting = "dark";
    d.surfaceSources.front = "data:image/png;base64,AAAA";
    d.decals.push({ id: "a", side: "front", src: "/sticker.png", aspect: 1, x: 10, y: 20, width: 22, rotation: 0, scale: 1 });
    d.decals.push({ id: "b", side: "back", src: "data:image/png;base64,BBBB", aspect: 1, x: 10, y: 20, width: 22, rotation: 0, scale: 1 });
    const { token, stripped } = await encodeDesignToken(d);
    expect(stripped).toBe(2);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = await decodeDesignToken(token);
    expect(back.cardholderName).toBe("Grace Hopper");
    expect(back.font).toBe("space-grotesk");
    expect(back.lighting).toBe("dark");
    expect(back.recipe).toEqual(d.recipe);
    expect(back.surfaceSources.front).toBeUndefined();
    expect(back.decals.map((x) => x.src)).toEqual(["/sticker.png"]);
  });

  it("reads tokens in the studio's format, from a link, a hash or bare", async () => {
    const token = studioToken({ recipe: { material: "brass", texture: "guilloche", color: "#e8c27a" }, cardholderName: "Ada" });
    for (const input of [
      token,
      `#d=${token}`,
      `d=${token}`,
      `https://card-studio.pages.dev/#d=${token}`,
      `https://example.com/studio/?x=1#d=${token}&y=2`,
      `  ${token.slice(0, 10)}\n  ${token.slice(10)}  `,
    ]) {
      const d = await decodeDesignToken(input);
      expect(d.recipe.material).toBe("brass");
      expect(d.recipe.texture).toBe("guilloche");
      expect(d.cardholderName).toBe("Ada");
    }
  });

  it("validates what it decodes like the studio does", async () => {
    const d = await decodeDesignToken(
      studioToken({
        recipe: { material: "unobtainium" },
        cardholderName: "X",
        font: "comic-sans",
        lighting: "disco",
        shaders: [{ id: "nope" }, { id: "oil-slick", opacity: 7 }],
      }),
    );
    expect(d.recipe.material).toBe("silver");
    expect(d.font).toBeUndefined();
    expect(d.lighting).toBeUndefined();
    expect(d.shaders?.map((l) => [l.id, l.opacity])).toEqual([["oil-slick", 1]]);
  });

  it("carries Google and URL fonts; an uploaded font keeps its family without the file", async () => {
    const d = defaultDesign();
    d.font = { source: "google", family: "Fraunces", weight: 600 };
    expect(await decodeDesignToken((await encodeDesignToken(d)).token).then((x) => x.font)).toEqual({ source: "google", family: "Fraunces", weight: 600 });
    d.font = { source: "url", family: "Brand Sans", src: "https://cdn.example.com/brand.woff2" };
    expect(await decodeDesignToken((await encodeDesignToken(d)).token).then((x) => x.font)).toEqual(d.font);

    const upload = { source: "upload" as const, family: "Brand Sans", src: "data:font/woff2;base64,d09GMgABAAAAAA==" };
    d.font = upload;
    expect(countEmbeddedMedia(d)).toBe(1);
    const { token, stripped } = await encodeDesignToken(d);
    expect(stripped).toBe(1);
    expect((await decodeDesignToken(token)).font).toEqual({ source: "upload", family: "Brand Sans" });
    // the design itself (drafts, .card.json) keeps the file
    expect(d.font).toEqual(upload);
    expect(ensureDesign(JSON.parse(JSON.stringify(d))).font).toEqual(upload);
    expect(stripEmbeddedMedia(d).design.font).toEqual({ source: "upload", family: "Brand Sans" });
    // copies don't share the font object
    const copy = cloneDesign(d);
    expect(copy.font).toEqual(upload);
    expect(copy.font).not.toBe(d.font);
  });

  it("reads old tokens' font ids and drops unusable custom fonts", async () => {
    // a token from before custom fonts: a plain catalog id
    expect((await decodeDesignToken(studioToken({ recipe: {}, cardholderName: "X", font: "playfair" }))).font).toBe("playfair");
    expect((await decodeDesignToken(studioToken({ recipe: {}, cardholderName: "X", font: "google:Fraunces" }))).font).toEqual({
      source: "google",
      family: "Fraunces",
    });
    for (const font of [
      { source: "url", family: "X", src: "javascript:alert(1)" },
      { source: "url", family: "X", src: "https://user:pw@cdn.example.com/x.woff2" },
      { source: "google", family: "Fraunces&family=Evil" },
      { source: "upload", family: "X", src: "data:text/html;base64,PHNjcmlwdD4=" },
      "Fraunces",
      42,
    ]) {
      const d = await decodeDesignToken(studioToken({ recipe: {}, cardholderName: "X", font }));
      expect(!d.font || (typeof d.font === "object" && !d.font.src), JSON.stringify(font)).toBe(true);
    }
  });

  it("rejects what isn't a token", async () => {
    expect(shareToken("")).toBeNull();
    expect(shareToken("not a token!")).toBeNull();
    expect(shareToken("https://example.com/#x=1")).toBeNull();
    await expect(decodeDesignToken("#nothing")).rejects.toThrow();
    await expect(decodeDesignToken("AAAA")).rejects.toThrow();
    await expect(decodeDesignToken(studioToken([1, 2]))).rejects.toThrow(/JSON object/);
  });

  it("ensureDesign accepts a bare recipe and refuses junk", () => {
    expect(ensureDesign({ material: "titanium" }).recipe.material).toBe("titanium");
    expect(() => ensureDesign({ hello: 1 })).toThrow(/No recipe/);
    expect(() => ensureDesign("x")).toThrow(/Expected a JSON object/);
  });
});
