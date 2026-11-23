// The shine add-on's additive layers (addons/shine/rig.ts): three's MeshBasicMaterial (the aura and the
// streaks) and SpriteMaterial (the glint) with a map, additive, not tone-mapped.
diagnostic(off, derivative_uniformity);

struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    light_dir: vec4f,
    light_color: vec4f,
    ambient: vec4f,
    misc: vec4f, // y = 1: linear output (the glass's buffer passes)
};

struct Layer {
    model_view: mat4x4f,
    color: vec4f, // linear rgb, opacity
    misc: vec4f,  // x = the sprite's rotation
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> layer: Layer;
@group(1) @binding(1) var map: texture_2d<f32>;
@group(1) @binding(2) var map_sampler: sampler;

struct VOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> VOut {
    return VOut(frame.proj * layer.model_view * vec4f(position, 1.0), uv);
}

// THREE.Sprite: a camera-facing quad at the object's origin, sized by its world scale, turned by the
// material's rotation.
@vertex
fn vs_sprite(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> VOut {
    let mv = layer.model_view;
    let a = position.xy * vec2f(length(mv[0].xyz), length(mv[1].xyz));
    let r = layer.misc.x;
    let p = mv[3].xy + vec2f(cos(r) * a.x - sin(r) * a.y, sin(r) * a.x + cos(r) * a.y);
    return VOut(frame.proj * vec4f(p, mv[3].zw), uv);
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4f {
    let c = layer.color * textureSample(map, map_sampler, in.uv);
    if (frame.misc.y > 0.5) { return c; }
    return vec4f(select(pow(c.rgb, vec3f(0.41666)) * 1.055 - 0.055, c.rgb * 12.92, c.rgb <= vec3f(0.0031308)), c.a);
}
