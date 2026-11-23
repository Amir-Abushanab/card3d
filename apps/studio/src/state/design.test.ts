import { describe, expect, it } from "vitest";
import { cloneDesign, defaultDesign, ensureDesign, sanitizeLogo, stripEmbeddedMedia } from "./design.ts";
import { maskAlpha } from "../stickers/logo.ts";

describe("design: font, logo and lighting", () => {
  it("survive ensureDesign (share links, files); unknown values are dropped", () => {
    const d = ensureDesign({
      ...defaultDesign(),
      font: "playfair",
      lighting: "warm",
      logo: { path: "M0 0H10V10Z", viewBox: [10, 10], position: "center", scale: 1.5 },
    });
    expect(d.font).toBe("playfair");
    expect(d.lighting).toBe("warm");
    expect(d.logo).toEqual({ path: "M0 0H10V10Z", viewBox: [10, 10], position: "center", scale: 1.5 });
    const bad = ensureDesign({ ...defaultDesign(), font: "comic", lighting: "disco", logo: { path: "<script>", viewBox: [1, 1] } });
    expect(bad.font).toBeUndefined();
    expect(bad.lighting).toBeUndefined();
    expect(bad.logo).toBeUndefined();
  });

  it("sanitizeLogo bounds paths and mask URLs and clamps placement", () => {
    expect(sanitizeLogo({ src: "data:image/png;base64,AAAA", aspect: 2, scale: 99, position: "nowhere" })).toEqual({
      src: "data:image/png;base64,AAAA",
      aspect: 2,
      scale: 3,
    });
    expect(sanitizeLogo({ src: "javascript:alert(1)" })).toBeNull();
    expect(sanitizeLogo({ src: "data:text/html;base64,AAAA" })).toBeNull();
    expect(sanitizeLogo({ path: "M0 0".repeat(10_000), viewBox: [1, 1] })).toBeNull();
    expect(sanitizeLogo({ path: "M0 0Z", viewBox: [1, 1], origin: [2, 3], fillRule: "evenodd", scale: 1, position: "corner" })).toEqual({
      path: "M0 0Z",
      viewBox: [1, 1],
      origin: [2, 3],
      fillRule: "evenodd",
    });
  });

  it("the logo is kept in links and autosave (stripEmbeddedMedia), and cloned deeply", () => {
    const d = { ...defaultDesign(), logo: { src: "data:image/png;base64,AAAA", aspect: 2 } };
    expect(stripEmbeddedMedia(d).design.logo).toEqual(d.logo);
    const p = { ...defaultDesign(), logo: { path: "M0 0Z", viewBox: [1, 1] as [number, number] } };
    const c = cloneDesign(p);
    c.logo!.viewBox![0] = 5;
    expect(p.logo.viewBox[0]).toBe(1);
  });
});

describe("logo mask", () => {
  const image = (w: number, h: number, px: (x: number, y: number) => [number, number, number, number]) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
    return { width: w, height: h, data, colorSpace: "srgb" } as ImageData;
  };

  it("uses the image's alpha when it has transparency", () => {
    const a = maskAlpha(image(10, 10, (x) => (x < 5 ? [0, 0, 0, 0] : [200, 10, 10, 255])));
    expect(a[0]).toBe(0);
    expect(a[9]).toBe(255);
  });

  it("finds dark ink on white, and light ink on dark", () => {
    const dark = maskAlpha(image(20, 20, (x, y) => (x > 6 && x < 13 && y > 6 && y < 13 ? [10, 10, 10, 255] : [255, 255, 255, 255])));
    expect(dark[0]).toBe(0);
    expect(dark[10 * 20 + 10]).toBe(255);
    const light = maskAlpha(image(20, 20, (x, y) => (x > 6 && x < 13 && y > 6 && y < 13 ? [250, 250, 250, 255] : [5, 5, 5, 255])));
    expect(light[0]).toBe(0);
    expect(light[10 * 20 + 10]).toBe(255);
  });

  it("refuses a flat image", () => {
    expect(() => maskAlpha(image(8, 8, () => [128, 128, 128, 255]))).toThrow(/contrast/);
  });
});
