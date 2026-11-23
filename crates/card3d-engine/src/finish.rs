//! Mark finishes (`card/finish.ts`): embossed, engraved and laser-etched marks made from the same
//! glyph masks as the default branding. A mask becomes a height field (blurred to the finish's
//! shoulder or wall width), its gradient a tangent-space normal map, plus a colour / alpha map (and,
//! engraved, a roughness map). The TypeScript stores the fields in Float32Arrays: here they are f32
//! too, with the arithmetic in f64, so the bytes match.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Finish {
    Embossed,
    Engraved,
    Etched,
}

impl Finish {
    /// A design's finish string; "default" (and anything unknown) is `None`: the plain branding material.
    pub fn parse(s: Option<&str>) -> Option<Finish> {
        match s {
            Some("embossed") => Some(Finish::Embossed),
            Some("engraved") => Some(Finish::Engraved),
            Some("etched") => Some(Finish::Etched),
            _ => None,
        }
    }

    /// Width of the emboss shoulder / engraving wall, card units (`FINISH_RELIEF_UNITS`).
    fn relief_units(self) -> f64 {
        match self {
            Finish::Embossed => 0.0065,
            Finish::Engraved => 0.008,
            Finish::Etched => 0.0012,
        }
    }
}

/// The finish maps (`FinishFields`): RGBA8, row 0 = top.
pub struct FinishFields {
    pub width: u32,
    pub height: u32,
    /// Padding added on each side, px.
    pub pad: u32,
    pub color: Vec<u8>,
    pub normal: Vec<u8>,
    pub roughness: Option<Vec<u8>>,
}

fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    hi.min(lo.max(x))
}

fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `blurField`: three separable box passes (≈ Gaussian) of radius round(radius / 1.73).
pub fn blur_field(src: &[f32], w: usize, h: usize, radius: f64) -> Vec<f32> {
    let r = round(radius / 1.73).max(0.0) as isize;
    if r < 1 {
        return src.to_vec();
    }
    let mut a = src.to_vec();
    let mut b = vec![0f32; src.len()];
    let pass = |from: &[f32], to: &mut [f32], horizontal: bool| {
        let (n, lines, step) = if horizontal { (w, h, 1) } else { (h, w, w) };
        let k = 1.0 / (2 * r + 1) as f64;
        let ci = |i: isize| i.clamp(0, n as isize - 1) as usize;
        for line in 0..lines {
            let base = if horizontal { line * w } else { line };
            let mut acc = 0.0f64;
            for i in -r..=r {
                acc += from[base + ci(i) * step] as f64;
            }
            for i in 0..n as isize {
                to[base + i as usize * step] = (acc * k) as f32;
                acc += from[base + ci(i + r + 1) * step] as f64 - from[base + ci(i - r) * step] as f64;
            }
        }
    };
    for _ in 0..3 {
        pass(&a, &mut b, true);
        pass(&b, &mut a, false);
    }
    a
}

