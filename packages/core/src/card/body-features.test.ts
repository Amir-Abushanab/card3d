/**
 * Card body and typography beyond the standard card: the layout on shaped frames, the contactless
 * placement, extra text lines and the design fields' sanitizers. (The three.js engine's geometry,
 * edge and finish tests are in the local archive, .archive/three-engine/.)
 */
import { describe, expect, it } from "vitest";
import { BODY_SCALE, CARD_H, CARD_W, CHIP_CENTER, CORNER_RADIUS_RANGE } from "../geometry/constants.ts";
import { cornerInset, DEFAULT_CORNER_RADIUS, frameForShape } from "../geometry/shape-frame.ts";
import { brandingLayout, chipRect, contactlessRect, layoutTextLines, userLogoRect } from "./branding-layout.ts";
import { decalPlacement } from "../design/decal-placement.ts";
import { cloneDesign, defaultDesign, ensureDesign } from "../design/design.ts";
import { sanitizeContactless, sanitizeEdge, sanitizeFinish, sanitizeShape, sanitizeTextLines } from "../design/sanitize.ts";
import { decodeDesignToken, encodeDesignToken } from "../design/share.ts";

const DEPTH = 7 * BODY_SCALE;

describe("layout on shaped frames", () => {
  it("moves corner content in as the corners round", () => {
    expect(cornerInset(undefined, 0.2, 0.1)).toBe(0);
    const pill = frameForShape({ cornerRadius: 1, portrait: false, cutouts: [] });
    const L = brandingLayout(undefined, DEPTH, pill);
    const std = brandingLayout(undefined, DEPTH);
    // Diagonally: in from the side and down from the top by the same amount, staying in the corner.
    expect(L.logo.left - std.logo.left).toBeGreaterThan(0.1);
    expect(L.logo.left - std.logo.left).toBeCloseTo(std.logo.top - L.logo.top, 9);
    expect(L.logo.left).toBeLessThan(-pill.bodyWidth / 2 + 0.6);
    expect(L.nameLeft!).toBeGreaterThan(std.logo.left + 0.1);
    expect(L.textBottom).toBeGreaterThan(std.textBottom + 0.1);
    // The logo's outer corner lies inside the pill's end circle.
    const r = pill.cornerRadius;
    const cx = -pill.bodyWidth / 2 + r;
    expect(Math.hypot(L.logo.left - cx, L.logo.top - 0)).toBeLessThanOrEqual(r);
    // Standard layout unchanged without a frame.
    expect(std.nameLeft).toBeUndefined();
    expect(std.logo.left).toBeCloseTo(-CARD_W / 2 + CARD_W * 0.06, 12);
  });

  it("places stickers and logos in the portrait frame", () => {
    const portrait = { width: CARD_H, height: CARD_W };
    const p = decalPlacement({ side: "front", x: 100, y: 0, width: 20, rotation: 0, aspect: 1 }, undefined, 0, DEPTH, portrait);
    expect(p.position[0]).toBeCloseTo(CARD_H / 2 - p.width / 2, 9);
    expect(p.position[1]).toBeCloseTo(CARD_W / 2 - p.height / 2, 9);
    const f = frameForShape({ cornerRadius: DEFAULT_CORNER_RADIUS, portrait: true, cutouts: [] });
    const L = brandingLayout(undefined, DEPTH, f);
    const r = userLogoRect({ path: "M0 0H8V1Z", viewBox: [8, 1], position: "top-right", scale: 3 }, 8, L);
    expect(r.x + r.w / 2).toBeLessThanOrEqual(CARD_H / 2);
    expect(r.x - r.w / 2).toBeGreaterThanOrEqual(-CARD_H / 2);
  });
});

describe("contactless and text lines", () => {
  it("puts the contactless mark beside the chip, towards the middle", () => {
    const r = contactlessRect(undefined);
    expect(r.x + r.w / 2).toBeLessThan(CHIP_CENTER.x - chipRect(undefined).w / 2);
    expect(r.y).toBeCloseTo(CHIP_CENTER.y, 9);
    const portrait = frameForShape({ cornerRadius: DEFAULT_CORNER_RADIUS, portrait: true, cutouts: [] });
    const p = contactlessRect(portrait);
    expect(p.x).toBeGreaterThan(portrait.chip.x);
  });

  const L = brandingLayout(undefined, DEPTH);
  const box = (o: Partial<Parameters<typeof layoutTextLines>[0][number]> = {}) => ({ aspect: 6, heightInLineBoxes: 1.13, ...o });

  it("stacks bottom-left lines above the name in reading order", () => {
    const nameTop = L.textBottom + 0.12;
    const [a, b] = layoutTextLines([box(), box()], L, { nameTop, obstacles: [] });
    expect(b!.y - b!.h / 2).toBeGreaterThan(nameTop);
    expect(a!.y).toBeGreaterThan(b!.y);
    expect(a!.x - a!.w / 2).toBeCloseTo(L.logo.left, 9);
  });

  it("aligns by placement, keeps clear of the chip and shrinks over-long lines", () => {
    const chip = chipRect(undefined);
    const [right, centre, long] = layoutTextLines(
      [box({ placement: "bottom-right" }), box({ placement: "center", aspect: 4 }), box({ placement: "top", aspect: 80 })],
      L,
      { nameTop: L.textBottom, obstacles: [chip] },
    );
    expect(right!.x + right!.w / 2).toBeCloseTo(CARD_W / 2 - L.M, 9);
    expect(centre!.x + centre!.w / 2).toBeLessThan(chip.x - chip.w / 2);
    expect(long!.w).toBeLessThanOrEqual(CARD_W - 2 * L.M + 1e-9);
  });
});

