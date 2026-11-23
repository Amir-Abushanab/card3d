/**
 * The production export's pure parts: payment look-alike detection (Luhn, digit runs, labels,
 * networks), the preflight rules (non-payment blocks, the contactless mark, safe zone and keep-outs on
 * a synthetic bake), the CMYK approximation and palette, spec.json's shape, the PNG writer, the mask
 * tracer and the vendor presets.
 */
import { describe, expect, it } from "vitest";
import { defaultDesign, type CardDesign } from "@card3d/core/model";
import { cardDieline, printLayout, type PrintElement, type PrintLayout } from "@card3d/core/print";
import { findNetworks, findPanLike, lookalikeScore, luhnValid, scanTexts } from "./lookalike.ts";
import { defaultPrintOptions, preflightDesign, preflightGeometry, preflightImages, printDesign, capHeightToPt, type PrintOptions } from "./preflight.ts";
import { cmykFor, dominantColors, rgbToCmyk } from "./color.ts";
import { buildPrintSpec, designFonts, PRINT_SPEC_FORMAT } from "./spec.ts";
import { decodePng, encodePng } from "./png.ts";
import { loopsArea, loopsToPath, traceLoops } from "./trace.ts";
import { DEFAULT_PRESET_ID, PRINT_PRESETS, getPreset } from "./vendors.ts";

const design = (patch: Partial<CardDesign> = {}): CardDesign => ({ ...defaultDesign(), ...patch });
const generic = getPreset("generic");
const opts = (patch: Partial<PrintOptions> = {}): PrintOptions => ({ ...defaultPrintOptions(generic), ...patch });
const rules = (issues: Array<{ rule: string }>) => issues.map((i) => i.rule);

describe("card-number detection", () => {
  it("Luhn", () => {
    for (const n of ["4242424242424242", "4111111111111111", "378282246310005", "6011111111111117", "79927398713"]) expect(luhnValid(n)).toBe(true);
    for (const n of ["4242424242424241", "1234567812345678", "", "7"]) expect(luhnValid(n)).toBe(false);
  });
  it("finds 13–19 digit runs, grouped or not, and marks real card-number shapes", () => {
    const m = findPanLike("Card 4242 4242 4242 4242 thanks");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ digits: "4242424242424242", length: 16, luhn: true, cardNumber: true });
    expect(findPanLike("3782-822463-10005")[0]).toMatchObject({ length: 15, luhn: true, cardNumber: true });
    expect(findPanLike("1234 5678 1234 5678")[0]).toMatchObject({ luhn: false, cardNumber: false });
    expect(findPanLike("4242424242424").map((x) => x.length)).toEqual([13]);
    expect(findPanLike("6011 0000 0000 0000 004")[0]!.length).toBe(19);
    // IDs of 10 digits or fewer, masked numbers and runs over 19 digits don't count.
    expect(findPanLike("MEMBER 0123456789")).toEqual([]);
    expect(findPanLike("•••• 4242")).toEqual([]);
    expect(findPanLike("12345678901234567890123")).toEqual([]);
  });
  it("labels and networks", () => {
    const [f] = scanTexts({ cardholderName: "", cardholderBio: "", textLines: [{ text: "Valid thru 12/30" }] });
    expect(f).toMatchObject({ expiryLabel: true, expiryDate: true, securityLabel: false });
    expect(scanTexts({ cardholderName: "CVV 123", cardholderBio: "", textLines: null })[0]!.securityLabel).toBe(true);
    expect(findNetworks("VISA Platinum")).toEqual([{ name: "Visa", strict: true }]);
    expect(findNetworks("Discover more")).toEqual([{ name: "Discover", strict: false }]);
    expect(findNetworks("Visage studio")).toEqual([]);
  });
  it("look-alike score", () => {
    const none = { chip: 0, magstripe: false, number: false, expiry: false, networkMark: false, securityPanel: false, contactless: false };
    expect(lookalikeScore(none)).toEqual({ score: 0, lookalike: false });
    expect(lookalikeScore({ ...none, chip: 1 }).lookalike).toBe(false);
    expect(lookalikeScore({ ...none, chip: 1, number: true, expiry: true }).lookalike).toBe(true);
  });
});

