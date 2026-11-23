// caustics (library/water.glsl.ts): rippling water over a tiled floor (or the artwork), with tilt-stirred caustics.

// Drifting sine waves, advected by flow; energy adds faster chop (card units, ~0.01 tall).
fn waterWaves(q: vec2f, t: f32, flow: vec2f, energy: f32) -> f32 {
    let w = q + 0.12 * vec2f(sin(4.1 * q.y + 0.25 * t), cos(3.7 * q.x - 0.22 * t)) + 0.055 * flow;
    return 0.0055 * sin(dot(w, vec2f(8.4, 5.7)) + 0.72 * t)
         + 0.0038 * sin(dot(w, vec2f(-5.7, 11.2)) - 0.63 * t)
         + 0.0022 * sin(dot(w, vec2f(17.1, -8.3)) + sin(6.0 * w.y - 0.38 * t) + 0.52 * t)
         + 0.00085 * sin(dot(w, vec2f(24.0, 18.0)) - 1.07 * t)
         + energy * (0.0035 * sin(dot(w, vec2f(15.0, 9.0)) - 2.2 * t + 4.0 * flow.x)
                   + 0.002 * sin(dot(w, vec2f(-9.0, 17.0)) + 1.7 * t + 3.0 * flow.y));
}

// Square tiles at `scale` per unit with grout lines and a per-tile tint; y shades the water depth.
fn waterTiles(fp: vec2f, y: f32, scale: f32, deep: vec3f, shallow: vec3f, groutColor: vec3f) -> vec3f {
    let T = scale * fp;
    let ft = fract(T);
    let edge = min(min(ft.x, 1.0 - ft.x), min(ft.y, 1.0 - ft.y));
    let grout = 1.0 - smoothstep(0.009, 0.038, edge);
    let tint = (hash22(floor(T)).x - 0.5) * 0.013;
    return mix(deep, shallow, vec3f(0.56 + 0.08 * sin(1.8 * y + 0.4) + tint)) - grout * groutColor + tint;
}

// Slow caustic-ish swell on the floor, about -1..1.
fn waterSwell(fp: vec2f, t: f32) -> f32 {
    let swell = sin(dot(fp, vec2f(7.1, 4.3)) + 0.34 * t + sin(5.0 * fp.y - 0.22 * t));
    let crs = sin(dot(fp, vec2f(-4.2, 9.1)) - 0.29 * t + sin(4.0 * fp.x + 0.18 * t));
    return 0.55 * swell + 0.45 * crs;
}

fn causticsHeight(q: vec2f, t: f32, flow: vec2f, energy: f32) -> f32 {
    return waterWaves(q, t, flow, energy) * uWaveHeight;
}

fn mainImage(uv: vec2f) -> vec4f {
    let t = uTime * uSpeed;
    let q = facePos / uScale;
    let flow = uTilt.xy * 2.0 * uFlowStrength;
    let energy = clamp(length(uTilt.zw), 0.0, 1.0) * uFlowStrength;

    const e: f32 = 0.0035;
    let grad = vec2f(causticsHeight(q + vec2f(e, 0.0), t, flow, energy) - causticsHeight(q - vec2f(e, 0.0), t, flow, energy),
                     causticsHeight(q + vec2f(0.0, e), t, flow, energy) - causticsHeight(q - vec2f(0.0, e), t, flow, energy)) / (2.0 * e);

    // refraction: the floor seen through the sloped surface, with tilt parallax
    let fp = q + uDepth * (0.6 * grad + 0.08 * uTilt.xy);

    // floor
    let deep = uDeepColor;
    let shallow = uShallowColor;
    var floorCol: vec3f;
    if (uFloor == 1 && uHasArtwork > 0.5) {
        let fuv = clamp(fp * uScale / vec2f(uAspect, 1.0) + 0.5, vec2f(0.0), vec2f(1.0));
        let art = artwork(fuv);
        floorCol = mix(mix(deep, shallow, vec3f(0.6)), art.rgb, vec3f(art.a)) * mix(vec3f(1.0), shallow * 1.2, vec3f(0.35));
    } else if (uFloor == 2) {
        floorCol = mix(uBaseColor, shallow, vec3f(0.35));
    } else {
        floorCol = waterTiles(fp, q.y, uTileScale, deep, shallow, vec3f(0.0125, 0.032, 0.036) * 4.0);
    }
    floorCol += vec3f(0.004, 0.012, 0.014) * 3.0 * waterSwell(fp, t);

    // caustics: light focused by the surface = inverse area change of the refracted grid
    let lp = q + uDepth * 1.5 * grad;
    let j0 = abs(dpdx(q).x * dpdy(q).y - dpdx(q).y * dpdy(q).x);
    let j1 = abs(dpdx(lp).x * dpdy(lp).y - dpdx(lp).y * dpdy(lp).x);
    let focus = clamp(j0 / max(j1, 1e-12), 0.0, 6.0);
    let caustic = smoothstep(1.25, 3.2, focus);
    floorCol += uCausticColor * caustic * uCaustics;

    // surface highlight
    let N = normalize(vec3f(-1.9 * grad, 1.0));
    let L = normalize(vec3f(-0.38, 0.52, 0.95));
    let V = normalize(vec3f(uTilt.xy * 0.6, 1.0));
    let nh = max(0.0, dot(N, normalize(L + V)));
    var col = floorCol + vec3f(0.25, 0.44, 0.49) * 0.35 * pow(nh, 76.0) * uCaustics;

    // keep the chip seat calm
    col = mix(mix(deep, shallow, vec3f(0.5)), col, vec3f(smoothstep(0.0, 0.05, chipDistance(uv))));
    return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
