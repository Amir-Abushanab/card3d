// Paper Shaders' liquid metal (`@paper-design/shaders` 0.0.80, https://github.com/paper-design/shaders;
// Copyright 2026 Paper; Apache License 2.0, see THIRD_PARTY_NOTICES.md), ported from the GLSL vendored
// in the three.js engine's shaders/library/liquid-metal/paper.ts (now in the local archive,
// .archive/three-engine/packages/core/src/): the shared vertex shader (the parts the fragment reads)
// and the liquid-metal fragment, with the three chip-clearance patches of surface.ts.
//
// The pass draws ShaderMount's quad over the whole target. The quad is flipped vertically on its way
// out, so that row k of the target holds what GL's row k (counted from the bottom) holds: the texture
// then has GL's layout (sampled with the same uv as three's render target), and the fragment's
// position is GL's `gl_FragCoord` (derivatives included).
diagnostic(off, derivative_uniformity);

struct Paper {
    a: vec4f,          // u_resolution.xy, u_pixelRatio, u_imageAspectRatio
    b: vec4f,          // u_originX, u_originY, u_worldWidth, u_worldHeight
    c: vec4f,          // u_fit, u_scale, u_rotation (degrees), u_time
    d: vec4f,          // u_offsetX, u_offsetY, u_isImage, u_shape
    color_back: vec4f, // u_colorBack
    color_tint: vec4f, // u_colorTint
    e: vec4f,          // u_softness, u_repetition, u_shiftRed, u_shiftBlue
    f: vec4f,          // u_distortion, u_contour, u_angle, u_cardAspect
    chip: vec4f,       // u_chip
};

@group(0) @binding(0) var<uniform> u: Paper;
@group(0) @binding(1) var u_image: texture_2d<f32>;
@group(0) @binding(2) var u_image_sampler: sampler;

const PI: f32 = 3.14159265358979323846;

struct VOut {
    @builtin(position) position: vec4f,
    @location(0) objectUV: vec2f,
    @location(1) responsiveUV: vec2f,
    @location(2) responsiveBoxGivenSize: vec2f,
    @location(3) imageUV: vec2f,
};

