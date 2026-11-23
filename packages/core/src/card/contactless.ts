import { createCanvas } from "../geometry/canvas.ts";

/**
 * The contactless mark (`CardDesign.contactless`): the EMVCo Contactless Indicator, four graduating
 * arcs facing right, traced from EMVCo's public reproduction requirements (Nov 2019, v6) and drawn
 * procedurally. It is a trademark of EMVCo, LLC (see THIRD_PARTY_NOTICES.md). White on transparent,
 * like the other branding masks, so it takes the mark finishes (`MARK_FINISHES`).
 */

/**
 * The traced geometry, in units of the mark's height (origin at its top-left): four concentric arcs
 * of equal stroke with round caps, centred left of the mark, each a little flatter than the last.
 */
const ARC_CENTRE = { x: -0.1652, y: 0.5 };
const ARC_STROKE = 0.1119;
const ARCS: readonly { r: number; half: number }[] = [
  { r: 0.2633, half: 0.6328 },
  { r: 0.4747, half: 0.5378 },
  { r: 0.6986, half: 0.5202 },
  { r: 0.9099, half: 0.5103 },
];
/** Antialiasing margin, as a fraction of the canvas height, on every side. */
const MARGIN = 0.02;

/**
 * `CardContactless.scale`: the mark's height × the chip plate's (11.4 mm landscape, 12.6 mm portrait).
 * EMVCo's reproduction requirements set a floor, ≥ 4.5 mm tall, and no ceiling: the minimum keeps
 * a landscape mark at 4.56 mm. The default is 8.9 mm (landscape).
 */
export const CONTACTLESS_SCALE = { min: 0.4, max: 1.2, default: 0.78 } as const;

/** Width / height of the mark (the traced ink box, 107 × 134). */
export const CONTACTLESS_ASPECT = 107 / 134;

/**
 * The traced geometry in units of the ink box's height (origin at its top-left, y down): arc centre,
 * stroke width (round caps) and each arc's radius and half-angle. For vector output (production files).
 */
export const CONTACTLESS_GEOMETRY = { centre: ARC_CENTRE, stroke: ARC_STROKE, arcs: ARCS, margin: MARGIN } as const;

/** @archive the local three.js archive (.archive/three-engine) imports it */
export function drawContactlessCanvas(heightPx = 384): HTMLCanvasElement | OffscreenCanvas | null {
  const H = Math.max(32, Math.round(heightPx));
  const W = Math.round(H * CONTACTLESS_ASPECT);
  const canvas = createCanvas(W, H);
  const ctx = canvas?.getContext("2d") as CanvasRenderingContext2D | null | undefined;
  if (!canvas || !ctx) return null;
  ctx.clearRect(0, 0, W, H);
  // The ink box fills the canvas, less the margin, keeping its aspect.
  const s = H * (1 - 2 * MARGIN);
  const ox = (W - s * CONTACTLESS_ASPECT) / 2;
  const oy = H * MARGIN;
  ctx.strokeStyle = "#ffffff";
  ctx.lineCap = "round";
  ctx.lineWidth = ARC_STROKE * s;
  for (const { r, half } of ARCS) {
    ctx.beginPath();
    ctx.arc(ox + ARC_CENTRE.x * s, oy + ARC_CENTRE.y * s, r * s, -half, half);
    ctx.stroke();
  }
  return canvas;
}
