// gradient-mesh (library/originals.glsl.ts): four colours drifting into a soft, warped mesh gradient.
fn mainImage(uv: vec2f) -> vec4f {
    let t = uTime * uSpeed;
    let q = uv + 0.12 * uWarp * (vec2f(noise(uv * 2.5 + 0.3 * t), noise(uv * 2.5 + 7.1 - 0.27 * t)) - 0.5) * 2.0;
    var P: array<vec2f, 4>;
    P[0] = vec2f(0.18, 0.78) + 0.16 * vec2f(sin(0.61 * t), cos(0.53 * t));
    P[1] = vec2f(0.82, 0.80) + 0.16 * vec2f(cos(0.47 * t + 1.0), sin(0.71 * t));
    P[2] = vec2f(0.22, 0.18) + 0.16 * vec2f(cos(0.57 * t + 2.0), sin(0.43 * t + 1.0));
    P[3] = vec2f(0.80, 0.22) + 0.16 * vec2f(sin(0.39 * t + 3.0), cos(0.66 * t + 2.0));
    var C: array<vec3f, 4>;
    C[0] = srgbToLinear(uColorA);
    C[1] = srgbToLinear(uColorB);
    C[2] = srgbToLinear(uColorC);
    C[3] = srgbToLinear(uColorD);
    var sum = vec3f(0.0);
    var wsum = 0.0;
    for (var i = 0; i < 4; i++) {
        let d = (q - P[i]) * vec2f(uAspect, 1.0);
        let w = 1.0 / pow(dot(d, d) + 0.02, 1.5 / uSoftness);
        sum += C[i] * w;
        wsum += w;
    }
    var col = linearToSrgb(sum / wsum);
    col += (hash12(uv * uResolution + fract(t) * 91.0) - 0.5) * uGrain;
    return vec4f(col, 1.0);
}
