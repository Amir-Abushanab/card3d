// A staged scene's draws (scene/marketing/: backdrop.ts, floor.ts; three's WebGLBackground): the
// background (the HDRI, sharp or blurred through the PMREM, or a gradient texture), the sweep and the
// floor with its reflection and contact shadow. The CUBEUV constants and cubeuv.wgsl come before this
// file (the environment atlas is the renderer's, group 0).

struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    light_dir: vec4f,
    light_color: vec4f,
    ambient: vec4f,
    misc: vec4f, // x = tone-mapping exposure, y = 1: linear output (half-float passes)
    env: vec4f,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var env_atlas: texture_2d<f32>;
@group(0) @binding(2) var env_sampler: sampler;

fn aces(color_in: vec3f) -> vec3f {
    let input = mat3x3f(vec3f(0.59719, 0.07600, 0.02840), vec3f(0.35458, 0.90834, 0.13383), vec3f(0.04823, 0.01566, 0.83777));
    let output = mat3x3f(vec3f(1.60475, -0.10208, -0.00327), vec3f(-0.53108, 1.10813, -0.07276), vec3f(-0.07367, -0.00605, 1.07602));
    var c = color_in * (frame.misc.x / 0.6);
    c = input * c;
    let a = c * (c + 0.0245786) - 0.000090537;
    let b = c * (0.983729 * c + 0.4329510) + 0.238081;
    c = output * (a / b);
    return saturate(c);
}

