// wood (library/finishes.glsl.ts): warped growth rings, figure and pore streaks along the grain.
fn mainImage(uv: vec2f) -> vec4f {
    let p = rotate(cardUv * vec2f(uAspect, 1.0), radians(uAngle)) * uScale + vec2f(uSeed * 1.37, uSeed * 0.71);
    // gentle large-scale waviness of the grain, plus a slower cathedral swell
    let w = (fbm(p * vec2f(0.5, 1.6)) - 0.5) * uFigure;
    let y = p.y + 0.22 * w + 0.05 * uFigure * sin(1.7 * p.x + 4.0 * w);
    let rings = y * uRings;
    let f = fract(rings + 0.3 * noise(vec2f(p.x * 2.0, floor(rings))));
    // gradual earlywood to sharp-edged latewood band
    let late = smoothstep(0.45, 0.85, f) * (1.0 - smoothstep(0.9, 0.99, f));
    let streak = fbm(vec2f(p.x * 0.7, y * 42.0));
    var col = mix(uLightColor, uDarkColor, vec3f(clamp(0.6 * late + 0.55 * (streak - 0.45), 0.0, 1.0)));
    // pores: short dark dashes along the grain
    let pores = smoothstep(0.7, 0.92, noise(vec2f(p.x * 9.0, y * 220.0))) * uPores;
    col *= 1.0 - 0.3 * pores;
    col *= 0.93 + 0.1 * noise(p * vec2f(0.8, 3.0));
    return vec4f(col, 1.0);
}
