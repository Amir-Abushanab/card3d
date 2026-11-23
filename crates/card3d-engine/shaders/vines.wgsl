// The vines add-on (addons/vines/shaders.ts): stems, instanced leaves, their
// leaf-shadow pass (MAX-blended into a 768×486 target, written in clip space directly) and the face
// shadow catchers. Display values out, no colour-space conversion or tone mapping. The `*_shadow`
// entry points are the GLSL's `#define SHADOW` programs; FACE_Z, GROWN and LEAF_TINT are uniforms.
//
// The shadow target's rows run down (GL's run up), so it is sampled with v flipped (`shadow_at`).
diagnostic(off, derivative_uniformity);

struct Frame {
    view: mat4x4f,
    proj: mat4x4f,
};

struct Vines {
    light: vec4f,  // uLight: the sun, in the card's space
    eye: vec4f,    // uEye: the camera, in the card's space
    motion: vec4f, // uTime, uSway, uRustle, uWind
    conf: vec4f,   // FACE_Z, GROWN, LEAF_TINT, 0
    shift: vec4f,  // uLeafShift (hsvShift triple)
};

struct Item {
    model_view: mat4x4f,
    misc: vec4f, // catchers: uSide, uStrength
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> item: Item;
@group(1) @binding(1) var<uniform> vines: Vines;
@group(1) @binding(2) var atlas: texture_2d<f32>;
@group(1) @binding(3) var shadow: texture_2d<f32>;
@group(1) @binding(4) var trilinear: sampler;

const SKY = vec3f(.66, .71, .86);
const SUN = vec3f(.67, .58, .27);
const WIDE = vec2f(1.685, 1.0625) * 1.12;

fn sunlight(side: f32) -> vec3f { return normalize(vec3f(vines.light.xy, vines.light.z * side)); }
fn sunward(l: vec3f) -> vec2f { return clamp(l.xy / max(l.z, .19), vec2f(-3.5), vec2f(3.5)); }
fn shadow_uv(xy: vec2f, z: f32, l: vec3f) -> vec2f { return (xy - sunward(l) * z) / (2. * WIDE) + .5; }
fn shadow_at(uv: vec2f, bias: f32) -> vec4f { return textureSampleBias(shadow, trilinear, vec2f(uv.x, 1. - uv.y), bias); }
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn rbox(p: vec2f, b: vec2f, r: f32) -> f32 {
    let q = abs(p) - b + r;
    return length(max(q, vec2f(0.))) + min(max(q.x, q.y), 0.) - r;
}
fn toon(d: f32) -> f32 { return mix(d, .45 * smoothstep(.12, .32, d) + .55 * smoothstep(.46, .68, d), .5); }

// Rodrigues rotation taking +Z to f.
fn turn_z(v: vec3f, f: vec3f) -> vec3f {
    let s = length(f.xy);
    if (s < 1e-4) { return v; }
    let k = vec3f(-f.y / s, f.x / s, 0.);
    let c = f.z;
    return v * c + cross(k, v) * s + k * dot(k, v) * (1. - c);
}

// ── leaves ──

struct LeafV {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) life: f32,
    @location(2) wither: f32,
    @location(3) seed: f32,
    @location(4) side: f32,
    @location(5) variant: f32,
    @location(6) x: vec3f,
    @location(7) s: vec3f,
    @location(8) t: vec3f,
};

