import type { ShaderDefinition } from "../types.ts";

export const LENS_SHADER: ShaderDefinition = {
  id: "lens",
  label: "Coated lens",
  description: "A camera lens of coated glass whose rings, reflections and glint slide with the viewing angle.",
  targets: ["overlay", "skin"],
  defaultTarget: "overlay",
  linearOutput: true,
  tags: ["view-dependent", "glass"],
  params: [
    {
      key: "center",
      label: "Position",
      type: "vec2",
      default: [0.5, 0.5],
      min: 0,
      max: 1,
      step: 0.005,
      description: "Lens centre in face uv (0,0 bottom-left).",
    },
    { key: "radius", label: "Radius", type: "float", default: 0.3, min: 0.05, max: 0.5, step: 0.005, description: "In card heights." },
    { key: "coating", label: "Coating", type: "color", default: "#bababa", description: "Tints the ring coatings (grey = the original rose/violet)." },
    { key: "glint", label: "Glint", type: "float", default: 1, min: 0, max: 3, step: 0.05 },
    { key: "response", label: "View response", type: "float", default: 1, min: 0, max: 2, step: 0.05 },
    { key: "exposure", label: "Exposure", type: "float", default: 1, min: 0.2, max: 4, step: 0.05 },
  ],
};
