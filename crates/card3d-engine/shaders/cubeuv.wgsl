// three's CUBEUV atlas lookup (cube_uv_reflection_fragment, r180). Shared by the blur and the card shader.

// CUBEUV_MAX_MIP, CUBEUV_TEXEL_WIDTH and CUBEUV_TEXEL_HEIGHT come before this file, for the atlas size
// (`EnvSize::cubeuv_prelude`).
const cubeUV_minMipLevel: f32 = 4.0;
const cubeUV_minTileSize: f32 = 16.0;

fn get_face(direction: vec3f) -> f32 {
    let a = abs(direction);
    var face = -1.0;
    if (a.x > a.z) {
        if (a.x > a.y) { face = select(3.0, 0.0, direction.x > 0.0); }
        else { face = select(4.0, 1.0, direction.y > 0.0); }
    } else {
        if (a.z > a.y) { face = select(5.0, 2.0, direction.z > 0.0); }
        else { face = select(4.0, 1.0, direction.y > 0.0); }
    }
    return face;
}

fn get_uv(direction: vec3f, face: f32) -> vec2f {
    var uv: vec2f;
    if (face == 0.0) { uv = vec2f(direction.z, direction.y) / abs(direction.x); }
    else if (face == 1.0) { uv = vec2f(-direction.x, -direction.z) / abs(direction.y); }
    else if (face == 2.0) { uv = vec2f(-direction.x, direction.y) / abs(direction.z); }
    else if (face == 3.0) { uv = vec2f(-direction.z, direction.y) / abs(direction.x); }
    else if (face == 4.0) { uv = vec2f(-direction.x, direction.z) / abs(direction.y); }
    else { uv = vec2f(direction.x, direction.y) / abs(direction.z); }
    return 0.5 * (uv + 1.0);
}

fn bilinear_cube_uv(atlas: texture_2d<f32>, atlas_sampler: sampler, direction: vec3f, mip_in: f32) -> vec3f {
    var face = get_face(direction);
    let filter_int = max(cubeUV_minMipLevel - mip_in, 0.0);
    let mip_int = max(mip_in, cubeUV_minMipLevel);
    let face_size = exp2(mip_int);
    var uv = get_uv(direction, face) * (face_size - 2.0) + 1.0;
    if (face > 2.0) {
        uv.y += face_size;
        face -= 3.0;
    }
    uv.x += face * face_size;
    uv.x += filter_int * 3.0 * cubeUV_minTileSize;
    uv.y += 4.0 * (exp2(CUBEUV_MAX_MIP) - face_size);
    uv.x *= CUBEUV_TEXEL_WIDTH;
    uv.y *= CUBEUV_TEXEL_HEIGHT;
    return textureSampleLevel(atlas, atlas_sampler, uv, 0.0).rgb;
}

const cubeUV_r0: f32 = 1.0;
const cubeUV_m0: f32 = -2.0;
const cubeUV_r1: f32 = 0.8;
const cubeUV_m1: f32 = -1.0;
const cubeUV_r4: f32 = 0.4;
const cubeUV_m4: f32 = 2.0;
const cubeUV_r5: f32 = 0.305;
const cubeUV_m5: f32 = 3.0;
const cubeUV_r6: f32 = 0.21;
const cubeUV_m6: f32 = 4.0;

fn roughness_to_mip(roughness: f32) -> f32 {
    var mip = 0.0;
    if (roughness >= cubeUV_r1) {
        mip = (cubeUV_r0 - roughness) * (cubeUV_m1 - cubeUV_m0) / (cubeUV_r0 - cubeUV_r1) + cubeUV_m0;
    } else if (roughness >= cubeUV_r4) {
        mip = (cubeUV_r1 - roughness) * (cubeUV_m4 - cubeUV_m1) / (cubeUV_r1 - cubeUV_r4) + cubeUV_m1;
    } else if (roughness >= cubeUV_r5) {
        mip = (cubeUV_r4 - roughness) * (cubeUV_m5 - cubeUV_m4) / (cubeUV_r4 - cubeUV_r5) + cubeUV_m4;
    } else if (roughness >= cubeUV_r6) {
        mip = (cubeUV_r5 - roughness) * (cubeUV_m6 - cubeUV_m5) / (cubeUV_r5 - cubeUV_r6) + cubeUV_m5;
    } else {
        mip = -2.0 * log2(1.16 * roughness); // 1.16 = 1.79^0.25
    }
    return mip;
}

fn texture_cube_uv(atlas: texture_2d<f32>, atlas_sampler: sampler, dir: vec3f, roughness: f32) -> vec3f {
    let mip = clamp(roughness_to_mip(roughness), cubeUV_m0, CUBEUV_MAX_MIP);
    let mip_f = fract(mip);
    let mip_int = floor(mip);
    let c0 = bilinear_cube_uv(atlas, atlas_sampler, dir, mip_int);
    if (mip_f == 0.0) {
        return c0;
    }
    let c1 = bilinear_cube_uv(atlas, atlas_sampler, dir, mip_int + 1.0);
    return mix(c0, c1, mip_f);
}
