// scanlines (library/originals.glsl.ts): CRT-style scanlines with a slow rolling glow band.
fn mainImage(uv: vec2f) -> vec4f {
    let y = uv.y * uLines;
    let aa = clamp(fwidth(y), 0.0, 1.0);
    let line = 0.5 + 0.5 * cos(TAU * y) * (1.0 - aa);
    // (x / 0.07)² as a product: pow is undefined for the negative half of the band (x < 0).
    let bx = (fract(uv.y - uTime * uSpeed) - 0.5) / 0.07;
    let band = exp(-bx * bx);
    let lineA = uIntensity * (1.0 - line);
    let glowA = uGlow * band * (0.6 + 0.4 * line);
    let col = mix(uLineColor, uGlowColor, glowA / max(lineA + glowA, 1e-4));
    return vec4f(col, clamp(lineA + glowA, 0.0, 1.0));
}
