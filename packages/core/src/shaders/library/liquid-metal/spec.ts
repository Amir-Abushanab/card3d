import type { ShaderDefinition } from "../../types.ts";

/**
 * `liquid-metal`: Paper Shaders' liquid metal (Apache-2.0) as a face shader. The card engine draws it
 * (crates/card3d-engine: src/liquid_metal.rs, shaders/face/liquid-metal.wgsl).
 *
 * Mask: the face's artwork alpha, the asset provider's brand mark, or one of Paper's procedural shapes.
 */
const LIQUID_METAL_MASKS = [
  { label: "Card artwork", value: 0 },
  { label: "Brand mark", value: 1 },
  { label: "Circle", value: 2 },
  { label: "Daisy", value: 3 },
  { label: "Diamond", value: 4 },
  { label: "Metaballs", value: 5 },
  { label: "Whole face", value: 6 },
];

/** The definition: the catalog, the design model and the editor read it. */
export const LIQUID_METAL_SHADER: ShaderDefinition = {
  id: "liquid-metal",
  label: "Liquid metal",
  description: "Chrome that flows inside a mask (the artwork, the brand mark or a shape), stirred by tilt and pointer speed.",
  targets: ["overlay", "skin"],
  defaultTarget: "overlay",
  animated: true,
  tags: ["animated", "tilt", "chrome"],
  replacesArtwork: (p) => p.mask === 0,
  params: [
    { key: "mask", label: "Mask", type: "int", default: 0, options: LIQUID_METAL_MASKS, description: "Card artwork uses this face's artwork alpha." },
    { key: "speed", label: "Speed", type: "float", default: 1, min: 0, max: 20, step: 0.1, description: "Clock multiplier (1 = a slow drift at rest)." },
    { key: "motion", label: "React to motion", type: "bool", default: true, description: "Tilt, pointer speed and scrolling stir the metal." },
    { key: "tint", label: "Tint", type: "color", default: "#606060" },
    { key: "repetition", label: "Repetition", type: "float", default: 3.03, min: 1, max: 10, step: 0.01 },
    { key: "softness", label: "Softness", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
    { key: "shiftRed", label: "Red shift", type: "float", default: -0.76, min: -1, max: 1, step: 0.01 },
    { key: "shiftBlue", label: "Blue shift", type: "float", default: -1, min: -1, max: 1, step: 0.01 },
    { key: "distortion", label: "Distortion", type: "float", default: 0.57, min: 0, max: 1, step: 0.01 },
    { key: "contour", label: "Contour", type: "float", default: 0.12, min: 0, max: 1, step: 0.01 },
    { key: "angle", label: "Angle", type: "float", default: -194, min: -360, max: 360, step: 1 },
    { key: "scale", label: "Scale", type: "float", default: 1.1, min: 0.2, max: 4, step: 0.01 },
    { key: "rotation", label: "Rotation", type: "float", default: 0, min: 0, max: 360, step: 1 },
    { key: "offset", label: "Offset", type: "vec2", default: [-0.02, -0.025], min: -1, max: 1, step: 0.005 },
    { key: "avoidChip", label: "Clear the chip", type: "bool", default: true },
  ],
};