fn leaf(uv: vec2f, root_size: vec4f, life4: vec4f, art: vec4f, a_face: vec3f, shadow_pass: bool) -> LeafV {
    let angle = life4.x;
    let phase = life4.y;
    let progress = life4.z;
    let lift = life4.w;
    let kz = art.y;
    let seed = art.z;
    let side = art.w;
    let root = root_size.xy;
    let m = vines.motion;
    var age = fract(m.x / 80. + phase);
    if (vines.conf.y > .5) { age = .40 * progress + .16 + .03 * fract(5.3 * seed); }
    let birth = .40 * progress + .035;
    let growth = smoothstep(birth, birth + .12, age);
    let life = clamp((age - birth) / (.985 - birth), 0., 1.);
    let wither = smoothstep(.80, .95, life);
    let gust = m.z * (.6 + .4 * sin(2.7 * m.w - dot(root, vec2f(2.1, 1.3))));
    let flap = .6 * sin(17. * m.w + 7. * seed) + .4 * sin(29. * m.w + 3. * seed);
    let ang = angle + wither * (.85 + .25 * sin(seed)) + .16 * m.y + .010 * sin(.4 * m.x + seed) * (1. - wither) + .18 * gust * flap;
    let face = normalize(mix(mix(vec3f(0., 0., 1.), a_face, smoothstep(.15, 1., growth)), vec3f(.3 * a_face.x, -.4, .85), .5 * wither)
        + vec3f(cos(seed), sin(seed), 0.) * gust * sin(23. * m.w + 11. * seed) * .35);
    let S = turn_z(vec3f(cos(ang), sin(ang), 0.), face);
    let T = turn_z(vec3f(-sin(ang), cos(ang), 0.), face);
    let size = root_size.zw * growth * vec2f(growth * (1. - .86 * wither), 1. - .56 * wither);
    var q = vec2f((uv.x - .5) * size.x, uv.y * size.y);
    q.x += .28 * wither * size.y * uv.y * uv.y;
    q.y -= .18 * wither * size.y * uv.y * uv.y;
    let o = q.x * S + q.y * T;
    let over = kz > .5 && rbox(root + o.xy, vec2f(1.545, .9225), 0.) > .143;
    let hgt = clamp((lift * smoothstep(0., .25, uv.y) + kz * o.z) * (1. - .5 * wither), select(.002, -.3, over), .075);
    let X = vec3f(root + o.xy, hgt);
    var v: LeafV;
    v.uv = uv;
    v.life = life;
    v.wither = wither;
    v.seed = seed;
    v.side = side;
    v.variant = art.x;
    v.x = X;
    v.s = S;
    v.t = T;
    if (shadow_pass) {
        v.pos = vec4f((X.xy - sunward(sunlight(side)) * hgt) / WIDE, 0., 1.);
    } else {
        v.pos = frame.proj * item.model_view * vec4f(X.xy, side * (vines.conf.x + hgt), 1.);
    }
    if (growth < .003 || age >= .985) { v.pos = vec4f(0., 0., 2., 1.); }
    return v;
}

@vertex
fn vs_leaf(@location(2) uv: vec2f, @location(3) root_size: vec4f, @location(4) life: vec4f, @location(5) art: vec4f, @location(6) face: vec3f) -> LeafV {
    return leaf(uv, root_size, life, art, face, false);
}

@vertex
fn vs_leaf_shadow(@location(2) uv: vec2f, @location(3) root_size: vec4f, @location(4) life: vec4f, @location(5) art: vec4f, @location(6) face: vec3f) -> LeafV {
    return leaf(uv, root_size, life, art, face, true);
}

fn palette(s: f32) -> vec3f {
    var c = vec3f(.62, .76, .32);
    c = mix(c, vec3f(.42, .62, .27), clamp(s / .14, 0., 1.));
    c = mix(c, vec3f(.25, .46, .23), clamp((s - .14) / .18, 0., 1.));
    c = mix(c, vec3f(.87, .52, .18), clamp((s - .32) / .20, 0., 1.));
    c = mix(c, vec3f(.72, .20, .15), clamp((s - .52) / .18, 0., 1.));
    c = mix(c, vec3f(.47, .27, .15), clamp((s - .70) / .14, 0., 1.));
    c = mix(c, vec3f(.45, .35, .24), clamp((s - .84) / .16, 0., 1.));
    return c;
}

