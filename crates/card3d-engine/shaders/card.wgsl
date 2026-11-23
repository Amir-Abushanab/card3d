// three's MeshPhysicalMaterial (r180) for the card's layers, ported to WGSL: GGX with anisotropy and
// clearcoat, a directional light, image-based lighting from the PMREM atlas with the multi-scattering
// split sum, normal or bump maps, ACES filmic tone mapping and the sRGB output transfer. Shading is in
// view space, as in three. Only the features the card uses are here (no sheen or shadows). The glass
// body has its own entry points (`vs_glass`, `fs_glass`): drei's MeshTransmissionMaterial, a physical
// material whose diffuse term is a multi-sample refraction of a private buffer (scene/
// transmission-material.ts). `cubeuv.wgsl` is prepended.
//
// WGSL's dpdy runs down the framebuffer; GL's dFdy runs up. `dfdy` restores GL's sign, which the
// tangent frame and the bump gradient depend on.
//
// No identifier may be named `gl`: naga's GLSL output (the WebGL build) renames it `gl_1`, and names
// starting with `gl_` are reserved in GLSL.

const PI: f32 = 3.141592653589793;
const RECIPROCAL_PI: f32 = 0.3183098861837907;
const EPSILON: f32 = 1e-6;

struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
    light_dir: vec4f,    // view space, towards the light
    light_color: vec4f,
    ambient: vec4f,
    misc: vec4f,         // x = tone-mapping exposure, y = 1: linear output (the glass's buffer passes), z = point lights
    env: vec4f,          // environment intensity, rotation about y (radians)
    points: array<vec4f, 8>, // per point light (up to 4): view position, distance; colour × intensity, decay
    fill_dir: vec4f,     // a second directional light (the marquee's frontal fill), view space
    fill_color: vec4f,   // its colour × intensity; w = 1 when on
};

