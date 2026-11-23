import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_FONT_LIMITS,
  familyFromFileName,
  googleFontSpec,
  googleFontsCssUrl,
  isFontDataUrl,
  loadCustomFont,
  loadedCustomFontFamily,
  parseGoogleFontSpec,
  sanitizeCustomFont,
  sanitizeFontLabel,
  sanitizeFontUrl,
  sanitizeGoogleFamily,
} from "./custom-font.ts";
import { designFontFamily, loadDesignFont } from "./fonts.ts";

const WOFF2 = "data:font/woff2;base64,d09GMgABAAAAAA==";

describe("custom font validation", () => {
  it("accepts Google family names of letters, digits and spaces only", () => {
    expect(sanitizeGoogleFamily("Fraunces")).toBe("Fraunces");
    expect(sanitizeGoogleFamily("  Noto   Sans JP ")).toBe("Noto Sans JP");
    expect(sanitizeGoogleFamily("Playfair+Display")).toBe("Playfair Display");
    expect(sanitizeGoogleFamily("M PLUS 1p")).toBe("M PLUS 1p");
    for (const bad of ["", " ", "Fraunces&family=Evil", "Fraunces:wght@700", "Font'); x", "a/b", "Ünïcode", "x".repeat(65), 7, null]) {
      expect(sanitizeGoogleFamily(bad), String(bad)).toBeNull();
    }
  });

  it("cleans display names of URL and uploaded fonts", () => {
    expect(sanitizeFontLabel("Brand Sans")).toBe("Brand Sans");
    expect(sanitizeFontLabel('Brand "Sans"; } <b>')).toBe("Brand Sans b");
    expect(sanitizeFontLabel("Éditorial-Bold_2.1")).toBe("Éditorial-Bold_2.1");
    expect(sanitizeFontLabel("   ")).toBeNull();
    expect(sanitizeFontLabel("x".repeat(100))?.length).toBe(CUSTOM_FONT_LIMITS.familyChars);
    expect(familyFromFileName("https://cdn.example.com/fonts/BrandSans-Bold.woff2?v=3")).toBe("BrandSans Bold");
    expect(familyFromFileName("my%20font.ttf")).toBe("my font");
  });

  it("allows https URLs and same-origin paths, never other schemes or credentials", () => {
    expect(sanitizeFontUrl("https://cdn.example.com/brand.woff2")).toBe("https://cdn.example.com/brand.woff2");
    expect(sanitizeFontUrl("  HTTPS://CDN.example.com/a.woff2 ")).toBe("https://cdn.example.com/a.woff2");
    expect(sanitizeFontUrl("/fonts/brand.woff2")).toBe("/fonts/brand.woff2");
    expect(sanitizeFontUrl("fonts/brand.woff2")).toBe("fonts/brand.woff2");
    expect(sanitizeFontUrl("http://localhost:4181/f.woff2")).toBe("http://localhost:4181/f.woff2");
    expect(sanitizeFontUrl("http://127.0.0.1/f.woff2")).toBe("http://127.0.0.1/f.woff2");
    for (const bad of [
      "http://cdn.example.com/brand.woff2",
      "https://user:pass@cdn.example.com/brand.woff2",
      "https://token@cdn.example.com/brand.woff2",
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:font/woff2;base64,AAAA",
      "blob:https://example.com/x",
      "file:///etc/passwd",
      "ftp://example.com/f.woff2",
      "//evil.example.com/f.woff2",
      "/fonts/a.woff2) format('woff2'), url(https://evil",
      'https://x.com/"a.woff2',
      "https://x.com/a b.woff2",
      "/\\evil.example.com/f.woff2",
      `https://x.com/${"a".repeat(CUSTOM_FONT_LIMITS.urlChars)}`,
      "",
      42,
    ]) {
      expect(sanitizeFontUrl(bad), String(bad)).toBeNull();
    }
  });

  it("accepts uploads only as base64 font data URLs within the size limit", () => {
    expect(isFontDataUrl(WOFF2)).toBe(true);
    expect(isFontDataUrl("data:font/ttf;base64,AAEAAAALAIAAAwAw")).toBe(true);
    expect(isFontDataUrl("data:application/font-woff;base64,d09GRgABAAA=")).toBe(true);
    expect(isFontDataUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isFontDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isFontDataUrl("data:font/woff2,rawbytes")).toBe(false);
    expect(isFontDataUrl(`data:font/woff2;base64,${"A".repeat(Math.ceil((CUSTOM_FONT_LIMITS.uploadBytes + 4096) / 3) * 4)}`)).toBe(false);
  });

  it("parses and writes the google: spec", () => {
    expect(parseGoogleFontSpec("google:Fraunces")).toEqual({ source: "google", family: "Fraunces" });
    expect(parseGoogleFontSpec("Google:Playfair Display@900")).toEqual({ source: "google", family: "Playfair Display", weight: 900 });
    expect(parseGoogleFontSpec("google:Fraunces@700")).toEqual({ source: "google", family: "Fraunces" });
    for (const bad of ["Fraunces", "google:", "google:Fraunces@750", "google:Fraunces@1000", "google:Evil&x=1", "google:a@b"])
      expect(parseGoogleFontSpec(bad), bad).toBeNull();
    expect(googleFontSpec({ source: "google", family: "Fraunces", weight: 600 })).toBe("google:Fraunces@600");
    expect(googleFontSpec({ source: "url", family: "X", src: "/x.woff2" })).toBeNull();
    expect(googleFontsCssUrl("Noto Sans JP", 700)).toBe("https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@700&display=swap");
  });

  it("sanitizes each source", () => {
    expect(sanitizeCustomFont({ source: "google", family: "Fraunces", weight: 600, src: "https://evil" })).toEqual({
      source: "google",
      family: "Fraunces",
      weight: 600,
    });
    expect(sanitizeCustomFont({ source: "google", family: "Fraunces", weight: 650 })).toEqual({ source: "google", family: "Fraunces" });
    expect(sanitizeCustomFont({ source: "google", family: "x}y" })).toBeNull();
    expect(sanitizeCustomFont({ source: "url", family: "Brand", src: "https://cdn.example.com/b.woff2", weight: 300 })).toEqual({
      source: "url",
      family: "Brand",
      src: "https://cdn.example.com/b.woff2",
    });
    expect(sanitizeCustomFont({ source: "url", src: "https://cdn.example.com/Brand-Sans.woff2" })).toEqual({
      source: "url",
      family: "Brand Sans",
      src: "https://cdn.example.com/Brand-Sans.woff2",
    });
    expect(sanitizeCustomFont({ source: "url", family: "Brand", src: "javascript:alert(1)" })).toBeNull();
    expect(sanitizeCustomFont({ source: "url", family: "Brand", src: WOFF2 })).toBeNull();
    expect(sanitizeCustomFont({ source: "upload", family: "Brand", src: WOFF2 })).toEqual({ source: "upload", family: "Brand", src: WOFF2 });
    // a share link's stub: the family without the file
    expect(sanitizeCustomFont({ source: "upload", family: "Brand" })).toEqual({ source: "upload", family: "Brand" });
    expect(sanitizeCustomFont({ source: "upload", family: "Brand", src: "https://cdn.example.com/b.woff2" })).toEqual({ source: "upload", family: "Brand" });
    expect(sanitizeCustomFont({ source: "upload", src: WOFF2 })).toBeNull();
    expect(sanitizeCustomFont({ source: "ftp", family: "X" })).toBeNull();
    expect(sanitizeCustomFont("google:Fraunces@600")).toEqual({ source: "google", family: "Fraunces", weight: 600 });
    expect(sanitizeCustomFont("inter")).toBeNull();
  });
});

