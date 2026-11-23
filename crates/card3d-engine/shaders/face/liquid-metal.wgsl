// liquid-metal (library/liquid-metal/liquid-metal.glsl.ts): the surface its runtime draws
// (crate::liquid_metal), already in display colour multiplied by its opacity, with straight alpha.
fn mainImage(uv: vec2f) -> vec4f {
    return textureSample(uSource, uSourceSampler, uv);
}
