import { describe, expect, it, vi } from "vitest";
import { encodeDesignToken, defaultDesign, DEFAULT_PRESET_ID } from "@card3d/core";
import {
  DEFAULT_AUTO_ROTATE,
  accessibleLabel,
  applyPatch,
  parseAutoRotate,
  parseBool,
  parseFont,
  parseFontUrl,
  parseHexColor,
  parseInteraction,
  parseLighting,
  parseQuality,
  parseFit,
  parseFloor,
  presetDesign,
  resolveDesign,
} from "./attributes.ts";

describe("attribute parsing", () => {
  it("booleans: presence is true, false-ish strings are false, absence is the fallback", () => {
    expect(parseBool(null, true)).toBe(true);
    expect(parseBool(null, false)).toBe(false);
    expect(parseBool("", false)).toBe(true);
    expect(parseBool("lazy", false)).toBe(true);
    for (const v of ["false", "0", "off", "no", " FALSE "]) expect(parseBool(v, true)).toBe(false);
  });

  it("auto-rotate: off when absent, a default speed when bare, a number when given, clamped", () => {
    expect(parseAutoRotate(null)).toBe(0);
    expect(parseAutoRotate("")).toBe(DEFAULT_AUTO_ROTATE);
    expect(parseAutoRotate("true")).toBe(DEFAULT_AUTO_ROTATE);
    expect(parseAutoRotate("45")).toBe(45);
    expect(parseAutoRotate("-30")).toBe(-30);
    expect(parseAutoRotate("9000")).toBe(360);
    expect(parseAutoRotate("false")).toBe(0);
    expect(parseAutoRotate("0")).toBe(0);
    expect(parseAutoRotate("fast")).toBe(DEFAULT_AUTO_ROTATE);
  });

  it("interaction, quality", () => {
    expect(parseInteraction(null)).toBe("drag");
    expect(parseInteraction("Turntable")).toBe("turntable");
    expect(parseInteraction("none")).toBe("none");
    expect(parseInteraction("static")).toBe("none");
    expect(parseInteraction("spin")).toBe("drag");
    expect(parseQuality(null)).toBe("full");
    expect(parseQuality("performance")).toBe("performance");
    expect(parseFit(null)).toBe("contain");
    expect(parseFit(" Studio ")).toBe("studio");
    expect(parseFit("cover")).toBe("contain");
    expect(parseQuality("ultra")).toBe("full");
  });

  it("colours, fonts and lighting presets", () => {
    expect(parseHexColor("#E8C27A")).toBe("#e8c27a");
    expect(parseHexColor("#abc")).toBe("#aabbcc");
    expect(parseHexColor("red")).toBeNull();
    expect(parseFont("space-grotesk")).toBe("space-grotesk");
    expect(parseFont("Space Grotesk")).toBe("space-grotesk");
    expect(parseFont("Comic Sans")).toBeNull();
    expect(parseLighting("Dark")).toBe("dark");
    expect(parseLighting("disco")).toBeNull();
  });

  it("accessible label", () => {
    expect(accessibleLabel("  Team card ", null)).toBe("Team card");
    expect(accessibleLabel(null, { cardholderName: "Ada Lovelace" })).toBe("Ada Lovelace, 3D metal card");
    expect(accessibleLabel(null, { cardholderName: "" })).toBe("3D metal card");
  });
});

describe("convenience attributes", () => {
  it("patch the recipe and identity, ignoring unknown values instead of resetting", () => {
    const base = defaultDesign();
    base.recipe.material = "titanium";
    const { design, ignored } = applyPatch(base, {
      material: "gold",
      texture: "brushed",
      color: "#123",
      name: "Grace Hopper",
      bio: "",
      font: "Unbounded",
      lighting: "warm",
    });
    expect(design.recipe.material).toBe("titanium");
    expect(design.recipe.texture).toBe("brushed");
    expect(design.recipe.color).toBe("#112233");
    expect(design.cardholderName).toBe("Grace Hopper");
    expect(design.cardholderBio).toBe("");
    expect(design.font).toBe("unbounded");
    expect(design.lighting).toBe("warm");
    expect(ignored).toEqual(['material="gold"']);
    expect(base.recipe.texture).not.toBe("brushed"); // the input is not mutated
  });
});

