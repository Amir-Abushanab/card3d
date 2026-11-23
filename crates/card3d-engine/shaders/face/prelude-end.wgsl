// The wrapper `main()` (MAIN_GLSL) and the skin / overlay vertex shaders, after the shader's code.

struct FOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) local: vec3f,
};

// One full-screen triangle with uv 0..1 over the viewport. Clip y is flipped so uv.y = 0 lands on the
// target's first row: sampling the skin at uv then reads what was drawn at uv, as in three (whose
// render targets start at the bottom row).
@vertex
fn vs_skin(@builtin(vertex_index) i: u32) -> FOut {
    let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    let t = array<vec2f, 3>(vec2f(0.0, 0.0), vec2f(2.0, 0.0), vec2f(0.0, 2.0));
    var o: FOut;
    o.pos = vec4f(p[i].x, -p[i].y, 0.0, 1.0);
    o.uv = t[i];
    o.local = vec3f(0.0);
    return o;
}

@vertex
fn vs_overlay(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> FOut {
    var o: FOut;
    o.pos = frame.proj * face.model_view * vec4f(position, 1.0);
    o.uv = uv;
    o.local = position;
    return o;
}

fn aces_filmic(color_in: vec3f) -> vec3f {
    let input = mat3x3f(vec3f(0.59719, 0.07600, 0.02840), vec3f(0.35458, 0.90834, 0.13383), vec3f(0.04823, 0.01566, 0.83777));
    let output = mat3x3f(vec3f(1.60475, -0.10208, -0.00327), vec3f(-0.53108, 1.10813, -0.07276), vec3f(-0.07367, -0.00605, 1.07602));
    var c = color_in * (frame.misc.x / 0.6);
    c = input * c;
    let a = c * (c + 0.0245786) - 0.000090537;
    let b = c * (0.983729 * c + 0.4329510) + 0.238081;
    c = output * (a / b);
    return saturate(c);
}

fn srgb_encode(c: vec3f) -> vec3f {
    return select(pow(c, vec3f(0.41666)) * 1.055 - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

@fragment
fn fs_face(in: FOut) -> @location(0) vec4f {
    uTime = face.time.x;
    uResolution = face.time.yz;
    uOpacity = face.time.w;
    uTilt = face.tilt;
    uPointer = face.pointer.xyz;
    uBaseColor = face.base.rgb;
    uHasArtwork = face.base.w;
    uChip = face.chip;
    uAspect = face.misc.x;
    uSide = face.misc.y;
    uOverlay = face.misc.z;
    uEye = face.eye.xyz;
    card3d_params();

    card3dLoopGuard = 0;
    let uv = in.uv;
    cardUv = vec2f(mix(uv.x, 1.0 - uv.x, uSide), uv.y);
    facePos = (uv - 0.5) * vec2f(uAspect, 1.0);
    faceNormal = vec3f(0.0, 0.0, 1.0);
    if (FACE_OVERLAY) {
        viewDir = normalize(uEye - in.local);
    } else {
        viewDir = faceNormal;
    }
    let c = mainImage(uv);
    var rgb = select(srgbToLinear(c.rgb), c.rgb, LINEAR_OUTPUT);
    let a = clamp(c.a, 0.0, 1.0) * uOpacity;
    // tonemapping_fragment / colorspace_fragment: an overlay on the canvas is encoded (and tone-mapped
    // when it returns linear colour); a skin's target is sRGB, which the hardware encodes; the glass's
    // buffer passes keep linear values.
    if (FACE_OVERLAY && frame.misc.y < 0.5) {
        if (LINEAR_OUTPUT) { rgb = aces_filmic(rgb); }
        rgb = srgb_encode(rgb);
    }
    // Multiply / add / screen fold the alpha into the colour after the output encoding.
    if (BLEND_MODE == 3u) {
        rgb = mix(vec3f(1.0), rgb, a);
    } else if (BLEND_MODE == 2u || BLEND_MODE == 4u) {
        rgb *= a;
    }
    return vec4f(rgb, a);
}
