// foil-flakes (library/originals.glsl.ts): metallic flakes that catch the light one by one as the card tilts.
fn mainImage(uv: vec2f) -> vec4f {
    let px = uv * uResolution / uFlakeSize;
    let cell = floor(px);
    let h = hash22(cell);
    let jitter = hash22(cell + vec2f(31.7)) - 0.5;
    let n = normalize(vec3f((h - 0.5) * 2.0 * uSpread, 1.0));
    let v = select(normalize(vec3f(1.5 * uTilt.xy, 1.0)), viewDir, uOverlay > 0.5);
    let l = normalize(vec3f(-0.35, 0.55, 1.0));
    let spec = pow(max(dot(reflect(-l, n), v), 0.0), uSharpness);
    let shape = 1.0 - smoothstep(0.18, 0.42, length(fract(px) - 0.5 - 0.25 * jitter));
    let tw = mix(1.0, 0.5 + 0.5 * sin(uTime * 3.0 + h.x * TAU), clamp(uTwinkle, 0.0, 1.0));
    let flake = spec * shape * tw * uAmount * (1.0 + uTwinkle);
    let grain = hash12(floor(uv * uResolution) + floor(uTime * 12.0 * step(0.001, uTwinkle))) * uGrain;
    return vec4f(uTint * clamp(flake * 2.5 + grain, 0.0, 1.0), 1.0);
}