describe("custom fonts", () => {
  it("font takes google:<Family>[@weight]", () => {
    expect(parseFont("google:Fraunces")).toEqual({ source: "google", family: "Fraunces" });
    expect(parseFont(" google:Playfair Display@900 ")).toEqual({ source: "google", family: "Playfair Display", weight: 900 });
    expect(parseFont("google:Bad;Name")).toBeNull();
    expect(parseFont("Fraunces")).toBeNull();
  });

  it("font-url names a web font file, https or same-origin only", () => {
    expect(parseFontUrl("https://cdn.example.com/brand.woff2", "Brand Sans")).toEqual({
      source: "url",
      family: "Brand Sans",
      src: "https://cdn.example.com/brand.woff2",
    });
    expect(parseFontUrl("/fonts/Brand-Sans.ttf")).toEqual({ source: "url", family: "Brand Sans", src: "/fonts/Brand-Sans.ttf" });
    for (const bad of ["javascript:alert(1)", "data:font/woff2;base64,AAAA", "http://cdn.example.com/x.woff2", "https://u:p@cdn.example.com/x.woff2"])
      expect(parseFontUrl(bad), bad).toBeNull();
  });

  it("applyPatch: font-url wins over font, which then names it; bad values are ignored", () => {
    const base = defaultDesign();
    expect(applyPatch(base, { font: "google:Fraunces@600" }).design.font).toEqual({ source: "google", family: "Fraunces", weight: 600 });
    expect(applyPatch(base, { font: "Brand Sans", fontUrl: "https://cdn.example.com/b.woff2" }).design.font).toEqual({
      source: "url",
      family: "Brand Sans",
      src: "https://cdn.example.com/b.woff2",
    });
    const bad = applyPatch({ ...base, font: "manrope" }, { fontUrl: "javascript:alert(1)" });
    expect(bad.design.font).toBe("manrope");
    expect(bad.ignored).toEqual(['font-url="javascript:alert(1)"']);
  });

  it("a design or share link with a custom font resolves as written", async () => {
    const d = defaultDesign();
    d.font = { source: "google", family: "Fraunces" };
    const { token } = await encodeDesignToken(d);
    expect((await resolveDesign({ share: token })).design.font).toEqual({ source: "google", family: "Fraunces" });
    expect((await resolveDesign({ designJson: JSON.stringify({ recipe: {}, cardholderName: "X", font: "google:Fraunces" }) })).design.font).toEqual({
      source: "google",
      family: "Fraunces",
    });
  });
});

