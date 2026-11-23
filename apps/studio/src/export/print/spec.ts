/**
 * `spec.json`: the machine-readable description of a print package (format "card3d-print/1"): the card
 * (ISO/IEC 7810 ID-1 trim, corners, orientation, thickness, cutouts), material and finish, edge,
 * registration (dpi, bleed, safe zone, the trim box in pixels), colours (sRGB hex, approximate CMYK,
 * no Pantone), plates (spot layers and their files), the dieline's keep-outs, chip / stripe / contactless
 * features, placed layers, fonts, the preflight result and the look-alike score.
 */
import { getCardFont, DEFAULT_CARD_FONT, type CardDesign, type Side } from "@card3d/core/model";
import { resolveMaterial, recipeToMaterialConfig } from "@card3d/core/editor";
import type { CardDieline, PrintElement, PrintLayout, PrintMaskId } from "@card3d/core/print";
import { CMYK_FORMULA, cmykFor, hexToRgb, rgbToHex, type Cmyk, type PaletteEntry } from "./color.ts";
import type { PreflightIssue, PrintOptions, StripNote } from "./preflight.ts";
import { elementLabel } from "./preflight.ts";
import type { LookalikeFeatures } from "./lookalike.ts";
import type { PrintPreset } from "./vendors.ts";

export const PRINT_SPEC_FORMAT = "card3d-print/1";

/** A plate: one spot layer of one side, as files. */
export interface PlateFile {
  side: Side;
  /** Spot / layer name ("Engrave", "Foil-Holographic", "ColorFill-5E5E5E", "Cut"…). */
  name: string;
  kind: PrintMaskId | "cut" | "keepout";
  files: string[];
  process: string;
  description: string;
  /** Mask PNG bit depth and polarity. */
  bits: 1 | 8;
  polarity: "black = effect" | "white = effect" | "greyscale";
  color?: { hex: string; cmyk: Cmyk | null; pms: null };
}

export interface FontEntry {
  roles: string[];
  family: string;
  source: "catalog" | "google" | "url" | "upload";
  id?: string;
  weight: number | string;
  licence: string;
  licenceConfirmed: boolean | null;
  files: string[];
  note?: string;
}

interface SpecSide {
  side: Side;
  layout: PrintLayout;
  composite: string;
  elements: PrintElement[];
  palette: PaletteEntry[];
  features: { foil: boolean; shaderSkin: boolean; shaderOverlays: number; addons: boolean; effects: boolean; clear: boolean };
}

