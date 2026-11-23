//! Material scalars and the procedural surface maps: ports of `materials/scalar.ts`,
//! `materials/presets.ts`, `materials/math.ts`, `materials/surface-data.ts` (flat and brushed modes)
//! and `materials/surface-modes.ts`. f64 throughout, in the original operation order.

use crate::design::{MaterialOverride, Recipe};

/// `resolveMaterial` output.
#[derive(Clone, Copy, Debug, Default)]
pub struct Resolved {
    /// Linear RGB.
    pub color: [f32; 3],
    pub metalness: f64,
    pub roughness: f64,
    pub clearcoat: f64,
    pub clearcoat_roughness: f64,
    /// Above 0.5 the card is clear glass (`createGlassBody`).
    pub transmission: f64,
    /// A look (0.42–0.70 over the polish range), mapped onto the slab's real thickness by the glass.
    pub thickness: f64,
    pub ior: f64,
}

impl Resolved {
    /// `(R?.transmission ?? 0) > 0.5`: the card is a clear glass slab.
    pub fn glass(&self) -> bool {
        self.transmission > 0.5
    }
}

/// (roughnessBias, clearcoat, metalness) per preset (`PRESET_MODIFIERS`).
fn modifiers(preset: &str) -> (f64, f64, f64) {
    match preset {
        "glass" => (-0.12, 1.0, 0.0),
        "nickel" => (-0.04, 1.25, 1.0),
        "titanium" => (0.05, 0.72, 1.0),
        "brass" => (-0.015, 1.12, 1.0),
        "oxide" => (0.09, 0.54, 1.0),
        "carbon" => (0.15, 0.3, 1.0),
        _ => (0.0, 1.0, 1.0),
    }
}

fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    hi.min(lo.max(x))
}

/// `whitenGlass`: lerp toward `#f7fcfd` by 0.82 in linear space, back to an sRGB hex (8 bits).
pub(crate) fn whiten_glass(hex: &str) -> String {
    let (c, t) = (srgb_hex_to_linear(hex), srgb_hex_to_linear("#f7fcfd"));
    let enc = |l: f32| {
        let l = l as f64;
        let s = if l < 0.0031308 { l * 12.92 } else { 1.055 * l.powf(0.41666) - 0.055 };
        (s * 255.0).clamp(0.0, 255.0).round() as u32
    };
    let ch = |k: usize| enc(c[k] + (t[k] - c[k]) * 0.82);
    format!("#{:02x}{:02x}{:02x}", ch(0), ch(1), ch(2))
}

/// `resolveMaterial` (materials/scalar.ts); override keys win.
pub fn resolve(r: &Recipe, o: Option<&MaterialOverride>) -> Resolved {
    let d = MaterialOverride::default();
    let o = o.unwrap_or(&d);
    let (bias, cc, metalness) = modifiers(&r.material);
    let a = clamp(r.polish / 100.0, 0.0, 1.0);
    let shine = a.powf(1.7);
    if r.material == "glass" {
        // The recipe's colour, else the preset's (`PRESET_FALLBACK_COLORS.glass`), whitened.
        let base = o.color.clone().unwrap_or_else(|| if r.color.is_empty() { "#c5dde4".into() } else { r.color.clone() });
        return Resolved {
            color: srgb_hex_to_linear(&o.color.clone().unwrap_or_else(|| whiten_glass(&base))),
            metalness: o.metalness.unwrap_or(0.0),
            roughness: o.roughness.unwrap_or(clamp(0.28 - 0.24 * shine + bias, 0.02, 0.18)),
            clearcoat: o.clearcoat.unwrap_or(1.0),
            clearcoat_roughness: o.clearcoat_roughness.unwrap_or(0.02 + 0.12 * (1.0 - a)),
            transmission: o.transmission.unwrap_or(1.0),
            thickness: o.thickness.unwrap_or(0.42 + 0.28 * a),
            ior: o.ior.unwrap_or(1.5),
        };
    }
    Resolved {
        transmission: o.transmission.unwrap_or(0.0),
        thickness: o.thickness.unwrap_or(0.0),
        ior: o.ior.unwrap_or(1.5),
        color: srgb_hex_to_linear(o.color.as_deref().unwrap_or(&r.color)),
        metalness: o.metalness.unwrap_or(metalness),
        roughness: o.roughness.unwrap_or(clamp(0.64 - 0.56 * shine + bias, 0.04, 0.88)),
        clearcoat: o.clearcoat.unwrap_or((0.015 + 0.055 * a) * cc),
        clearcoat_roughness: o.clearcoat_roughness.unwrap_or(0.52 - 0.34 * a),
    }
}

