import type { MarkFinish } from "../types.ts";

/** Mark finishes (`CardDesign.finish`, `CardContactless.finish`): the ids (the engine draws them: crates/card3d-engine/src/finish.rs). */
export const MARK_FINISHES: readonly MarkFinish[] = ["default", "embossed", "engraved", "etched"];

/** @archive the local three.js archive (.archive/three-engine) imports it */
export const isMarkFinish = (v: unknown): v is MarkFinish => MARK_FINISHES.includes(v as MarkFinish);
