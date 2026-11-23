// A staged scene's environment (scene/marketing/: environment.ts, grade.ts; three's PMREMGenerator
// and WebGLCubeRenderTarget.fromEquirectangularTexture): the HDRI into the PMREM atlas's top level,
// and into a cube (as it is, or graded by a lighting preset, with the preset's rim panels in front).
// plane.wgsl comes before this file. The equirect is uploaded bottom row first (three's flipY), so GL's
// uv samples it.

const RECIPROCAL_PI: f32 = 0.3183098861837907;
const RECIPROCAL_PI2: f32 = 0.15915494309189535;

@group(0) @binding(0) var equirect: texture_2d<f32>;
@group(0) @binding(1) var equirect_sampler: sampler;

fn equirect_uv(dir: vec3f) -> vec2f {
    let u = atan2(dir.z, dir.x) * RECIPROCAL_PI2 + 0.5;
    let v = asin(clamp(dir.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5;
    return vec2f(u, v);
}

// `_textureToCubeUV` with the equirect material.
@fragment
fn fs_equirect(in: PlaneOut) -> @location(0) vec4f {
    let d = normalize(in.dir);
    return vec4f(textureSampleLevel(equirect, equirect_sampler, equirect_uv(d), 0.0).rgb, 1.0);
}

struct Panel {
    center: vec4f,  // xyz, w = form (0 rect, 1 ring)
    axis_x: vec4f,  // local x × scale.x
    axis_y: vec4f,  // local y × scale.y
    radiance: vec4f,
};
struct Grade {
    face: vec4u,      // cube face, face size, rim count, 1: graded (else the HDRI as it is)
    turn: vec4f,      // cos, sin of the rotation baked in; saturation
    zones: vec4f,     // log2 luminance: room, lights; the key's lobe: no key beyond z, full key within w
    key_dir: vec4f,
    key_color: vec4f, // log2 of gain × tint, per role
    fill_color: vec4f,
    base_color: vec4f,
    rims: array<Panel, 8>,
};
@group(0) @binding(2) var<uniform> grade: Grade;

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

const LUMA: vec3f = vec3f(0.2126, 0.7152, 0.0722);

@fragment
fn fs_cube(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    let size = f32(grade.face.y);
    let w = normalize(cube_dir(grade.face.x, pos.x / size, pos.y / size));
    // The rim panels (in front of the HDRI's box): the nearest one hit.
    var best = 1e30;
    var rim = vec4f(0.0);
    for (var i = 0u; i < grade.face.z; i++) {
        let p = grade.rims[i];
        let n = cross(p.axis_x.xyz, p.axis_y.xyz);
        let denom = dot(w, n);
        if (abs(denom) < 1e-12) { continue; }
        let t = dot(p.center.xyz, n) / denom;
        if (t <= 0.0 || t >= best) { continue; }
        let q = t * w - p.center.xyz;
        let u = dot(q, p.axis_x.xyz) / dot(p.axis_x.xyz, p.axis_x.xyz);
        let v = dot(q, p.axis_y.xyz) / dot(p.axis_y.xyz, p.axis_y.xyz);
        if (abs(u) <= 0.5 && abs(v) <= 0.5) {
            best = t;
            rim = vec4f(p.radiance.rgb, 1.0);
        }
    }
    if (rim.a > 0.0) { return rim; }
    if (grade.face.w == 0u) {
        return textureSampleLevel(equirect, equirect_sampler, equirect_uv(w), 0.0);
    }
    // The rotation three applies to scene.environment (envMapRotation: the inverse turn about Y), baked in.
    let d = vec3f(grade.turn.x * w.x - grade.turn.y * w.z, w.y, grade.turn.y * w.x + grade.turn.x * w.z);
    var c = textureSampleLevel(equirect, equirect_sampler, equirect_uv(d), 0.0).rgb;
    let l = dot(c, LUMA);
    let light = smoothstep(grade.zones.x, grade.zones.y, log2(max(l, 1e-6)));
    let key = smoothstep(grade.zones.z, grade.zones.w, dot(d, grade.key_dir.xyz));
    // Gains blend in log space, so the curve stays smooth and monotonic across the bands.
    c *= exp2(mix(grade.base_color.rgb, mix(grade.fill_color.rgb, grade.key_color.rgb, key), light));
    let g = dot(c, LUMA);
    return vec4f(max(mix(vec3f(g), c, grade.turn.z), vec3f(0.0)), 1.0);
}