// ── loading, with the CSS Font Loading API and fetch stubbed (Node has neither) ──

class FakeFontFace {
  status: "unloaded" | "loading" | "loaded" | "error" = "unloaded";
  constructor(
    readonly family: string,
    readonly source: string | ArrayBuffer,
    readonly descriptors: FontFaceDescriptors = {},
  ) {}
  async load() {
    const bytes = typeof this.source === "string" ? null : new Uint8Array(this.source);
    const ok =
      typeof this.source === "string" ? !this.source.includes("missing") : bytes!.length >= 4 && String.fromCharCode(...bytes!.subarray(0, 4)) === "wOF2";
    this.status = ok ? "loaded" : "error";
    if (!ok) throw new DOMException("bad font", "SyntaxError");
    return this;
  }
}

const added: FakeFontFace[] = [];
const fakeFonts = {
  add: (f: FakeFontFace) => added.push(f),
  delete: (f: FakeFontFace) => added.splice(added.indexOf(f), 1),
  check: () => false,
  async load(font: string, text = " ") {
    const family = /"([^"]+)"/.exec(font)![1];
    // faces of the family whose range covers the text (a simple U+0000-00FF test is enough here)
    const faces = added.filter(
      (f) => f.family === family && (!f.descriptors.unicodeRange || (/U\+0000-00FF/.test(f.descriptors.unicodeRange) && text.charCodeAt(0) < 256)),
    );
    return Promise.all(faces.map((f) => f.load()));
  },
};

const GOOGLE_CSS = `/* latin-ext */
@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 700; src: url(https://fonts.gstatic.com/s/fraunces/ext.woff2) format('woff2'); unicode-range: U+0100-02BA; }
/* evil */
@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 700; src: url(https://evil.example.com/x.woff2) format('woff2'); unicode-range: U+0000-00FF; }
/* latin */
@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 700; src: url(https://fonts.gstatic.com/s/fraunces/latin.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131; }`;