fn srgb_oetf(c: vec3f) -> vec3f {
    return select(pow(c, vec3f(0.41666)) * 1.055 - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

// A tone-mapped material's output: ACES and sRGB on the canvas, linear into a render target.
fn out_tone(c: vec3f) -> vec3f {
    if (frame.misc.y > 0.5) { return c; }
    return srgb_oetf(aces(c));
}

// `toneMapped: false`: sRGB on the canvas only.
fn out_plain(c: vec3f) -> vec3f {
    if (frame.misc.y > 0.5) { return c; }
    return srgb_oetf(c);
}

// ── background (WebGLBackground: the box of `backgroundCube`, the plane of `background`) ─────────

struct Background {
    model_view: mat4x4f,
    params: vec4f, // cos, sin of the turn (−environmentRotation.y), intensity, blurriness
};
@group(1) @binding(0) var<uniform> bg: Background;
@group(1) @binding(1) var bg_cube: texture_cube<f32>;
@group(1) @binding(2) var bg_texture: texture_2d<f32>;
@group(1) @binding(3) var bg_sampler: sampler;

struct BgOut {
    @builtin(position) pos: vec4f,
    @location(0) ndc: vec2f,
};

// A full-screen triangle (its mesh's positions are clip-space x, y).
@vertex
fn vs_background(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> BgOut {
    var o: BgOut;
    o.pos = vec4f(position.xy, 0.0, 1.0);
    o.ndc = position.xy;
    return o;
}

// The world direction through the pixel, turned by `backgroundRotation`.
fn bg_direction(ndc: vec2f) -> vec3f {
    let d = vec3f(ndc.x / frame.proj[0][0], ndc.y / frame.proj[1][1], -1.0);
    let w = (vec4f(d, 0.0) * frame.view).xyz;
    let c = bg.params.x;
    let s = bg.params.y;
    return vec3f(c * w.x + s * w.z, w.y, -s * w.x + c * w.z);
}

// Blurred: the environment's PMREM at roughness = blurriness.
@fragment
fn fs_background_env(in: BgOut) -> @location(0) vec4f {
    let c = texture_cube_uv(env_atlas, env_sampler, bg_direction(in.ndc), bg.params.w) * bg.params.z;
    return vec4f(out_tone(c), 1.0);
}

// Sharp: the environment as a cube (the HDRI drawn into one, or the graded cube).
@fragment
fn fs_background_cube(in: BgOut) -> @location(0) vec4f {
    let c = textureSampleLevel(bg_cube, bg_sampler, bg_direction(in.ndc), 0.0).rgb * bg.params.z;
    return vec4f(out_tone(c), 1.0);
}

// A texture over the frame (the gradient: sRGB, not tone mapped).
@fragment
fn fs_background_texture(in: BgOut) -> @location(0) vec4f {
    let c = textureSample(bg_texture, bg_sampler, in.ndc * 0.5 + 0.5);
    return vec4f(out_plain(c.rgb * bg.params.z), c.a);
}

// ── sweep (backdrop.ts) ──────────────────────────────────────────────────────

struct Sweep {
    model_view: mat4x4f,
    model: mat4x4f,
    frame_inv: mat4x4f, // the sweep's own frame (it turns with an orbiting camera)
    color: vec4f,       // linear
    pool: vec4f,        // xyz, w = floor y
    misc: vec4f,        // x = the target's height (GL's gl_FragCoord runs up)
};
@group(1) @binding(0) var<uniform> sweep: Sweep;

struct SweepOut {
    @builtin(position) pos: vec4f,
    @location(0) world: vec3f,
};

@vertex
fn vs_sweep(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> SweepOut {
    var o: SweepOut;
    o.pos = frame.proj * sweep.model_view * vec4f(position, 1.0);
    o.world = (sweep.model * vec4f(position, 1.0)).xyz;
    return o;
}

fn hash(p: vec2f) -> f32 {
    return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fs_sweep(in: SweepOut) -> @location(0) vec4f {
    let p = (sweep.frame_inv * vec4f(in.world, 1.0)).xyz;
    let d = (p - sweep.pool.xyz) * vec3f(0.5, 0.9, 0.8);
    let pool = exp(-dot(d, d) / 9.0);
    var light = 0.5 + 0.62 * pool;
    light *= 1.0 - 0.38 * smoothstep(1.5, 9.0, p.y - sweep.pool.w);
    light *= 1.0 - 0.22 * smoothstep(2.0, 9.0, p.z);
    var c = out_plain(sweep.color.rgb * light);
    // Dither against banding in the smooth falloff.
    c += (hash(vec2f(in.pos.x, sweep.misc.x - in.pos.y)) - 0.5) / 255.0;
    return vec4f(c, 1.0);
}

// ── floor (floor.ts) ─────────────────────────────────────────────────────────

struct Floor {
    model_view: mat4x4f,
    model: mat4x4f,
    mirror: mat4x4f, // the mirror camera's projection · view
    eye: vec4f,
    p0: vec4f,       // reflection texel (x, y), lod max, reflectivity
    p1: vec4f,       // blur, shadow opacity, shadow size, fade radius
    p2: vec4f,       // card height (fade length), floor y
};
@group(1) @binding(0) var<uniform> floor_u: Floor;
@group(1) @binding(1) var reflection: texture_2d<f32>;
@group(1) @binding(2) var shadow: texture_2d<f32>;
@group(1) @binding(3) var mip_sampler: sampler;
@group(1) @binding(4) var lin_sampler: sampler;

struct FloorOut {
    @builtin(position) pos: vec4f,
    @location(0) world: vec3f,
    @location(1) mirror: vec4f,
};

@vertex
fn vs_floor(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> FloorOut {
    var o: FloorOut;
    let world = floor_u.model * vec4f(position, 1.0);
    o.world = world.xyz;
    o.mirror = floor_u.mirror * world;
    o.pos = frame.proj * floor_u.model_view * vec4f(position, 1.0);
    return o;
}

// A render target's texel at GL's uv (v = 0 at the bottom; wgpu's rows run down).
fn rt(uv: vec2f) -> vec2f {
    return vec2f(uv.x, 1.0 - uv.y);
}

@fragment
fn fs_floor(in: FloorOut) -> @location(0) vec4f {
    let eye = floor_u.eye.xyz;
    let V = normalize(in.world - eye);
    let R = reflect(V, vec3f(0.0, 1.0, 0.0));
    // Height above the floor of what this texel reflects: follow R to the vertical plane through the
    // card (origin), facing the camera horizontally.
    let n = normalize(eye.xz + vec2f(1e-5, 0.0));
    let along = dot(R.xz, n);
    let t = select(1e4, -dot(in.world.xz, n) / along, along < -1e-4);
    let h = max(0.0, t * R.y);
    let k = clamp(h / floor_u.p2.x, 0.0, 1.0);

    let fade = floor_u.p1.w;
    let edge = 1.0 - smoothstep(fade * 0.35, fade, length(in.world.xz));
    let fresnel = mix(0.4, 1.0, pow(1.0 - abs(V.y), 4.0));
    let strength = floor_u.p0.w * fresnel * pow(1.0 - k, 2.4) * edge;

    var refl = vec4f(0.0);
    if (strength > 0.001) {
        let uv = in.mirror.xy / in.mirror.w * 0.5 + 0.5;
        let lod = floor_u.p1.x * floor_u.p0.z * (0.3 + 0.7 * k);
        let r = floor_u.p0.xy * exp2(lod) * 0.75;
        refl = textureSampleLevel(reflection, mip_sampler, rt(uv), lod) * 0.36
            + textureSampleLevel(reflection, mip_sampler, rt(uv + vec2f(r.x, 0.3 * r.y)), lod) * 0.16
            + textureSampleLevel(reflection, mip_sampler, rt(uv + vec2f(-0.3 * r.x, r.y)), lod) * 0.16
            + textureSampleLevel(reflection, mip_sampler, rt(uv + vec2f(-r.x, -0.3 * r.y)), lod) * 0.16
            + textureSampleLevel(reflection, mip_sampler, rt(uv + vec2f(0.3 * r.x, -r.y)), lod) * 0.16;
    }
    let ar = clamp(refl.a * strength, 0.0, 1.0);

    let suv = in.world.xz / floor_u.p1.z + 0.5;
    let inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
    let s = clamp(textureSampleLevel(shadow, lin_sampler, rt(suv), 0.0).a * floor_u.p1.y, 0.0, 1.0) * inside * edge;

    // Straight colour through tone mapping and the output transform, then premultiplied: reflection over shadow.
    let c = out_tone(select(vec3f(0.0), refl.rgb / refl.a, refl.a > 1e-4));
    return vec4f(c * ar, ar + s * (1.0 - ar));
}
