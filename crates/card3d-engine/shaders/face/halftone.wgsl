// halftone (library/originals.glsl.ts; the `source` param's uniform is uHalftoneSource, as the prelude's texture is uSource): print-style dot screen of the artwork (or a gradient).
fn halftoneTone(suv: vec2f) -> f32 {
    if (uHalftoneSource == 0 && uHasArtwork > 0.5) {
        let a = artwork(clamp(suv, vec2f(0.0), vec2f(1.0)));
        return mix(1.0, luma(a.rgb), a.a);
    }
    if (uHalftoneSource == 2) { return smoothstep(0.0, 0.85, length((suv - vec2f(0.3, 0.65)) * vec2f(uAspect, 1.0))); }
    return clamp(0.15 + 0.85 * suv.x, 0.0, 1.0);
}

fn mainImage(uv: vec2f) -> vec4f {
    let k = uResolution.y / uCellSize;
    let ang = radians(uAngle);
    let g = rotate(facePos * k, ang);
    let cell = floor(g) + 0.5;
    let suv = rotate(cell, -ang) / k / vec2f(uAspect, 1.0) + 0.5;
    var tone = halftoneTone(suv);
    if (uInvert) { tone = 1.0 - tone; }
    let dark = clamp((0.5 - tone) * uContrast + 0.5, 0.0, 1.0);
    let r = 0.72 * sqrt(dark);
    let d = length(g - cell);
    let aa = max(fwidth(d), 1e-4);
    let dotMask = 1.0 - smoothstep(r - aa, r + aa, d);
    return vec4f(uInk, dotMask);
}
