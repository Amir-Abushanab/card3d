import type { CustomShaderExample } from "./custom-parse.ts";

/**
 * Starter custom face shaders in WGSL (`FaceShader { id: "custom", language: "wgsl", code }`), the
 * language the card engine draws (crates/card3d-engine/shaders/face/prelude.wgsl is the prelude they
 * see). Parameters are `var<private> uName: type; // @param …` / `// @color …`; the shader defines
 * `fn mainImage(uv: vec2f) -> vec4f`.
 */
export const WGSL_SHADER_EXAMPLES: CustomShaderExample[] = [
  {
    id: "plasma",
    label: "Plasma",
    description: "Animated cosine-palette plasma that keeps clear of the chip.",
    target: "skin",
    code: `// Plasma: a starter skin shader. Edit me!
var<private> uSpeed: f32;   // @param 0 3 0.6 label="Speed"
var<private> uScale: f32;   // @param 1 12 4 label="Scale"
var<private> uTintA: vec3f; // @color #1d2b64 label="Shadow"
var<private> uTintB: vec3f; // @color #f8cdda label="Highlight"

fn mainImage(uv: vec2f) -> vec4f {
  let p = facePos * uScale;
  let t = uTime * uSpeed;
  let v = sin(p.x + t) + sin(p.y * 1.3 - t) + sin(length(p + vec2f(sin(t * 0.7), cos(t * 0.5))) * 1.7);
  var col = mix(uTintA, uTintB, 0.5 + 0.5 * sin(v * 1.6));
  // keep the area around the chip calm
  col = mix(uBaseColor, col, smoothstep(0.0, 0.06, chipDistance(uv)));
  return vec4f(col, 1.0);
}
`,
  },
  {
    id: "spotlight",
    label: "Tilt spotlight",
    description: "A soft light that slides across the face as the card tilts (overlay).",
    target: "overlay",
    code: `// A view-dependent glint: brightest where the reflected view meets a fixed light.
var<private> uColor: vec3f;    // @color #fff4d6 label="Light"
var<private> uSize: f32;       // @param 0.05 0.6 0.22 label="Size"
var<private> uStrength: f32;   // @param 0 1 0.55 label="Strength"

fn mainImage(uv: vec2f) -> vec4f {
  let r = reflect(-viewDir, faceNormal);
  let spot = r.xy * 1.8;                    // where the light lands on the face
  let d = length(facePos - spot * vec2f(uAspect, 1.0) * 0.5);
  let glow = exp(-d * d / (uSize * uSize)) * uStrength;
  return vec4f(uColor, glow);
}
`,
  },
  {
    id: "rings",
    label: "Ripple rings",
    description: "Concentric rings from the pointer (or the centre), tinted by the artwork.",
    target: "skin",
    code: `// Rings that follow the pointer while it is over the card.
// @replaces-artwork  (this shader redraws the artwork itself, so the card hides the original)
var<private> uRings: f32;    // @param 4 60 24 label="Rings"
var<private> uSpeed: f32;    // @param 0 4 1 label="Speed"
var<private> uUseArt: bool;  // @param default=true label="Tint with artwork"

fn mainImage(uv: vec2f) -> vec4f {
  let c = mix(vec2f(0.5), uPointer.xy, uPointer.z);
  let d = length((uv - c) * vec2f(uAspect, 1.0));
  let ring = 0.5 + 0.5 * cos(d * uRings * 6.2831 - uTime * uSpeed * 3.0);
  var base = uBaseColor;
  let art = artwork(uv);
  if (uUseArt && uHasArtwork > 0.5) { base = mix(base, art.rgb, art.a); }
  return vec4f(base * (0.75 + 0.35 * ring), 1.0);
}
`,
  },
];