fn smooth(e0: f64, e1: f64, x: f64) -> f64 {
    let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// `hashNoise`: deterministic per-texel noise in [-1, 1] (JS 32-bit integer semantics).
fn hash_noise(x: i64, y: i64) -> f64 {
    let n = (x * 374761393 + y * 668265263) as i32; // `| 0`: wraps to int32
    let n = (n ^ ((n as u32) >> 13) as i32).wrapping_mul(1274126177);
    let u = (n ^ ((n as u32) >> 16) as i32) as u32;
    u as f64 / 4294967295.0 * 2.0 - 1.0
}

/// `computeFinishFields`: the maps for a mask (alpha 0–255, w × h, row 0 = top) at `px_per_unit`
/// texels per card unit; `relief_scale` 0.35–1 makes small text shallower.
/// `compute_finish_fields` behind a split point: on the web it lives in the `finish` chunk, which
/// downloads the first time a design has a finished mark. Natively it is a direct call.
#[wasm_split_helpers::wasm_split(finish, fallible)]
pub fn compute_finish_fields_lazy(
    alpha: &[u8],
    w: usize,
    h: usize,
    finish: Finish,
    px_per_unit: f64,
    relief_scale: f64,
) -> Result<FinishFields, crate::ChunkUnavailable> {
    Ok(compute_finish_fields(alpha, w, h, finish, px_per_unit, relief_scale))
}

pub fn compute_finish_fields(alpha: &[u8], w: usize, h: usize, finish: Finish, px_per_unit: f64, relief_scale: f64) -> FinishFields {
    // Mean stroke half-width (area / outline length, px) caps the relief.
    let (mut area, mut outline) = (0.0f64, 0usize);
    for y in 0..h {
        for x in 0..w {
            let v = alpha[y * w + x] as f64 / 255.0;
            area += v;
            if v <= 0.5 {
                continue;
            }
            let edge = x == 0
                || y == 0
                || x == w - 1
                || y == h - 1
                || alpha[y * w + x - 1] <= 127
                || alpha[y * w + x + 1] <= 127
                || alpha[(y - 1) * w + x] <= 127
                || alpha[(y + 1) * w + x] <= 127;
            if edge {
                outline += 1;
            }
        }
    }
    let half_stroke = if outline > 0 { area / outline as f64 } else { f64::INFINITY };
    let relief = (finish.relief_units() * clamp(relief_scale, 0.35, 1.0) * px_per_unit).min(0.75 * half_stroke).max(1.0);
    let small = clamp((1.0 - relief_scale) / 0.6, 0.0, 1.0);
    let pad = if finish == Finish::Embossed { (relief * 2.0).ceil() as usize } else { 1 };
    let (ww, hh) = (w + 2 * pad, h + 2 * pad);
    let mut mask = vec![0f32; ww * hh];
    for y in 0..h {
        for x in 0..w {
            mask[(y + pad) * ww + x + pad] = (alpha[y * w + x] as f64 / 255.0) as f32;
        }
    }
    let blurred = blur_field(&mask, ww, hh, relief);
    let mut height = vec![0f32; ww * hh];
    let strength = match finish {
        Finish::Embossed => {
            for i in 0..height.len() {
                height[i] = smooth(0.0, 1.0, blurred[i] as f64) as f32;
            }
            relief * 0.85
        }
        Finish::Engraved => {
            for i in 0..height.len() {
                height[i] = -smooth(0.5, 0.97, blurred[i] as f64) as f32;
            }
            relief * 1.4
        }
        Finish::Etched => {
            for i in 0..height.len() {
                height[i] = (-0.35 * smooth(0.3, 0.9, blurred[i] as f64)) as f32;
            }
            relief * 1.2
        }
    };
    let mut color = vec![0u8; ww * hh * 4];
    let mut normal = vec![0u8; ww * hh * 4];
    let mut rough = (finish == Finish::Engraved).then(|| vec![0u8; ww * hh * 4]);
    let at = |x: isize, y: isize| height[y.clamp(0, hh as isize - 1) as usize * ww + x.clamp(0, ww as isize - 1) as usize] as f64;
    for y in 0..hh as isize {
        for x in 0..ww as isize {
            let i = y as usize * ww + x as usize;
            let du = (at(x + 1, y) - at(x - 1, y)) / 2.0;
            let dv = -(at(x, y + 1) - at(x, y - 1)) / 2.0; // canvas y runs down, v runs up
            let mut nx = -strength * du;
            let mut ny = -strength * dv;
            let m = mask[i] as f64;
            if finish == Finish::Etched && m > 0.02 {
                nx += 0.22 * m * hash_noise(x as i64, y as i64);
                ny += 0.22 * m * hash_noise(y as i64 + 7919, x as i64 + 104729);
            }
            let inv = 1.0 / (nx * nx + ny * ny + 1.0).sqrt();
            normal[i * 4] = round((nx * inv * 0.5 + 0.5) * 255.0) as u8;
            normal[i * 4 + 1] = round((ny * inv * 0.5 + 0.5) * 255.0) as u8;
            normal[i * 4 + 2] = round((inv * 0.5 + 0.5) * 255.0) as u8;
            normal[i * 4 + 3] = 255;
            let b = blurred[i] as f64;
            let (shade, a) = match finish {
                Finish::Embossed => (1.0 - (0.12 + 0.22 * small) * m, smooth(0.04, 0.35, b)),
                Finish::Engraved => {
                    let depth = -(height[i] as f64);
                    let floor = smooth(0.35, 1.0, depth);
                    let r = rough.as_mut().unwrap();
                    r[i * 4] = 255;
                    r[i * 4 + 1] = round((0.14 + 0.5 * floor) * 255.0) as u8;
                    r[i * 4 + 2] = 255;
                    r[i * 4 + 3] = 255;
                    (1.0 - (0.4 * floor).max((0.15 + 0.4 * small) * m), smooth(0.35, 0.6, m.max(b)))
                }
                Finish::Etched => (0.92 + 0.08 * hash_noise(x as i64 * 3 + 1, y as i64 * 5 + 2) - 0.12 * small * m, smooth(0.3, 0.65, m.max(b))),
            };
            let g = round(clamp(shade, 0.0, 1.0) * 255.0) as u8;
            color[i * 4..i * 4 + 3].fill(g);
            color[i * 4 + 3] = round(a * 255.0) as u8;
        }
    }
    FinishFields { width: ww as u32, height: hh as u32, pad: pad as u32, color, normal, roughness: rough }
}

/// The finished mark's material scalars (`createFinishMaterial`) from the branding input: colour
/// (linear), metalness, roughness (`None`: from the roughness map, at 1), clearcoat, clearcoat roughness.
pub struct FinishMaterial {
    pub color: [f32; 3],
    pub metalness: f32,
    pub roughness: f32,
    pub clearcoat: f32,
    pub clearcoat_roughness: f32,
}

/// `color_srgb` is the branding colour as sRGB hex; `small` 0 (name-sized) … 1 (the smallest text).
pub fn finish_material(
    finish: Finish,
    color_srgb: &str,
    metalness: Option<f64>,
    roughness: Option<f64>,
    clearcoat: Option<f64>,
    clearcoat_roughness: Option<f64>,
    small: f64,
) -> FinishMaterial {
    let base = crate::material::srgb_hex_to_linear(color_srgb);
    let metal = metalness.unwrap_or(1.0);
    match finish {
        Finish::Embossed => FinishMaterial {
            color: base,
            metalness: metal as f32,
            roughness: clamp(roughness.unwrap_or(0.27), 0.12, 0.7) as f32,
            clearcoat: clearcoat.unwrap_or(0.03) as f32,
            clearcoat_roughness: clearcoat_roughness.unwrap_or(0.38) as f32,
        },
        Finish::Engraved => FinishMaterial { color: base, metalness: metal as f32, roughness: 1.0, clearcoat: 0.0, clearcoat_roughness: 0.0 },
        Finish::Etched => {
            // A laser lifts a dark finish off (bright frosted metal) or anneals light metal (darker grey):
            // pick by the face's sRGB lightness, so the etch contrasts with it; lerp in linear space.
            let srgb = crate::material::srgb_hex_to_srgb(color_srgb);
            let (mx, mn) = (srgb.iter().copied().fold(f64::MIN, f64::max), srgb.iter().copied().fold(f64::MAX, f64::min));
            let light = (mx + mn) / 2.0 > 0.62;
            let target = crate::material::srgb_hex_to_linear(if light { "#5d6066" } else { "#dcdde1" });
            let t = clamp(0.5 + 0.3 * small, 0.0, 1.0) as f32;
            let color = [0, 1, 2].map(|k| base[k] + (target[k] - base[k]) * t);
            FinishMaterial { color, metalness: metal.min(0.55) as f32, roughness: 0.72, clearcoat: 0.0, clearcoat_roughness: 0.0 }
        }
    }
}