describe("preflight: design rules", () => {
  const withPan = design({ textLines: [{ text: "4242 4242 4242 4242" }, { text: "Valid thru 12/30", placement: "bottom-right" }] });

  it("non-payment: a card number blocks unless it is left out", () => {
    const off = preflightDesign(withPan, opts({ strip: false }), generic);
    const pan = off.issues.find((i) => i.rule === "non-payment:card-number")!;
    expect(pan).toMatchObject({ level: "error", blocking: true });
    expect(pan.message).toContain("Luhn");
    expect(off.issues.find((i) => i.rule === "non-payment:expiry")).toMatchObject({ blocking: true });
    const on = preflightDesign(withPan, opts({ strip: true }), generic);
    expect(on.issues.filter((i) => i.blocking)).toEqual([]);
    expect(on.issues.find((i) => i.rule === "non-payment:card-number")!.level).toBe("info");
    const { design: out, stripped } = printDesign(withPan, opts({ strip: true }));
    expect(out.textLines).toBeNull();
    expect(stripped).toHaveLength(2);
  });

  it("non-payment: the EMVCo contactless mark is blocked, or left out", () => {
    const d = design({ contactless: { finish: "embossed" } });
    expect(preflightDesign(d, opts({ strip: false }), generic).issues.find((i) => i.rule === "non-payment:contactless")).toMatchObject({
      level: "error",
      blocking: true,
    });
    const on = preflightDesign(d, opts({ strip: true }), generic);
    expect(on.issues.find((i) => i.rule === "non-payment:contactless")).toMatchObject({ level: "info", blocking: false });
    expect(printDesign(d, opts({ strip: true })).design.contactless).toBeNull();
    expect(on.lookalike.features.contactless).toBe(false);
  });

  it("non-payment: network names, marks confirmation and the chip", () => {
    const d = design({
      cardholderName: "VISA GOLD",
      decals: [{ id: "a", side: "front", src: "x.png", aspect: 1, x: 50, y: 50, width: 10, rotation: 0, scale: 1 }],
    });
    const r = preflightDesign(d, opts({ strip: false }), generic);
    expect(r.issues.find((i) => i.rule === "non-payment:network")).toMatchObject({ blocking: true });
    expect(r.issues.find((i) => i.rule === "non-payment:marks")).toMatchObject({ blocking: true });
    expect(rules(r.issues)).toContain("non-payment:chip");
    const ok = preflightDesign(d, opts({ strip: true, noNetworkMarks: true, decorativeChip: true }), generic);
    expect(ok.issues.filter((i) => i.blocking)).toEqual([]);
    expect(rules(ok.issues)).not.toContain("non-payment:chip");
  });

  it("payment mode warns instead of blocking", () => {
    const p = preflightDesign(withPan, opts({ mode: "payment" }), getPreset("stripe-custom"));
    expect(p.issues.some((i) => i.blocking)).toBe(false);
    expect(rules(p.issues)).toEqual(expect.arrayContaining(["payment:card-number", "payment:personalisation", "payment:layout"]));
  });

  it("unprintable effects and font licences", () => {
    const d = design({
      recipe: { ...defaultDesign().recipe, frontHolo: true },
      shaders: [{ id: "oil-slick", side: "front", target: "overlay" }],
      font: { source: "upload", family: "Mine", src: "data:font/woff2;base64,AAAA" },
    });
    const r = preflightDesign(d, opts(), generic);
    expect(rules(r.issues)).toEqual(expect.arrayContaining(["unprintable:holo", "unprintable:shader", "font-licence"]));
    expect(r.issues.find((i) => i.rule === "font-licence")).toMatchObject({ blocking: true });
    expect(preflightDesign(d, opts({ fontRights: true }), generic).issues.find((i) => i.rule === "font-licence")).toBeUndefined();
  });
});

/** A synthetic element: a filled rectangle (mm) on a side's raster. */
function element(L: PrintLayout, id: string, kind: PrintElement["kind"], r: { x0: number; y0: number; x1: number; y1: number }): PrintElement {
  const x = Math.floor(L.trim.x + r.x0 * L.pxPerMm);
  const y = Math.floor(L.trim.y + r.y0 * L.pxPerMm);
  const w = Math.ceil((r.x1 - r.x0) * L.pxPerMm);
  const h = Math.ceil((r.y1 - r.y0) * L.pxPerMm);
  return {
    id,
    kind,
    side: "front",
    finish: "default",
    coverage: { x, y, width: w, height: h, data: new Uint8Array(w * h).fill(255) },
    boxMm: r,
    plane: { widthMm: r.x1 - r.x0, heightMm: r.y1 - r.y0, uvWidth: 1, uvHeight: 1, imageWidth: 0, imageHeight: 0 },
    placement: { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, rotation: 0 },
  };
}

