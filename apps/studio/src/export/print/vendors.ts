/**
 * Print vendor presets, as data. Each sets the defaults of the production export (resolution, bleed,
 * safe zone, clearances, minimum type, mask format, extra derivative files) and the rules preflight
 * checks against. Numbers carry their provenance: `sources` lists where they come from, each graded
 * (P: the vendor's own published page; S: secondary source or common practice; U: unverified or
 * inferred), and anything not public is in `todo` instead of being guessed.
 *
 * To add a vendor, add an entry; nothing else needs to change.
 */
import type { MmRect } from "@card3d/core/print";

export type PrintMode = "payment" | "non-payment";
type Grade = "P" | "S" | "U";

/** An extra file a vendor takes besides the package (a resampled or thresholded front). */
export interface PrintDerivative {
  id: string;
  /** File name in the package (the design's base name is prefixed). */
  file: string;
  /**
   * - `bw`: the front composite, black and white only (1-bit, no transparency);
   * - `composite`: the front composite resampled to the size;
   * - `logo`: the card's logo (or mark), black on white, 1-bit, fitted in the size;
   * - `wallet`: tokenised wallet art: the front without chip, foil, name, number or text, square corners.
   */
  kind: "bw" | "composite" | "logo" | "wallet";
  width: number;
  height: number;
  /** Include the bleed around the trim (the image is the trim plus this, mm); default 0 (the trim). */
  bleedMm?: number;
  /** Largest file the vendor accepts, bytes. */
  maxBytes?: number;
  note: string;
  grade: Grade;
}

export interface PrintPreset {
  id: string;
  name: string;
  kind: "generic" | "issuing" | "pod" | "nfc" | "digital";
  /** How much of the preset is backed by the vendor's own published specs. */
  status: "published" | "partial" | "todo";
  mode: PrintMode;
  dpi: number;
  /** Lowest effective resolution of placed images the vendor accepts, ppi. */
  minPpi: number;
  bleedMm: number;
  safeMm: number;
  /** Clearance of text and logos from the chip module, mm. */
  chipClearanceMm: number;
  /** Clearance from the hologram, signature panel, stripe and network mark, mm. */
  panelClearanceMm: number;
  /** Minimum type size, pt (null: no published minimum). */
  minTypePt: { sans: number; serif: number } | null;
  /** Thinnest line or stroke, mm. */
  minLineMm: number | null;
  /** Separation masks as 1-bit (no greys) or 8-bit greyscale. */
  maskBits: 1 | 8;
  /** Payment programs: a magnetic stripe on the back by default. */
  magstripe: boolean;
  /** Back: signature panel, hologram (mm from the back's top-left, landscape); null when not given. */
  signaturePanel: MmRect | null;
  hologram: MmRect | null;
  /** Front: the network brand mark's reserved area (landscape mm); null when the vendor doesn't publish it. */
  networkMark: MmRect | null;
  /** Effects the vendor allows on the front only. */
  frontOnly: Array<"foil" | "spot-gloss" | "knockout">;
  /** Black text and marks as K = 100 only (no rich black). */
  blackK100: boolean;
  derivatives: PrintDerivative[];
  notes: string[];
  todo: string[];
  sources: Array<{ label: string; url?: string; grade: Grade }>;
}

/** The ISO/IEC 7810 generic defaults: 1/8 in bleed, 3.2 mm safe, 600 dpi (common print-shop practice). */
const GENERIC: PrintPreset = {
  id: "generic",
  name: "Generic (ISO, 3.175 mm bleed, 600 dpi)",
  kind: "generic",
  status: "partial",
  mode: "non-payment",
  dpi: 600,
  minPpi: 300,
  bleedMm: 3.175,
  safeMm: 3.2,
  chipClearanceMm: 2,
  panelClearanceMm: 2,
  minTypePt: { sans: 4.5, serif: 5 },
  minLineMm: 0.08,
  maskBits: 1,
  magstripe: false,
  signaturePanel: null,
  hologram: null,
  networkMark: null,
  frontOnly: [],
  blackK100: true,
  derivatives: [],
  notes: [
    "ISO/IEC 7810 ID-1 trim (85.60 × 53.98 mm, R 3.18 mm), 1/8 in (3.175 mm) bleed and a 3.2 mm safe zone: the usual print-shop defaults.",
    "Masks are 1-bit, black = the effect, white elsewhere (the common mask convention); every plate is also an SVG.",
    "Colour is the sRGB master: the vendor converts to CMYK with their own ICC profile.",
  ],
  todo: [],
  sources: [
    { label: "Common print-shop practice: generic printers / POD bleed 1/8 in", grade: "S" },
    { label: "Common print-shop practice: safe zone 3.2 mm default (a guide)", grade: "S" },
    { label: "Common print-shop practice: composite ≥ 600 dpi, POD minimum 300 ppi", grade: "S" },
    {
      label: "Stripe: logos and text ≥ 2 mm from the chip; minimum type 4.5 pt sans / 5 pt serif, line 0.08 mm",
      url: "https://docs.stripe.com/issuing/cards/artwork-templates",
      grade: "P",
    },
    {
      label: "4over4: mask files, 100 % K where the effect goes",
      url: "https://www.4over4.com/help/finish/do-i-need-to-provide-a-mask-file-for-custom-printing-effects",
      grade: "P",
    },
  ],
};