describe("custom font loading and fallback", () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const assets = { nameFontFamily: "card3d Inter" };

  beforeEach(() => {
    added.length = 0;
    fetchMock.mockReset();
    warn.mockClear();
    vi.stubGlobal("FontFace", FakeFontFace);
    vi.stubGlobal("document", { fonts: fakeFonts });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads a URL font under a card3d-only family, fetched without credentials", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1])));
    const font = { source: "url" as const, family: "Brand", src: "https://cdn.example.com/ok.woff2" };
    const family = await loadDesignFont({ font }, assets);
    expect(family).toMatch(/^card3d custom [0-9a-z]+$/);
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.example.com/ok.woff2", { credentials: "omit" });
    expect(added.map((f) => f.family)).toEqual([family]);
    expect(added[0].descriptors.weight).toBe("100 900");
    // cached: the same family, no second fetch, and the sync lookup sees it
    expect(await loadDesignFont({ font: { ...font } }, assets)).toBe(family);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadedCustomFontFamily(font)).toBe(family);
    expect(designFontFamily({ font }, assets)).toBe(family);
    expect(warn).not.toHaveBeenCalled();
  });

  it("loads an upload from its data URL without any request", async () => {
    const family = await loadDesignFont({ font: { source: "upload", family: "Mine", src: "data:font/woff2;base64,d09GMgAB" } }, assets);
    expect(family).toMatch(/^card3d custom /);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the provider's family on 404, network errors, bad files and missing uploads, warning once", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    const notFound = { source: "url" as const, family: "Gone", src: "https://cdn.example.com/404.woff2" };
    expect(await loadDesignFont({ font: notFound }, assets)).toBe("card3d Inter");
    expect(await loadCustomFont(notFound)).toEqual({ ok: false, error: "HTTP 404" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/"Gone" \(url\) could not be loaded: HTTP 404/);
    expect(designFontFamily({ font: notFound }, assets)).toBe("card3d Inter");

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await loadCustomFont({ source: "url", family: "Offline", src: "https://cdn.example.com/offline.woff2" })).toEqual({
      ok: false,
      error: "network error (Failed to fetch)",
    });

    fetchMock.mockResolvedValueOnce(new Response("<html>not a font</html>"));
    const bad = await loadCustomFont({ source: "url", family: "Html", src: "https://cdn.example.com/page.woff2" });
    expect(bad.ok).toBe(false);
    expect(added).toEqual([]); // the broken face was taken back out

    const missing = await loadCustomFont({ source: "upload", family: "Shared" });
    expect(missing).toEqual({ ok: false, error: expect.stringMatching(/isn't included/) });
    expect(await loadDesignFont({ font: { source: "upload", family: "Shared" } }, assets)).toBe("card3d Inter");
  });

  it("gives up waiting after the timeout and draws with the fallback", async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    expect(await loadDesignFont({ font: { source: "url", family: "Slow", src: "https://cdn.example.com/slow.woff2" } }, assets, 20)).toBe("card3d Inter");
  });

  it("loads a Google family from the CSS2 API, keeping only fonts.gstatic.com faces", async () => {
    fetchMock.mockResolvedValueOnce(new Response(GOOGLE_CSS, { headers: { "content-type": "text/css" } }));
    const family = await loadDesignFont({ font: { source: "google", family: "Fraunces", weight: 600 } }, assets);
    expect(family).toMatch(/^card3d custom /);
    expect(fetchMock.mock.calls[0][0]).toBe("https://fonts.googleapis.com/css2?family=Fraunces:wght@600&display=swap");
    expect(added.map((f) => f.source)).toEqual([
      'url("https://fonts.gstatic.com/s/fraunces/ext.woff2")',
      'url("https://fonts.gstatic.com/s/fraunces/latin.woff2")',
    ]);
    expect(added[1].descriptors.unicodeRange).toBe("U+0000-00FF, U+0131");
  });

  it("retries a Google family without the weight it lacks, and reports unknown families", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 400 })).mockResolvedValueOnce(new Response(GOOGLE_CSS));
    expect((await loadCustomFont({ source: "google", family: "Fraunces", weight: 100 })).ok).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe("https://fonts.googleapis.com/css2?family=Fraunces&display=swap");

    fetchMock.mockResolvedValue(new Response("bad", { status: 400 }));
    expect(await loadCustomFont({ source: "google", family: "No Such Font" })).toEqual({ ok: false, error: "no such Google Fonts family" });
    expect(await loadDesignFont({ font: { source: "google", family: "No Such Font" } }, assets)).toBe("card3d Inter");
  });

  it("leaves catalog fonts and the provider's family alone", async () => {
    expect(await loadDesignFont({}, assets)).toBe("card3d Inter");
    expect(await loadDesignFont({ font: "playfair" }, assets)).toBe("card3d Playfair Display");
    expect(await loadDesignFont({}, { nameFontFamily: "Host Grotesk" })).toBe("Host Grotesk");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
