import type { ShaderParamValue } from "../types.ts";

/**
 * Face shader model. A `ShaderDefinition` is the library entry
 * a `FaceShader` layer (types.ts) points at by id; the studio builds its controls from `params`. The
 * card engine draws the built-ins and custom WGSL layers (crates/card3d-engine: face_shaders.rs).
 */

export type ShaderTarget = "skin" | "overlay";
export type ShaderBlend = "normal" | "add" | "multiply" | "screen";
export type ShaderParamType = "float" | "int" | "bool" | "color" | "vec2" | "vec3";

export interface ShaderParamOption {
  label: string;
  value: number;
}

/**
 * One user-facing parameter. The shader reads it as `uniform` (default `u` + PascalCase(key), e.g.
 * key "flowStrength" → `uFlowStrength`).
 *
 * Value conventions (`ShaderParamValue`):
 * - float / int: number (int is rounded). `min`/`max`/`step` are UI hints; values are not clamped.
 * - bool: boolean.
 * - color: "#rrggbb" (or "#rgb"), or an [r, g, b] triple in 0..1. Display (sRGB) values: the
 *   shader receives them unconverted, matching what `mainImage` returns.
 * - vec2 / vec3: [x, y] / [x, y, z]; min/max/step apply per component.
 * - `options`: a select (int/float); the value is one of the options' `value`s.
 */
export interface ShaderParamSpec {
  key: string;
  label: string;
  type: ShaderParamType;
  default: ShaderParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: ShaderParamOption[];
  /** One-line help for the control. */
  description?: string;
  /** The shader's name for it; default `u` + PascalCase(key). */
  uniform?: string;
}

/** A built-in face shader, or a custom layer's (`customShaderDefinition`). */
export interface ShaderDefinition {
  id: string;
  label: string;
  description: string;
  targets: ShaderTarget[];
  defaultTarget: ShaderTarget;
  /** Default blend for new layers (FaceShader.blend overrides). Default "normal". */
  defaultBlend?: ShaderBlend;
  params: ShaderParamSpec[];
  /** Uses the clock or the tilt spring, so it needs live frames (default false). */
  animated?: boolean;
  /**
   * `mainImage` returns scene-linear (HDR) colour that the renderer tone-maps (overlay) instead of a
   * display (sRGB) colour. Default false.
   */
  linearOutput?: boolean;
  /** Re-render when the pointer moves (reads `uPointer`). */
  pointer?: boolean;
  /**
   * True when the layer renders the face's artwork itself (e.g. a halftone or liquid-metal version of
   * it): the card then hides that side's artwork layer so the original doesn't cover the result.
   */
  replacesArtwork?: (params: Record<string, ShaderParamValue>) => boolean;
  /** Search/grouping tags for the studio. */
  tags?: string[];
}

export interface ShaderError {
  /** 1-based line in the user's code (0 = not attributable to a line). */
  line: number;
  message: string;
}