describe("preflight: geometry", () => {
  const o = opts();
  const d = design();
  const dl = cardDieline(d, { bleedMm: o.bleedMm, safeMm: o.safeMm, chipClearanceMm: 2 });
  const L = printLayout({ width: dl.width, height: dl.height }, 100, o.bleedMm);
  const run = (els: PrintElement[]) => preflightGeometry([{ side: "front", layout: L, elements: els, masks: {} }], dl, o, generic, d);

  it("text inside the safe zone passes; near the edge it warns; past the trim it errors", () => {
    expect(run([element(L, "cardholder name", "name", { x0: 10, y0: 44, x1: 40, y1: 47 })]).filter((i) => i.rule !== "min-type")).toEqual([]);
    const near = run([element(L, "cardholder name", "name", { x0: 1, y0: 44, x1: 30, y1: 47 })]);
    expect(near.find((i) => i.rule === "safe-zone")).toMatchObject({ level: "warning", element: "cardholder name" });
    const past = run([element(L, "logo", "logo", { x0: -2, y0: 5, x1: 8, y1: 10 })]);
    expect(past.find((i) => i.rule === "trim")).toMatchObject({ level: "error" });
    // A sticker off the edge is a warning (full-bleed stickers exist).
    expect(run([element(L, "sticker decal 0", "sticker", { x0: 70, y0: -2, x1: 90, y1: 10 })]).find((i) => i.rule === "trim")!.level).toBe("warning");
  });

  it("the chip module: overlapping is an error, the clearance band a warning", () => {
    const over = run([element(L, "logo", "logo", { x0: 12, y0: 20, x1: 16, y1: 24 })]);
    expect(over.find((i) => i.rule === "keep-out:contact-plate")).toMatchObject({ level: "error" });
    // 1 mm right of the plate (it ends at 21.36 mm): inside the 2 mm clearance only.
    const close = run([element(L, "logo", "logo", { x0: 22.4, y0: 22, x1: 26, y1: 24 })]);
    expect(close.find((i) => i.rule === "keep-out:contact-plate")).toMatchObject({ level: "warning" });
    expect(run([element(L, "logo", "logo", { x0: 24, y0: 22, x1: 28, y1: 24 })]).find((i) => i.rule === "keep-out:contact-plate")).toBeUndefined();
  });

  it("minimum type and the contactless mark's size", () => {
    expect(capHeightToPt(1.6)).toBeCloseTo(6.3, 1);
    const tiny = run([element(L, "text line 1", "text", { x0: 10, y0: 40, x1: 30, y1: 41 })]);
    expect(tiny.find((i) => i.rule === "min-type")).toBeTruthy();
    const mark = run([element(L, "contactless mark", "contactless", { x0: 25, y0: 21, x1: 28, y1: 25 })]);
    expect(mark.find((i) => i.rule === "contactless-size")).toBeTruthy();
  });

  it("cutouts across the antenna zone", () => {
    const shaped = design({ shape: { cutouts: ["lanyard", "window"] } });
    const sdl = cardDieline(shaped, { bleedMm: 3, safeMm: 3 });
    const issues = preflightGeometry([], sdl, o, generic, shaped);
    expect(issues.map((i) => i.element)).toEqual(["cutout lanyard"]);
    expect(issues[0]!.rule).toBe("cutout:antenna");
  });

  it("image resolution", () => {
    const im = (w: number) => preflightImages([{ label: "Front artwork", width: w, height: Math.round(w * 0.63), widthMm: 85.6, heightMm: 53.98 }], o, generic);
    expect(im(400)[0]).toMatchObject({ rule: "low-res", level: "error" });
    expect(im(900)[0]).toMatchObject({ level: "warning" });
    expect(im(1500)[0]).toMatchObject({ level: "info" });
    expect(im(2100)).toEqual([]);
  });
});

