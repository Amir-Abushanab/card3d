/**
 * Preflight of a production export: checks run on the design (mode rules, fonts, effects a printer
 * can't reproduce) and on the flat bake (where each placed element landed against the trim, the safe
 * zone, cutouts and keep-outs; placed image resolution; minimum type; the contactless mark's size).
 * Each finding is an error, a warning or a note; `blocking` findings stop the export until the design
 * or the options change (the non-payment rules and unconfirmed font rights).
 *
 * The rules follow the standards (`@card3d/core/print` dieline) and the vendor preset (`vendors.ts`).
 */
import type { CardDesign, Side } from "@card3d/core/model";
import { contourPoints, inContour, inRounded, type CardDieline, type KeepOut, type PrintElement, type PrintLayout, type PrintMaskId } from "@card3d/core/print";
import type { PrintMode, PrintPreset } from "./vendors.ts";
import { lookalikeScore, scanTexts, type LookalikeFeatures, type TextFinding } from "./lookalike.ts";

type IssueLevel = "error" | "warning" | "info";

export interface PreflightIssue {
  /** Stable rule id ("non-payment:card-number", "safe-zone", …). */
  rule: string;
  level: IssueLevel;
  /** Stops the export (non-payment rules, unconfirmed rights). */
  blocking: boolean;
  message: string;
  side?: Side;
  /** The element or text concerned (a mesh name such as "cardholder name", or a design field). */
  element?: string;
}

export interface PrintOptions {
  presetId: string;
  mode: PrintMode;
  dpi: number;
  bleedMm: number;
  safeMm: number;
  maskBits: 1 | 8;
  /** A magnetic stripe on the back (payment programs). */
  magstripe: boolean;
  /** Non-payment: leave payment-card features out of the files instead of blocking. */
  strip: boolean;
  /** The chip is a decorative or NFC module (or a contact memory chip), not a payment chip. */
  decorativeChip: boolean;
  /** The user confirms their logo and stickers carry no payment network or bank marks. */
  noNetworkMarks: boolean;
  /** The user confirms the rights to use an uploaded or linked font in printed products. */
  fontRights: boolean;
}

export function defaultPrintOptions(preset: PrintPreset, mode: PrintMode = preset.mode): PrintOptions {
  return {
    presetId: preset.id,
    mode,
    dpi: preset.dpi,
    bleedMm: preset.bleedMm,
    safeMm: preset.safeMm,
    maskBits: preset.maskBits,
    magstripe: mode === "payment" && preset.magstripe,
    strip: true,
    decorativeChip: false,
    noNetworkMarks: false,
    fontRights: false,
  };
}

export interface StripNote {
  what: string;
  why: string;
}

const isPaymentText = (f: TextFinding) =>
  f.pan.length > 0 || f.expiryLabel || f.securityLabel || f.networks.some((n) => n.strict) || (f.expiryDate && f.expiryLabel);

/**
 * The design the files are made from. Non-payment with `strip`: the contactless indicator and any text
 * that carries a card number, an expiry or security-code label or a network name are left out.
 */
export function printDesign(design: CardDesign, o: Pick<PrintOptions, "mode" | "strip">): { design: CardDesign; stripped: StripNote[] } {
  const stripped: StripNote[] = [];
  if (o.mode !== "non-payment" || !o.strip) return { design, stripped };
  const d: CardDesign = { ...design };
  if (d.contactless) {
    d.contactless = null;
    stripped.push({ what: "Contactless indicator", why: "EMVCo's payment trademark" });
  }
  const why = (f: TextFinding) =>
    f.pan.length
      ? "a card-number-like run of digits"
      : f.securityLabel
        ? "a security-code label"
        : f.expiryLabel
          ? "an expiry label"
          : "a payment network name";
  for (const f of scanTexts(design)) {
    if (!isPaymentText(f)) continue;
    stripped.push({ what: `${f.label} “${f.text}”`, why: why(f) });
    if (f.key === "name") d.cardholderName = "";
    else if (f.key === "bio") d.cardholderBio = "";
  }
  const lines = (design.textLines ?? []).filter((l) => {
    const f = scanTexts({ cardholderName: "", cardholderBio: "", textLines: [l] })[0];
    return !(f && isPaymentText(f));
  });
  if (design.textLines) d.textLines = lines.length ? lines : null;
  return { design: d, stripped };
}