describe("design fields", () => {
  it("sanitizes untrusted input", () => {
    expect(sanitizeFinish({ name: "embossed", bio: "default", logo: "x" })).toEqual({ name: "embossed" });
    expect(sanitizeEdge({ finish: "match", color: "#123456" })).toEqual({ finish: "match" });
    expect(sanitizeEdge({ finish: "metal", color: "#ABCDEF", chamfer: true })).toEqual({ finish: "metal", color: "#abcdef", chamfer: true });
    expect(sanitizeEdge({ color: "#ffffff" })).toBeUndefined();
    expect(sanitizeShape({ cornerRadius: 7, cutouts: ["window", "window", "nope", "lanyard"] })).toEqual({
      cornerRadius: CORNER_RADIUS_RANGE.max,
      cutouts: ["lanyard", "window"],
    });
    expect(sanitizeShape({ cornerRadius: DEFAULT_CORNER_RADIUS })).toBeUndefined();
    expect(sanitizeShape({ cornerRadius: 0.118 })).toBeUndefined(); // the default, as the studio rounds it
    // Older designs: a pill or the former 4 mm default clamp to 3.48 mm, sharp corners to 2.88 mm.
    expect(sanitizeShape({ cornerRadius: 1 })).toEqual({ cornerRadius: CORNER_RADIUS_RANGE.max });
    expect(sanitizeShape({ cornerRadius: 0.148 })).toEqual({ cornerRadius: CORNER_RADIUS_RANGE.max });
    expect(sanitizeShape({ cornerRadius: 0 })).toEqual({ cornerRadius: CORNER_RADIUS_RANGE.min });
    expect(sanitizeShape({ cornerRadius: 0.123456 })).toEqual({ cornerRadius: 0.123 });
    expect(sanitizeContactless(true)).toEqual({});
    expect(sanitizeContactless({ finish: "etched", scale: 9 })).toEqual({ finish: "etched", scale: 1.2 });
    const lines = sanitizeTextLines(
      [
        { text: "a\nb", font: "inter", size: 99, tracking: -1, align: "right", placement: "top" },
        { text: 3 },
        { text: "x".repeat(99) },
        { text: "c" },
        { text: "d" },
      ],
      ["inter"],
    )!;
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ text: "a b", font: "inter", size: 2, tracking: -0.05, align: "right", placement: "top" });
    expect(lines[1]!.text).toHaveLength(48);
  });

  it("round-trips through ensureDesign, cloneDesign and share tokens", async () => {
    const d = {
      ...defaultDesign(),
      finish: { name: "engraved" as const, logo: "etched" as const },
      edge: { finish: "anodized" as const, color: "#2f6fd6", chamfer: true },
      shape: { cornerRadius: 0.125, orientation: "portrait" as const, cutouts: ["lanyard" as const] },
      contactless: { finish: "embossed" as const },
      textLines: [{ text: "•••• 4242", tracking: 0.12 }],
    };
    const e = ensureDesign(JSON.parse(JSON.stringify(d)));
    expect(e.finish).toEqual(d.finish);
    expect(e.edge).toEqual(d.edge);
    expect(e.shape).toEqual(d.shape);
    expect(e.contactless).toEqual(d.contactless);
    expect(e.textLines).toEqual(d.textLines);
    const c = cloneDesign(e);
    expect(c.shape!.cutouts).not.toBe(e.shape!.cutouts);
    expect(c.textLines![0]).not.toBe(e.textLines![0]);
    const back = await decodeDesignToken((await encodeDesignToken(e)).token);
    expect(back.shape).toEqual(d.shape);
    expect(back.textLines).toEqual(d.textLines);
    // Absent fields stay absent.
    const plain = ensureDesign(JSON.parse(JSON.stringify(defaultDesign())));
    for (const k of ["finish", "edge", "shape", "contactless", "textLines"]) expect(k in plain).toBe(false);
  });
});