fn getBoxSize(boxRatio: f32, givenBoxSize: vec2f) -> vec3f {
    var box = vec2f(0.0);
    // fit = none
    box.x = boxRatio * min(givenBoxSize.x / boxRatio, givenBoxSize.y);
    let noFitBoxWidth = box.x;
    if (u.c.x == 1.0) { // fit = contain
        box.x = boxRatio * min(u.a.x / boxRatio, u.a.y);
    } else if (u.c.x == 2.0) { // fit = cover
        box.x = boxRatio * max(u.a.x / boxRatio, u.a.y);
    }
    box.y = box.x / boxRatio;
    return vec3f(box, noFitBoxWidth);
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
    var quad = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    let a_position = vec4f(quad[i], 0.0, 1.0);
    let resolution = u.a.xy;
    let pixelRatio = u.a.z;
    let imageAspectRatio = u.a.w;
    let worldWidth = u.b.z;
    let worldHeight = u.b.w;
    let fit = u.c.x;
    let scale = u.c.y;
    var out: VOut;
    out.position = vec4f(a_position.x, -a_position.y, a_position.z, a_position.w);

    let uv = a_position.xy * 0.5;
    let boxOrigin = vec2f(0.5 - u.b.x, u.b.y - 0.5);
    var givenBoxSize = vec2f(worldWidth, worldHeight);
    givenBoxSize = max(givenBoxSize, vec2f(1.0)) * pixelRatio;
    let r = u.c.z * 3.14159265358979323846 / 180.0;
    let graphicRotation = mat2x2f(cos(r), sin(r), -sin(r), cos(r));
    let graphicOffset = vec2f(-u.d.x, u.d.y);

    let fixedRatio = 1.0;
    let fixedRatioBoxGivenSize = vec2f(select(givenBoxSize.x, resolution.x, worldWidth == 0.0), select(givenBoxSize.y, resolution.y, worldHeight == 0.0));
    let objectBoxSize = getBoxSize(fixedRatio, fixedRatioBoxGivenSize).xy;
    let objectWorldScale = resolution / objectBoxSize;

    var objectUV = uv;
    objectUV *= objectWorldScale;
    objectUV += boxOrigin * (objectWorldScale - 1.0);
    objectUV += graphicOffset;
    objectUV /= scale;
    objectUV = graphicRotation * objectUV;
    out.objectUV = objectUV;

    let responsiveBoxGivenSize = vec2f(select(givenBoxSize.x, resolution.x, worldWidth == 0.0), select(givenBoxSize.y, resolution.y, worldHeight == 0.0));
    let responsiveRatio = responsiveBoxGivenSize.x / responsiveBoxGivenSize.y;
    let responsiveBoxSize = getBoxSize(responsiveRatio, responsiveBoxGivenSize).xy;
    let responsiveBoxScale = resolution / responsiveBoxSize;
    var responsiveUV = uv;
    responsiveUV *= responsiveBoxScale;
    responsiveUV += boxOrigin * (responsiveBoxScale - 1.0);
    responsiveUV += graphicOffset;
    responsiveUV /= scale;
    responsiveUV.x *= responsiveRatio;
    responsiveUV = graphicRotation * responsiveUV;
    responsiveUV.x /= responsiveRatio;
    out.responsiveUV = responsiveUV;
    out.responsiveBoxGivenSize = responsiveBoxGivenSize;

    var imageBoxSize: vec2f;
    if (fit == 1.0) { // contain
        imageBoxSize.x = min(resolution.x / imageAspectRatio, resolution.y) * imageAspectRatio;
    } else if (fit == 2.0) { // cover
        imageBoxSize.x = max(resolution.x / imageAspectRatio, resolution.y) * imageAspectRatio;
    } else {
        imageBoxSize.x = min(10.0, 10.0 / imageAspectRatio * imageAspectRatio);
    }
    imageBoxSize.y = imageBoxSize.x / imageAspectRatio;
    let imageBoxScale = resolution / imageBoxSize;
    var imageUV = uv;
    imageUV *= imageBoxScale;
    imageUV += boxOrigin * (imageBoxScale - 1.0);
    imageUV += graphicOffset;
    imageUV /= scale;
    imageUV.x *= imageAspectRatio;
    imageUV = graphicRotation * imageUV;
    imageUV.x /= imageAspectRatio;
    imageUV += 0.5;
    imageUV.y = 1.0 - imageUV.y;
    out.imageUV = imageUV;
    return out;
}

fn rotate(uv: vec2f, th: f32) -> vec2f {
    return mat2x2f(cos(th), sin(th), -sin(th), cos(th)) * uv;
}

/** GLSL's mod (floored). */
fn mod289(x: vec3f) -> vec3f { return x - 289.0 * floor(x / 289.0); }
fn mod289v2(x: vec2f) -> vec2f { return x - 289.0 * floor(x / 289.0); }
fn permute(x: vec3f) -> vec3f { return mod289(((x * 34.0) + 1.0) * x); }
fn snoise(v: vec2f) -> f32 {
    let C = vec4f(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    var i = floor(v + dot(v, C.yy));
    let x0 = v - i + dot(i, C.xx);
    var i1: vec2f;
    i1 = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), x0.x > x0.y);
    var x12 = x0.xyxy + C.xxzz;
    x12 = vec4f(x12.xy - i1, x12.zw);
    i = mod289v2(i);
    let p = permute(permute(i.y + vec3f(0.0, i1.y, 1.0)) + i.x + vec3f(0.0, i1.x, 1.0));
    var m = max(0.5 - vec3f(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3f(0.0));
    m = m * m;
    m = m * m;
    let x = 2.0 * fract(p * C.www) - 1.0;
    let h = abs(x) - 0.5;
    let ox = floor(x + 0.5);
    let a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    var g: vec3f;
    g.x = a0.x * x0.x + h.x * x0.y;
    g = vec3f(g.x, a0.yz * x12.xz + h.yz * x12.yw);
    return 130.0 * dot(m, g);
}