const isGlass = (d: CardDesign) => d.recipe.material === "glass" || (d.materialOverride?.transmission ?? 0) > 0.5;

/** Checks that need only the design and the options. */
export function preflightDesign(
  design: CardDesign,
  o: PrintOptions,
  preset: PrintPreset,
): { issues: PreflightIssue[]; lookalike: { score: number; lookalike: boolean; features: LookalikeFeatures }; stripped: StripNote[] } {
  const issues: PreflightIssue[] = [];
  const add = (i: Omit<PreflightIssue, "blocking"> & { blocking?: boolean }) => issues.push({ blocking: false, ...i });
  const findings = scanTexts(design);
  const { design: out, stripped } = printDesign(design, o);
  const after = scanTexts(out);
  const np = o.mode === "non-payment";
  const strippedSet = new Set(stripped.map((s) => s.what));

  // ── payment look-alikes ──
  for (const f of findings) {
    const gone = strippedSet.has(`${f.label} “${f.text}”`);
    for (const p of f.pan) {
      const shape = `${p.length}-digit run${p.luhn ? " that passes the Luhn check (a real card number's shape)" : ""}`;
      if (np)
        add({
          rule: "non-payment:card-number",
          level: gone ? "info" : "error",
          blocking: !gone,
          element: f.label,
          message: gone
            ? `Left out: ${f.label} has a ${shape} (“${p.text}”).`
            : `${f.label} has a ${shape} (“${p.text}”). A non-payment card can't carry anything that reads as a card number (13–19 digits). Remove it, or keep IDs to 10 digits or add letters.`,
        });
      else
        add({
          rule: "payment:card-number",
          level: "warning",
          element: f.label,
          message: `${f.label} has a ${shape}. The issuer personalises the card number: leave it out of the art (use a placeholder zone).`,
        });
    }
    if (f.expiryLabel || f.securityLabel) {
      const what = f.securityLabel ? "a security-code label (CVV / CVC)" : `an expiry label${f.expiryDate ? " with a date" : ""}`;
      const next = findings.some((g) => g.pan.length) ? " next to a card-number-like number" : "";
      if (np)
        add({
          rule: "non-payment:expiry",
          level: gone ? "info" : "error",
          blocking: !gone,
          element: f.label,
          message: gone
            ? `Left out: ${f.label} (${what}).`
            : `${f.label} has ${what}${next}: that's a payment card's field. Not allowed on a non-payment card.`,
        });
      else
        add({
          rule: "payment:personalisation",
          level: "warning",
          element: f.label,
          message: `${f.label} has ${what}. Expiry and security codes are personalised by the issuer, not printed in the art.`,
        });
    }
    for (const n of f.networks) {
      if (np) {
        if (n.strict)
          add({
            rule: "non-payment:network",
            level: gone ? "info" : "error",
            blocking: !gone,
            element: f.label,
            message: gone
              ? `Left out: ${f.label} names ${n.name}.`
              : `${f.label} names the payment network ${n.name}: a registered mark, not allowed on a non-payment card.`,
          });
        else
          add({
            rule: "non-payment:network",
            level: "warning",
            element: f.label,
            message: `${f.label} has “${n.name}”, also a payment brand. Make sure it doesn't read as one.`,
          });
      } else
        add({
          rule: "payment:network",
          level: "warning",
          element: f.label,
          message: `${f.label} names ${n.name}. The network's brand mark comes from the network's artwork, not typed text.`,
        });
    }
  }
  if (design.contactless) {
    if (np)
      add({
        rule: "non-payment:contactless",
        level: o.strip ? "info" : "error",
        blocking: !o.strip,
        message: o.strip
          ? "Left out: the contactless indicator (EMVCo's payment trademark). Use your own NFC icon instead."
          : "The contactless indicator is EMVCo's trademark: a non-payment card can't carry it without EMVCo's non-payment licence. Turn it off, use your own NFC icon, or let the export leave it out.",
      });
    else
      add({
        rule: "payment:contactless",
        level: "info",
        message:
          "The contactless indicator is EMVCo's trademark: the issuer needs EMVCo's licence, and networks supply the official artwork (≥ 4.5 mm tall, facing right, solid colour).",
      });
  }
  if (np) {
    if (!o.noNetworkMarks && (design.logo || design.decals.length || design.surfaceSources.front || design.surfaceSources.back))
      add({
        rule: "non-payment:marks",
        level: "error",
        blocking: true,
        message:
          "Confirm that your logo, artwork and stickers show no payment network or bank marks (Visa, Mastercard, Amex, Discover, JCB, UnionPay, Maestro, Interac, a bank's name or logo, a hologram look-alike).",
      });
    if (!o.decorativeChip)
      add({
        rule: "non-payment:chip",
        level: "warning",
        message:
          "The card has a contact chip plate. On a non-payment card it must be a decorative or NFC module (or a contact-memory chip): tick “the chip is a decorative / NFC module”.",
      });
    if (o.magstripe) add({ rule: "non-payment:magstripe", level: "warning", message: "A magnetic stripe adds to the payment-card look." });
  } else {
    add({
      rule: "payment:layout",
      level: "info",
      message:
        "Payment programs: the issuer's printer places the network brand mark, hologram, signature panel and personalisation (number, name, dates) from their template. Keep the marked keep-outs clear.",
    });
    if (!preset.networkMark)
      add({
        rule: "payment:network-mark",
        level: "info",
        message:
          "Reserve a corner for the network brand mark (Visa: any corner; on vertical cards it may align with the chip). Its size comes from the network's artwork and isn't in this preset.",
      });
  }
  const features: LookalikeFeatures = {
    chip: o.decorativeChip ? 0.5 : 1,
    magstripe: o.magstripe,
    number: after.some((f) => f.pan.length > 0),
    expiry: after.some((f) => f.expiryLabel || (f.expiryDate && f.expiryLabel)),
    networkMark: after.some((f) => f.networks.some((n) => n.strict)) || (np && !o.noNetworkMarks && !!(design.logo || design.decals.length)),
    securityPanel: after.some((f) => f.securityLabel) || (o.mode === "payment" && !!preset.signaturePanel),
    contactless: !!out.contactless,
  };
  const look = lookalikeScore(features);
  if (np && look.lookalike)
    add({
      rule: "non-payment:lookalike",
      level: "error",
      blocking: true,
      message: `The card still looks like a payment card (look-alike score ${look.score.toFixed(2)}): a chip with a number, expiry, network-style mark or stripe. Remove those features.`,
    });
  if (np && features.chip > 0)
    add({
      rule: "non-payment:disclaimer",
      level: "info",
      message: "Cards that keep a chip often print “NOT A PAYMENT CARD” or “MEMBERSHIP” (common practice, not a legal safe harbour).",
    });

  // ── what a printer can't reproduce ──
  const r = design.recipe;
  if (r.frontHolo || r.backHolo)
    add({
      rule: "unprintable:holo",
      level: "warning",
      message: `The holographic foil${r.holoMotion || r.backHoloMotion ? " and its animation" : ""} can't be printed as rendered: it's exported as a Foil plate (where the foil goes). Pick a holographic foil with the vendor.`,
    });
  if (r.backHolo && preset.frontOnly.includes("foil"))
    add({ rule: "vendor:front-only", level: "warning", side: "back", message: `${preset.name}: foil on the front only; the back's foil can't be made.` });
  const layers = (design.shaders ?? []).filter((l) => l && l.enabled !== false);
  if (layers.length) {
    const live = layers.filter((l) => l.animated !== false && l.time === undefined);
    add({
      rule: "unprintable:shader",
      level: "warning",
      message: `${layers.length} face shader layer${layers.length > 1 ? "s are" : " is"} flattened to a still frame${live.length ? " (the animation is lost)" : ""}; view-dependent overlays print as seen face-on.`,
    });
  }
  if (isGlass(design))
    add({
      rule: "unprintable:glass",
      level: "warning",
      message: "Glass: refraction can't be printed. The files are a clear card: a White plate where ink is printed; unprinted areas stay clear.",
    });
  if (design.addons && (design.addons.shine || design.addons.vines))
    add({ rule: "unprintable:addon", level: "warning", message: "Add-ons (shine, vines) are 3D light and objects: left out of the files." });
  if (design.edge)
    add({
      rule: "edge",
      level: "info",
      message: `Edge: ${design.edge.finish ?? "body"}${design.edge.color ? ` ${design.edge.color}` : ""}${design.edge.chamfer ? ", polished chamfer" : ""}. An edge colour is a spec value (spec.json), not a plate.`,
    });

  // ── fonts ──
  const font = design.font;
  if (font && typeof font === "object") {
    if (font.source === "google")
      add({
        rule: "font-licence",
        level: "info",
        message: `Google Fonts “${font.family}”: most Google Fonts are under the SIL Open Font License, which allows print. Check the family's licence.`,
      });
    else {
      if (!o.fontRights)
        add({
          rule: "font-licence",
          level: "error",
          blocking: true,
          message: `The ${font.source === "upload" ? "uploaded" : "linked"} font “${font.family}”: confirm you have the right to use it in printed products (and to send it to the printer).`,
        });
      if (font.source === "upload" && !font.src)
        add({
          rule: "font-missing",
          level: "warning",
          message: `The uploaded font “${font.family}” isn't in this design (it came from a link): the card falls back to Inter.`,
        });
    }
  } else
    add({
      rule: "font-licence",
      level: "info",
      message: "Card fonts are under the SIL Open Font License (print allowed); the files and licences are in the package.",
    });

  add({
    rule: "colour",
    level: "warning",
    message:
      "Colours are sRGB. CMYK conversion by the vendor (with their ICC profile); spec.json lists approximate CMYK values only. Black text should print as K = 100.",
  });
  return { issues, lookalike: { ...look, features }, stripped };
}

