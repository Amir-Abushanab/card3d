// The holo / foil overlay (holo/holo-shader.ts), ported from GLSL. Output is raw (no tone mapping, no
// sRGB encoding) and blended additively: rgb += src.rgb · src.a, alpha += src.a.

struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    camera: vec4f,      // world-space camera position
};

struct Holo {
    model: mat4x4f,
    params: vec4f,      // style, texture, intensity, glare
    params2: vec4f,     // responsive, scale, coverage, edgeOnly
    params3: vec4f,     // edgeSide, 0, 0, 0
    light: vec4f,       // world-space light direction
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> holo: Holo;

struct VOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) world_position: vec3f,
    @location(2) world_normal: vec3f,
    @location(3) world_tangent: vec3f,
    @location(4) nz_local: f32,
    @location(5) z_local: f32,
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> VOut {
    var o: VOut;
    o.uv = uv;
    let world = holo.model * vec4f(position, 1.0);
    o.world_position = world.xyz;
    let model3 = mat3x3f(holo.model[0].xyz, holo.model[1].xyz, holo.model[2].xyz);
    o.world_normal = normalize(model3 * normal);
    o.world_tangent = normalize(model3 * vec3f(1.0, 0.0, 0.0));
    o.nz_local = abs(normal.z);
    o.z_local = position.z;
    o.pos = frame.proj * (frame.view * world);
    return o;
}

fn sat(x: f32) -> f32 { return max(x, 0.0); }

fn hash(q: vec2f) -> f32 {
    return fract(sin(127.1 * q.x + 311.7 * q.y) * 43758.5453123);
}

fn spectrum(t: f32) -> vec3f {
    return 0.54 + 0.46 * cos(6.283185307179586 * (t + vec3f(0.0, 0.33, 0.67)));
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4f {
    let style = holo.params.x;
    let texture = holo.params.y;
    let N = normalize(in.world_normal);
    let V = normalize(frame.camera.xyz - in.world_position);
    let L = normalize(holo.light.xyz);
    let Hh = normalize(V + L);
    let NdotV = sat(dot(N, V));
    let NdotL = sat(dot(N, L));
    let NdotH = sat(dot(N, Hh));
    let specular = pow(NdotH, 46.0) * NdotL;
    let broad_specular = pow(NdotH, 8.0) * NdotL;
    let fresnel = pow(1.0 - NdotV, 5.0);
    let aniso = dot(Hh, normalize(in.world_tangent));
    let diffraction = 1.65 * aniso * holo.params2.x;
    let reflection = dot(reflect(-L, N), V) * holo.params2.x;

    let s = max(holo.params2.y, 0.2);
    let su = (in.uv - 0.5) / s + 0.5;
    let p = select(su, fract(4.0 * su), holo.params2.z > 0.5);

    var C = vec3f(0.86);
    var k = 0.24;
    if (style < 0.5) {
        C = vec3f(0.78, 0.80, 0.77); k = 0.12;
    } else if (style < 1.5) {
        C = vec3f(0.84, 0.88, 0.84); k = 0.18;
    } else if (style < 2.5) {
        C = vec3f(0.95); k = 0.26;
    } else if (style < 3.5) {
        C = spectrum(0.28 * p.x + 1.9 * p.y + diffraction); k = 0.55;
    } else if (style < 4.5) {
        C = mix(vec3f(0.72), spectrum(2.4 * p.x - 0.55 * p.y + diffraction), 0.72); k = 0.62;
    } else if (style < 5.5) {
        let stars = step(0.935, hash(floor(92.0 * p)));
        C = mix(vec3f(0.08, 0.18, 0.42), vec3f(0.74, 0.92, 1.0), stars) + 0.18 * spectrum(0.3 * p.x + diffraction);
        k = 0.58 + 0.3 * stars;
    } else if (style < 6.5) {
        let cross_lines = pow(abs(sin(52.0 * p.x)), 10.0) + pow(abs(sin(52.0 * p.y)), 10.0);
        C = spectrum(p.x - p.y + diffraction) * (0.74 + 0.35 * cross_lines); k = 0.64;
    } else if (style < 7.5) {
        let spill = sin(8.0 * p.x) * sin(11.0 * p.y);
        C = spectrum(0.65 * p.x + p.y + 0.2 * spill + diffraction); k = 0.72;
    } else if (style < 8.5) {
        C = mix(vec3f(1.0), spectrum(0.8 * p.x + 0.7 * p.y + diffraction), 0.68); k = 0.78;
    } else if (style < 9.5) {
        C = mix(vec3f(0.72, 0.78, 0.82), spectrum(diffraction + 0.18 * p.y), 0.24); k = 0.50;
    } else if (style < 10.5) {
        C = mix(spectrum(0.35 * p.x + 0.22 * p.y + diffraction), vec3f(0.88), 0.34); k = 0.56;
    } else if (style < 11.5) {
        let opp = sin(30.0 * (p.x + p.y) + 8.0 * diffraction) - sin(24.0 * (p.x - p.y) - 7.0 * diffraction);
        C = spectrum(1.5 * p.x + 0.7 * p.y + 0.08 * opp + diffraction); k = 0.63;
    } else if (style < 12.5) {
        let relief = abs(sin(38.0 * (p.x - p.y)));
        C = spectrum(0.46 * p.x + 0.72 * p.y + 0.62 * diffraction) * (0.75 + 0.34 * relief); k = 0.70;
    } else if (style < 13.5) {
        C = mix(vec3f(1.0, 0.94, 0.88), spectrum(p.x + p.y + diffraction), 0.42); k = 0.54;
    } else {
        let warm = 0.5 + 0.5 * sin(34.0 * (0.5 * p.x + p.y + diffraction));
        C = mix(vec3f(0.28, 0.08, 0.005), vec3f(1.0, 0.72, 0.12), warm); k = 0.76;
    }

    var m: f32;
    if (texture < 0.5) {
        m = 0.58 + 0.42 * pow(abs(sin(92.0 * (1.7 * p.x + p.y))), 7.0);
    } else if (texture < 1.5) {
        let g = hash(floor(118.0 * (p + diffraction * 0.08)));
        m = 0.54 + 0.88 * step(0.91, g);
    } else {
        let c = abs(fract(p * vec2f(84.0, 54.0)) - 0.5);
        m = 0.54 + 0.68 * (1.0 - smoothstep(0.05, 0.13, length(c)));
    }

    let illumination = 0.16 + 0.24 * NdotL + 0.32 * broad_specular;
    let glare = (1.2 * specular + 0.5 * fresnel + 0.18 * sat(reflection)) * holo.params.w;
    let edge_surface = 1.0 - smoothstep(0.72, 0.98, in.nz_local);
    let edge_side = step(0.0, in.z_local * holo.params3.x);
    let geom_mask = select(1.0, edge_surface * edge_side, holo.params2.w > 0.5);
    let alpha = clamp(geom_mask * holo.params.z * k * m * (illumination + glare), 0.0, 0.88);
    let rgb = C + 0.44 * glare;
    return vec4f(rgb, alpha);
}