fn getColorChanges(c1: f32, c2: f32, stripe_p: f32, w: vec3f, blur: f32, bump_in: f32, tint: f32) -> f32 {
    var bump = bump_in;
    var ch = mix(c2, c1, smoothstep(0.0, 2.0 * blur, stripe_p));

    var border = w[0];
    ch = mix(ch, c2, smoothstep(border, border + 2.0 * blur, stripe_p));

    if (u.d.z > 0.5) {
        bump = smoothstep(0.2, 0.8, bump);
    }
    border = w[0] + 0.4 * (1.0 - bump) * w[1];
    ch = mix(ch, c1, smoothstep(border, border + 2.0 * blur, stripe_p));

    border = w[0] + 0.5 * (1.0 - bump) * w[1];
    ch = mix(ch, c2, smoothstep(border, border + 2.0 * blur, stripe_p));

    border = w[0] + w[1];
    ch = mix(ch, c1, smoothstep(border, border + 2.0 * blur, stripe_p));

    let gradient_t = (stripe_p - w[0] - w[1]) / w[2];
    let gradient = mix(c1, c2, smoothstep(0.0, 1.0, gradient_t));
    ch = mix(ch, gradient, smoothstep(border, border + 0.5 * blur, stripe_p));

    // Tint colour is applied with colour burn blending
    ch = mix(ch, 1.0 - min(1.0, (1.0 - ch) / max(tint, 0.0001)), u.color_tint.a);
    return ch;
}

fn getImgFrame(uv: vec2f, th: f32) -> f32 {
    var frame = 1.0;
    frame *= smoothstep(0.0, th, uv.y);
    frame *= 1.0 - smoothstep(1.0 - th, 1.0, uv.y);
    frame *= smoothstep(0.0, th, uv.x);
    frame *= 1.0 - smoothstep(1.0 - th, 1.0, uv.x);
    return frame;
}

// The procedural shapes' anti-aliased cut at 0.9, two pixels of `edge` wide. Where `edge` is flat (inside
// a shape, the fill's centre) fwidth is 0, and smoothstep with low == high is undefined: GPUs happen to
// return the step (0 below the cut), but SwiftShader's derivative of a flat value is -0 and its compiler
// folds high - low to that -0, so the division's infinity changes sign and the inside comes out cut
// away (transparent). A width of at least 1e-6 keeps the step everywhere; elsewhere it is unchanged.
fn edgeCut(edge: f32) -> f32 {
    return smoothstep(0.9 - max(2.0 * fwidth(edge), 1e-6), 0.9, edge);
}

