// The studio environment (scene/quality-env.ts) and three's PMREM (extras/PMREMGenerator.js, r180),
// ported to WGSL.
//
// 1. `fs_cube`: radiance of the Lightformer panels seen from the origin, one cube face per pass
//    (what three's CubeCamera rasterises: nearest panel wins, empty directions are black).
// 2. `fs_base`: the cube copied into the CUBEUV atlas's top level (`_textureToCubeUV`).
// 3. `fs_blur`: the spherical Gaussian blur between levels (`_halfBlur`'s SphericalGaussianBlur).
//
// The PMREM passes keep three's GL viewport numbers and flip clip-space y, so the atlas has the same
// texel layout as three's (row 0 = GL's bottom row) and `textureCubeUV` reads it unchanged.

// ── 1. panels → cube face ─────────────────────────────────────────────────────

struct Panel {
    center: vec4f,  // xyz, w = form (0 rect, 1 ring)
    axis_x: vec4f,  // local x × scale.x
    axis_y: vec4f,  // local y × scale.y
    radiance: vec4f,
};
struct Panels {
    count: vec4u,
    face: vec4u,    // x = cube face, y = face size
    clear: vec4f,   // empty directions (the cube's clear colour, linear)
    items: array<Panel, 16>,
};
@group(0) @binding(0) var<uniform> panels: Panels;

@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// WebGPU cube-face convention (the same as GL's): texel (s, t) of each face → direction.
fn cube_dir(face: u32, s: f32, t: f32) -> vec3f {
    let sc = 2.0 * s - 1.0;
    let tc = 2.0 * t - 1.0;
    switch face {
        case 0u: { return vec3f(1.0, -tc, -sc); }
        case 1u: { return vec3f(-1.0, -tc, sc); }
        case 2u: { return vec3f(sc, 1.0, tc); }
        case 3u: { return vec3f(sc, -1.0, -tc); }
        case 4u: { return vec3f(sc, -tc, 1.0); }
        default: { return vec3f(-sc, -tc, -1.0); }
    }
}

@fragment
fn fs_cube(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    let size = f32(panels.face.y);
    let d = normalize(cube_dir(panels.face.x, pos.x / size, pos.y / size));
    var best = 1e30;
    var color = panels.clear;
    for (var i = 0u; i < panels.count.x; i++) {
        let p = panels.items[i];
        let n = cross(p.axis_x.xyz, p.axis_y.xyz);
        let denom = dot(d, n);
        if (abs(denom) < 1e-12) { continue; }
        let t = dot(p.center.xyz, n) / denom;
        if (t <= 0.0 || t >= best) { continue; }
        let q = t * d - p.center.xyz;
        let u = dot(q, p.axis_x.xyz) / dot(p.axis_x.xyz, p.axis_x.xyz);
        let v = dot(q, p.axis_y.xyz) / dot(p.axis_y.xyz, p.axis_y.xyz);
        var inside = false;
        if (p.center.w < 0.5) {
            inside = abs(u) <= 0.5 && abs(v) <= 0.5;
        } else {
            let r = sqrt(u * u + v * v);
            inside = r >= 0.25 && r <= 0.5;
        }
        if (inside) {
            best = t;
            color = vec4f(p.radiance.rgb, 1.0);
        }
    }
    return color;
}
