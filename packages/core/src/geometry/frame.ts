import type { CardCutout } from "../types.ts";

/** Layout of an ID-1 card body with the standards' layout (card units): `isoFrame`, `frameForShape`. */
export interface CardFrame {
  /** Print area (what `CARD_W` × `CARD_H` are on the standard card): 3.37 × 2.125, or 2.125 × 3.37 portrait. */
  width: number;
  height: number;
  /** Physical body outline. */
  bodyWidth: number;
  bodyHeight: number;
  portrait: boolean;
  /** Outer corner radius. */
  cornerRadius: number;
  /**
   * The chip plate: centre, turn about z (portrait: a quarter turn clockwise, with the body), its
   * size before the turn, and how far its top stands above the face (ISO/IEC 7816-1: ≤ 0.10 mm).
   */
  chip: { x: number; y: number; rotation: number; width: number; height: number; top: number };
  cutouts: CardCutout[];
}