/// A `#rrggbb` colour's sRGB channels, 0..1.
pub fn srgb_hex_to_srgb(hex: &str) -> [f64; 3] {
    let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0xbcbcb9);
    [((v >> 16) & 0xff) as f64 / 255.0, ((v >> 8) & 0xff) as f64 / 255.0, (v & 0xff) as f64 / 255.0]
}

/// `THREE.Color.set("#rrggbb")` with colour management: sRGB → linear.
pub fn srgb_hex_to_linear(hex: &str) -> [f32; 3] {
    let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0xbcbcb9);
    let ch = |s: u32| {
        let c = ((v >> s) & 0xff) as f64 / 255.0;
        (if c < 0.04045 { c * 0.0773993808 } else { (c * 0.9478672986 + 0.0521327014).powf(2.4) }) as f32
    };
    [ch(16), ch(8), ch(0)]
}

/// The generated normal and roughness maps and how the material applies them.
#[derive(Clone)]
pub struct SurfaceMaps {
    pub size: u32,
    /// RGBA8, row 0 at v = 0.
    pub normal: Vec<u8>,
    pub roughness: Vec<u8>,
    pub repeat: [f32; 2],
    pub normal_scale: [f32; 2],
    pub anisotropy: f32,
    pub anisotropy_rotation: f32,
}

fn fract(x: f64) -> f64 {
    x - x.floor()
}

/// Per-texel white noise in [−0.5, 0.5).
fn texel_noise(x: f64, y: f64) -> f64 {
    fract(43758.5453 * (12.9898 * x + 78.233 * y).sin()) - 0.5
}

fn write_texel(normal: &mut [u8], rough: &mut [u8], o: usize, gx: f64, gy: f64, v: f64) {
    // JS Math.round (half up) for the normal; the Uint8Array store truncates the roughness.
    normal[o] = clamp(128.0 + (gx + 0.5).floor(), 0.0, 255.0) as u8;
    normal[o + 1] = clamp(128.0 + (gy + 0.5).floor(), 0.0, 255.0) as u8;
    normal[o + 2] = 253;
    normal[o + 3] = 255;
    let b = v as u8;
    rough[o..o + 4].copy_from_slice(&[b, b, b, 255]);
}