// ── geometry ────────────────────────────────────────────────────────────────

export interface GeometrySide {
  side: Side;
  layout: PrintLayout;
  elements: PrintElement[];
  /** Which separations exist (and their rasters, for coverage checks). */
  masks: Partial<Record<PrintMaskId, { width: number; height: number; data: Uint8Array }>>;
}

const LABEL: Record<PrintElement["kind"], string> = {
  logo: "Logo",
  name: "Cardholder name",
  bio: "Bio",
  text: "Text line",
  contactless: "Contactless indicator",
  sticker: "Sticker",
};
export const elementLabel = (e: Pick<PrintElement, "id" | "kind">) =>
  e.kind === "text" ? e.id.replace(/^text line/, "Text line") : e.kind === "sticker" ? e.id.replace(/^sticker decal/, "Sticker") : LABEL[e.kind];

/** Visit an element's covered pixels (value > 127) as mm points; at most ~60k samples. */
function forEachMm(e: PrintElement, L: PrintLayout, fn: (x: number, y: number) => void): number {
  const c = e.coverage;
  if (!c) return 0;
  const step = Math.max(1, Math.ceil(Math.sqrt((c.width * c.height) / 60_000)));
  let n = 0;
  for (let y = 0; y < c.height; y += step)
    for (let x = 0; x < c.width; x += step) {
      if (c.data[y * c.width + x]! <= 127) continue;
      n++;
      fn((c.x + x + 0.5 - L.trim.x) / L.pxPerMm, (c.y + y + 0.5 - L.trim.y) / L.pxPerMm);
    }
  return n;
}

