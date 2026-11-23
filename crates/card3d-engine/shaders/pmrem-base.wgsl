// `_textureToCubeUV`: the cube copied into the atlas's top level.

@group(0) @binding(0) var cube_tex: texture_cube<f32>;
@group(0) @binding(1) var lin: sampler;

@fragment
fn fs_base(in: PlaneOut) -> @location(0) vec4f {
    return textureSampleLevel(cube_tex, lin, in.dir, 0.0);
}
