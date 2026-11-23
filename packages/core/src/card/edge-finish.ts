import type { CardEdge } from "../types.ts";

/** Edge finishes (`CardDesign.edge`): the ids and defaults (the engine draws them: crates/card3d-engine/src/edge.rs). */
export const EDGE_FINISHES = ["metal", "anodized", "match"] as const;
export type EdgeFinish = (typeof EDGE_FINISHES)[number];
/** Default colours per finish (when `edge.color` is unset). */
export const EDGE_DEFAULT_COLOR: Record<Exclude<EdgeFinish, "match">, string> = { metal: "#c9a45c", anodized: "#2f6fd6" };

/** @archive the local three.js archive (.archive/three-engine) imports it */
export const isEdgeFinish = (v: unknown): v is EdgeFinish => EDGE_FINISHES.includes(v as EdgeFinish);

/** True when the design's edge changes anything. */
export function hasEdge(edge: CardEdge | null | undefined): edge is CardEdge {
  return !!edge && (isEdgeFinish(edge.finish) || edge.chamfer === true);
}
