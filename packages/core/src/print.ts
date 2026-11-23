/**
 * `@card3d/core/print`: production artwork for card manufacturers: print registration (mm ↔ px at a resolution and bleed), the dieline with the ISO trim,
 * cutouts and keep-outs, and the flat bake of a card on the card engine (colour artwork, separation
 * masks, element coverage). A separate entry so the root bundles and the CDN builds never carry it.
 */
export { printLayout, mmToPx, pxToMm, rasterBoxMm, PRINT_DPI, MM_PER_INCH, type PrintLayout } from "./print/layout.ts";
export {
  cardDieline,
  dielineSvg,
  printShape,
  roundedRectPath,
  inKeepOut,
  inRounded,
  inContour,
  contourPoints,
  ISO_7811_6_STRIPE,
  type CardDieline,
  type DielineSide,
  type DielineContour,
  type DielineArc,
  type DielineOptions,
  type DielineSvgOptions,
  type KeepOut,
  type KeepOutKind,
  type KeepOutRule,
} from "./print/dieline.ts";
export {
  bakePrint,
  bakeLayout,
  fillUncovered,
  printTrimMm,
  runBake,
  PRINT_MASKS,
  type BakeChoice,
  type BakeItem,
  type BakeRenderer,
  type BakeRole,
  type PrintImage,
  type PrintJobSource,
  type PrintBakeOptions,
  type PrintElement,
  type PrintElementKind,
  type PrintMaskId,
  type PrintRaster,
  type PrintSideBake,
} from "./print/bake.ts";
export { CONTACTLESS_ASPECT, CONTACTLESS_GEOMETRY } from "./card/contactless.ts";
export {
  contactlessRect,
  chipRect,
  userLogoRect,
  drawUserLogoCanvas,
  drawLogoCanvas,
  GENERIC_BRAND_MARK,
  LOGO_LIMITS,
  PRINT_MARK_KEY,
  type PrintMark,
} from "./card/branding-layout.ts";
export { shapeContours, type ShapeArc } from "./geometry/shape-frame.ts";
export { ISO_14443_CLASS1, ISO_CONTACT_AREA, ISO_CHIP_PLATE_MM, ISO_7811_AREAS, ISO_7816_CONTACTS, type MmRect } from "./geometry/iso.ts";
export { MAX_DESIGN_IMAGE_SIDE } from "./geometry/constants.ts";