describe("CMYK approximation", () => {
  it("is the documented naive formula", () => {
    expect(rgbToCmyk(255, 0, 0)).toEqual({ c: 0, m: 100, y: 100, k: 0 });
    expect(rgbToCmyk(255, 255, 255)).toEqual({ c: 0, m: 0, y: 0, k: 0 });
    expect(rgbToCmyk(0, 0, 0)).toEqual({ c: 0, m: 0, y: 0, k: 100 });
    expect(rgbToCmyk(128, 128, 128)).toEqual({ c: 0, m: 0, y: 0, k: 50 });
    expect(rgbToCmyk(0, 102, 204)).toEqual({ c: 100, m: 50, y: 0, k: 20 });
    // K = 1 − max; C = (1 − R − K)/(1 − K) …
    const { c, m, y, k } = rgbToCmyk(51, 153, 102);
    expect([c, m, y, k]).toEqual([67, 0, 33, 40]);
  });
  it("black text prints K = 100 only", () => {
    expect(cmykFor("#141414", { text: true })).toEqual({ c: 0, m: 0, y: 0, k: 100 });
    expect(cmykFor("#141414")).toEqual({ c: 0, m: 0, y: 0, k: 92 });
    expect(cmykFor("#1a0f40", { text: true })!.c).toBeGreaterThan(0); // a dark colour, not black
    expect(cmykFor("nope")).toBeNull();
  });
  it("dominant colours", () => {
    const w = 10;
    const px = new Uint8Array(w * w * 4);
    for (let i = 0; i < w * w; i++) px.set(i < 70 ? [200, 30, 30, 255] : [20, 40, 220, 255], i * 4);
    const p = dominantColors(px, w, w, 4);
    expect(p[0]).toMatchObject({ hex: "#c81e1e", share: 0.7 });
    expect(p[1]).toMatchObject({ hex: "#1428dc", share: 0.3 });
  });
});

describe("spec.json", () => {
  it("has the card3d-print/1 shape", () => {
    const d = design({ shape: { cutouts: ["lanyard"] }, edge: { finish: "anodized", color: "#2f6fd6" }, finish: { name: "engraved" } });
    const o = opts();
    const dl = cardDieline(d, { bleedMm: o.bleedMm, safeMm: o.safeMm });
    const L = printLayout({ width: dl.width, height: dl.height }, 600, o.bleedMm);
    const pre = preflightDesign(d, o, generic);
    const spec = buildPrintSpec({
      design: d,
      options: o,
      preset: generic,
      dieline: dl,
      sides: [
        {
          side: "front",
          layout: L,
          composite: "x-front-composite.png",
          elements: [element(L, "cardholder name", "name", { x0: 10, y0: 44, x1: 40, y1: 47 })],
          palette: [{ hex: "#bcbcb9", share: 1 }],
          features: { foil: false, shaderSkin: false, shaderOverlays: 0, addons: false, effects: false, clear: false },
        },
      ],
      plates: [
        {
          side: "front",
          name: "Engrave",
          kind: "engrave",
          files: ["x-front-engrave.png", "x-front-engrave.svg"],
          process: "laser",
          description: "",
          bits: 1,
          polarity: "black = effect",
        },
      ],
      fonts: [],
      files: ["x/spec.json"],
      dielineFiles: { front: "x-front-dieline.svg" },
      proofs: [],
      derivatives: [],
      issues: pre.issues,
      lookalike: pre.lookalike,
      stripped: [],
      createdAt: "2026-11-12T00:00:00.000Z",
    }) as Record<string, any>;
    expect(spec.spec).toBe(PRINT_SPEC_FORMAT);
    for (const k of [
      "card",
      "material",
      "bleed_mm",
      "safe_mm",
      "artwork",
      "colour",
      "plates",
      "dieline",
      "features",
      "layers",
      "fonts",
      "preflight",
      "lookalike_score",
      "files",
      "warnings",
    ])
      expect(spec).toHaveProperty(k);
    expect(spec.card).toMatchObject({ standard: "ISO/IEC 7810 ID-1", trim_mm: [85.6, 53.98], corner_mm: 3.18, orientation: "horizontal" });
    expect(spec.card.cutouts[0]).toMatchObject({ type: "lanyard-slot", path: "x-front-dieline.svg#cutout-lanyard" });
    expect(spec.material.edge).toEqual({ type: "anodized", colour: "#2f6fd6", chamfer: false });
    expect(spec.artwork).toMatchObject({ dpi: 600, colour_space: "sRGB IEC 61966-2.1", size_px: [L.width, L.height] });
    expect(spec.colour.cmyk_formula).toContain("K = 1 − max(R,G,B)");
    const roles = spec.colour.colours.map((c: { role: string }) => c.role);
    expect(roles).toEqual(expect.arrayContaining(["body", "engraved fill", "edge (anodized)"]));
    for (const c of spec.colour.colours) {
      expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(c.pms).toBeNull();
      expect(Object.keys(c.cmyk)).toEqual(["c", "m", "y", "k"]);
    }
    expect(spec.dieline.keep_outs.map((k: { kind: string }) => k.kind)).toEqual(expect.arrayContaining(["contact-plate", "antenna"]));
    expect(spec.layers[0]).toMatchObject({ id: "cardholder name", kind: "name", side: "front" });
    expect(spec.preflight.profile).toBe("generic");
    expect(spec.features.chip).toBe("contact (unconfirmed)");
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
  });
  it("fonts used", () => {
    expect(designFonts(design({ font: "manrope", textLines: [{ text: "MEMBER", font: "plex-mono" }] })).map((f) => [f.font, f.roles])).toEqual([
      ["manrope", ["cardholder name", "bio"]],
      ["plex-mono", ["text line 1"]],
    ]);
  });
});

