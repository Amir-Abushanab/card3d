// card3d face shader prelude (shaders/prelude.ts in WGSL): the uniforms, per-fragment globals and
// helpers every face shader sees, and the entry points that call its `mainImage(uv)`.
//
// The module is: this prelude, the layer's parameter declarations (`var<private> uName: type;`,
// filled from `face.params` by `card3d_params()`), the shader's code, then prelude-end.wgsl.
//
// Colour convention: `mainImage` returns display (sRGB) colour with straight alpha; with
// LINEAR_OUTPUT, scene-linear colour (tone-mapped on overlays). Face shaders may take derivatives in
// branches, as GLSL lets them.
diagnostic(off, derivative_uniformity);

// 0 replace, 1 normal, 2 add, 3 multiply, 4 screen (`BLEND_MODE_DEFINE`).
override BLEND_MODE: u32 = 1u;
override FACE_OVERLAY: bool = false;
override LINEAR_OUTPUT: bool = false;

struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    light_dir: vec4f,
    light_color: vec4f,
    ambient: vec4f,
    misc: vec4f,         // x = tone-mapping exposure, y = 1: linear output (glass buffer passes)
    env: vec4f,
};

struct Face {
    model_view: mat4x4f, // overlays
    time: vec4f,         // uTime, uResolution.xy, uOpacity
    tilt: vec4f,         // uTilt
    pointer: vec4f,      // uPointer.xyz
    base: vec4f,         // uBaseColor.rgb, uHasArtwork
    chip: vec4f,         // uChip
    misc: vec4f,         // uAspect, uSide, uOverlay
    eye: vec4f,          // uEye.xyz
    params: array<vec4f, 16>,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> face: Face;
@group(1) @binding(1) var uArtwork: texture_2d<f32>;
@group(1) @binding(2) var uArtworkSampler: sampler;
@group(1) @binding(3) var uSource: texture_2d<f32>;
@group(1) @binding(4) var uSourceSampler: sampler;

var<private> uTime: f32;            // seconds (frozen layers: FaceShader.time)
var<private> uResolution: vec2f;    // face size in pixels (skin target size)
var<private> uTilt: vec4f;          // card tilt spring: xy = position (card normal x/y), zw = velocity
var<private> uPointer: vec3f;       // xy = pointer on this face (uv), z = 1 while the pointer is over it
var<private> uBaseColor: vec3f;     // the card's base colour (display sRGB)
var<private> uHasArtwork: f32;      // 1 when the face has artwork
var<private> uChip: vec4f;          // chip bounds [cx, cy, hx, hy] in top-origin card uv (front)
var<private> uAspect: f32;          // card width / height (3.37 / 2.125)
var<private> uSide: f32;            // 0 front, 1 back
var<private> uOverlay: f32;         // 1 for overlay layers, 0 for skin layers
var<private> uEye: vec3f;           // camera position in face space (overlay; card units, +z out of the face)
var<private> uOpacity: f32;         // layer opacity (applied by the wrapper)

var<private> cardUv: vec2f;         // uv in front-card space: mirrored on the back
var<private> facePos: vec2f;        // aspect-correct, centred: (uv - 0.5) * vec2(uAspect, 1.0)
var<private> viewDir: vec3f;        // unit vector from the surface to the eye, face space ((0,0,1) on skins)
var<private> faceNormal: vec3f;     // (0, 0, 1) in face space
var<private> card3dLoopGuard: i32;
const CARD3D_LOOP_LIMIT: i32 = 10000;
/** Injected into custom shaders' loop conditions: caps total loop iterations per fragment. */
fn card3dGuard() -> bool { card3dLoopGuard += 1; return card3dLoopGuard < CARD3D_LOOP_LIMIT; }

const PI: f32 = 3.141592653589793;
const TAU: f32 = 6.283185307179586;

/** GLSL's mod (floored), which WGSL's % (truncated) is not for negative values. */
fn mod1(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn mod2(x: vec2f, y: vec2f) -> vec2f { return x - y * floor(x / y); }
fn mod3(x: vec3f, y: vec3f) -> vec3f { return x - y * floor(x / y); }

fn hash12(p: vec2f) -> f32 { var p3 = fract(vec3f(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
fn hash22(p: vec2f) -> vec2f { var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
fn noise(p: vec2f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u.x), mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p_in: vec2f) -> f32 {
    var p = p_in;
    var s = 0.0;
    var a = 0.5;
    for (var i = 0; i < 5; i++) { s += a * noise(p); p = mat2x2f(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
    return s;
}
fn rot2(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn rotate(p: vec2f, a: f32) -> vec2f { return rot2(a) * p; }
fn palette(t: f32, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f { return a + b * cos(TAU * (c * t + d)); }
fn hsv2rgb(c: vec3f) -> vec3f { let p = abs(fract(c.xxx + vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return c.z * mix(vec3f(1.0), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), c.y); }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn srgbToLinear(c_in: vec3f) -> vec3f { let c = max(c_in, vec3f(0.0)); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), step(vec3f(0.04045), c)); }
fn linearToSrgb(c_in: vec3f) -> vec3f { let c = max(c_in, vec3f(0.0)); return mix(c * 12.92, 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, step(vec3f(0.0031308), c)); }
fn sdRoundBox(p: vec2f, b: vec2f, r: f32) -> f32 { let q = abs(p) - b + r; return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r; }
/** Distance (card-height units) from the chip's rounded outline at face uv; large on the back. */
fn chipDistance(uv: vec2f) -> f32 {
    if (uSide > 0.5) { return 1e3; }
    let metric = vec2f(uAspect, 1.0);
    let hs = uChip.zw * metric;
    return sdRoundBox((vec2f(uv.x, 1.0 - uv.y) - uChip.xy) * metric, hs, 0.22 * min(hs.x, hs.y));
}
/** This face's artwork at uv (display sRGB, straight alpha); transparent when there is none. */
fn artwork(uv: vec2f) -> vec4f { let t = textureSample(uArtwork, uArtworkSampler, uv); return vec4f(linearToSrgb(t.rgb), t.a); }
// ─────────────────────────────────────────────────────────────────────────────