/// `generateSurfaceData` (materials/surface-data.ts): every texture mode. `pattern` is `none` or `orbit`.
pub fn surface_maps(size: u32, grain: f64, relief: f64, texture: &str, orbit: bool) -> SurfaceMaps {
    let n = size as usize;
    let s = clamp(grain / 100.0, 0.0, 1.0);
    let l = clamp(relief / 100.0, 0.0, 1.0);
    let mode = resolve_mode(texture, s, l);
    let mut normal = vec![0u8; 4 * n * n];
    let mut rough = vec![0u8; 4 * n * n];
    match mode {
        "none" => {
            for o in (0..4 * n * n).step_by(4) {
                write_texel(&mut normal, &mut rough, o, 0.0, 0.0, 250.0);
            }
        }
        "brushed" => {
            let (ox, oy) = (0.05 * n as f64, 0.08 * n as f64);
            for y in 0..n {
                let yf = y as f64;
                let w = 0.52 * (0.43 * yf).sin() + 0.24 * (1.77 * yf).sin() + 0.1 * (4.13 * yf).sin();
                for x in 0..n {
                    let xf = x as f64;
                    let mu = texel_noise(xf, yf);
                    let orb = if orbit { 0.7 * (0.22 * (xf + ox).hypot(yf + oy)).sin() } else { 0.0 };
                    let gx = 1.2 * mu;
                    let gy = w * (1.6 + 6.4 * s) + mu * (0.5 + 2.2 * s) + orb * l * 8.0;
                    let v = clamp(218.0 + w * (4.0 + 11.0 * s) + mu * (2.0 + 5.0 * s) + 5.0 * orb, 190.0, 238.0);
                    write_texel(&mut normal, &mut rough, 4 * (y * n + x), gx, gy, v);
                }
            }
        }
        patterned => {
            // Slopes are unwrapped central differences of h, evaluated once per texel on an (N+2)² grid.
            let h = height_fn(patterned, s, n as f64, orbit);
            let (gain, roughness_of) = patterned_shading(patterned, l);
            let g = n + 2;
            let mut grid = vec![0.0f64; g * g];
            for gy in 0..g {
                for gx in 0..g {
                    grid[gy * g + gx] = h(gx as f64 - 1.0, gy as f64 - 1.0);
                }
            }
            let at = |x: isize, y: isize| grid[((y + 1) as usize) * g + (x + 1) as usize];
            for y in 0..n as isize {
                for x in 0..n as isize {
                    let mu = texel_noise(x as f64, y as f64);
                    let e = at(x, y);
                    let dx = at(x - 1, y) - at(x + 1, y);
                    let dy = at(x, y - 1) - at(x, y + 1);
                    let v = clamp(roughness_of(e, mu), 196.0, 254.0);
                    write_texel(&mut normal, &mut rough, 4 * (y as usize * n + x as usize), dx * gain, dy * gain, v);
                }
            }
        }
    }
    let (repeat, anisotropy, anisotropy_rotation, normal_scale) = mode_layout(mode, s, l);
    SurfaceMaps { size, normal, roughness: rough, repeat, normal_scale, anisotropy, anisotropy_rotation }
}

/// `resolveSurfaceMode`: `none` with any grain or relief renders brushed; only 0 / 0 is flat.
/// An unknown texture renders as guilloché (the TypeScript engine rejects it before this point).
fn resolve_mode(texture: &str, s: f64, l: f64) -> &'static str {
    match texture {
        "guilloche" => "guilloche",
        "crosshatch" => "crosshatch",
        "hammered" => "hammered",
        "sandblasted" => "sandblasted",
        "pinpoint" => "pinpoint",
        "linen" => "linen",
        "carbon-fiber" => "carbon-fiber",
        "brushed" => "brushed",
        "none" if s > 0.001 || l > 0.001 => "brushed",
        "none" => "none",
        _ => "guilloche",
    }
}

/// Cell hash `H(x, y)`.
fn cell_hash(x: f64, y: f64) -> f64 {
    fract(43758.5453 * (127.1 * x + 311.7 * y).sin())
}

/// Negative Gaussian groove of width `w` at every multiple of `period`.
fn ridge(x: f64, period: f64, w: f64) -> f64 {
    let q = ((x % period) + period) % period;
    let d = q.min(period - q);
    -(-(d * d) / (w * w)).exp()
}

type HeightFn = Box<dyn Fn(f64, f64) -> f64>;