describe("PNG writer", () => {
  it("round-trips 1-bit (inverted), 8-bit grey and RGB with the resolution", () => {
    const g = new Uint8Array([0, 255, 255, 0, 128, 10, 250, 255, 0]);
    const one = decodePng(encodePng({ width: 3, height: 3, channels: 1, data: g }, { bits: 1, invert: true, dpi: 600 }));
    expect(one).toMatchObject({ width: 3, height: 3, bits: 1, dpi: 600 });
    expect(Array.from(one.data)).toEqual([255, 0, 0, 255, 0, 255, 0, 0, 255]);
    const eight = decodePng(encodePng({ width: 3, height: 3, channels: 1, data: g }));
    expect(Array.from(eight.data)).toEqual(Array.from(g));
    const rgb = new Uint8Array([1, 2, 3, 250, 128, 7]);
    const c = decodePng(encodePng({ width: 2, height: 1, channels: 3, data: rgb }, { dpi: 1200 }));
    expect([c.channels, c.dpi, ...c.data]).toEqual([3, 1200, ...rgb]);
  });
});

describe("mask tracing", () => {
  it("outlines a square with a hole (even-odd), in output units", () => {
    const w = 40;
    const data = new Uint8Array(w * w);
    for (let y = 5; y < 35; y++) for (let x = 5; x < 35; x++) data[y * w + x] = x >= 15 && x < 25 && y >= 15 && y < 25 ? 0 : 255;
    const loops = traceLoops({ width: w, height: w, data });
    expect(loops).toHaveLength(2);
    // Outer 30 × 30 minus the 10 × 10 hole, measured at the 50 % level between pixel centres.
    expect(Math.abs(loopsArea(loops.slice(0, 1)) - 900)).toBeLessThan(40);
    const d = loopsToPath(loops, (x, y) => [x / 10, y / 10]);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d.endsWith("Z")).toBe(true);
  });
});

describe("vendor presets", () => {
  it("are complete, sourced and keep unknowns as TODO", () => {
    expect(getPreset(DEFAULT_PRESET_ID).id).toBe("generic");
    expect(getPreset("nope").id).toBe("generic");
    const ids = new Set<string>();
    for (const p of PRINT_PRESETS) {
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      expect(p.sources.length).toBeGreaterThan(0);
      expect(p.bleedMm).toBeGreaterThan(0);
      expect(p.safeMm).toBeGreaterThan(0);
      expect([300, 600, 1200]).toContain(p.dpi);
      if (p.status !== "published") expect(p.todo.length + p.sources.filter((s) => s.grade !== "P").length).toBeGreaterThan(0);
      for (const d of p.derivatives) expect(d.width * d.height).toBeGreaterThan(0);
    }
    expect(getPreset("generic")).toMatchObject({ bleedMm: 3.175, safeMm: 3.2, dpi: 600, maskBits: 1 });
    expect(getPreset("stripe-custom")).toMatchObject({ bleedMm: 1, safeMm: 2, minPpi: 350, mode: "payment" });
    expect(getPreset("increase").derivatives[0]).toMatchObject({ width: 2100, height: 1344, kind: "bw" });
    expect(getPreset("printags").status).toBe("todo");
  });
});