/** "Magnetic stripe" → "magnetic stripe" (acronyms such as NFC and ISO stay). */
const lc = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

const grow = (k: KeepOut, by: number) => ({ rect: { x0: k.rect.x0 - by, x1: k.rect.x1 + by, y0: k.rect.y0 - by, y1: k.rect.y1 + by }, radius: k.radius + by });

/** Point size of a capitals-only text whose ink is `capMm` tall (cap height ≈ 0.72 em). */
export const capHeightToPt = (capMm: number) => capMm / 0.72 / (25.4 / 72);

/** Checks of where each placed element landed (needs the bake and the dieline). */
export function preflightGeometry(sides: GeometrySide[], d: CardDieline, o: PrintOptions, preset: PrintPreset, design: CardDesign): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const add = (i: Omit<PreflightIssue, "blocking"> & { blocking?: boolean }) => issues.push({ blocking: false, ...i });
  const np = o.mode === "non-payment";
  const serif = typeof design.font === "string" && design.font === "playfair";
  for (const s of sides) {
    const D = d.sides[s.side];
    const L = s.layout;
    for (const e of s.elements) {
      if (!e.coverage) continue;
      const label = elementLabel(e);
      const printed = e.kind !== "sticker";
      let total = 0;
      let outTrim = 0;
      let outSafe = 0;
      let inHole = 0;
      const hits = new Map<KeepOut, number>();
      const inArea = new Map<KeepOut, number>();
      const zones = D.keepOuts.filter((k) => k.rule !== "info" || (k.kind === "raised-free" && e.finish === "embossed"));
      total = forEachMm(e, L, (x, y) => {
        if (!inContour(D.trim, x, y)) outTrim++;
        else if (!inRounded(d.safe.rect, d.safe.radius, x, y)) outSafe++;
        if (D.cutouts.some((c) => inContour(c, x, y))) inHole++;
        for (const k of zones) {
          const g = grow(k, k.clearance);
          if (!inRounded(g.rect, g.radius, x, y) || (k.inner && inRounded(k.inner.rect, Math.max(0, k.inner.radius - k.clearance), x, y))) continue;
          hits.set(k, (hits.get(k) ?? 0) + 1);
          if (inRounded(k.rect, k.radius, x, y) && !(k.inner && inRounded(k.inner.rect, k.inner.radius, x, y))) inArea.set(k, (inArea.get(k) ?? 0) + 1);
        }
      });
      if (!total) continue;
      const pct = (n: number) => `${Math.max(1, Math.round((100 * n) / total))} %`;
      if (outTrim) {
        if (printed)
          add({
            rule: "trim",
            level: "error",
            side: s.side,
            element: e.id,
            message: `${label} (${s.side}) runs past the trim: ${pct(outTrim)} of it is cut off.`,
          });
        else
          add({
            rule: "trim",
            level: "warning",
            side: s.side,
            element: e.id,
            message: `${label} (${s.side}) runs off the card edge (${pct(outTrim)} in the bleed). Fine for a full-bleed sticker; otherwise move it in.`,
          });
      }
      if (outSafe && printed)
        add({
          rule: "safe-zone",
          level: "warning",
          side: s.side,
          element: e.id,
          message: `${label} (${s.side}) is outside the ${o.safeMm} mm safe zone: the cut can drift into it.`,
        });
      if (inHole)
        add({ rule: "cutout", level: "warning", side: s.side, element: e.id, message: `Part of ${label} (${s.side}) lies over a cutout and is punched out.` });
      for (const k of hits.keys()) {
        if (k.kind === "antenna") continue; // checked for cutouts and foil below
        const chip = k.kind === "contact-plate" || k.kind === "contact-area";
        if (k.kind === "raised-free") {
          add({
            rule: "keep-out:raised",
            level: "error",
            side: s.side,
            element: e.id,
            message: `${label} is embossed (raised) within 19.05 mm of the magnetic stripe's edge: ISO/IEC 7811-6 allows no raised areas there.`,
          });
          continue;
        }
        if (chip && k.kind === "contact-area" && hits.has(D.keepOuts.find((x) => x.kind === "contact-plate")!)) continue;
        const inside = inArea.get(k) ?? 0;
        if (!inside) {
          add({
            rule: `keep-out:${k.kind}`,
            level: "warning",
            side: s.side,
            element: e.id,
            message: `${label} (${s.side}) is closer than ${k.clearance} mm to the ${lc(k.label)} (${preset.name} asks for ${k.clearance} mm).`,
          });
          continue;
        }
        const level = k.rule === "block" && !(chip && np && o.decorativeChip) ? "error" : "warning";
        add({
          rule: `keep-out:${k.kind}`,
          level,
          side: s.side,
          element: e.id,
          message: `${label} (${s.side}) overlaps the ${lc(k.label)}: ${pct(inside)} of it.${chip ? " The module is inserted there; nothing printed or engraved under it survives." : ""}`,
        });
      }
      // Minimum type: capitals' height → points.
      if ((e.kind === "name" || e.kind === "bio" || e.kind === "text") && e.boxMm && preset.minTypePt) {
        const pt = capHeightToPt(e.boxMm.y1 - e.boxMm.y0);
        const min = serif ? preset.minTypePt.serif : preset.minTypePt.sans;
        if (pt < min)
          add({
            rule: "min-type",
            level: "warning",
            side: s.side,
            element: e.id,
            message: `${label} is about ${pt.toFixed(1)} pt; ${preset.name} asks for at least ${min} pt.`,
          });
      }
      if (e.kind === "contactless" && e.boxMm) {
        const h = e.boxMm.y1 - e.boxMm.y0;
        if (h < 4.5)
          add({
            rule: "contactless-size",
            level: np ? "warning" : "error",
            side: s.side,
            element: e.id,
            message: `The contactless indicator is ${h.toFixed(1)} mm tall; EMVCo requires at least 4.5 mm.`,
          });
        const space = h < 7 ? 1.7 : h * 0.25;
        const box = { x0: e.boxMm.x0 - space, x1: e.boxMm.x1 + space, y0: e.boxMm.y0 - space, y1: e.boxMm.y1 + space };
        for (const other of s.elements) {
          if (other === e || !other.boxMm) continue;
          let near = 0;
          forEachMm(other, L, (x, y) => {
            if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) near++;
          });
          if (near)
            add({
              rule: "contactless-space",
              level: "warning",
              side: s.side,
              element: other.id,
              message: `${elementLabel(other)} is within the contactless indicator's clear space (${space.toFixed(1)} mm).`,
            });
        }
      }
    }
    // Foil: coverage, over the antenna, overlapping spot gloss.
    const foil = s.masks.foil;
    if (foil) {
      const ant = D.keepOuts.find((k) => k.kind === "antenna");
      let on = 0;
      let overAnt = 0;
      let overGloss = 0;
      const gloss = s.masks["spot-gloss"];
      const step = Math.max(1, Math.round(L.pxPerMm / 4));
      let n = 0;
      for (let y = 0; y < foil.height; y += step)
        for (let x = 0; x < foil.width; x += step) {
          const xm = (x + 0.5 - L.trim.x) / L.pxPerMm;
          const ym = (y + 0.5 - L.trim.y) / L.pxPerMm;
          if (!inContour(D.trim, xm, ym)) continue;
          n++;
          const i = y * foil.width + x;
          if (foil.data[i]! <= 127) continue;
          on++;
          if (ant && inRounded(ant.rect, ant.radius, xm, ym) && !(ant.inner && inRounded(ant.inner.rect, ant.inner.radius, xm, ym))) overAnt++;
          if (gloss && gloss.data[i]! > 127) overGloss++;
        }
      if (n && on / n > 0.5)
        add({
          rule: "foil-coverage",
          level: "warning",
          side: s.side,
          message: `Foil covers ${Math.round((100 * on) / n)} % of the ${s.side}; some vendors limit hot foil to 50 % and to two edges.`,
        });
      if (overAnt)
        add({
          rule: "foil-antenna",
          level: "warning",
          side: s.side,
          message: `Foil lies over the contactless antenna zone (${s.side}): metallic foil can stop NFC / contactless reads. Check with the vendor.`,
        });
      if (overGloss)
        add({
          rule: "foil-gloss",
          level: "warning",
          side: s.side,
          message: `Foil and spot gloss overlap (${s.side}); some vendors can't put both on the same area.`,
        });
    }
  }
  // Cutouts against the antenna and the stripe.
  const D = d.sides.front;
  for (const c of D.cutouts.concat(d.notch ? [{ ...D.trim, kind: "notch" as const }] : [])) {
    const pts = c.kind === "notch" ? contourPoints(D.trim).filter((p) => p.x > d.width - 10 && p.y < 10) : contourPoints(c);
    for (const k of [...D.keepOuts, ...d.sides.back.keepOuts.filter((x) => x.kind === "magstripe")]) {
      if (k.rule === "info") continue;
      // The back's keep-outs are mirrored: bring the cutout's points into the back's view.
      const hit = pts.some((p) => {
        const x = k.side === "back" ? d.width - p.x : p.x;
        return inRounded(k.rect, k.radius, x, p.y) && !(k.inner && inRounded(k.inner.rect, k.inner.radius, x, p.y));
      });
      if (!hit) continue;
      const level = k.kind === "antenna" ? "warning" : "error";
      add({
        rule: `cutout:${k.kind}`,
        level,
        element: `cutout ${c.kind}`,
        message: `The ${c.kind === "lanyard" ? "lanyard slot" : c.kind} cuts through the ${lc(k.label)}${k.kind === "antenna" ? ": a contactless or NFC card's coil runs there (confirm the vendor's antenna routing)" : ""}.`,
      });
    }
  }
  return issues;
}

