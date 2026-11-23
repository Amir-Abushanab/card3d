import type { ShaderDefinition } from "../types.ts";

/**
 * Procedural finishes: a vinyl record and a walnut veneer, for any card.
 */

export const VINYL_SHADER: ShaderDefinition = {
  id: "vinyl",
  label: "Vinyl record",
  description: "A spinning record with fine grooves, a paper label and an anisotropic sheen that follows the tilt.",
  targets: ["skin", "overlay"],
  defaultTarget: "skin",
  animated: true,
  tags: ["animated", "tilt", "object"],
  params: [
    { key: "center", label: "Position", type: "vec2", default: [0.5, 0.5], min: 0, max: 1, step: 0.005 },
    { key: "radius", label: "Radius", type: "float", default: 0.46, min: 0.1, max: 0.8, step: 0.005, description: "In card heights." },
    { key: "grooves", label: "Grooves", type: "float", default: 140, min: 20, max: 400, step: 1 },
    { key: "spin", label: "Spin (rpm)", type: "float", default: 33.3, min: 0, max: 78, step: 0.1 },
    { key: "sheen", label: "Sheen", type: "float", default: 0.55, min: 0, max: 1.5, step: 0.01 },
    { key: "labelSize", label: "Label size", type: "float", default: 0.34, min: 0.1, max: 0.8, step: 0.01, description: "Fraction of the record radius." },
    { key: "vinylColor", label: "Vinyl", type: "color", default: "#161718" },
    { key: "labelColor", label: "Label", type: "color", default: "#d24a2c" },
    { key: "bandColor", label: "Label band", type: "color", default: "#efe2c6" },
  ],
};

export const WOOD_SHADER: ShaderDefinition = {
  id: "wood",
  label: "Walnut veneer",
  description: "Procedural wood: warped growth rings, figure and pore streaks along the grain.",
  targets: ["skin", "overlay"],
  defaultTarget: "skin",
  tags: ["material"],
  params: [
    { key: "rings", label: "Grain lines", type: "float", default: 16, min: 2, max: 60, step: 0.5, description: "Growth rings per card height." },
    { key: "figure", label: "Figure", type: "float", default: 1, min: 0, max: 3, step: 0.05, description: "How much the grain waves and swirls." },
    { key: "pores", label: "Pores", type: "float", default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: "scale", label: "Scale", type: "float", default: 1, min: 0.25, max: 4, step: 0.05 },
    { key: "angle", label: "Grain angle", type: "float", default: 0, min: -90, max: 90, step: 1 },
    { key: "seed", label: "Seed", type: "float", default: 0, min: 0, max: 100, step: 1 },
    { key: "lightColor", label: "Earlywood", type: "color", default: "#a8774f" },
    { key: "darkColor", label: "Latewood", type: "color", default: "#3f2416" },
  ],
};
