// A staged scene's floor passes (scene/marketing/floor.ts): the contact shadow's darkness by height,
// its separable blur, and the reflection's mipmaps (`generateMipmap`).

// ── darkness (the contact shadow's override material) ─────────────────────────

struct Shadow {
    view_proj: mat4x4f, // the shadow camera: at the floor, looking up
    params: vec4f,      // floor y, height that still casts shadow
};
@group(0) @binding(0) var<uniform> shadow: Shadow;
@group(1) @binding(0) var<uniform> model: mat4x4f;

struct DarkOut {
    @builtin(position) pos: vec4f,
    @location(0) height: f32,
};

@vertex
fn vs_dark(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> DarkOut {
    var o: DarkOut;
    let world = model * vec4f(position, 1.0);
    o.height = world.y - shadow.params.x;
    o.pos = shadow.view_proj * world;
    return o;
}

@fragment
fn fs_dark(in: DarkOut) -> @location(0) vec4f {
    let a = 1.0 - clamp(in.height / shadow.params.y, 0.0, 1.0);
    return vec4f(0.0, 0.0, 0.0, pow(a, 1.5));
}

// ── full-screen passes ───────────────────────────────────────────────────────

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> blur_step: vec4f;

@vertex
fn vs_quad(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// Gaussian, 9 taps through linear filtering.
@fragment
fn fs_blur(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    let uv = pos.xy / vec2f(textureDimensions(source));
    let s = blur_step.xy;
    var c = textureSampleLevel(source, source_sampler, uv, 0.0) * 0.2270270270;
    c += textureSampleLevel(source, source_sampler, uv + s * 1.3846153846, 0.0) * 0.3162162162;
    c += textureSampleLevel(source, source_sampler, uv - s * 1.3846153846, 0.0) * 0.3162162162;
    c += textureSampleLevel(source, source_sampler, uv + s * 3.2307692308, 0.0) * 0.0702702703;
    c += textureSampleLevel(source, source_sampler, uv - s * 3.2307692308, 0.0) * 0.0702702703;
    return c;
}

// One mip level from the one above: a bilinear tap at each texel's centre (a 2 × 2 box for even sizes).
@fragment
fn fs_mip(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    return textureSampleLevel(source, source_sampler, pos.xy / blur_step.xy, 0.0);
}
