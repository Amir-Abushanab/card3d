import type { ShaderDefinition } from "../types.ts";

export const CAUSTICS_SHADER: ShaderDefinition = {
  id: "caustics",
  label: "Water caustics",
  description: "Rippling water over a tiled floor (or the card's artwork), refracting and focusing light; tilt stirs it.",
  targets: ["skin", "overlay"],
  defaultTarget: "skin",
  animated: true,
  tags: ["animated", "tilt", "water"],
  replacesArtwork: (p) => p.floor === 1,
  params: [
    {
      key: "floor",
      label: "Floor",
      type: "int",
      default: 0,
      options: [
        { label: "Tiles", value: 0 },
        { label: "Card artwork", value: 1 },
        { label: "Base colour", value: 2 },
      ],
    },
    { key: "speed", label: "Speed", type: "float", default: 1, min: 0, max: 4, step: 0.05 },
    { key: "waveHeight", label: "Wave height", type: "float", default: 1.6, min: 0, max: 6, step: 0.1 },
    { key: "depth", label: "Depth", type: "float", default: 0.3, min: 0, max: 1, step: 0.01, description: "Refraction depth (card heights)." },
    { key: "scale", label: "Scale", type: "float", default: 0.7, min: 0.25, max: 4, step: 0.05 },
    { key: "tileScale", label: "Tiles per height", type: "float", default: 14, min: 2, max: 40, step: 1 },
    { key: "caustics", label: "Caustics", type: "float", default: 0.3, min: 0, max: 1.5, step: 0.01 },
    { key: "flowStrength", label: "Tilt stir", type: "float", default: 1, min: 0, max: 3, step: 0.05 },
    { key: "deepColor", label: "Deep", type: "color", default: "#057dd1" },
    { key: "shallowColor", label: "Shallow", type: "color", default: "#0aa8eb" },
    { key: "causticColor", label: "Light", type: "color", default: "#e9fbff" },
  ],
};
