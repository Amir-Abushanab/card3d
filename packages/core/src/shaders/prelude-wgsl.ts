/**
 * The WGSL face-shader prelude's names (crates/card3d-engine/shaders/face/prelude.wgsl: what every
 * custom WGSL layer sees), as reference data for editors and the design-space description. A test
 * holds this list to the prelude file.
 */
export interface WgslPreludeName {
  name: string;
  kind: "uniform" | "global" | "helper";
  /** The declared type, or a helper's signature. */
  type: string;
  doc: string;
}

export const WGSL_PRELUDE_NAMES: readonly WgslPreludeName[] = [
  {
    name: "uTime",
    kind: "uniform",
    type: "f32",
    doc: "Seconds since the layer started (frozen layers: their Freeze time). Using it makes the layer animated.",
  },
  { name: "uResolution", kind: "uniform", type: "vec2f", doc: "Face texture size in pixels." },
  {
    name: "uTilt",
    kind: "uniform",
    type: "vec4f",
    doc: "The card's tilt spring: xy position (card normal x/y), zw velocity. Using it makes the layer animated.",
  },
  { name: "uPointer", kind: "uniform", type: "vec3f", doc: "Pointer on this face: xy = uv, z = 1 while over it." },
  { name: "uBaseColor", kind: "uniform", type: "vec3f", doc: "The card's base colour (display sRGB)." },
  { name: "uHasArtwork", kind: "uniform", type: "f32", doc: "1 when the face has artwork." },
  { name: "uChip", kind: "uniform", type: "vec4f", doc: "Chip bounds [cx, cy, hx, hy] in top-origin card uv. Prefer chipDistance(uv)." },
  { name: "uAspect", kind: "uniform", type: "f32", doc: "Card width / height (3.37 / 2.125)." },
  { name: "uSide", kind: "uniform", type: "f32", doc: "0 on the front, 1 on the back." },
  { name: "uOverlay", kind: "uniform", type: "f32", doc: "1 for overlay layers, 0 for skins." },
  { name: "uEye", kind: "uniform", type: "vec3f", doc: "Camera position in face space (overlays)." },
  { name: "uOpacity", kind: "uniform", type: "f32", doc: "Layer opacity (the wrapper applies it for you)." },
  { name: "cardUv", kind: "global", type: "vec2f", doc: "uv in front-card space: mirrored on the back so x runs the same way through the card." },
  { name: "facePos", kind: "global", type: "vec2f", doc: "Aspect-correct, centred: (uv − 0.5) · vec2f(uAspect, 1); y in [−0.5, 0.5]." },
  { name: "viewDir", kind: "global", type: "vec3f", doc: "Unit vector to the eye, face space (+z out of the face). Overlays only; skins get (0,0,1)." },
  { name: "faceNormal", kind: "global", type: "vec3f", doc: "(0, 0, 1) in face space." },
  { name: "mod1", kind: "helper", type: "fn mod1(x: f32, y: f32) -> f32", doc: "GLSL's floored mod (WGSL's % truncates); mod2 / mod3 for vec2f / vec3f." },
  { name: "mod2", kind: "helper", type: "fn mod2(x: vec2f, y: vec2f) -> vec2f", doc: "Floored mod per component." },
  { name: "mod3", kind: "helper", type: "fn mod3(x: vec3f, y: vec3f) -> vec3f", doc: "Floored mod per component." },
  { name: "hash12", kind: "helper", type: "fn hash12(p: vec2f) -> f32", doc: "Pseudo-random 0..1 from a 2D point." },
  { name: "hash22", kind: "helper", type: "fn hash22(p: vec2f) -> vec2f", doc: "Two pseudo-random 0..1 values." },
  { name: "noise", kind: "helper", type: "fn noise(p: vec2f) -> f32", doc: "Smooth value noise, 0..1." },
  { name: "fbm", kind: "helper", type: "fn fbm(p: vec2f) -> f32", doc: "5-octave fractal noise." },
  { name: "rot2", kind: "helper", type: "fn rot2(a: f32) -> mat2x2f", doc: "2D rotation matrix (radians)." },
  { name: "rotate", kind: "helper", type: "fn rotate(p: vec2f, a: f32) -> vec2f", doc: "Rotate a point (radians)." },
  {
    name: "palette",
    kind: "helper",
    type: "fn palette(t: f32, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f",
    doc: "Cosine palette a + b·cos(TAU·(c·t + d)).",
  },
  { name: "hsv2rgb", kind: "helper", type: "fn hsv2rgb(c: vec3f) -> vec3f", doc: "HSV (0..1) to RGB." },
  { name: "luma", kind: "helper", type: "fn luma(c: vec3f) -> f32", doc: "Relative luminance." },
  { name: "srgbToLinear", kind: "helper", type: "fn srgbToLinear(c: vec3f) -> vec3f", doc: "Display sRGB → linear." },
  { name: "linearToSrgb", kind: "helper", type: "fn linearToSrgb(c: vec3f) -> vec3f", doc: "Linear → display sRGB." },
  { name: "sdRoundBox", kind: "helper", type: "fn sdRoundBox(p: vec2f, b: vec2f, r: f32) -> f32", doc: "Signed distance to a rounded box." },
  {
    name: "chipDistance",
    kind: "helper",
    type: "fn chipDistance(uv: vec2f) -> f32",
    doc: "Distance (card heights) from the chip's outline; large on the back.",
  },
  {
    name: "artwork",
    kind: "helper",
    type: "fn artwork(uv: vec2f) -> vec4f",
    doc: "This face's artwork (display sRGB, straight alpha); transparent when there is none.",
  },
];
