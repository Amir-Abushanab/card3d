// lens (library/lens.glsl.ts): view-responsive multilayer lens glass; scene-linear output.
fn lensGauss(x: f32, w: f32) -> f32 { return exp(-(x * x) / (w * w)); }
// x². The GLSL's even powers of signed values (pow(x, 2.0), pow(x, 6.0)) are written as x * x and
// pow(|x|, 6.0): WGSL's pow, like GLSL's, is undefined for x < 0. GPUs fold the constant even exponent
// into multiplies, but lavapipe (llvmpipe) takes exp2(6 log2 x), a NaN that blacked out all of the lens
// but the softbox's one quadrant where both bases are positive.
fn lensSq(x: f32) -> f32 { return x * x; }

fn lensGlass(p: vec2f, tilt: vec2f, facing: f32, coating: vec3f, glint: f32) -> vec3f {
    let r = length(p);
    var col = vec3f(0.008, 0.009, 0.016);
    let upper = normalize(vec2f(-0.68, 0.73) + 0.55 * tilt);
    let lower = normalize(vec2f(0.60, -0.80) - 0.35 * tilt);

    // coated rings
    for (var k = 0; k < 5; k++) {
        let i = f32(k);
        let R = 0.96 - 0.153 * i;
        let q = p - tilt * (0.09 + 0.025 * i);
        let rho = length(q);
        let rad = q / max(rho, 1e-4);
        let band = smoothstep(R - 0.151, R - 0.134, rho) * (1.0 - smoothstep(R - 0.007, R, rho));
        let edge = lensGauss(rho - (R - 0.005), 0.003);
        let up = pow(max(0.0, dot(rad, upper)), 7.0);
        let lo = pow(max(0.0, dot(rad, lower)), 9.0);
        let depth = 1.0 - 0.13 * i;
        let lowD = exp(-lensSq((i - 2.0) / 1.45));
        let sh = 0.45 + 0.55 * smoothstep(R - 0.15, R - 0.02, rho);
        let rose = mix(vec3f(0.40, 0.10, 0.27), vec3f(0.25, 0.055, 0.45), vec3f(i / 4.0)) * coating;
        let violet = mix(vec3f(0.36, 0.14, 0.36), vec3f(0.20, 0.09, 0.42), vec3f(i / 4.0)) * coating;
        col += band * sh * depth * (rose * up + 1.65 * violet * lo * lowD)
             + band * vec3f(0.010, 0.009, 0.018) * depth
             + edge * (0.10 + up + lo) * 0.50 * vec3f(0.027, 0.025, 0.042);
    }

    // softbox reflection
    let f = p - 0.30 * tilt;
    col += vec3f(0.095, 0.040, 0.14) * exp(-pow(abs(f.x + 0.38) / 0.35, 6.0) - pow(abs(f.y - 0.48) / 0.15, 6.0)) * smoothstep(0.25, 0.5, r);

    // pupil
    col *= mix(0.20, 1.0, smoothstep(0.16, 0.37, length(p - 0.24 * tilt)));
    col += vec3f(0.008, 0.009, 0.012) * (1.0 - smoothstep(0.1, 0.26, r));

    // glint
    let c = vec2f(0.61, 0.60) - 0.52 * tilt;
    let d = p - c;
    let diag = vec2f(0.7071 * (d.x + d.y), 0.7071 * (d.y - d.x));
    let d2 = dot(d, d);
    let core = exp(-d2 / 0.00030);
    let halo = exp(-d2 / 0.008);
    let ray = lensGauss(diag.y, 0.0035) * lensGauss(diag.x, 0.29) + 0.60 * lensGauss(diag.x, 0.003) * lensGauss(diag.y, 0.14);
    col += glint * (0.55 + 0.45 * pow(facing, 4.0)) * (0.46 * vec3f(0.20, 0.47, 1.0) * halo + 0.85 * vec3f(0.55, 0.80, 1.0) * ray + 2.2 * vec3f(0.90, 0.97, 1.0) * core);

    // rim
    col *= 1.0 - smoothstep(0.965, 1.02, r);
    return col;
}

fn mainImage(uv: vec2f) -> vec4f {
    // lens space: unit radius, y down (as the camera's lens UVs)
    let centre = (uCenter - 0.5) * vec2f(uAspect, 1.0);
    let d = (facePos - centre) / uRadius;
    let p = vec2f(d.x, -d.y);
    let r = length(p);
    if (r > 1.03) { return vec4f(0.0); }
    // the eye direction in face space (y flipped to lens space); skins use the tilt spring
    let e = select(normalize(vec3f(uTilt.xy, 1.0)), viewDir, uOverlay > 0.5);
    let tilt = vec2f(e.x, -e.y) * uResponse;
    let facing = max(0.0, e.z);
    let col = lensGlass(p, tilt, facing, srgbToLinear(uCoating) * 2.0, uGlint) * uExposure;
    let alpha = 1.0 - smoothstep(0.985, 1.03, r);
    return vec4f(col, alpha);
}
