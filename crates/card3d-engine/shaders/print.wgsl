// The print bake's pass materials (print/bake.ts): the metal face as flat print colour or its relief,
// and the separations / coverage masks; and the AR bake's (ar/index.ts, the engine's ar.rs): packed
// roughness / metalness and tangent-space normals. Drawn as custom items over the frame's group 0.

struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;

struct Draw {
    model_view: mat4x4f,
    // surface: base colour (linear), roughness; mask: value, opacity, alpha test, clip (1: outside the
    // alpha's [0, 1] square is empty); AR: roughness, metalness, opacity, alpha test
    a: vec4f,
    // the colour map's (surface, AR) or the alpha's (mask) transform: offset xy, scale zw
    map_uv: vec4f,
    // surface, AR: the normal map's repeat xy and normal scale zw
    normal_uv: vec4f,
    // surface: the roughness map's repeat xy; has map, has normal map. AR: has map, normal map,
    // roughness map, bump map
    rough_uv: vec4f,
    // has roughness map / has alpha, mode (0 colour, 1 relief); AR: bump scale
    flags: vec4f,
};
@group(1) @binding(0) var<uniform> d: Draw;
@group(1) @binding(1) var t_map: texture_2d<f32>;
@group(1) @binding(2) var t_normal: texture_2d<f32>;
@group(1) @binding(3) var t_rough: texture_2d<f32>;
@group(1) @binding(4) var s_map: sampler;
@group(1) @binding(5) var s_surface: sampler;

struct V {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) view: vec3f,
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> V {
    var o: V;
    let mv = d.model_view * vec4f(position, 1.0);
    o.pos = frame.proj * mv;
    o.uv = uv;
    o.view = mv.xyz;
    return o;
}

// SURFACE_FRAG: the base colour (× map) shaded by the relief under a fixed light from the top left
// (1 = flat), or the relief alone.
@fragment
fn fs_surface(in: V) -> @location(0) vec4f {
    let map = textureSample(t_map, s_map, d.map_uv.xy + in.uv * d.map_uv.zw);
    let nt = textureSample(t_normal, s_surface, in.uv * d.normal_uv.xy);
    let rt = textureSample(t_rough, s_surface, in.uv * d.rough_uv.xy);
    var n = vec3f(0.0, 0.0, 1.0);
    if (d.rough_uv.w > 0.5) {
        n = nt.xyz * 2.0 - 1.0;
        n = normalize(vec3f(n.xy * d.normal_uv.zw, n.z));
    }
    let L = normalize(vec3f(-0.55, 0.65, 1.0));
    let shade = dot(n, L) / L.z;
    let r = d.a.w * select(1.0, rt.g, d.flags.x > 0.5);
    if (d.flags.y > 0.5) {
        return vec4f(vec3f(clamp(0.5 + (shade - 1.0) * 1.6, 0.0, 1.0)), 1.0);
    }
    var base = d.a.rgb;
    if (d.rough_uv.z > 0.5) { base *= map.rgb; }
    let s = clamp(1.0 + (shade - 1.0) * 0.9 + (d.a.w - r) * 0.25, 0.6, 1.35);
    return vec4f(base * s, 1.0);
}

// MASK_FRAG: `value` where the item draws, its alpha from a map (or a glyph raster).
@fragment
fn fs_mask(in: V) -> @location(0) vec4f {
    let t = d.map_uv.xy + in.uv * d.map_uv.zw;
    let texel = textureSample(t_map, s_map, t);
    var a = d.a.y;
    if (d.flags.x > 0.5) {
        let outside = any(t < vec2f(0.0)) || any(t > vec2f(1.0));
        a *= select(texel.a, 0.0, d.a.w > 0.5 && outside);
    }
    if (a < max(d.a.z, 0.002)) { discard; }
    return vec4f(vec3f(d.a.x), a);
}

// The AR bake's coverage: opacity × the colour map's alpha (a pass material's `a`).
fn ar_alpha(uv: vec2f) -> f32 {
    let texel = textureSample(t_map, s_map, d.map_uv.xy + uv * d.map_uv.zw);
    return d.a.z * select(1.0, texel.a, d.rough_uv.x > 0.5);
}

// The AR bake's roughness / metalness, packed as glTF does (G roughness, B metalness).
@fragment
fn fs_orm(in: V) -> @location(0) vec4f {
    let a = ar_alpha(in.uv);
    let rt = textureSample(t_rough, s_surface, in.uv * d.normal_uv.xy);
    if (a < max(d.a.w, 0.002)) { discard; }
    return vec4f(1.0, d.a.x * select(1.0, rt.g, d.rough_uv.z > 0.5), d.a.y, a);
}

// The AR bake's tangent-space normal, seen face-on: the normal map (× normal scale) and the bump map
// (three's bump mapping in the face-on camera's view space; `t_rough` holds the bump map).
@fragment
fn fs_normal(in: V) -> @location(0) vec4f {
    let a = ar_alpha(in.uv);
    let nt = textureSample(t_normal, s_surface, in.uv * d.normal_uv.xy);
    let duvdx = dpdx(in.uv);
    let duvdy = -dpdy(in.uv);
    let b0 = textureSample(t_rough, s_map, in.uv).x;
    let bx = textureSampleGrad(t_rough, s_map, in.uv + duvdx, duvdx, duvdy).x;
    let by = textureSampleGrad(t_rough, s_map, in.uv + duvdy, duvdx, duvdy).x;
    let sx = normalize(dpdx(in.view));
    let sy = normalize(-dpdy(in.view));
    if (a < max(d.a.w, 0.002)) { discard; }
    var n = vec3f(0.0, 0.0, 1.0);
    if (d.rough_uv.y > 0.5) {
        n = nt.xyz * 2.0 - 1.0;
        n = vec3f(n.xy * d.normal_uv.zw, n.z);
    }
    if (d.rough_uv.w > 0.5) {
        let k = d.flags.x;
        let dh = vec2f(k * bx - k * b0, k * by - k * b0);
        let N = vec3f(0.0, 0.0, 1.0);
        let r1 = cross(sy, N);
        let r2 = cross(N, sx);
        let det = dot(sx, r1);
        let grad = sign(det) * (dh.x * r1 + dh.y * r2);
        let b = normalize(abs(det) * N - grad);
        n = normalize(vec3f(n.xy + b.xy, n.z * b.z));
    }
    return vec4f(normalize(n) * 0.5 + 0.5, a);
}
