/**
 * The common face-shader contract's reserved names: the uniforms and per-fragment globals every face
 * shader sees, which a custom shader's own declarations must not reuse (`parseCustomShader`). The
 * engine's WGSL prelude (crates/card3d-engine/shaders/face/prelude.wgsl; its names are
 * `WGSL_PRELUDE_NAMES`) carries the same contract. These are its names in the GLSL dialect, which `parseCustomShader` still reads (a design's
 * GLSL layers are skipped by the engine, but their parameters stay editable).
 */

/** Uniforms every layer gets (reserved: user code must not redeclare them). */
export const COMMON_UNIFORMS = [
  "uTime",
  "uResolution",
  "uTilt",
  "uPointer",
  "uBaseColor",
  "uArtwork",
  "uHasArtwork",
  "uChip",
  "uAspect",
  "uSide",
  "uOverlay",
  "uEye",
  "uOpacity",
] as const;

/** Globals set before `mainImage` runs (reserved names too). */
export const COMMON_GLOBALS = ["cardUv", "facePos", "viewDir", "faceNormal", "vUv", "vLocal"] as const;
