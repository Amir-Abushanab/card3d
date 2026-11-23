/**
 * The contactless mark's size range against EMVCo's reproduction floor (≥ 4.5 mm tall). (Its draw
 * order above the front stickers was the three.js engine's; that test is in the local archive.)
 */
import { describe, expect, it } from "vitest";
import { contactlessHeightMm } from "./branding-layout.ts";
import { CONTACTLESS_SCALE } from "./contactless.ts";
import { sanitizeContactless } from "../design/sanitize.ts";

describe("contactless mark size", () => {
  it("never goes below EMVCo's 4.5 mm, in either orientation", () => {
    for (const portrait of [false, true]) expect(contactlessHeightMm(CONTACTLESS_SCALE.min, portrait)).toBeGreaterThanOrEqual(4.5);
    expect(contactlessHeightMm(0.01)).toBeGreaterThanOrEqual(4.5);
    expect(sanitizeContactless({ scale: 0.1 })).toEqual({ scale: CONTACTLESS_SCALE.min });
  });

  it("is 8.9 mm by default and grows with scale", () => {
    expect(contactlessHeightMm()).toBeCloseTo(8.9, 1);
    expect(contactlessHeightMm(1)).toBeGreaterThan(contactlessHeightMm());
  });
});