struct Draw {
    model_view: mat4x4f,
    normal_matrix: mat4x4f,
    color: vec4f,        // linear rgb, opacity
    pbr: vec4f,          // metalness, roughness, clearcoat, clearcoatRoughness
    aniso: vec4f,        // anisotropy, anisotropyRotation, alphaTest, bumpScale
    irid: vec4f,         // iridescence, iridescenceIOR, thickness (nm)
    maps: vec4f,         // normalScale.xy, surface repeat.xy
    flags: vec4f,        // map, normal map, roughness map, bump map
    flags2: vec4f,       // transparent, luminance after map, unlit tone mapped, unlit
    emissive: vec4f,     // linear rgb
    map_uv: vec4f,       // map offset.xy, repeat.xy
    look_tint: vec4f,    // sticker tint rgb, amount
    look_adjust: vec4f,  // brightness, contrast, saturation, has look
    spec: vec4f,         // specularIntensity, side (0 front, 1 double, 2 back)
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var env_atlas: texture_2d<f32>;
@group(0) @binding(2) var env_sampler: sampler;

@group(1) @binding(0) var<uniform> draw: Draw;
@group(1) @binding(1) var normal_map: texture_2d<f32>;
@group(1) @binding(2) var roughness_map: texture_2d<f32>;
@group(1) @binding(3) var color_map: texture_2d<f32>;
@group(1) @binding(4) var bump_map: texture_2d<f32>;
@group(1) @binding(5) var surface_sampler: sampler;
@group(1) @binding(6) var map_sampler: sampler;

struct VOut {
    @builtin(position) pos: vec4f,
    @location(0) view_position: vec3f, // three's vViewPosition (= −mvPosition)
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
    @location(3) world_position: vec3f, // the glass's vWorldPosition (zero elsewhere)
};

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> VOut {
    return vertex(position, normal, uv);
}

fn vertex(position: vec3f, normal: vec3f, uv: vec2f) -> VOut {
    var o: VOut;
    let mv = draw.model_view * vec4f(position, 1.0);
    o.pos = frame.proj * mv;
    o.view_position = -mv.xyz;
    o.normal = (draw.normal_matrix * vec4f(normal, 0.0)).xyz;
    // FLIP_SIDED (a back-side material): the normal faces the other way.
    if (draw.spec.y > 1.5) { o.normal = -o.normal; }
    o.uv = uv;
    o.world_position = vec3f(0.0);
    return o;
}

fn pow2(x: f32) -> f32 { return x * x; }
fn dfdy2(v: vec2f) -> vec2f { return -dpdy(v); }
fn dfdy3(v: vec3f) -> vec3f { return -dpdy(v); }

fn F_Schlick(f0: vec3f, f90: f32, dotVH: f32) -> vec3f {
    let fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
    return f0 * (1.0 - fresnel) + f90 * fresnel;
}

fn V_GGX_SmithCorrelated(alpha: f32, dotNL: f32, dotNV: f32) -> f32 {
    let a2 = pow2(alpha);
    let gv = dotNL * sqrt(a2 + (1.0 - a2) * pow2(dotNV));
    let g_l = dotNV * sqrt(a2 + (1.0 - a2) * pow2(dotNL));
    return 0.5 / max(gv + g_l, EPSILON);
}

fn D_GGX(alpha: f32, dotNH: f32) -> f32 {
    let a2 = pow2(alpha);
    let denom = pow2(dotNH) * (a2 - 1.0) + 1.0;
    return RECIPROCAL_PI * a2 / pow2(denom);
}

fn V_GGX_SmithCorrelated_Anisotropic(alphaT: f32, alphaB: f32, dotTV: f32, dotBV: f32, dotTL: f32, dotBL: f32, dotNV: f32, dotNL: f32) -> f32 {
    let gv = dotNL * length(vec3f(alphaT * dotTV, alphaB * dotBV, dotNV));
    let g_l = dotNV * length(vec3f(alphaT * dotTL, alphaB * dotBL, dotNL));
    return saturate(0.5 / (gv + g_l));
}

fn D_GGX_Anisotropic(alphaT: f32, alphaB: f32, dotNH: f32, dotTH: f32, dotBH: f32) -> f32 {
    let a2 = alphaT * alphaB;
    let v = vec3f(alphaB * dotTH, alphaT * dotBH, a2 * dotNH);
    let v2 = dot(v, v);
    let w2 = a2 / v2;
    return RECIPROCAL_PI * a2 * pow2(w2);
}

fn DFGApprox(normal: vec3f, viewDir: vec3f, roughness: f32) -> vec2f {
    let dotNV = saturate(dot(normal, viewDir));
    let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
    let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
    let r = roughness * c0 + c1;
    let a004 = min(r.x * r.x, exp2(-9.28 * dotNV)) * r.x + r.y;
    return vec2f(-1.04, 1.04) * a004 + r.zw;
}

// ── iridescence (three's iridescence_fragment) ──

const XYZ_TO_REC709 = mat3x3f(
    vec3f(3.2404542, -0.9692660, 0.0556434),
    vec3f(-1.5371385, 1.8760108, -0.2040259),
    vec3f(-0.4985314, 0.0415560, 1.0572252),
);

fn F_Schlick1(f0: f32, f90: f32, dotVH: f32) -> f32 {
    let fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
    return f0 * (1.0 - fresnel) + f90 * fresnel;
}

fn Fresnel0ToIor(f0: vec3f) -> vec3f {
    let s = sqrt(f0);
    return (vec3f(1.0) + s) / (vec3f(1.0) - s);
}

fn IorToFresnel0v(t: vec3f, i: f32) -> vec3f {
    let x = (t - vec3f(i)) / (t + vec3f(i));
    return x * x;
}

fn IorToFresnel0(t: f32, i: f32) -> f32 {
    return pow2((t - i) / (t + i));
}

fn evalSensitivity(OPD: f32, shift: vec3f) -> vec3f {
    let phase = 2.0 * PI * OPD * 1.0e-9;
    let val = vec3f(5.4856e-13, 4.4201e-13, 5.2481e-13);
    let pos = vec3f(1.6810e+06, 1.7953e+06, 2.2084e+06);
    let vr = vec3f(4.3278e+09, 9.3046e+09, 6.6121e+09);
    var xyz = val * sqrt(2.0 * PI * vr) * cos(pos * phase + shift) * exp(-pow2(phase) * vr);
    xyz.x += 9.7470e-14 * sqrt(2.0 * PI * 4.5282e+09) * cos(2.2399e+06 * phase + shift.x) * exp(-4.5282e+09 * pow2(phase));
    xyz /= 1.0685e-7;
    return XYZ_TO_REC709 * xyz;
}

fn evalIridescence(outsideIOR: f32, eta2: f32, cosTheta1: f32, thinFilmThickness: f32, baseF0: vec3f) -> vec3f {
    let iridescenceIOR = mix(outsideIOR, eta2, smoothstep(0.0, 0.03, thinFilmThickness));
    let sinTheta2Sq = pow2(outsideIOR / iridescenceIOR) * (1.0 - pow2(cosTheta1));
    let cosTheta2Sq = 1.0 - sinTheta2Sq;
    if (cosTheta2Sq < 0.0) {
        return vec3f(1.0);
    }
    let cosTheta2 = sqrt(cosTheta2Sq);
    let R0 = IorToFresnel0(iridescenceIOR, outsideIOR);
    let R12 = F_Schlick1(R0, 1.0, cosTheta1);
    let T121 = 1.0 - R12;
    var phi12 = 0.0;
    if (iridescenceIOR < outsideIOR) { phi12 = PI; }
    let phi21 = PI - phi12;
    let baseIOR = Fresnel0ToIor(clamp(baseF0, vec3f(0.0), vec3f(0.9999)));
    let R1 = IorToFresnel0v(baseIOR, iridescenceIOR);
    let R23 = F_Schlick(R1, 1.0, cosTheta2);
    let phi23 = select(vec3f(0.0), vec3f(PI), baseIOR < vec3f(iridescenceIOR));
    let OPD = 2.0 * iridescenceIOR * thinFilmThickness * cosTheta2;
    let phi = vec3f(phi21) + phi23;
    let R123 = clamp(R12 * R23, vec3f(1e-5), vec3f(0.9999));
    let r123 = sqrt(R123);
    let Rs = pow2(T121) * R23 / (vec3f(1.0) - R123);
    var I = R12 + Rs;
    var Cm = Rs - T121;
    for (var m = 1; m <= 2; m++) {
        Cm *= r123;
        let Sm = 2.0 * evalSensitivity(f32(m) * OPD, f32(m) * phi);
        I += Cm * Sm;
    }
    return max(I, vec3f(0.0));
}

fn Schlick_to_F0(f: vec3f, f90: f32, dotVH: f32) -> vec3f {
    let x = clamp(1.0 - dotVH, 0.0, 1.0);
    let x2 = x * x;
    let x5 = clamp(x * x2 * x2, 0.0, 0.9999);
    return (f - vec3f(f90) * x5) / (1.0 - x5);
}

struct Mat {
    diffuse: vec3f,
    roughness: f32,
    specular: vec3f,
    specular_f90: f32,
    clearcoat: f32,
    clearcoat_roughness: f32,
    anisotropic: bool,
    anisotropy: f32,
    alphaT: f32,
    anisotropyT: vec3f,
    anisotropyB: vec3f,
    iridescence: f32,
    iridescenceFresnel: vec3f,
};

fn BRDF_GGX(L: vec3f, V: vec3f, N: vec3f, m: Mat) -> vec3f {
    let alpha = pow2(m.roughness);
    let H = normalize(L + V);
    let dotNL = saturate(dot(N, L));
    let dotNV = saturate(dot(N, V));
    let dotNH = saturate(dot(N, H));
    let dotVH = saturate(dot(V, H));
    var F = F_Schlick(m.specular, m.specular_f90, dotVH);
    F = mix(F, m.iridescenceFresnel, m.iridescence);
    var Vis: f32;
    var D: f32;
    if (m.anisotropic) {
        let dotTL = dot(m.anisotropyT, L);
        let dotTV = dot(m.anisotropyT, V);
        let dotTH = dot(m.anisotropyT, H);
        let dotBL = dot(m.anisotropyB, L);
        let dotBV = dot(m.anisotropyB, V);
        let dotBH = dot(m.anisotropyB, H);
        Vis = V_GGX_SmithCorrelated_Anisotropic(m.alphaT, alpha, dotTV, dotBV, dotTL, dotBL, dotNV, dotNL);
        D = D_GGX_Anisotropic(m.alphaT, alpha, dotNH, dotTH, dotBH);
    } else {
        Vis = V_GGX_SmithCorrelated(alpha, dotNL, dotNV);
        D = D_GGX(alpha, dotNH);
    }
    return F * (Vis * D);
}

fn BRDF_GGX_Clearcoat(L: vec3f, V: vec3f, N: vec3f, m: Mat) -> vec3f {
    let alpha = pow2(m.clearcoat_roughness);
    let H = normalize(L + V);
    let dotNL = saturate(dot(N, L));
    let dotNV = saturate(dot(N, V));
    let dotNH = saturate(dot(N, H));
    let dotVH = saturate(dot(V, H));
    let F = F_Schlick(vec3f(0.04), 1.0, dotVH);
    return F * (V_GGX_SmithCorrelated(alpha, dotNL, dotNV) * D_GGX(alpha, dotNH));
}

// inverseTransformDirection(dir, viewMatrix): view → world, then three's envMapRotation (the scene's
// environmentRotation with its angles negated): a turn of −θ about y.
fn to_world(dir: vec3f) -> vec3f {
    let w = normalize((vec4f(dir, 0.0) * frame.view).xyz);
    let a = -frame.env.y;
    let c = cos(a);
    let s = sin(a);
    return vec3f(c * w.x + s * w.z, w.y, -s * w.x + c * w.z);
}

fn ibl_radiance(V: vec3f, N: vec3f, roughness: f32) -> vec3f {
    var r = reflect(-V, N);
    r = normalize(mix(r, N, roughness * roughness));
    return texture_cube_uv(env_atlas, env_sampler, to_world(r), roughness) * frame.env.x;
}

fn ibl_irradiance(N: vec3f) -> vec3f {
    return PI * texture_cube_uv(env_atlas, env_sampler, to_world(N), 1.0) * frame.env.x;
}

// Normal mapping without precomputed tangents (http://www.thetenthplanet.de/archives/1180).
fn tangent_frame(eye_pos: vec3f, N: vec3f, uv: vec2f) -> mat3x3f {
    let q0 = dpdx(eye_pos);
    let q1 = dfdy3(eye_pos);
    let st0 = dpdx(uv);
    let st1 = dfdy2(uv);
    let q1perp = cross(q1, N);
    let q0perp = cross(N, q0);
    let T = q1perp * st0.x + q0perp * st1.x;
    let B = q1perp * st0.y + q0perp * st1.y;
    let det = max(dot(T, T), dot(B, B));
    let scale = select(inverseSqrt(det), 0.0, det == 0.0);
    return mat3x3f(T * scale, B * scale, N);
}

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

// A sticker's colour look (decals.ts LOOK_PARS): corrections then tint, in display (sRGB) space.
fn decal_look(linear: vec3f) -> vec3f {
    let lc = max(linear, vec3f(0.0));
    var c = select(1.055 * pow(lc, vec3f(1.0 / 2.4)) - 0.055, lc * 12.92, lc < vec3f(0.0031308));
    let b = draw.look_adjust.x;
    c = mix(c, vec3f(step(0.0, b)), abs(b));
    let k = draw.look_adjust.y;
    c = (c - 0.5) * select(1.0 / (1.0 - 0.9 * k), 1.0 + k, k < 0.0) + 0.5;
    let W = vec3f(0.2126, 0.7152, 0.0722);
    c = mix(vec3f(dot(c, W)), c, 1.0 + draw.look_adjust.z);
    c = clamp(c, vec3f(0.0), vec3f(1.0));
    let l = dot(c, W);
    let duo = select(mix(draw.look_tint.rgb, vec3f(1.0), l * 2.0 - 1.0), draw.look_tint.rgb * (l * 2.0), l < 0.5);
    c = mix(c, duo, draw.look_tint.a);
    return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c < vec3f(0.04045));
}