/// `createHeightFn` (materials/surface-height.ts).
fn height_fn(mode: &str, s: f64, n: f64, orbit: bool) -> HeightFn {
    use std::f64::consts::PI;
    let h = cell_hash;
    match mode {
        "crosshatch" => {
            let p = 26.0 - 8.0 * s;
            Box::new(move |x, y| 0.72 * ridge(x + y, p, 1.2) + 0.72 * ridge(x - y, p, 1.2))
        }
        "pinpoint" => {
            let p = 23.0 - 7.0 * s;
            let r = 2.4 + 0.9 * s;
            let r2 = r * r;
            Box::new(move |x, y| {
                let (i, j) = ((x / p).floor(), (y / p).floor());
                let mut best = 0.0f64;
                for dj in -1..=1 {
                    for di in -1..=1 {
                        let (ci, cj) = (i + di as f64, j + dj as f64);
                        let cx = (ci + 0.5 + (h(ci, cj) - 0.5) * 0.34) * p;
                        let cy = (cj + 0.5 + (h(ci + 31.0, cj - 19.0) - 0.5) * 0.34) * p;
                        let (ddx, ddy) = (x - cx, y - cy);
                        let g = (-(ddx * ddx + ddy * ddy) / r2).exp();
                        if g > best {
                            best = g;
                        }
                    }
                }
                -best
            })
        }
        "hammered" => {
            let p = 30.0 - 10.0 * s;
            let radius = 0.58 * p;
            Box::new(move |x, y| {
                let (i, j) = ((x / p).floor(), (y / p).floor());
                let (mut dmin, mut wt) = (f64::INFINITY, 0.0);
                // Visit order (dj outer, di inner) and the strict < decide exact ties, as in TypeScript.
                for dj in -1..=1 {
                    for di in -1..=1 {
                        let (ci, cj) = (i + di as f64, j + dj as f64);
                        let fx = (ci + 0.18 + 0.64 * h(ci, cj)) * p;
                        let fy = (cj + 0.18 + 0.64 * h(ci + 47.0, cj - 23.0)) * p;
                        let d = (x - fx).hypot(y - fy);
                        if d < dmin {
                            dmin = d;
                            wt = 0.72 + 0.38 * h(ci - 11.0, cj + 29.0);
                        }
                    }
                }
                -((0.0f64).max(1.0 - dmin / radius) * PI / 2.0).sin() * wt
            })
        }
        "sandblasted" => Box::new(move |x, y| {
            (h((0.72 * x).floor(), (0.72 * y).floor()) - 0.5) * 0.72 + (h((2.35 * x).floor() + 17.0, (2.35 * y).floor() - 9.0) - 0.5) * 0.34
        }),
        "linen" => {
            let p = 7.5 - 2.2 * s;
            Box::new(move |x, y| (0.54 * (PI * x / p).sin() + 0.46 * (PI * y / p).sin()) * (0.66 + 0.18 * (PI * (x + y) / (2.0 * p)).sin()))
        }
        "carbon-fiber" => {
            let p = 12.0 - 3.0 * s;
            Box::new(move |x, y| 0.58 * (PI * (x + y) / p).sin() + 0.24 * (PI * (x - y) / p).sin() + 0.18 * (PI * (x + 0.34 * y) / (2.0 * p)).sin())
        }
        _ => {
            // Guilloché: concentric grooves around the texture centre; full amplitude only with orbit.
            let pg = 2.0 * PI / (0.78 + 0.38 * s);
            let amp = if orbit { 1.0 } else { 0.72 };
            let c = n / 2.0;
            Box::new(move |x, y| ridge((x - c).hypot(y - c), pg, 0.82) * amp)
        }
    }
}

type RoughnessFn = Box<dyn Fn(f64, f64) -> f64>;

/// `patternedShading`: the normal gain and the (unclamped) roughness byte per patterned mode.
fn patterned_shading(mode: &str, l: f64) -> (f64, RoughnessFn) {
    match mode {
        "guilloche" => (36.0 + 24.0 * l, Box::new(|e, mu| 238.0 + 6.0 * e.abs() + mu)),
        "sandblasted" => (18.0 + 26.0 * l, Box::new(|e, mu| 242.0 + 9.0 * e + 4.0 * mu)),
        "linen" => (25.0 + 38.0 * l, Box::new(|e: f64, mu| 232.0 + 14.0 * e.abs() + 2.0 * mu)),
        "carbon-fiber" => (25.0 + 38.0 * l, Box::new(|e: f64, mu| 218.0 + 18.0 * e.abs() + 2.0 * mu)),
        _ => {
            let contrast = 13.0 + 12.0 * l;
            (48.0 + 52.0 * l, Box::new(move |e: f64, mu| 228.0 + e.abs() * contrast + 2.0 * mu))
        }
    }
}

