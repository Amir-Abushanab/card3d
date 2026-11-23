import { CAUSTICS_SHADER } from "./library/water.ts";
import { FOIL_FLAKES_SHADER, GRADIENT_MESH_SHADER, HALFTONE_SHADER, OIL_SLICK_SHADER, SCANLINES_SHADER } from "./library/originals.ts";
import { LENS_SHADER } from "./library/lens.ts";
import { LIQUID_METAL_SHADER } from "./library/liquid-metal/spec.ts";
import { THERMAL_SHADER } from "./library/thermal.ts";
import { VINYL_SHADER, WOOD_SHADER } from "./library/finishes.ts";
import type { ShaderDefinition } from "./types.ts";

/**
 * The face shader library: the built-in definitions a `FaceShader.id` names (the card engine draws
 * each in WGSL: crates/card3d-engine/src/face_library.rs). "custom" is not an entry: a custom layer's
 * definition comes from its code (`customShaderDefinition`).
 */
export const BUILTIN_SHADERS: readonly ShaderDefinition[] = [
  THERMAL_SHADER,
  LIQUID_METAL_SHADER,
  CAUSTICS_SHADER,
  LENS_SHADER,
  VINYL_SHADER,
  WOOD_SHADER,
  OIL_SLICK_SHADER,
  GRADIENT_MESH_SHADER,
  FOIL_FLAKES_SHADER,
  HALFTONE_SHADER,
  SCANLINES_SHADER,
];

const registry = new Map<string, ShaderDefinition>(BUILTIN_SHADERS.map((d) => [d.id, d]));

/** The definition for an id, or undefined ("custom" is not a registry entry). */
export function getShaderDefinition(id: string): ShaderDefinition | undefined {
  return registry.get(id);
}

/** Every definition, in library order. */
export function listShaders(): ShaderDefinition[] {
  return [...registry.values()];
}
