/**
 * The card's layer stack: z offsets above the body cap J = bodyDepth/2,
 * render orders and polygon offsets. The back mirrors the front (z → −z, π about y); a back layer drawn
 * on the face plane uses `sideFace(geometry, "back")`, so a shaped card's cutouts stay over the body's.
 */
export const LAYER = {
  /** Metal face skins (row 3/3b): J + 0.0015, drawn without depth test. */
  face: { z: 0.0015, renderOrder: 5 },
  /** Artwork / design layers (row 5/5b): J + 0.00165. */
  design: { z: 0.00165, renderOrder: 8 },
  /** Holo foil (row 6) — placed by holo/ (J + 0.0024, renderOrder 9). */
  holo: { renderOrder: 9 },
  /** Chip base (row 7): flat top at J + 0.006. */
  chip: { top: 0.006, renderOrder: 10 },
  /** Chip detail (row 8). */
  chipDetail: { renderOrder: 11, polygonOffset: [-1, -1] },
  /** Logo / name / bio (rows 9–13): J + 0.003 + 0.01. */
  branding: { z: 0.003 + 0.01, renderOrder: 12, polygonOffset: [-2, -2] },
  /** Front chip decal depth mask (row 14). */
  chipMask: { renderOrder: 29, polygonOffset: [-64, -64], aboveDecal: 0.0001 },
  /** The contactless mark, when there are front stickers: drawn just after the last (render order 30 + r + 0.5). */
  contactless: { aboveDecal: 0.5 },
  /** Sticker decal r (row 15): J + 0.0048 + 0.0008·r, renderOrder 30 + r, polygonOffset (−6 − r, −3). */
  decal: { z: 0.0048, zStep: 0.0008, renderOrder: 30 },
} as const;

/** z of sticker decal `r` on the front (negate for the back). */
export function decalZ(bodyDepth: number, r: number): number {
  return bodyDepth / 2 + LAYER.decal.z + LAYER.decal.zStep * r;
}

/**
 * `userData` key placing an object relative to a clear card's body: +1 on the front face, −1 on the
 * back face (print, stickers, the contact plate), 0 inside the body (the chip module, the antenna).
 * Only a clear card reads it (the transmission buffer passes): its refraction buffers leave out
 * whatever lies on the face towards the camera, and the far face's buffer leaves out what is inside.
 * @archive the local three.js archive (.archive/three-engine) imports it
 */
export const CARD_FACE_KEY = "cardFace";
