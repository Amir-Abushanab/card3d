import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import type { Decal } from "../types.ts";
import { cloneDesign, defaultDesign, ensureDesign } from "./design.ts";
import { decodeDesignToken, encodeDesignToken } from "./share.ts";
import {
  DECAL_TINT_PRESETS,
  cloneDecal,
  contrastFactor,
  decalHasLook,
  decalLookRgb,
  decalUvTransform,
  decalVisibleAspect,
  resetDecalPicture,
  sanitizeDecalAdjust,
  sanitizeDecalCrop,
  sanitizeDecalTint,
} from "./decal.ts";
import { decalPlacement } from "./decal-placement.ts";

const base: Decal = { id: "s", side: "front", src: "/stickers/star.svg", aspect: 1.5, x: 40, y: 50, width: 20, rotation: 12, scale: 1 };
const close = (a: readonly number[], b: readonly number[], d = 4) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], d));

describe("decal picture: sanitize", () => {
  it("keeps the old shape exactly when no picture fields are set", () => {
    const d = ensureDesign({ cardholderName: "x", decals: [base] });
    expect(d.decals[0]).toEqual(base);
    expect(Object.keys(d.decals[0]).sort()).toEqual(Object.keys(base).sort());
  });

  it("clamps the crop inside the image and drops a full one", () => {
    expect(sanitizeDecalCrop({ x: 0.9, y: -1, w: 0.5, h: 2 })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(sanitizeDecalCrop({ x: 0.2, y: 0.2, w: 0, h: 0.001 })).toEqual({ x: 0.2, y: 0.2, w: 0.02, h: 0.02 });
    expect(sanitizeDecalCrop({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
    expect(sanitizeDecalCrop({ x: "0", y: 0, w: 1, h: 1 })).toBeNull();
    expect(sanitizeDecalCrop(null)).toBeNull();
  });

  it("validates tint, corrections and opacity", () => {
    expect(sanitizeDecalTint({ color: "#AABBCC", amount: 3 })).toEqual({ color: "#aabbcc", amount: 1 });
    expect(sanitizeDecalTint({ color: "#aabbcc" })).toEqual({ color: "#aabbcc", amount: 1 });
    expect(sanitizeDecalTint({ color: "red", amount: 1 })).toBeNull();
    expect(sanitizeDecalTint({ color: "#aabbcc", amount: 0 })).toBeNull();
    expect(sanitizeDecalAdjust({ brightness: 2, contrast: 0, saturation: -0.25, junk: 4 })).toEqual({ brightness: 1, saturation: -0.25 });
    expect(sanitizeDecalAdjust({ contrast: 0 })).toBeNull();
    const d = ensureDesign({
      cardholderName: "x",
      decals: [{ ...base, aspect: -3, flip: { h: true, v: "yes" }, opacity: -1, tint: { color: "#123456", amount: 0.5 }, adjust: { contrast: 0.4 } }],
    }).decals[0];
    expect(d.aspect).toBe(1);
    expect(d.flip).toEqual({ h: true });
    expect(d.opacity).toBe(0);
    expect(d.tint).toEqual({ color: "#123456", amount: 0.5 });
    expect(d.adjust).toEqual({ contrast: 0.4 });
    const plain = ensureDesign({ cardholderName: "x", decals: [{ ...base, flip: { h: false }, opacity: 1, tint: null, adjust: {} }] }).decals[0];
    expect(plain).toEqual(base);
  });

  it("copies the picture objects with the design", () => {
    const d = defaultDesign();
    d.decals.push({ ...base, crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, tint: { color: "#808080", amount: 1 }, adjust: { brightness: 0.2 }, flip: { v: true } });
    const c = cloneDesign(d);
    c.decals[0].crop!.x = 0.3;
    c.decals[0].tint!.amount = 0.1;
    c.decals[0].adjust!.brightness = 0.9;
    c.decals[0].flip!.v = false;
    expect(d.decals[0].crop!.x).toBe(0);
    expect(d.decals[0].tint!.amount).toBe(1);
    expect(d.decals[0].adjust!.brightness).toBe(0.2);
    expect(d.decals[0].flip!.v).toBe(true);
    const r = cloneDecal(d.decals[0]);
    resetDecalPicture(r);
    expect(r).toEqual(base);
  });
});

describe("decal picture: share links", () => {
  it("round-trips every picture field", async () => {
    const d = defaultDesign();
    const edited: Decal = {
      ...base,
      crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 },
      flip: { h: true, v: true },
      tint: { color: "#3b6fd4", amount: 0.75 },
      adjust: { brightness: 0.1, contrast: -0.2, saturation: 0.3 },
      opacity: 0.6,
    };
    d.decals.push(edited);
    const back = await decodeDesignToken((await encodeDesignToken(d)).token);
    expect(back.decals).toEqual([edited]);
  });

  it("reads old tokens (no picture fields) unchanged", async () => {
    const token = gzipSync(Buffer.from(JSON.stringify({ cardholderName: "Ada", decals: [base] }))).toString("base64url");
    expect((await decodeDesignToken(token)).decals).toEqual([base]);
  });
});

describe("decal picture: crop maths", () => {
  it("gives the visible part's aspect and keeps the visible width", () => {
    expect(decalVisibleAspect(2, undefined)).toBe(2);
    expect(decalVisibleAspect(2, { x: 0, y: 0, w: 0.5, h: 1 })).toBe(1);
    const p = decalPlacement({ ...base, crop: { x: 0.25, y: 0, w: 0.5, h: 0.5 } }, undefined, 0, 0.0274);
    expect(p.width).toBeCloseTo(3.37 * 0.2, 9);
    expect(p.height).toBeCloseTo((3.37 * 0.2) / 1.5, 9);
  });

  it("places an uncropped sticker exactly as before", () => {
    const a = decalPlacement(base, undefined, 2, 0.0274);
    const b = decalPlacement({ ...base, crop: undefined }, undefined, 2, 0.0274);
    expect(a).toEqual(b);
    expect(a.height).toBe(a.width / 1.5);
  });

  it("maps the crop and flips to the map's offset / repeat (flipY texture)", () => {
    expect(decalUvTransform({})).toEqual({ offset: [0, 0], repeat: [1, 1] });
    const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.3 };
    const t = decalUvTransform({ crop });
    close(t.offset, [0.1, 0.5]);
    close(t.repeat, [0.5, 0.3]);
    // uv (0,0) is the crop's bottom-left in image space (v up): x 0.1, y from the top 0.5.
    const at = (uv: [number, number], tr = t) => [tr.offset[0] + uv[0] * tr.repeat[0], tr.offset[1] + uv[1] * tr.repeat[1]];
    close(at([0, 1]), [0.1, 0.8]); // top-left of the crop: 1 − 0.2
    const f = decalUvTransform({ crop, flip: { h: true, v: true } });
    close(at([0, 0], f), [0.6, 0.8]); // mirrored: the quad's bottom-left shows the crop's top-right
    close(at([1, 1], f), [0.1, 0.5]);
  });
});

describe("decal picture: colour maths", () => {
  const grey = (v: number) => [v, v, v] as [number, number, number];

  it("is the identity without a look", () => {
    expect(decalHasLook({})).toBe(false);
    expect(decalHasLook({ adjust: { brightness: 0 } })).toBe(false);
    expect(decalHasLook({ tint: { color: "#000000", amount: 0 } })).toBe(false);
    close(decalLookRgb([0.2, 0.5, 0.9], {}), [0.2, 0.5, 0.9], 9);
  });

  it("grayscale keeps luminance and removes colour", () => {
    const g = DECAL_TINT_PRESETS.find((p) => p.id === "grayscale")!.tint!;
    const [r, gg, b] = decalLookRgb([0.9, 0.3, 0.1], { tint: g });
    expect(Math.abs(r - gg)).toBeLessThan(1e-9);
    expect(Math.abs(gg - b)).toBeLessThan(1e-9);
    const l = 0.2126 * 0.9 + 0.7152 * 0.3 + 0.0722 * 0.1;
    expect(r).toBeCloseTo(l, 2);
  });

  it("a colour wash maps black → colour → white", () => {
    const tint = { color: "#3b6fd4", amount: 1 };
    close(decalLookRgb(grey(0), { tint }), [0, 0, 0]);
    close(decalLookRgb(grey(0.5), { tint }), [0x3b / 255, 0x6f / 255, 0xd4 / 255]);
    close(decalLookRgb(grey(1), { tint }), [1, 1, 1]);
    // amount mixes it in
    close(decalLookRgb(grey(0), { tint: { ...tint, amount: 0.5 } }), [0, 0, 0]);
    close(decalLookRgb([1, 0, 0], { tint: { color: "#000000", amount: 0.5 } }), [0.5, 0, 0]);
  });

  it("brightness, contrast and saturation", () => {
    close(decalLookRgb(grey(0.4), { adjust: { brightness: 1 } }), grey(1));
    close(decalLookRgb(grey(0.4), { adjust: { brightness: -0.5 } }), grey(0.2));
    close(decalLookRgb(grey(0.8), { adjust: { contrast: -1 } }), grey(0.5));
    expect(contrastFactor(0)).toBe(1);
    expect(contrastFactor(1)).toBeCloseTo(10, 9);
    close(decalLookRgb(grey(0.55), { adjust: { contrast: 0.5 } }), grey(0.5 + 0.05 / 0.55));
    const [r, g, b] = decalLookRgb([0.8, 0.4, 0.2], { adjust: { saturation: -1 } });
    expect(r).toBeCloseTo(g, 9);
    expect(g).toBeCloseTo(b, 9);
    const s = decalLookRgb([0.6, 0.4, 0.4], { adjust: { saturation: 1 } });
    expect(s[0] - s[1]).toBeCloseTo(0.4, 9);
  });

  it("every preset is a valid tint", () => {
    for (const p of DECAL_TINT_PRESETS) if (p.tint) expect(sanitizeDecalTint(p.tint)).toEqual(p.tint);
    expect(DECAL_TINT_PRESETS[0]).toMatchObject({ id: "original", tint: null });
  });
});
