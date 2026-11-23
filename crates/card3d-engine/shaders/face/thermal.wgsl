// thermal (library/thermal.glsl.ts): isotherm lines over a heat map that drifts and flows with the tilt.
fn thermalPool(P: vec2f, c: vec2f, s: vec2f) -> f32 {
    let d = (P - c) / s;
    return exp(-2.0 * dot(d, d));
}

fn mainImage(uv: vec2f) -> vec4f {
    // top-origin v; the back is mirrored so motion stays in card space.
    let back = uSide;
    let u = cardUv.x;
    let v = 1.0 - uv.y;

    // chip SDF in metric card space.
    let metric = vec2f(uAspect, 1.0);
    let local = (vec2f(u, v) - uChip.xy) * metric;
    let hs = uChip.zw * metric;
    let radius = 0.22 * min(hs.x, hs.y);
    let q = abs(local) - hs + radius;
    let chipD = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
    let nearest = clamp(local, -hs + radius, hs - radius);
    let outward = normalize(local - nearest + 1e-5);
    let clr = max(back, 1.0 - select(0.0, 1.0, uAvoidChip));
    let obstacle = (1.0 - clr) * (1.0 - smoothstep(0.01, 0.21, chipD));

    // flow, with the component into the chip removed.
    let ph = uPhase + uSpeed * uTime;
    var P = (vec2f(u, v) - 0.5) * metric / uScale;
    let fl = uTilt.xy * vec2f(0.28, -0.24) * uFlowStrength;
    P -= fl - outward * dot(fl, outward) * obstacle;

    // advection.
    P += 0.115 * uTurbulence * vec2f(sin(5.6 * P.y + sin(3.7 * P.x) + ph), cos(4.8 * P.x - sin(4.1 * P.y) - 0.7 * ph));
    P += 0.018 * uTurbulence * vec2f(sin(12.0 * P.y + ph), cos(10.0 * P.x - ph));
    P += uTilt.zw * 0.045 * uFlowStrength * sin(5.0 * vec2f(P.y, P.x) + ph);

    // heat.
    var heat = 1.1 * thermalPool(P, vec2f(-0.23, -0.21), vec2f(0.62, 0.48))
             + 0.96 * thermalPool(P, vec2f(0.50, 0.28), vec2f(0.52, 0.39))
             - 0.47 * thermalPool(P, vec2f(-0.17, -0.15), vec2f(0.23, 0.18));
    heat = smoothstep(0.20, 1.0, clamp(heat, 0.0, 1.0));
    heat *= mix(smoothstep(0.012, 0.115, chipD), 1.0, clr);

    // isotherms.
    let L = uContours * heat;
    let e = abs(fract(L + 0.5) - 0.5);
    let aa = max(fwidth(L), 0.002);
    let line = (1.0 - smoothstep(0.4 * aa, 1.2 * aa, e)) * smoothstep(0.12, 0.24, heat) * (1.0 - smoothstep(0.95, 1.0, heat));

    // palette.
    let ink = uInk;
    var col = ink;
    col = mix(col, uColor1, vec3f(smoothstep(0.16, 0.30, heat)));
    col = mix(col, uColor2, vec3f(smoothstep(0.23, 0.42, heat)));
    col = mix(col, uColor3, vec3f(smoothstep(0.43, 0.64, heat)));
    col = mix(col, uColor4, vec3f(smoothstep(0.64, 0.82, heat)));
    col = mix(col, uColor5, vec3f(smoothstep(0.80, 1.00, heat)));
    col *= 1.0 - uLineDarkness * line;

    // quiet zones (front only).
    let logo = 1.0 - smoothstep(0.025, 0.17, distance(vec2f(u, v), vec2f(0.10, 0.14)));
    let name = (1.0 - smoothstep(0.52, 0.68, u)) * smoothstep(0.69, 0.85, v);
    col = mix(col, ink, vec3f(max(logo, name) * uQuiet * (1.0 - back)));

    return vec4f(col, 1.0);
}
