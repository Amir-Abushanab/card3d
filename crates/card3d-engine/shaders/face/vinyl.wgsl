// vinyl (library/finishes.glsl.ts): a spinning record with fine grooves, a paper label and a tilt-following sheen.
fn mainImage(uv: vec2f) -> vec4f {
    let d = facePos - (uCenter - 0.5) * vec2f(uAspect, 1.0);
    let r = length(d) / uRadius;
    let aa = fwidth(r);
    if (r > 1.0 + 2.0 * aa) { return vec4f(0.0); }
    let spin = uTime * uSpin / 60.0 * TAU;
    let a = atan2(d.y, d.x);

    // grooves: fine rings with a slightly random depth per turn
    let g = r * uGrooves;
    let groove = 0.5 + 0.5 * cos(TAU * g);
    let turn = hash12(vec2f(floor(g), 7.0));
    var col = uVinylColor * (0.8 + 0.35 * groove * (0.6 + 0.4 * turn));
    // smooth run-in / run-out bands
    let land = smoothstep(0.93, 0.95, r) + (1.0 - smoothstep(uLabelSize + 0.03, uLabelSize + 0.05, r));
    col = mix(col, uVinylColor * 1.15, vec3f(clamp(land, 0.0, 1.0)));

    // anisotropic sheen: two bright spokes facing the light, which swings with the view
    let tilt = select(uTilt.xy, viewDir.xy, uOverlay > 0.5);
    let light = 0.7 + 2.5 * tilt.x - 1.5 * tilt.y;
    let spoke = pow(abs(cos(a - light)), 18.0) * smoothstep(uLabelSize, uLabelSize + 0.08, r);
    col += uSheen * spoke * vec3f(0.55, 0.56, 0.58) * (0.6 + 0.4 * groove);

    // label (rotates with the record), with a band and a ring
    let ld = rotate(d / uRadius, -spin);
    let label = 1.0 - smoothstep(uLabelSize - aa, uLabelSize + aa, r);
    var lab = mix(uLabelColor, uBandColor, vec3f(step(abs(ld.y), uLabelSize * 0.2)));
    lab *= 1.0 - 0.6 * (1.0 - smoothstep(0.0, 2.0 * aa, abs(r - uLabelSize * 0.9)));
    col = mix(col, lab, vec3f(label));
    // spindle hole
    col = mix(col, vec3f(0.04), vec3f(1.0 - smoothstep(0.03 - aa, 0.03 + aa, r)));
    return vec4f(col, 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r));
}
