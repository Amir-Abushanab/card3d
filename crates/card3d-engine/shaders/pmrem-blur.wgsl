// `_halfBlur`: three's SphericalGaussianBlur between atlas levels.

struct Blur {
    weights: array<vec4f, 5>,
    pole_axis: vec4f,
    samples: i32,
    latitudinal: u32,
    d_theta: f32,
    mip_int: f32,
};
@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var atlas_sampler: sampler;
@group(0) @binding(2) var<uniform> blur: Blur;

fn weight(i: i32) -> f32 {
    return blur.weights[i / 4][i % 4];
}

fn get_sample(dir: vec3f, theta: f32, axis: vec3f) -> vec3f {
    let c = cos(theta);
    let d = dir * c + cross(axis, dir) * sin(theta) + axis * dot(axis, dir) * (1.0 - c);
    return bilinear_cube_uv(atlas, atlas_sampler, d, blur.mip_int);
}

@fragment
fn fs_blur(in: PlaneOut) -> @location(0) vec4f {
    var axis = select(cross(blur.pole_axis.xyz, in.dir), blur.pole_axis.xyz, blur.latitudinal != 0u);
    if (all(axis == vec3f(0.0))) {
        axis = vec3f(in.dir.z, 0.0, -in.dir.x);
    }
    axis = normalize(axis);
    var c = weight(0) * get_sample(in.dir, 0.0, axis);
    for (var i = 1; i < 20; i++) {
        if (i >= blur.samples) { break; }
        let theta = blur.d_theta * f32(i);
        c += weight(i) * get_sample(in.dir, -theta, axis);
        c += weight(i) * get_sample(in.dir, theta, axis);
    }
    return vec4f(c, 1.0);
}