fn srgb_oetf(c: vec3f) -> vec3f {
    return select(pow(c, vec3f(0.41666)) * 1.055 - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

// What the physical material computes before its outputs are combined (meshphysical.glsl up to
// `#include <transmission_fragment>`).
struct Lit {
    color: vec4f,          // diffuse colour × map (rgb), alpha
    unlit: bool,
    total_diffuse: vec3f,
    total_specular: vec3f,
    cc_specular: vec3f,
    clearcoat: f32,
    dotNVcc: f32,
    N: vec3f,              // view space
    V: vec3f,
    m: Mat,
    roughness_factor: f32,
    emissive: vec3f,
};

fn shade(in: VOut, front_facing: bool) -> Lit {
    var lit: Lit;
    let use_map = draw.flags.x > 0.5;
    let use_normal_map = draw.flags.y > 0.5;
    let use_roughness_map = draw.flags.z > 0.5;
    let use_bump = draw.flags.w > 0.5;
    let bump_scale = draw.aniso.w;
    let map_uv = in.uv * draw.maps.zw; // the surface maps' repeat (texture matrix)

    // Every texture read and derivative happens up front, in uniform control flow.
    let normal_texel = textureSample(normal_map, surface_sampler, map_uv);
    let rough_texel = textureSample(roughness_map, surface_sampler, map_uv);
    let color_texel = textureSample(color_map, map_sampler, draw.map_uv.xy + in.uv * draw.map_uv.zw);
    let duvdx = dpdx(in.uv);
    let duvdy = dfdy2(in.uv);
    let bump_0 = textureSample(bump_map, map_sampler, in.uv).x;
    let bump_x = textureSampleGrad(bump_map, map_sampler, in.uv + duvdx, duvdx, duvdy).x;
    let bump_y = textureSampleGrad(bump_map, map_sampler, in.uv + duvdy, duvdx, duvdy).x;
    let eye_pos = -in.view_position;
    let sigma_x = dpdx(eye_pos);
    let sigma_y = dfdy3(eye_pos);

    var diffuse_color = draw.color;
    if (use_map) { diffuse_color *= color_texel; }
    if (draw.look_adjust.w > 0.5) {
        diffuse_color = vec4f(decal_look(diffuse_color.rgb), diffuse_color.a);
    }
    lit.color = diffuse_color;
    lit.emissive = draw.emissive.rgb;
    lit.unlit = draw.flags2.w > 0.5;
    if (draw.flags2.y > 0.5) {
        // The chip's contacts: neutral grey (Rec. 709 luminance) after the map.
        diffuse_color = vec4f(vec3f(dot(diffuse_color.rgb, vec3f(0.2126, 0.7152, 0.0722))), diffuse_color.a);
    }

    var roughness_factor = draw.pbr.y;
    if (use_roughness_map) { roughness_factor *= rough_texel.g; }
    lit.roughness_factor = roughness_factor;

    // normal_fragment_begin / maps (DOUBLE_SIDED: faceDirection)
    var normal = normalize(in.normal);
    if (draw.spec.y > 0.5 && draw.spec.y < 1.5 && !front_facing) { normal = -normal; }
    // three's tangent frame follows the normal map's UVs, else the mesh UVs.
    var tbn = tangent_frame(eye_pos, normal, select(in.uv, map_uv, use_normal_map));
    // DOUBLE_SIDED: the tangent frame follows the face direction (as the normal did above).
    if (draw.spec.y > 0.5 && draw.spec.y < 1.5 && !front_facing) { tbn[0] = -tbn[0]; tbn[1] = -tbn[1]; }
    let non_perturbed = normal;
    let dxy = max(abs(dpdx(non_perturbed)), abs(dfdy3(non_perturbed)));
    if (use_normal_map) {
        var mapN = normal_texel.xyz * 2.0 - 1.0;
        mapN = vec3f(mapN.xy * draw.maps.xy, mapN.z);
        normal = normalize(tbn * mapN);
    } else if (use_bump) {
        // Bump map (red channel): perturbNormalArb(dHdxy_fwd()).
        let hll = bump_scale * bump_0;
        let dHdxy = vec2f(bump_scale * bump_x - hll, bump_scale * bump_y - hll);
        let vSigmaX = normalize(sigma_x);
        let vSigmaY = normalize(sigma_y);
        let R1 = cross(vSigmaY, normal);
        let R2 = cross(normal, vSigmaX);
        let fDet = dot(vSigmaX, R1);
        let vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
        normal = normalize(abs(fDet) * normal - vGrad);
    }

    // lights_physical_fragment
    let metalness = draw.pbr.x;
    let specular_intensity = draw.spec.x;
    var m: Mat;
    m.diffuse = diffuse_color.rgb * (1.0 - metalness);
    let geometry_roughness = max(max(dxy.x, dxy.y), dxy.z);
    m.roughness = min(max(roughness_factor, 0.0525) + geometry_roughness, 1.0);
    m.specular = mix(vec3f(0.04 * specular_intensity), diffuse_color.rgb, metalness); // ior 1.5
    m.specular_f90 = mix(specular_intensity, 1.0, metalness);
    m.clearcoat = saturate(draw.pbr.z);
    m.clearcoat_roughness = min(max(draw.pbr.w, 0.0525) + geometry_roughness, 1.0);
    m.anisotropic = draw.aniso.x > 0.0;
    if (m.anisotropic) {
        var av = vec2f(cos(draw.aniso.y), sin(draw.aniso.y)) * draw.aniso.x;
        m.anisotropy = length(av);
        av /= m.anisotropy;
        m.anisotropy = saturate(m.anisotropy);
        m.alphaT = mix(pow2(m.roughness), 1.0, pow2(m.anisotropy));
        m.anisotropyT = tbn[0] * av.x + tbn[1] * av.y;
        m.anisotropyB = tbn[1] * av.x - tbn[0] * av.y;
    }

    let N = normal;
    let V = normalize(in.view_position);
    let Ncc = non_perturbed;

    // lights_fragment_begin: the thin-film Fresnel, when the material has iridescence.
    m.iridescence = 0.0;
    m.iridescenceFresnel = vec3f(0.0);
    if (draw.irid.x > 0.0 && draw.irid.z != 0.0) {
        m.iridescence = saturate(draw.irid.x);
        let dotNVi = saturate(dot(N, V));
        m.iridescenceFresnel = evalIridescence(1.0, draw.irid.y, dotNVi, draw.irid.z, m.specular);
    }

    // Direct light: the point lights (getPointLightInfo, getDistanceAttenuation), then the directional.
    var direct_specular = vec3f(0.0);
    var direct_diffuse = vec3f(0.0);
    var cc_specular = vec3f(0.0);
    for (var k = 0; k < i32(frame.misc.z); k++) {
        let p = frame.points[2 * k];
        let q = frame.points[2 * k + 1];
        let lv = p.xyz + in.view_position;
        let d = length(lv);
        var c = q.rgb / max(pow(d, q.w), 0.01);
        if (p.w > 0.0) { c *= pow2(saturate(1.0 - pow2(pow2(d / p.w)))); }
        let Lp = normalize(lv);
        let ip = saturate(dot(N, Lp)) * c;
        direct_specular += ip * BRDF_GGX(Lp, V, N, m);
        direct_diffuse += ip * RECIPROCAL_PI * m.diffuse;
        cc_specular += saturate(dot(Ncc, Lp)) * c * BRDF_GGX_Clearcoat(Lp, V, Ncc, m);
    }
    let L = frame.light_dir.xyz;
    let irr = saturate(dot(N, L)) * frame.light_color.rgb;
    direct_specular += irr * BRDF_GGX(L, V, N, m);
    direct_diffuse += irr * RECIPROCAL_PI * m.diffuse;
    cc_specular += saturate(dot(Ncc, L)) * frame.light_color.rgb * BRDF_GGX_Clearcoat(L, V, Ncc, m);
    if (frame.fill_color.w > 0.0) {
        let Lf = frame.fill_dir.xyz;
        let irf = saturate(dot(N, Lf)) * frame.fill_color.rgb;
        direct_specular += irf * BRDF_GGX(Lf, V, N, m);
        direct_diffuse += irf * RECIPROCAL_PI * m.diffuse;
        cc_specular += saturate(dot(Ncc, Lf)) * frame.fill_color.rgb * BRDF_GGX_Clearcoat(Lf, V, Ncc, m);
    }

    // Indirect: ambient + IBL.
    let ibl_irr = ibl_irradiance(N);
    var radiance: vec3f;
    if (m.anisotropic) {
        var bent = cross(m.anisotropyB, V);
        bent = normalize(cross(bent, m.anisotropyB));
        bent = normalize(mix(bent, N, pow2(pow2(1.0 - m.anisotropy * (1.0 - m.roughness)))));
        radiance = ibl_radiance(V, bent, m.roughness);
    } else {
        radiance = ibl_radiance(V, N, m.roughness);
    }
    let cc_radiance = ibl_radiance(V, Ncc, m.clearcoat_roughness);
    var indirect_diffuse = frame.ambient.rgb * RECIPROCAL_PI * m.diffuse;

    let cc_fab = DFGApprox(Ncc, V, m.clearcoat_roughness);
    cc_specular += cc_radiance * (vec3f(0.04) * cc_fab.x + cc_fab.y);

    let fab = DFGApprox(N, V, m.roughness);
    // computeMultiscatteringIridescence passes the iridescence Fresnel as its "F0" (three r180).
    let Fr = mix(m.specular, m.iridescenceFresnel, m.iridescence);
    let FssEss = Fr * fab.x + m.specular_f90 * fab.y;
    let Ess = fab.x + fab.y;
    let Ems = 1.0 - Ess;
    let Favg = Fr + (1.0 - Fr) * 0.047619;
    let Fms = FssEss * Favg / (1.0 - Ems * Favg);
    let multi = Fms * Ems;
    let total = FssEss + multi;
    let diffuse_ms = m.diffuse * (1.0 - max(max(total.r, total.g), total.b));
    let cos_irr = ibl_irr * RECIPROCAL_PI;
    let indirect_specular = radiance * FssEss + multi * cos_irr;
    indirect_diffuse += diffuse_ms * cos_irr;

    lit.total_diffuse = direct_diffuse + indirect_diffuse;
    lit.total_specular = direct_specular + indirect_specular;
    lit.cc_specular = cc_specular;
    lit.clearcoat = m.clearcoat;
    lit.dotNVcc = saturate(dot(Ncc, V));
    lit.N = N;
    lit.V = V;
    lit.m = m;
    return lit;
}

// The output: ACES and the sRGB transfer for the canvas; linear for the glass's buffer passes (three
// renders those with NoToneMapping into a linear half-float target).
fn finish(c: vec3f, alpha: f32) -> vec4f {
    if (frame.misc.y > 0.5) { return vec4f(c, alpha); }
    return vec4f(srgb_oetf(aces(c)), alpha);
}

// outgoingLight + the clearcoat layer (meshphysical.glsl after the transmission).
fn combine(lit: Lit, total_diffuse: vec3f, total_specular: vec3f) -> vec3f {
    var outgoing = total_diffuse + total_specular + lit.emissive;
    let Fcc = F_Schlick(vec3f(0.04), 1.0, lit.dotNVcc);
    return outgoing * (1.0 - lit.clearcoat * Fcc) + lit.cc_specular * lit.clearcoat;
}

@fragment
fn fs_main(in: VOut, @builtin(front_facing) front_facing: bool) -> @location(0) vec4f {
    let lit = shade(in, front_facing);
    if (lit.unlit) {
        // MeshBasicMaterial: the colour as authored (tone mapped unless toneMapped is false).
        if (lit.color.a < draw.aniso.z) { discard; }
        let a = select(1.0, lit.color.a, draw.flags2.x > 0.5);
        if (draw.flags2.z > 0.5) { return finish(lit.color.rgb, a); }
        if (frame.misc.y > 0.5) { return vec4f(lit.color.rgb, a); }
        return vec4f(srgb_oetf(lit.color.rgb), a);
    }
    let outgoing = combine(lit, lit.total_diffuse, lit.total_specular);
    let alpha = select(1.0, lit.color.a, draw.flags2.x > 0.5);
    if (lit.color.a < draw.aniso.z) { discard; }
    return finish(outgoing, alpha);
}

// ── glass (drei's MeshTransmissionMaterial, scene/transmission-material.ts) ─────────────────────────

struct Glass {
    model: mat4x4f,
    camera: vec4f,   // world camera position
    params: vec4f,   // thickness, ior, chromaticAberration, anisotropicBlur
    params2: vec4f,  // smear, distortion, distortionScale, temporalDistortion
    params3: vec4f,  // time, samples, edge absorption, edge specular
    viewport: vec4f, // framebuffer height (GL's gl_FragCoord runs up), transmission
};
@group(2) @binding(0) var<uniform> glass: Glass;
@group(2) @binding(1) var transmission_buffer: texture_2d<f32>;
@group(2) @binding(2) var transmission_sampler: sampler;

@vertex
fn vs_glass(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> VOut {
    var o = vertex(position, normal, uv);
    o.world_position = (glass.model * vec4f(position, 1.0)).xyz;
    return o;
}

fn random3(c: vec3f) -> vec3f {
    var j = 4096.0 * sin(dot(c, vec3f(17.0, 59.4, 15.0)));
    var r: vec3f;
    r.z = fract(512.0 * j);
    j *= 0.125;
    r.x = fract(512.0 * j);
    j *= 0.125;
    r.y = fract(512.0 * j);
    return r - 0.5;
}

fn hash1(x_in: u32) -> u32 {
    var x = x_in;
    x += (x << 10u);
    x ^= (x >> 6u);
    x += (x << 3u);
    x ^= (x >> 11u);
    x += (x << 15u);
    return x;
}
fn hash3(v: vec3u) -> u32 { return hash1(v.x ^ hash1(v.y) ^ hash1(v.z)); }

// A float in [0, 1) from the low 23 bits.
fn float_construct(m_in: u32) -> f32 {
    var m = m_in & 0x007FFFFFu;
    m |= 0x3F800000u;
    return bitcast<f32>(m) - 1.0;
}

fn rand(frag: vec2f, seed: f32) -> f32 { return float_construct(hash3(bitcast<vec3u>(vec3f(frag, seed)))); }

const F3: f32 = 0.3333333;
const G3: f32 = 0.1666667;

fn snoise(p: vec3f) -> f32 {
    let s = floor(p + dot(p, vec3f(F3)));
    let x = p - s + dot(s, vec3f(G3));
    let e = step(vec3f(0.0), x - x.yzx);
    let i1 = e * (1.0 - e.zxy);
    let i2 = 1.0 - e.zxy * (1.0 - e);
    let x1 = x - i1 + G3;
    let x2 = x - i2 + 2.0 * G3;
    let x3 = x - 1.0 + 3.0 * G3;
    var w = vec4f(dot(x, x), dot(x1, x1), dot(x2, x2), dot(x3, x3));
    w = max(0.6 - w, vec4f(0.0));
    var d = vec4f(dot(random3(s), x), dot(random3(s + i1), x1), dot(random3(s + i2), x2), dot(random3(s + 1.0), x3));
    w *= w;
    w *= w;
    d *= w;
    return dot(d, vec4f(52.0));
}

fn snoise_fractal(m: vec3f) -> f32 {
    return 0.5333333 * snoise(m) + 0.2666667 * snoise(2.0 * m) + 0.1333333 * snoise(4.0 * m) + 0.0666667 * snoise(8.0 * m);
}

// getIBLVolumeRefraction, sampling the private buffer (no LOD) at the refracted ray's exit.
fn volume_refraction(n: vec3f, v: vec3f, roughness: f32, diffuse: vec3f, specular: vec3f, specular_f90: f32, position: vec3f, ior: f32, thickness: f32) -> vec4f {
    let refraction = refract(-v, normalize(n), 1.0 / ior);
    let model_scale = vec3f(length(glass.model[0].xyz), length(glass.model[1].xyz), length(glass.model[2].xyz));
    let ray = normalize(refraction) * thickness * model_scale;
    let exit = position + ray;
    let ndc = frame.proj * frame.view * vec4f(exit, 1.0);
    // GL's texture coordinates run up; the buffer's rows run down.
    let coords = (ndc.xy / ndc.w + 1.0) / 2.0;
    let light = textureSampleLevel(transmission_buffer, transmission_sampler, vec2f(coords.x, 1.0 - coords.y), 0.0);
    let fab = DFGApprox(n, v, roughness);
    let F = specular * fab.x + specular_f90 * fab.y; // EnvironmentBRDF
    return vec4f((1.0 - F) * light.rgb * diffuse, light.a);
}

@fragment
fn fs_glass(in: VOut, @builtin(front_facing) front_facing: bool) -> @location(0) vec4f {
    let lit = shade(in, front_facing);
    let m = lit.m;
    let thickness = glass.params.x;
    let ior = glass.params.y;
    let chromatic = glass.params.z;
    let anisotropic_blur = glass.params.w;
    let smear = glass.params2.x;
    let distortion = glass.params2.y;
    let distortion_scale = glass.params2.z;
    let temporal = glass.params2.w;
    let time = glass.params3.x;
    let samples = glass.params3.y;
    // GL's gl_FragCoord (origin bottom-left) seeds drei's per-pixel randoms.
    let frag = vec2f(in.pos.x, glass.viewport.x - in.pos.y);

    let pos = in.world_position;
    var seed = 0.0;
    let v = normalize(glass.camera.xyz - pos);
    let n = normalize((vec4f(lit.N, 0.0) * frame.view).xyz); // inverseTransformDirection(normal, viewMatrix)
    var transmission = vec3f(0.0);
    let random_coords = rand(frag, seed);
    seed += 1.0;
    let thickness_smear = smear * thickness * max(pow(lit.roughness_factor, 0.33), anisotropic_blur);
    var distortion_normal = vec3f(0.0);
    let temporal_offset = vec3f(time, -time, -time) * temporal;
    if (distortion > 0.0) {
        distortion_normal = distortion * vec3f(
            snoise_fractal(pos * distortion_scale + temporal_offset),
            snoise_fractal(pos.zxy * distortion_scale - temporal_offset),
            snoise_fractal(pos.yxz * distortion_scale + temporal_offset));
    }
    for (var i = 0.0; i < samples; i += 1.0) {
        let r0 = rand(frag, seed);
        let r1 = rand(frag, seed + 1.0);
        let r2 = rand(frag, seed + 2.0);
        let r3 = rand(frag, seed + 3.0);
        seed += 4.0;
        let sample_norm = normalize(n + lit.roughness_factor * lit.roughness_factor * 2.0 * normalize(vec3f(r0 - 0.5, r1 - 0.5, r2 - 0.5)) * pow(r3, 0.33) + distortion_normal);
        let k = (i + random_coords) / samples;
        let th = thickness + thickness_smear * k;
        transmission.r += volume_refraction(sample_norm, v, m.roughness, m.diffuse, m.specular, m.specular_f90, pos, ior, th).r;
        transmission.g += volume_refraction(sample_norm, v, m.roughness, m.diffuse, m.specular, m.specular_f90, pos, ior * (1.0 + chromatic * k), th).g;
        transmission.b += volume_refraction(sample_norm, v, m.roughness, m.diffuse, m.specular, m.specular_f90, pos, ior * (1.0 + 2.0 * chromatic * k), th).b;
    }
    transmission /= samples;
    var total_diffuse = mix(lit.total_diffuse, transmission, glass.viewport.y);
    var total_specular = lit.total_specular;
    // addGlassEdges: where the surface turns away from the faces, light runs along the slab.
    let edge = smoothstep(0.15, 0.9, 1.0 - abs(dot(normalize(n), normalize(glass.model[2].xyz))));
    total_diffuse *= mix(vec3f(1.0), pow(max(lit.color.rgb, vec3f(1e-3)), vec3f(glass.params3.z)), edge);
    total_specular *= 1.0 + glass.params3.w * edge;
    return finish(combine(lit, total_diffuse, total_specular), 1.0);
}