fn blurEdge3x3(uv: vec2f, dudx: vec2f, dudy: vec2f, radius: f32, centerSample: f32) -> f32 {
    let texel = 1.0 / vec2f(textureDimensions(u_image, 0));
    let r = radius * texel;

    let w1 = 1.0;
    let w2 = 2.0;
    let w4 = 4.0;
    let norm = 16.0;
    var sum = w4 * centerSample;

    sum += w2 * textureSampleGrad(u_image, u_image_sampler, uv + vec2f(0.0, -r.y), dudx, dudy).r;
    sum += w2 * textureSampleGrad(u_image, u_image_sampler, uv + vec2f(0.0, r.y), dudx, dudy).r;
    sum += w2 * textureSampleGrad(u_image, u_image_sampler, uv + vec2f(-r.x, 0.0), dudx, dudy).r;
    sum += w2 * textureSampleGrad(u_image, u_image_sampler, uv + vec2f(r.x, 0.0), dudx, dudy).r;

    sum += w1 * textureSampleGrad(u_image, u_image_sampler, uv + vec2f(-r.x, -r.y), dudx, dudy).r;
    sum += w1 * textureSampleGrad(u_image, u_image_sampler, uv + vec2f(r.x, -r.y), dudx, dudy).r;
    sum += w1 * textureSampleGrad(u_image, u_image_sampler, uv + vec2f(-r.x, r.y), dudx, dudy).r;
    sum += w1 * textureSampleGrad(u_image, u_image_sampler, uv + vec2f(r.x, r.y), dudx, dudy).r;

    return sum / norm;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
    let isImage = u.d.z > 0.5;
    let shape = u.d.w;
    let softness_u = u.e.x;
    let repetition = u.e.y;
    let shiftRed = u.e.z;
    let shiftBlue = u.e.w;
    let distortion = u.f.x;
    let contour_u = u.f.y;
    let angle_u = u.f.z;

    let firstFrameOffset = 2.8;
    let t = 0.3 * (u.c.w + firstFrameOffset);

    var uv = in.imageUV;
    let dudx = dpdx(in.imageUV);
    let dudy = dpdy(in.imageUV);
    let img = textureSampleGrad(u_image, u_image_sampler, uv, dudx, dudy);

    if (!isImage) {
        uv = in.objectUV + 0.5;
        uv.y = 1.0 - uv.y;
    }

    // Patch: the chip's rounded outline in card uv.
    let cardUv = vec2f(in.responsiveUV.x + 0.5, 0.5 - in.responsiveUV.y);
    let chipLocal = (cardUv - u.chip.xy) * vec2f(u.f.w, 1.0);
    let chipHalf = u.chip.zw * vec2f(u.f.w, 1.0);
    let chipRadius = 0.22 * min(chipHalf.x, chipHalf.y);
    let chipQ = abs(chipLocal) - chipHalf + chipRadius;
    let chipDistance = length(max(chipQ, vec2f(0.0))) + min(max(chipQ.x, chipQ.y), 0.0) - chipRadius;

    var cycleWidth = repetition;
    var edge = 0.0;
    var contOffset = 1.0;

    var rotatedUV = uv - vec2f(0.5);
    let angle = (-angle_u + 70.0) * PI / 180.0;
    let cosA = cos(angle);
    let sinA = sin(angle);
    rotatedUV = vec2f(rotatedUV.x * cosA - rotatedUV.y * sinA, rotatedUV.x * sinA + rotatedUV.y * cosA) + vec2f(0.5);

    if (isImage) {
        let edgeRaw = img.r;
        edge = blurEdge3x3(uv, dudx, dudy, 6.0, edgeRaw);
        edge = pow(edge, 1.6);
        edge *= mix(0.0, 1.0, smoothstep(0.0, 0.4, contour_u));
    } else {
        if (shape < 1.0) {
            // full-fill on canvas
            let borderUV = in.responsiveUV + 0.5;
            let ratio = in.responsiveBoxGivenSize.x / in.responsiveBoxGivenSize.y;
            let mask = min(borderUV, 1.0 - borderUV);
            let pixel_thickness = min(250.0 / in.responsiveBoxGivenSize, vec2f(0.5));
            var maskX = smoothstep(0.0, pixel_thickness.x, mask.x);
            var maskY = smoothstep(0.0, pixel_thickness.y, mask.y);
            maskX = pow(maskX, 0.25);
            maskY = pow(maskY, 0.25);
            edge = clamp(1.0 - maskX * maskY, 0.0, 1.0);

            uv = in.responsiveUV;
            if (ratio > 1.0) {
                uv.y /= ratio;
            } else {
                uv.x *= ratio;
            }
            uv += 0.5;
            uv.y = 1.0 - uv.y;

            cycleWidth *= 2.0;
            contOffset = 1.5;
        } else if (shape < 2.0) {
            // circle
            var shapeUV = uv - 0.5;
            shapeUV *= 0.67;
            edge = pow(clamp(3.0 * length(shapeUV), 0.0, 1.0), 18.0);
        } else if (shape < 3.0) {
            // daisy
            var shapeUV = uv - 0.5;
            shapeUV *= 1.68;

            var r = length(shapeUV) * 2.0;
            let a = atan2(shapeUV.y, shapeUV.x) + 0.2;
            r *= (1.0 + 0.05 * sin(3.0 * a + 2.0 * t));
            let f = abs(cos(a * 3.0));
            edge = smoothstep(f, f + 0.7, r);
            edge *= edge;

            uv *= 0.8;
            cycleWidth *= 1.6;
        } else if (shape < 4.0) {
            // diamond
            var shapeUV = uv - 0.5;
            shapeUV = rotate(shapeUV, 0.25 * PI);
            shapeUV *= 1.42;
            shapeUV += 0.5;
            let mask = min(shapeUV, 1.0 - shapeUV);
            let pixel_thickness = vec2f(0.15);
            var maskX = smoothstep(0.0, pixel_thickness.x, mask.x);
            var maskY = smoothstep(0.0, pixel_thickness.y, mask.y);
            maskX = pow(maskX, 0.25);
            maskY = pow(maskY, 0.25);
            edge = clamp(1.0 - maskX * maskY, 0.0, 1.0);
        } else if (shape < 5.0) {
            // metaballs
            var shapeUV = uv - 0.5;
            shapeUV *= 1.3;
            edge = 0.0;
            for (var i = 0; i < 5; i++) {
                let fi = f32(i);
                let speed = 1.5 + 2.0 / 3.0 * sin(fi * 12.345);
                let angle = -fi * 1.5;
                let dir1 = vec2f(cos(angle), sin(angle));
                let dir2 = vec2f(cos(angle + 1.57), sin(angle + 1.0));
                let traj = 0.4 * (dir1 * sin(t * speed + fi * 1.23) + dir2 * cos(t * (speed * 0.7) + fi * 2.17));
                let d = length(shapeUV + traj);
                edge += pow(1.0 - clamp(d, 0.0, 1.0), 4.0);
            }
            edge = 1.0 - smoothstep(0.65, 0.9, edge);
            edge = pow(edge, 4.0);
        }

        edge = mix(edgeCut(edge), edge, smoothstep(0.0, 0.4, contour_u));
    }

    var opacity = 0.0;
    if (isImage) {
        opacity = img.g;
        let frame = getImgFrame(in.imageUV, 0.0);
        opacity *= frame;
    } else {
        opacity = 1.0 - edgeCut(edge);
        if (shape < 2.0) {
            edge = 1.2 * edge;
        } else if (shape < 5.0) {
            edge = 1.8 * pow(edge, 1.5);
        }
    }

    let diagBLtoTR = rotatedUV.x - rotatedUV.y;
    let diagTLtoBR = rotatedUV.x + rotatedUV.y;

    var color = vec3f(0.0);
    let color1 = vec3f(0.98, 0.98, 1.0);
    let color2 = vec3f(0.1, 0.1, 0.1 + 0.1 * smoothstep(0.7, 1.3, diagTLtoBR));

    var grad_uv = uv - 0.5;

    let dist = length(grad_uv + vec2f(0.0, 0.2 * diagBLtoTR));
    grad_uv = rotate(grad_uv, (0.25 - 0.2 * diagBLtoTR) * PI);
    var direction = grad_uv.x;

    var bump = pow(1.8 * dist, 1.2);
    bump = 1.0 - bump;
    bump *= pow(uv.y, 0.3);

    let thin_strip_1_ratio = 0.12 / cycleWidth * (1.0 - 0.4 * bump);
    let thin_strip_2_ratio = 0.07 / cycleWidth * (1.0 + 0.4 * bump);
    let wide_strip_ratio = (1.0 - thin_strip_1_ratio - thin_strip_2_ratio);

    let thin_strip_1_width = cycleWidth * thin_strip_1_ratio;
    let thin_strip_2_width = cycleWidth * thin_strip_2_ratio;

    let noise = snoise(uv - t);

    edge += (1.0 - edge) * distortion * noise;

    direction += diagBLtoTR;
    let contour = 0.0;
    direction -= 2.0 * noise * diagBLtoTR * (smoothstep(0.0, 1.0, edge) * (1.0 - smoothstep(0.0, 1.0, edge)));
    direction *= mix(1.0, 1.0 - edge, smoothstep(0.5, 1.0, contour_u));
    direction -= 1.7 * edge * smoothstep(0.5, 1.0, contour_u);
    direction += 0.2 * pow(contour_u, 4.0) * (1.0 - smoothstep(0.0, 1.0, edge));

    bump *= clamp(pow(uv.y, 0.1), 0.3, 1.0);
    direction *= (0.1 + (1.1 - edge) * bump);

    direction *= (0.4 + 0.6 * (1.0 - smoothstep(0.5, 1.0, edge)));
    direction += 0.18 * (smoothstep(0.1, 0.2, uv.y) * (1.0 - smoothstep(0.2, 0.4, uv.y)));
    direction += 0.03 * (smoothstep(0.1, 0.2, 1.0 - uv.y) * (1.0 - smoothstep(0.2, 0.4, 1.0 - uv.y)));

    direction *= (0.5 + 0.5 * pow(uv.y, 2.0));
    direction *= cycleWidth;
    direction -= t;

    var colorDispersion = (1.0 - bump);
    colorDispersion = clamp(colorDispersion, 0.0, 1.0);
    var dispersionRed = colorDispersion;
    dispersionRed += 0.03 * bump * noise;
    dispersionRed += 5.0 * (smoothstep(-0.1, 0.2, uv.y) * (1.0 - smoothstep(0.1, 0.5, uv.y))) * (smoothstep(0.4, 0.6, bump) * (1.0 - smoothstep(0.4, 1.0, bump)));
    dispersionRed -= diagBLtoTR;

    var dispersionBlue = colorDispersion;
    dispersionBlue *= 1.3;
    dispersionBlue += (smoothstep(0.0, 0.4, uv.y) * (1.0 - smoothstep(0.1, 0.8, uv.y))) * (smoothstep(0.4, 0.6, bump) * (1.0 - smoothstep(0.4, 0.8, bump)));
    dispersionBlue -= 0.2 * edge;

    dispersionRed *= (shiftRed / 20.0);
    dispersionBlue *= (shiftBlue / 20.0);

    var blur = 0.0;
    var rExtraBlur = 0.0;
    var gExtraBlur = 0.0;
    if (isImage) {
        let softness = 0.05 * softness_u;
        blur = softness + 0.5 * smoothstep(1.0, 10.0, repetition) * smoothstep(0.0, 1.0, edge);
        let smallCanvasT = 1.0 - smoothstep(100.0, 500.0, min(u.a.x, u.a.y));
        blur += smallCanvasT * smoothstep(0.0, 1.0, edge);
        rExtraBlur = softness * (0.05 + 0.1 * (shiftRed / 20.0) * bump);
        gExtraBlur = softness * 0.05 / max(0.001, abs(1.0 - diagBLtoTR));
    } else {
        blur = softness_u / 15.0 + 0.3 * contour;
    }

    var w = vec3f(thin_strip_1_width, thin_strip_2_width, wide_strip_ratio);
    w[1] -= 0.02 * smoothstep(0.0, 1.0, edge + bump);
    let stripe_r = fract(direction + dispersionRed);
    let r = getColorChanges(color1.r, color2.r, stripe_r, w, blur + fwidth(stripe_r) + rExtraBlur, bump, u.color_tint.r);
    let stripe_g = fract(direction);
    let g = getColorChanges(color1.g, color2.g, stripe_g, w, blur + fwidth(stripe_g) + gExtraBlur, bump, u.color_tint.g);
    let stripe_b = fract(direction - dispersionBlue);
    let b = getColorChanges(color1.b, color2.b, stripe_b, w, blur + fwidth(stripe_b), bump, u.color_tint.b);

    color = vec3f(r, g, b);
    color *= opacity;

    // Patch: clear the chip.
    let chipClearance = smoothstep(0.006, 0.065, chipDistance);
    color *= chipClearance;
    opacity *= chipClearance;

    let bgColor = u.color_back.rgb * u.color_back.a;
    color = color + bgColor * (1.0 - opacity);
    opacity = opacity + u.color_back.a * (1.0 - opacity);

    color += 1.0 / 256.0 * (fract(sin(dot(0.014 * in.position.xy, vec2f(12.9898, 78.233))) * 43758.5453123) - 0.5);

    return vec4f(color, opacity);
}