/// `surfaceModeLayout`: repeat, material anisotropy and its rotation, normal scale.
fn mode_layout(mode: &str, s: f64, l: f64) -> ([f32; 2], f32, f32, [f32; 2]) {
    use std::f32::consts::{FRAC_PI_2, FRAC_PI_4};
    let same = |k: f64| [k as f32, k as f32];
    match mode {
        "none" => ([1.0, 1.0], 0.12, 0.0, [0.0, 0.0]),
        "brushed" => ([1.5, 7.0], 1.0, FRAC_PI_2, [(0.01 + 0.055 * s) as f32, (0.025 + 0.17 * l) as f32]),
        "hammered" => (same(2.15), 0.03, 0.0, same(0.22 + 0.22 * l)),
        "sandblasted" => (same(3.4), 0.01, 0.0, same(0.08 + 0.12 * l)),
        "linen" => (same(3.1), 0.16, FRAC_PI_2, same(0.13 + 0.18 * l)),
        "carbon-fiber" => (same(2.35), 0.28, FRAC_PI_4, same(0.16 + 0.2 * l)),
        "crosshatch" => (same(2.6), 0.08, FRAC_PI_4, same(0.24 + 0.16 * l)),
        "pinpoint" => (same(2.4), 0.02, 0.0, same(0.28 + 0.18 * l)),
        _ => (same(1.0), 0.06, 0.0, same(0.1 + 0.06 * l)),
    }
}

/// Mip chain of an RGBA8 image (level 0 first), like a GPU's generateMipmap. `srgb`: filter in linear light.
pub fn mip_chain(data: &[u8], w: u32, h: u32, srgb: bool) -> Vec<(u32, u32, Vec<u8>)> {
    let to_lin = |b: u8| {
        let c = b as f32 / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let to_srgb = |c: f32| {
        let v = if c <= 0.0031308 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
        (v * 255.0 + 0.5).clamp(0.0, 255.0) as u8
    };
    let mut levels = vec![(w, h, data.to_vec())];
    while levels.last().map(|l| l.0 > 1 || l.1 > 1).unwrap_or(false) {
        let (pw, ph, prev) = levels.last().unwrap();
        let (nw, nh) = ((pw / 2).max(1), (ph / 2).max(1));
        let mut out = vec![0u8; (4 * nw * nh) as usize];
        // One bilinear tap at each output texel's centre in the level above, as GPUs generate mipmaps:
        // a 2×2 box for even sizes; for odd sizes the taps spread over the whole level, unshifted.
        let fetch = |x: u32, y: u32, c: usize| {
            let b = prev[4 * (y.min(ph - 1) * pw + x.min(pw - 1)) as usize + c];
            if srgb && c < 3 {
                to_lin(b)
            } else {
                b as f32
            }
        };
        for y in 0..nh {
            let v = ((y as f64 + 0.5) * *ph as f64 / nh as f64 - 0.5).max(0.0);
            let (y0, fy) = (v.floor() as u32, (v - v.floor()) as f32);
            for x in 0..nw {
                let u = ((x as f64 + 0.5) * *pw as f64 / nw as f64 - 0.5).max(0.0);
                let (x0, fx) = (u.floor() as u32, (u - u.floor()) as f32);
                for c in 0..4 {
                    let top = fetch(x0, y0, c) * (1.0 - fx) + fetch(x0 + 1, y0, c) * fx;
                    let bottom = fetch(x0, y0 + 1, c) * (1.0 - fx) + fetch(x0 + 1, y0 + 1, c) * fx;
                    let avg = top * (1.0 - fy) + bottom * fy;
                    out[(4 * (y * nw + x)) as usize + c] = if srgb && c < 3 { to_srgb(avg) } else { (avg + 0.5) as u8 };
                }
            }
        }
        levels.push((nw, nh, out));
    }
    levels
}