export interface SpecInput {
  design: CardDesign;
  options: PrintOptions;
  preset: PrintPreset;
  dieline: CardDieline;
  sides: SpecSide[];
  plates: PlateFile[];
  fonts: FontEntry[];
  files: string[];
  dielineFiles: Partial<Record<Side, string>>;
  proofs: string[];
  derivatives: Array<{ id: string; file: string; width: number; height: number; note: string }>;
  issues: PreflightIssue[];
  lookalike: { score: number; lookalike: boolean; features: LookalikeFeatures };
  stripped: StripNote[];
  createdAt: string;
  generator?: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** sRGB hex mixed in linear light (as the engine's colours are). */
function mixLinear(hex: string, to: string, t: number, scale = 1): string {
  const a = hexToRgb(hex) ?? [188, 188, 185];
  const b = hexToRgb(to) ?? a;
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const enc = (v: number) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  return rgbToHex(...([0, 1, 2].map((i) => enc(Math.min(1, (lin(a[i]!) * (1 - t) + lin(b[i]!) * t) * scale))) as [number, number, number]));
}

/** The named colours of a design: body, print, engraved fill, etch, edge. */
export function designColors(design: CardDesign, blackK100: boolean): Array<{ role: string; hex: string; cmyk: Cmyk | null; pms: null }> {
  const R = resolveMaterial(recipeToMaterialConfig(design.recipe), design.materialOverride) ?? null;
  const body = (R && "color" in R && typeof R.color === "string" ? R.color : null) ?? "#bcbcb9";
  const print = typeof design.brandingOverride?.color === "string" ? design.brandingOverride.color : body;
  const out: Array<{ role: string; hex: string }> = [{ role: "body", hex: body }];
  const finishes = [design.finish?.name, design.finish?.bio, design.finish?.logo, design.contactless ? (design.contactless.finish ?? "embossed") : undefined];
  if (finishes.some((f) => !f || f === "default")) out.push({ role: "print (branding ink)", hex: print });
  if (finishes.includes("engraved")) out.push({ role: "engraved fill", hex: mixLinear(print, print, 0, 0.6) });
  if (finishes.includes("etched")) {
    const rgb = hexToRgb(print) ?? [188, 188, 185];
    const l = (Math.max(...rgb) + Math.min(...rgb)) / 2 / 255;
    out.push({ role: "etch", hex: mixLinear(print, l > 0.62 ? "#5d6066" : "#dcdde1", 0.5) });
  }
  if (design.edge?.color && design.edge.finish !== "match") out.push({ role: `edge (${design.edge.finish ?? "metal"})`, hex: design.edge.color });
  return out.map((c) => ({
    ...c,
    hex: c.hex.toLowerCase(),
    cmyk: cmykFor(c.hex, { text: c.role.startsWith("print") || c.role.startsWith("engraved"), blackK100 }),
    pms: null,
  }));
}

/** The fonts a design prints with (catalog fonts by id, custom fonts by source). */
export function designFonts(design: CardDesign): Array<{ key: string; roles: string[]; font: string | NonNullable<CardDesign["font"]> }> {
  const map = new Map<string, { key: string; roles: string[]; font: string | NonNullable<CardDesign["font"]> }>();
  const base = design.font ?? DEFAULT_CARD_FONT;
  const keyOf = (f: string | NonNullable<CardDesign["font"]>) =>
    typeof f === "string" ? `catalog:${getCardFont(f) ? f : DEFAULT_CARD_FONT}` : `${f.source}:${f.family}:${f.weight ?? 700}`;
  const use = (f: string | NonNullable<CardDesign["font"]>, role: string) => {
    const k = keyOf(f);
    const e = map.get(k) ?? map.set(k, { key: k, roles: [], font: typeof f === "string" && !getCardFont(f) ? DEFAULT_CARD_FONT : f }).get(k)!;
    if (!e.roles.includes(role)) e.roles.push(role);
  };
  if (design.cardholderName?.trim()) use(base, "cardholder name");
  if (design.cardholderBio?.trim()) use(base, "bio");
  (design.textLines ?? []).forEach((l, i) => l?.text?.trim() && use(l.font && getCardFont(l.font) ? l.font : base, `text line ${i + 1}`));
  return [...map.values()];
}

export function buildPrintSpec(i: SpecInput): Record<string, unknown> {
  const { design, options: o, preset, dieline: d } = i;
  const glass = design.recipe.material === "glass" || (design.materialOverride?.transmission ?? 0) > 0.5;
  const R = resolveMaterial(recipeToMaterialConfig(design.recipe), design.materialOverride);
  const front = i.sides.find((s) => s.side === "front") ?? i.sides[0]!;
  const L = front.layout;
  const byLevel = (lv: PreflightIssue["level"]) =>
    i.issues
      .filter((x) => x.level === lv)
      .map(({ rule, message, side, element, blocking }) => ({
        rule,
        message,
        ...(side ? { side } : {}),
        ...(element ? { element } : {}),
        ...(blocking ? { blocking } : {}),
      }));
  const edge = design.edge;
  return {
    spec: PRINT_SPEC_FORMAT,
    generator: i.generator ?? "Card Studio",
    createdAt: i.createdAt,
    profile: { id: preset.id, name: preset.name, status: preset.status, sources: preset.sources, todo: preset.todo, notes: preset.notes },
    mode: o.mode,
    card: {
      standard: "ISO/IEC 7810 ID-1",
      trim_mm: [r3(d.width), r3(d.height)],
      corner_mm: r3(d.cornerRadiusMm),
      orientation: d.orientation === "portrait" ? "vertical" : "horizontal",
      thickness_mm: { iso_nominal: 0.76, iso_range: [0.68, 0.84], modelled: glass ? 0.76 : 0.7 },
      cutouts: [
        ...d.sides.front.cutouts.map((c) => ({
          type: c.kind === "lanyard" ? "lanyard-slot" : c.kind,
          path: `${i.dielineFiles.front ?? "dieline.svg"}#cutout-${c.kind}`,
          box_mm: c.box,
        })),
        ...(d.notch ? [{ type: "notch", path: `${i.dielineFiles.front ?? "dieline.svg"}#trim` }] : []),
      ],
    },
    material: {
      body: glass ? "clear" : "metal",
      preset: design.recipe.material,
      color: (R as { color?: string } | undefined)?.color ?? null,
      finish: {
        texture: design.recipe.texture,
        pattern: design.recipe.pattern,
        polish: design.recipe.polish,
        grain: design.recipe.grain,
        relief: design.recipe.relief,
      },
      treatments: design.surfaceTreatments,
      edge: edge
        ? {
            type: edge.finish === "anodized" ? "anodized" : edge.finish === "match" ? "match-artwork" : "metal",
            colour: edge.color ?? null,
            chamfer: !!edge.chamfer,
          }
        : { type: glass ? "clear" : "body", colour: null, chamfer: false },
    },
    bleed_mm: r3(o.bleedMm),
    safe_mm: r3(o.safeMm),
    artwork: {
      dpi: o.dpi,
      colour_space: "sRGB IEC 61966-2.1",
      size_px: [L.width, L.height],
      trim_box_px: { x: r3(L.trim.x), y: r3(L.trim.y), width: r3(L.trim.width), height: r3(L.trim.height) },
      origin: "mm from the trim's top-left corner, as seen from that side (the back is mirrored)",
      files: Object.fromEntries(i.sides.map((s) => [s.side, s.composite])),
      chip: "not printed (inserted by the manufacturer); see the dieline",
    },
    colour: {
      process_profile: "sRGB",
      cmyk_conversion: "by the vendor (ICC profile of their choice); the values here are approximate",
      cmyk_formula: CMYK_FORMULA,
      black_text_k100: preset.blackK100,
      colours: designColors(design, preset.blackK100),
      palette: Object.fromEntries(i.sides.map((s) => [s.side, s.palette.map((p) => ({ ...p, cmyk: cmykFor(p.hex) }))])),
      spots: i.plates
        .filter((p) => p.kind !== "cut" && p.kind !== "keepout" && p.kind !== "relief")
        .map((p) => ({ name: p.name, side: p.side, kind: p.kind, ...(p.color ? { hex: p.color.hex, fallback_cmyk: p.color.cmyk, pms: null } : {}) })),
      pantone: "not matched: enter PMS references with the vendor",
    },
    plates: i.plates.map((p) => ({
      side: p.side,
      name: p.name,
      kind: p.kind,
      files: p.files,
      process: p.process,
      description: p.description,
      bits: p.bits,
      polarity: p.polarity,
      ...(p.color ? { color: p.color } : {}),
    })),
    dieline: {
      files: i.dielineFiles,
      keep_outs: (["front", "back"] as const).flatMap((s) =>
        d.sides[s].keepOuts.map((k) => ({
          id: k.id,
          side: s,
          kind: k.kind,
          label: k.label,
          rule: k.rule,
          rect_mm: { x0: r3(k.rect.x0), y0: r3(k.rect.y0), x1: r3(k.rect.x1), y1: r3(k.rect.y1) },
          radius_mm: k.radius,
          clearance_mm: k.clearance,
          ...(k.inner ? { inner_mm: k.inner.rect } : {}),
          source: k.source,
        })),
      ),
      safe_mm: { rect: d.safe.rect, radius: r3(d.safe.radius) },
    },
    features: {
      chip: o.mode === "payment" ? "emv" : o.decorativeChip ? "decorative" : "contact (unconfirmed)",
      magstripe: o.magstripe,
      signature_panel: !!preset.signaturePanel,
      hologram: !!preset.hologram,
      contactless_indicator: { present: !!design.contactless, licensed: null, note: "EMVCo trademark: the issuer or vendor must hold EMVCo's licence" },
      nfc: null,
    },
    layers: i.sides.flatMap((s) =>
      s.elements.map((e) => ({
        id: e.id,
        side: s.side,
        kind: e.kind,
        label: elementLabel(e),
        finish: e.finish,
        box_mm: e.boxMm && { x0: r2(e.boxMm.x0), y0: r2(e.boxMm.y0), x1: r2(e.boxMm.x1), y1: r2(e.boxMm.y1) },
      })),
    ),
    effects: Object.fromEntries(i.sides.map((s) => [s.side, s.features])),
    fonts: i.fonts,
    preflight: {
      profile: preset.id,
      blocked: i.issues.some((x) => x.blocking),
      errors: byLevel("error"),
      warnings: byLevel("warning"),
      notes: byLevel("info"),
    },
    lookalike_score: i.lookalike.score,
    lookalike: i.lookalike,
    stripped: i.stripped,
    proofs: i.proofs,
    derivatives: i.derivatives,
    files: i.files,
    warnings: i.issues.filter((x) => x.level !== "info").map((x) => x.message),
  };
}