export const PRINT_PRESETS: readonly PrintPreset[] = [
  GENERIC,
  {
    ...GENERIC,
    id: "stripe-custom",
    name: "Stripe Issuing: custom card art",
    kind: "issuing",
    status: "published",
    mode: "payment",
    minPpi: 350,
    bleedMm: 1,
    safeMm: 2,
    chipClearanceMm: 2,
    panelClearanceMm: 2,
    minTypePt: { sans: 4.5, serif: 5 },
    minLineMm: 0.08,
    magstripe: true,
    frontOnly: ["foil", "spot-gloss", "knockout"],
    notes: [
      "Art ≥ 87.6 × 55.98 mm (1 mm bleed); logos and text 2 mm from the edge and from the chip, hologram, signature panel and stripe.",
      "Raster ≥ 350 ppi; images CMYK / greyscale, not RGB (convert at the printer); greys as K % or PMS 428 / 430; avoid borders that follow the edge.",
      "Metallic foil, knockout and post-laminate finishes on the front only.",
      "Custom bundles go through Stripe's Illustrator template and design sessions (no API); this package is the input to that.",
    ],
    todo: [
      "Where the hologram and signature panel sit is given by Stripe's template (not public): not drawn.",
      "Network brand mark size and corner come from the network's artwork: not drawn.",
      "Whether Stripe's template imports the PDF's layers and spot colours as-is: unverified.",
    ],
    sources: [
      { label: "Stripe: physical card design, artwork templates", url: "https://docs.stripe.com/issuing/cards/artwork-templates", grade: "P" },
      { label: "Stripe: custom bundles", url: "https://docs.stripe.com/issuing/cards/physical/order-custom-bundle", grade: "P" },
    ],
  },
  {
    ...GENERIC,
    id: "stripe-standard-logo",
    name: "Stripe Issuing: standard card logo",
    kind: "issuing",
    status: "published",
    mode: "payment",
    minPpi: 350,
    bleedMm: 1,
    safeMm: 2,
    magstripe: true,
    derivatives: [
      {
        id: "stripe-logo",
        file: "stripe-logo-1000x200.png",
        kind: "logo",
        width: 1000,
        height: 200,
        maxBytes: 512 * 1024,
        note: "Stripe's standard black or white card takes only a logo: PNG 1000 × 200 px, binary black on white (no greys), under 512 KB, uploaded with purpose issuing_logo.",
        grade: "P",
      },
    ],
    notes: ["The standard bundle prints Stripe's own card with your logo; the rest of the package is for reference."],
    todo: [],
    sources: [{ label: "Stripe API: personalization designs, card_logo", url: "https://docs.stripe.com/api/issuing/personalization_designs", grade: "P" }],
  },
  {
    ...GENERIC,
    id: "highnote",
    name: "Highnote (on-demand / premium)",
    kind: "issuing",
    status: "partial",
    mode: "payment",
    safeMm: 2.38,
    chipClearanceMm: 2.38,
    panelClearanceMm: 2.38,
    minTypePt: { sans: 6, serif: 6 },
    magstripe: true,
    notes: [
      "Layered .ai / .eps / .pdf, every element on its own layer, fonts outlined, images embedded, CMYK (premium: CMYK / PMS), black = 0/0/0/100, minimum 6 pt.",
      "Logos and text 3/32 in (2.38 mm) from the edges, stripe, hologram and signature panel; Highnote recommends Arroweye's templates.",
    ],
    todo: [
      "Bleed is required but its size isn't published: the generic 3.175 mm is used.",
      "Hologram and signature panel positions: from the template (not public).",
    ],
    sources: [{ label: "Highnote: physical card design", url: "https://docs.highnote.com/docs/issuing/cards/design/physical-cards", grade: "P" }],
  },
  {
    ...GENERIC,
    id: "increase",
    name: "Increase (Visa, black and white)",
    kind: "issuing",
    status: "published",
    mode: "payment",
    bleedMm: 1.65,
    safeMm: 2.54,
    chipClearanceMm: 3,
    panelClearanceMm: 3,
    magstripe: true,
    derivatives: [
      {
        id: "increase-bw",
        file: "increase-front-2100x1344.png",
        kind: "bw",
        width: 2100,
        height: 1344,
        bleedMm: 1.65,
        note: "Increase takes a 2100 × 1344 px, 600 dpi, black-and-white PNG with no transparency (88.9 × 56.9 mm: the trim plus ≈ 1.65 mm).",
        grade: "P",
      },
    ],
    notes: ["No art within 2.54 mm of the edge, 3 mm of the Visa logo or 3 mm of the chip. Increase has a Figma template."],
    todo: [
      "The bleed is derived from the image size (2100 × 1344 px at 600 dpi), not stated.",
      "The Visa logo's place comes from Increase's template: not drawn.",
    ],
    sources: [{ label: "Increase: card art for physical cards", url: "https://increase.com/documentation/card-art-physical-cards", grade: "P" }],
  },
  {
    ...GENERIC,
    id: "printags",
    name: "Printags (PVC / NFC cards)",
    kind: "nfc",
    status: "todo",
    mode: "non-payment",
    notes: ["PVC and NFC PVC (NTAG213), MIFARE, NFC wood (NTAG424); REST API with artwork upload; no metal. NFC payload: a URI."],
    todo: [
      "Printags' artwork specs (bleed, safe zone, resolution, file format) are not public: the generic values are used. Confirm before ordering.",
      "NFC payload capacity (NTAG213: 144 bytes) is not checked: Card Studio has no NFC data yet.",
    ],
    sources: [{ label: "Printags: API integration", url: "https://www.printags.com/en/api-integration/", grade: "P" }],
  },
  {
    ...GENERIC,
    id: "merchize-alu",
    name: "Merchize: printed aluminium wallet card",
    kind: "pod",
    status: "partial",
    mode: "non-payment",
    derivatives: [
      {
        id: "merchize",
        file: "merchize-front-2000x1272.png",
        kind: "composite",
        width: 2000,
        height: 1272,
        bleedMm: 0.5,
        note: "Merchize's template is 2000 × 1272 px (UV print on 0.45 mm aluminium). Its bleed isn't stated: this file is the front with ~0.5 mm round the trim, fitted to the size. Check it against Merchize's template.",
        grade: "U",
      },
    ],
    notes: ["A printed novelty card (UV print), not engraved: engraving, etching and foil plates don't apply."],
    todo: ["Merchize's bleed, safe zone and file rules aren't published beyond the template size."],
    sources: [{ label: "Merchize: 1-side printed metal wallet card", url: "https://merchize.com/product/1-side-printed-metal-wallet-card/", grade: "P" }],
  },
  {
    ...GENERIC,
    id: "wallet-art",
    name: "Digital wallet art (tokenised card image)",
    kind: "digital",
    status: "published",
    mode: "payment",
    magstripe: false,
    derivatives: [
      {
        id: "wallet",
        file: "wallet-art-1536x969.png",
        kind: "wallet",
        width: 1536,
        height: 969,
        note: "Tokenised wallet art: PNG 1536 × 969, without chip, hologram, magnetic stripe, card number or name, and with square corners.",
        grade: "P",
      },
    ],
    notes: ["For Apple Pay / Google Pay provisioning through the issuer processor."],
    todo: [],
    sources: [{ label: "Galileo (SoFi Tech): design a card", url: "https://docs.tech.sofi.com/pro/docs/design-a-card", grade: "P" }],
  },
];

export const DEFAULT_PRESET_ID = "generic";

export function getPreset(id: string | null | undefined): PrintPreset {
  return PRINT_PRESETS.find((p) => p.id === id) ?? GENERIC;
}