describe("resolveDesign", () => {
  const noFetch = () => Promise.reject(new Error("no network in tests"));

  it("defaults to the studio's default card", async () => {
    const r = await resolveDesign({}, noFetch);
    expect(r.source).toBe("default");
    expect(r.design).toEqual(defaultDesign());
    expect(r.warnings).toEqual([]);
    expect(presetDesign(DEFAULT_PRESET_ID)!.recipe).toEqual(r.design.recipe);
  });

  it("presets, with effect presets keeping their effects", async () => {
    const r = await resolveDesign({ preset: "brass-orbit-guilloche" }, noFetch);
    expect(r.source).toBe("preset");
    expect(r.design.recipe.material).toBe("brass");
    const fx = await resolveDesign({ preset: "sunset-mesh" }, noFetch);
    expect(fx.design.shaders?.length).toBeGreaterThan(0);
    const bad = await resolveDesign({ preset: "nope" }, noFetch);
    expect(bad.source).toBe("default");
    expect(bad.warnings[0]).toMatch(/preset "nope"/);
  });

  it("decodes a studio share link, hash or token", async () => {
    const d = defaultDesign();
    d.recipe.material = "oxide";
    d.cardholderName = "Katherine Johnson";
    const { token } = await encodeDesignToken(d);
    for (const share of [token, `#d=${token}`, `https://card3d-studio.pages.dev/#d=${token}`]) {
      const r = await resolveDesign({ share }, noFetch);
      expect(r.source).toBe("share");
      expect(r.design.recipe.material).toBe("oxide");
      expect(r.design.cardholderName).toBe("Katherine Johnson");
    }
  });

  it("takes the most specific design and applies the convenience attributes over it", async () => {
    const { token } = await encodeDesignToken({ ...defaultDesign(), cardholderName: "From share" });
    const fetchJson = vi.fn(async () => ({ recipe: { material: "carbon" }, cardholderName: "From src" }));
    const json = JSON.stringify({ recipe: { material: "brass" }, cardholderName: "From attribute" });

    let r = await resolveDesign({ src: "/card.json", preset: "studio-silver" }, fetchJson);
    expect([r.source, r.design.cardholderName, r.design.recipe.material]).toEqual(["src", "From src", "carbon"]);
    expect(fetchJson).toHaveBeenCalledWith("/card.json");

    r = await resolveDesign({ share: token, src: "/card.json" }, fetchJson);
    expect([r.source, r.design.cardholderName]).toEqual(["share", "From share"]);

    r = await resolveDesign({ designJson: json, share: token }, fetchJson);
    expect([r.source, r.design.cardholderName]).toEqual(["design", "From attribute"]);

    r = await resolveDesign(
      { design: { recipe: { material: "glass" }, cardholderName: "From property" }, designJson: json, name: "Override", color: "#ff0000" },
      fetchJson,
    );
    expect([r.source, r.design.cardholderName, r.design.recipe.material, r.design.recipe.color]).toEqual(["design", "Override", "glass", "#ff0000"]);
  });

  it("falls through unreadable sources with a warning", async () => {
    const r = await resolveDesign({ designJson: "{oops", share: "%%%", src: "/missing.json", preset: "hero-black" }, noFetch);
    expect(r.source).toBe("preset");
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings[0]).toMatch(/^design attribute:/);
    expect(r.warnings[1]).toMatch(/^share:/);
    expect(r.warnings[2]).toMatch(/^src "\/missing.json": no network/);
  });

  it("keeps inline images of a design JSON (the embed snippets inline small uploads)", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const r = await resolveDesign({ designJson: JSON.stringify({ cardholderName: "X", surfaceSources: { front: png }, decals: [{ src: png }] }) }, noFetch);
    expect(r.design.surfaceSources.front).toBe(png);
    expect(r.design.decals[0].src).toBe(png);
  });
});

describe("scene attributes", () => {
  it("environment and floor patch design.scene; studio and floor=false remove them", () => {
    expect(parseFloor(null)).toBeNull();
    expect(parseFloor("")).toEqual({});
    expect(parseFloor("0.7")).toEqual({ reflectivity: 0.7 });
    expect(parseFloor("none")).toBe(false);
    expect(parseFloor("shiny")).toBeNull();

    const staged = applyPatch(defaultDesign(), { environment: "Softbox", floor: "" });
    expect(staged.design.scene).toEqual({ environment: "softbox", floor: {} });
    expect(staged.ignored).toEqual([]);

    const url = applyPatch(defaultDesign(), { environment: "https://cdn.example/rooms/Hall_1k.hdr" });
    expect(url.design.scene).toEqual({ environment: "https://cdn.example/rooms/Hall_1k.hdr" });

    const base = { ...defaultDesign(), scene: { environment: "loft", floor: { blur: 0.2 }, backdrop: "sweep" as const } };
    const off = applyPatch(base, { environment: "studio", floor: "false" });
    expect(off.design.scene).toEqual({ backdrop: "sweep" });
    expect(applyPatch(base, { floor: "0.9" }).design.scene?.floor).toEqual({ blur: 0.2, reflectivity: 0.9 });

    const bad = applyPatch(defaultDesign(), { environment: "javascript:alert(1)", floor: "wobbly" });
    expect(bad.design.scene).toBeUndefined();
    expect(bad.ignored).toEqual(['environment="javascript:alert(1)"', 'floor="wobbly"']);
  });
});
