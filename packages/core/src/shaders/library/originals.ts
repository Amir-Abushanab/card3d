import type { ShaderDefinition } from "../types.ts";

/** Small original face shaders so the library is useful on its own. */

export const OIL_SLICK_SHADER: ShaderDefinition = {
  id: "oil-slick",
  label: "Oil slick",
  description: "Thin-film interference: swirling iridescent bands whose colours shift with the viewing angle.",
  targets: ["overlay", "skin"],
  defaultTarget: "overlay",
  defaultBlend: "screen",
  animated: true,
  tags: ["iridescent", "view-dependent", "animated"],
  params: [
    { key: "strength", label: "Strength", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    {
      key: "thickness",
      label: "Film thickness",
      type: "float",
      default: 1.6,
      min: 0.2,
      max: 5,
      step: 0.05,
      description: "More thickness → more colour bands.",
    },
    { key: "scale", label: "Scale", type: "float", default: 1.4, min: 0.2, max: 6, step: 0.05 },
    { key: "speed", label: "Speed", type: "float", default: 0.25, min: 0, max: 2, step: 0.01 },
    { key: "hue", label: "Hue shift", type: "float", default: 0, min: 0, max: 1, step: 0.01 },
    { key: "saturation", label: "Saturation", type: "float", default: 0.85, min: 0, max: 1.5, step: 0.01 },
  ],
};

export const GRADIENT_MESH_SHADER: ShaderDefinition = {
  id: "gradient-mesh",
  label: "Gradient mesh",
  description: "Four colours drifting and blending into a soft, warped mesh gradient with optional grain.",
  targets: ["skin", "overlay"],
  defaultTarget: "skin",
  animated: true,
  tags: ["animated", "gradient"],
  params: [
    { key: "colorA", label: "Colour A", type: "color", default: "#ff8a5b" },
    { key: "colorB", label: "Colour B", type: "color", default: "#ffd166" },
    { key: "colorC", label: "Colour C", type: "color", default: "#7b6cf6" },
    { key: "colorD", label: "Colour D", type: "color", default: "#2ec4b6" },
    { key: "speed", label: "Speed", type: "float", default: 0.35, min: 0, max: 2, step: 0.01 },
    { key: "warp", label: "Warp", type: "float", default: 1, min: 0, max: 3, step: 0.05 },
    { key: "softness", label: "Softness", type: "float", default: 1, min: 0.3, max: 3, step: 0.05 },
    { key: "grain", label: "Grain", type: "float", default: 0.04, min: 0, max: 0.2, step: 0.005 },
  ],
};

export const FOIL_FLAKES_SHADER: ShaderDefinition = {
  id: "foil-flakes",
  label: "Foil flakes",
  description: "Metallic flakes that catch the light one by one as the card tilts, over a fine grain.",
  targets: ["overlay", "skin"],
  defaultTarget: "overlay",
  defaultBlend: "add",
  animated: true,
  tags: ["sparkle", "view-dependent", "foil"],
  params: [
    { key: "amount", label: "Amount", type: "float", default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: "flakeSize", label: "Flake size (px)", type: "float", default: 7, min: 2, max: 40, step: 0.5, description: "At the face's texture resolution." },
    { key: "sharpness", label: "Sharpness", type: "float", default: 60, min: 4, max: 400, step: 1, description: "Higher = fewer flakes lit at once." },
    { key: "spread", label: "Flake tilt", type: "float", default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: "twinkle", label: "Twinkle", type: "float", default: 0.4, min: 0, max: 2, step: 0.01 },
    { key: "grain", label: "Grain", type: "float", default: 0.05, min: 0, max: 0.3, step: 0.005 },
    { key: "tint", label: "Tint", type: "color", default: "#fff3d6" },
  ],
};

export const HALFTONE_SHADER: ShaderDefinition = {
  id: "halftone",
  label: "Halftone",
  description: "Print-style dot screen of the artwork (or a gradient), in one ink over the card.",
  targets: ["skin", "overlay"],
  defaultTarget: "skin",
  tags: ["print", "artwork"],
  replacesArtwork: (p) => p.source === 0,
  params: [
    {
      key: "source",
      label: "Source",
      type: "int",
      default: 0,
      options: [
        { label: "Artwork (gradient if none)", value: 0 },
        { label: "Linear gradient", value: 1 },
        { label: "Radial gradient", value: 2 },
      ],
    },
    { key: "cellSize", label: "Cell size (px)", type: "float", default: 14, min: 3, max: 60, step: 0.5, description: "At the face's texture resolution." },
    { key: "angle", label: "Screen angle", type: "float", default: 45, min: 0, max: 90, step: 1 },
    { key: "contrast", label: "Contrast", type: "float", default: 1.2, min: 0.2, max: 3, step: 0.05 },
    { key: "invert", label: "Invert", type: "bool", default: false },
    { key: "ink", label: "Ink", type: "color", default: "#14161a" },
  ],
};

export const SCANLINES_SHADER: ShaderDefinition = {
  id: "scanlines",
  label: "Scanlines",
  description: "CRT-style scanlines with a slow rolling glow band.",
  targets: ["overlay", "skin"],
  defaultTarget: "overlay",
  animated: true,
  tags: ["retro", "animated"],
  params: [
    { key: "lines", label: "Lines", type: "float", default: 180, min: 20, max: 600, step: 1 },
    { key: "intensity", label: "Line darkness", type: "float", default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: "glow", label: "Band glow", type: "float", default: 0.25, min: 0, max: 1, step: 0.01 },
    { key: "speed", label: "Roll speed", type: "float", default: 0.12, min: 0, max: 1, step: 0.01 },
    { key: "lineColor", label: "Line colour", type: "color", default: "#05070a" },
    { key: "glowColor", label: "Glow colour", type: "color", default: "#b8ffd9" },
  ],
};