// HSV_SHIFT_GLSL (effects/params.ts).
fn rgb2hsv(c: vec3f) -> vec3f {
    let K = vec4f(0., -1. / 3., 2. / 3., -1.);
    let p = mix(vec4f(c.bg, K.wz), vec4f(c.gb, K.xy), step(c.b, c.g));
    let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
    let d = q.x - min(q.w, q.y);
    return vec3f(abs(q.z + (q.w - q.y) / (6. * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
fn hsv2rgb(c: vec3f) -> vec3f {
    let p = abs(fract(c.xxx + vec3f(1., 2. / 3., 1. / 3.)) * 6. - 3.);
    return c.z * mix(vec3f(1.), clamp(p - 1., vec3f(0.), vec3f(1.)), c.y);
}
fn hsv_shift(rgb: vec3f, s: vec3f) -> vec3f {
    let h = rgb2hsv(max(rgb, vec3f(0.)));
    return hsv2rgb(vec3f(fract(h.x + s.x), clamp(h.y * s.y, 0., 1.), h.z * s.z));
}

// The leaf's coverage (`a`, after the crumble) and its atlas texel.
fn leaf_art(in: LeafV) -> vec4f {
    let variant = floor(in.variant + .5);
    let tile = vec2f(variant % 2., 2. - floor(variant / 2.));
    return textureSample(atlas, trilinear, (in.uv + tile) / vec2f(2., 3.));
}
fn leaf_alpha(in: LeafV, art: vec4f) -> f32 {
    let crumble = smoothstep(.955, 1., in.life);
    return art.a * step(crumble, hash(floor(in.uv * vec2f(16., 24.)) + in.seed) * .55 + (1. - in.uv.y) * .45);
}

@fragment
fn fs_leaf_shadow(in: LeafV) -> @location(0) vec4f {
    let a = leaf_alpha(in, leaf_art(in));
    if (a < .2 || in.x.z < 0.) { discard; }
    return select(vec4f(0., 0., 10. * in.x.z * a, a), vec4f(10. * in.x.z * a, a, 0., 0.), in.side > 0.);
}

@fragment
fn fs_leaf(in: LeafV) -> @location(0) vec4f {
    let art = leaf_art(in);
    let l = sunlight(in.side);
    let sh = shadow_at(shadow_uv(in.x.xy, in.x.z, l), 0.);
    let a = leaf_alpha(in, art);
    if (a < .2) { discard; }
    let fz = vines.conf.x;
    let stage = clamp(in.life + .08 * (1. - art.b) - .05 * art.g + .09 * (fract(7.31 * in.seed) - .5), 0., 1.);
    let dry = smoothstep(.78, .92, stage);
    var base = palette(stage);
    if (vines.conf.z > .5) { base = mix(hsv_shift(base, vines.shift.xyz), base, smoothstep(.26, .44, stage)); }
    var albedo = base * (.52 + .82 * art.r) * (.90 + .16 * fract(3.7 * in.seed));
    albedo = mix(albedo, min(1.35 * albedo + .06, vec3f(1.)), .62 * art.g * (1. - dry));
    albedo = mix(albedo, vec3f(.60, .50, .38) * (.7 + .4 * art.r), .4 * in.wither);
    let F = normalize(cross(in.s, in.t));
    let V = normalize(vec3f(vines.eye.xy, vines.eye.z * in.side) - vec3f(in.x.xy, fz + in.x.z));
    let under = select(0., 1., dot(F, V) <= 0.);
    albedo = mix(albedo, .62 * albedo + vec3f(.24, .26, .15), .6 * under);
    let sd = 2. * smoothstep(-.16, .16, in.uv.x - .5) - 1.;
    let tl = vec2f(sd * (.34 + 1.1 * in.wither) + .5 * (in.uv.x - .5), .26 - .56 * in.uv.y);
    let n = normalize(tl.x * in.s + tl.y * in.t + F) * (1. - 2. * under);
    let d = max(0., dot(n, l));
    let lit = toon(d);
    let occ = select(sh.ba, sh.rg, in.side > 0.);
    let shade = occ.y * smoothstep(in.x.z + .004, in.x.z + .012, .1 * occ.x) * .85;
    let direct = (1. - shade) * smoothstep(-.04, .25, l.z);
    let sky = SKY * (.92 + .2 * n.y) * mix(vec3f(.84, .88, .96), vec3f(1.), smoothstep(.004, .05, in.x.z));
    var color = albedo * (.86 * sky + 1.05 * SUN * lit * direct + vec3f(.15, .15, .14) * max(0., -n.y))
        + 1.1 * albedo * SUN * max(0., dot(F, l) * (2. * under - 1.)) * direct * (1. - .6 * dry);
    let margin = 1. - smoothstep(0., .3, art.b);
    color += vec3f(.36, .30, .12) * margin * smoothstep(.5, .8, d) * direct * (1. - dry);
    color *= 1. - margin * (.08 + .18 * (1. - lit * direct));
    let gloss = smoothstep(.93, .99, dot(n, normalize(l + V))) * (1. - dry) * (1. - under) * direct * smoothstep(.45, .75, art.r);
    color += .30 * vec3f(1., .96, .80) * gloss;
    color -= .06 * dry * hash(floor(90. * in.uv));
    return vec4f(color, a);
}

// ── stems ──

struct StemV {
    @builtin(position) pos: vec4f,
    @location(0) s: f32,
    @location(1) progress: f32,
    @location(2) age: f32,
    @location(3) wither: f32,
    @location(4) h: f32,
    @location(5) cov: f32,
    @location(6) nv: vec3f,
    @location(7) tan: vec3f,
    @location(8) n: vec3f,
    @location(9) x: vec3f,
};

// position; aT (as the mesh normal); aData = (width, progress) as the mesh uv and (phase, s); aN.
fn stem(position: vec3f, a_t: vec3f, wp: vec2f, ps: vec2f, a_n: vec3f, shadow_pass: bool) -> StemV {
    let width = wp.x;
    let s = ps.y;
    var age = fract(vines.motion.x / 80. + ps.x);
    if (vines.conf.y > .5) { age = .5; }
    let wither = smoothstep(.82, .97, age);
    let r = .5 * width * (1. - .45 * wither) * (1. - smoothstep(.975, 1., age));
    let t = normalize(a_t);
    var o: StemV;
    o.s = s;
    o.progress = wp.y;
    o.age = age;
    o.wither = wither;
    o.n = a_n;
    o.tan = t;
    if (shadow_pass) {
        let side = sign(a_n.z);
        let h = max(abs(position.z) - vines.conf.x, 0.);
        let w = max(r, .0037) * step(.9, abs(a_n.z));
        let l = sunlight(side);
        let sideways = cross(t, a_n);
        var dir = vec2f(0.);
        if (length(sideways) > 0.) { dir = normalize(sideways).xy; }
        let xy = position.xy + dir * s * w - sunward(l) * h;
        o.h = h;
        o.cov = r / max(w, 1e-5);
        o.nv = vec3f(0.);
        o.x = vec3f(xy, h);
        o.pos = vec4f(xy / WIDE, 0., 1.);
    } else {
        let v = normalize(vines.eye.xyz - position);
        let nv = normalize(v - t * dot(v, t) + .01 * a_n);
        let X = position + cross(t, nv) * s * r;
        o.nv = nv;
        o.x = X;
        o.h = 0.;
        o.cov = 0.;
        o.pos = frame.proj * item.model_view * vec4f(X, 1.);
    }
    return o;
}

@vertex
fn vs_stem(@location(0) position: vec3f, @location(1) a_t: vec3f, @location(2) wp: vec2f, @location(3) a_n: vec3f, @location(4) ps: vec2f) -> StemV {
    return stem(position, a_t, wp, ps, a_n, false);
}

@vertex
fn vs_stem_shadow(@location(0) position: vec3f, @location(1) a_t: vec3f, @location(2) wp: vec2f, @location(3) a_n: vec3f, @location(4) ps: vec2f) -> StemV {
    return stem(position, a_t, wp, ps, a_n, true);
}

fn stem_tip(in: StemV) -> f32 { return min(1.08, in.age / .36); }
fn stem_cut(in: StemV, tip: f32) -> bool { return in.progress > tip || abs(in.s) > sqrt(clamp((tip - in.progress) / .012, 0., 1.)); }

@fragment
fn fs_stem_shadow(in: StemV) -> @location(0) vec4f {
    if (stem_cut(in, stem_tip(in))) { discard; }
    let cov = clamp(in.cov, 0., 1.);
    return select(vec4f(0., 0., 10. * in.h * cov, cov), vec4f(10. * in.h * cov, cov, 0., 0.), in.n.z > 0.);
}

@fragment
fn fs_stem(in: StemV) -> @location(0) vec4f {
    let side = sign(in.n.z);
    let l = sunlight(side);
    let h = abs(in.x.z) - vines.conf.x;
    let sh = shadow_at(shadow_uv(in.x.xy, h, l), 0.);
    let tip = stem_tip(in);
    if (stem_cut(in, tip)) { discard; }
    var bark = mix(vec3f(.42, .53, .28), vec3f(.42, .31, .24), smoothstep(.04, .30, in.age - .36 * in.progress));
    bark = mix(bark, vec3f(.47, .42, .36), in.wither);
    let e = (in.progress - tip) / .014;
    bark = mix(bark, vec3f(.64, .76, .38), exp(-e * e) * (1. - in.wither) * .7);
    let nv = normalize(in.nv);
    let t = normalize(in.tan);
    let n = nv * sqrt(max(0., 1. - in.s * in.s)) + cross(t, nv) * in.s;
    var shade = 0.;
    if (abs(in.n.z) > .9) {
        let occ = select(sh.ba, sh.rg, side > 0.);
        shade = occ.y * smoothstep(h + .004, h + .012, .1 * occ.x) * .85;
    }
    let lit = toon(max(0., dot(n, vines.light.xyz)));
    let color = bark * (SKY * (.62 + .3 * dot(n, in.n)) + SUN * (.15 + lit) * (1. - shade) * smoothstep(-.04, .25, dot(in.n, vines.light.xyz)));
    return vec4f(color, 1.);
}

// ── the shadow catchers: a face-sized plane above each face, multiplied over it ──

struct CatcherV {
    @builtin(position) pos: vec4f,
    @location(0) p: vec2f,
};

@vertex
fn vs_catcher(@location(0) position: vec3f) -> CatcherV {
    return CatcherV(frame.proj * item.model_view * vec4f(position, 1.), vec2f(position.x * item.misc.x, position.y));
}

fn leaf_shade(q: vec2f, bias: f32) -> f32 {
    let s = shadow_at(q / (2.24 * vec2f(1.685, 1.0625)) + .5, bias);
    return select(s.a, s.g, item.misc.x > 0.);
}

@fragment
fn fs_catcher(in: CatcherV) -> @location(0) vec4f {
    let leaf = .86 * (.55 * leaf_shade(in.p, 0.) + .45 * leaf_shade(in.p, 2.));
    let mass = min(1., 1.4 * leaf_shade(in.p, 4.));
    return vec4f(vec3f(1. - item.misc.y * (.58 * leaf + .16 * mass)), 1.);
}

// ── the shadow target's mipmaps (GL's generateMipmap): one bilinear tap per texel of the level above ──

struct BlitV {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@group(2) @binding(0) var blit_src: texture_2d<f32>;
@group(2) @binding(1) var blit_sampler: sampler;

@vertex
fn vs_blit(@builtin(vertex_index) i: u32) -> BlitV {
    let p = vec2f(f32(i & 1u) * 4. - 1., f32(i >> 1u) * 4. - 1.);
    return BlitV(vec4f(p, 0., 1.), vec2f(p.x * .5 + .5, .5 - p.y * .5));
}

@fragment
fn fs_blit(in: BlitV) -> @location(0) vec4f {
    return textureSampleLevel(blit_src, blit_sampler, in.uv, 0.);
}
