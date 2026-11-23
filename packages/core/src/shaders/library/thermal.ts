import type { ShaderDefinition } from "../types.ts";

/**
 * The thermal palette, exactly (display values; the hex defaults below round them).
 * @ported the Rust port (thermal.rs) cites it
 */
export const THERMAL_PALETTE = {
  ink: [0.07, 0.072, 0.085],
  color1: [0.15, 0.17, 0.22],
  color2: [0.3, 0.35, 0.41],
  color3: [0.53, 0.61, 0.66],
  color4: [0.79, 0.85, 0.88],
  color5: [0.98, 0.99, 1.0],
} as const satisfies Record<string, readonly [number, number, number]>;

/**
 * Thermal contours: a heat field from three Gaussian
 * pools, advected by layered sine flow and pushed by the card's tilt spring, quantised into
 * isotherm lines over a cool-to-white palette. The chip is an obstacle the flow slides around, and two
 * quiet zones (corner mark, name) stay ink-dark so branding reads.
 */
export const THERMAL_SHADER: ShaderDefinition = {
  id: "thermal",
  label: "Thermal contours",
  description: "Isotherm lines over a heat map that drifts and flows with the card's tilt, clearing the chip.",
  targets: ["skin", "overlay"],
  defaultTarget: "skin",
  animated: true,
  tags: ["animated", "tilt", "contours"],
  params: [
    {
      key: "contours",
      label: "Contour count",
      type: "float",
      default: 17,
      min: 2,
      max: 40,
      step: 0.5,
      description: "Isotherm lines across the full heat range.",
    },
    { key: "speed", label: "Drift speed", type: "float", default: 0.075, min: 0, max: 1, step: 0.005, description: "Phase drift per second." },
    { key: "phase", label: "Phase", type: "float", default: 0.35, min: 0, max: 6.283, step: 0.01 },
    {
      key: "flowStrength",
      label: "Tilt flow",
      type: "float",
      default: 1,
      min: 0,
      max: 3,
      step: 0.05,
      description: "How far tilting the card pushes the heat.",
    },
    { key: "turbulence", label: "Turbulence", type: "float", default: 1, min: 0, max: 3, step: 0.05 },
    { key: "scale", label: "Scale", type: "float", default: 1, min: 0.3, max: 3, step: 0.05 },
    { key: "lineDarkness", label: "Line darkness", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    {
      key: "quiet",
      label: "Quiet zones",
      type: "float",
      default: 0.93,
      min: 0,
      max: 1,
      step: 0.01,
      description: "Darkens the corner mark and name areas so branding reads.",
    },
    { key: "avoidChip", label: "Flow around chip", type: "bool", default: true },
    { key: "ink", label: "Ink", type: "color", default: "#121216" },
    { key: "color1", label: "Cool", type: "color", default: "#262b38" },
    { key: "color2", label: "Mid-cool", type: "color", default: "#4d5969" },
    { key: "color3", label: "Mid", type: "color", default: "#879ca8" },
    { key: "color4", label: "Warm", type: "color", default: "#c9d9e0" },
    { key: "color5", label: "Hot", type: "color", default: "#fafcff" },
  ],
};