export interface PlacedImage {
  label: string;
  /** Pixels of the image shown (after any crop). */
  width: number;
  height: number;
  /** Size it is printed at, mm. */
  widthMm: number;
  heightMm: number;
}

/** Effective resolution of uploaded images at their printed size. */
export function preflightImages(images: PlacedImage[], o: PrintOptions, preset: PrintPreset): PreflightIssue[] {
  const out: PreflightIssue[] = [];
  for (const im of images) {
    if (!(im.widthMm > 0) || !(im.heightMm > 0) || !im.width || !im.height) continue;
    const ppi = Math.min(im.width / (im.widthMm / 25.4), im.height / (im.heightMm / 25.4));
    const r = Math.round(ppi);
    if (ppi < preset.minPpi * 0.5)
      out.push({
        rule: "low-res",
        level: "error",
        blocking: false,
        element: im.label,
        message: `${im.label}: ${r} ppi at its printed size (${im.width} × ${im.height} px over ${im.widthMm.toFixed(1)} × ${im.heightMm.toFixed(1)} mm). ${preset.name} needs ${preset.minPpi} ppi: it will print visibly soft or pixelated.`,
      });
    else if (ppi < preset.minPpi)
      out.push({
        rule: "low-res",
        level: "warning",
        blocking: false,
        element: im.label,
        message: `${im.label}: ${r} ppi at its printed size; ${preset.name} asks for at least ${preset.minPpi} ppi.`,
      });
    else if (ppi < o.dpi * 0.98)
      out.push({
        rule: "low-res",
        level: "info",
        blocking: false,
        element: im.label,
        message: `${im.label}: ${r} ppi, upsampled to ${o.dpi} dpi in the files.`,
      });
  }
  return out;
}

export const blocking = (issues: PreflightIssue[]) => issues.some((i) => i.blocking);
