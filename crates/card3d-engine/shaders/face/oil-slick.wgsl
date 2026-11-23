// oil-slick (library/originals.glsl.ts): thin-film interference bands whose colours shift with the view.
fn mainImage(uv: vec2f) -> vec4f {
    let p = facePos * uScale;
    let t = uTime * uSpeed;
    let film = fbm(p * 1.3 + vec2f(0.0, 0.15 * t)) + 0.5 * fbm(rotate(p, 0.7) * 2.7 - vec2f(0.1 * t, 0.0));
    // overlays see the real view direction; skins approximate it from the tilt spring
    let v = select(normalize(vec3f(1.5 * uTilt.xy, 1.0)), viewDir, uOverlay > 0.5);
    let cosT = clamp(v.z, 0.0, 1.0);
    let path = uThickness * (0.4 + 2.0 * film) * mix(0.7, 1.0, cosT) + 0.6 * dot(v.xy, vec2f(0.8, 0.5)) + uHue;
    var col = 0.5 + 0.5 * cos(TAU * (path + vec3f(0.0, 0.33, 0.67)));
    col = clamp(mix(vec3f(luma(col)), col, uSaturation), vec3f(0.0), vec3f(1.0));
    let fres = pow(1.0 - cosT, 3.0);
    let a = uStrength * (0.55 + 0.45 * smoothstep(0.3, 1.0, film)) * (0.75 + 0.5 * fres);
    return vec4f(col, clamp(a, 0.0, 1.0));
}
