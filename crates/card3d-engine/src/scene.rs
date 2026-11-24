//! Scenes (`CardDesign.scene`; scene/staging.ts and scene/marketing/): product-shot staging around the
//! card. An HDRI environment (one of the catalog's gain-mapped `.webp` files, or a `.hdr` / `.webp`
//! URL) in place of the studio rig, graded by the design's lighting preset; a backdrop (a sweep, a
//! radial gradient, or the HDRI itself, blurred); a floor with the card's reflection and a contact
//! shadow; and the framing a floor or sweep asks for (`stagingView`, applied by the stage).
//!
//! On the web all of it is the `scene` chunk: [`load`] (the split point) decodes the environment and
//! prefilters it before the renderer is made, and returns a [`Plan`] whose `finish` adds the staging's
//! items once the card is built and installs its per-frame passes (`FramePasses`, through the vtable).
//! The host loads the environment file (`Host::environment`); the engine decodes it here.

use glam::{DMat4, DVec3, Mat4, Vec3};
use std::rc::Rc;

use crate::canvas::{EnvironmentFile, Host, Paint};
use crate::design::CardDesign;
use crate::effects::{self, PipelineOptions, Target};
use crate::env::{self, EnvSize, ATLAS_FORMAT};
use crate::geometry::Mesh;
use crate::json::{Map, Value};
use crate::quality::Quality;
use crate::renderer::{Camera, CustomDraw, FramePasses, Item, Material, PassFrame, PassStage, Renderer, GLASS_BUFFER_FORMAT};
use crate::stage::StagingView;
use crate::ChunkUnavailable;

// ── the resolved scene (staging.ts) ──────────────────────────────────────────

/// `SceneBackdrop`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backdrop {
    None,
    Sweep,
    Gradient,
    Environment,
}

/// `CardFloor` with its defaults.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Floor {
    pub reflectivity: f64,
    pub shadow: f64,
    pub blur: f64,
}

/// `ResolvedScene`: the scene with every default filled in.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedScene {
    /// "studio" or an environment id / URL.
    pub environment: String,
    pub environment_intensity: f64,
    pub environment_rotation: f64,
    pub backdrop: Backdrop,
    pub backdrop_color: Option<String>,
    pub backdrop_blur: f64,
    pub floor: Option<Floor>,
}

/// Gap between the card's lower edge and the floor (`FLOOR_GAP`).
pub const FLOOR_GAP: f64 = 0.06;

/// `resolveScene`: the scene with defaults, or `None` when it changes nothing (the studio environment
/// at its own intensity and turn, no backdrop and no floor).
pub fn resolve_scene(scene: &Map) -> Option<ResolvedScene> {
    let num = |k: &str, d: f64| scene.get(k).and_then(Value::as_f64).unwrap_or(d);
    let environment = scene.get("environment").and_then(Value::as_str).filter(|e| !e.is_empty() && *e != "studio").unwrap_or("studio");
    let backdrop = match scene.get("backdrop").and_then(Value::as_str) {
        Some("sweep") => Backdrop::Sweep,
        Some("gradient") => Backdrop::Gradient,
        Some("environment") => Backdrop::Environment,
        _ => Backdrop::None,
    };
    let floor = scene.get("floor").and_then(Value::as_object).map(|f| {
        let n = |k: &str, d: f64| f.get(k).and_then(Value::as_f64).unwrap_or(d);
        Floor { reflectivity: n("reflectivity", 0.45), shadow: n("shadow", 0.6), blur: n("blur", 0.35) }
    });
    let r = ResolvedScene {
        environment: environment.to_string(),
        environment_intensity: num("environmentIntensity", 1.0),
        environment_rotation: num("environmentRotation", 0.0),
        backdrop,
        backdrop_color: scene.get("backdropColor").and_then(Value::as_str).map(str::to_string),
        backdrop_blur: num("backdropBlur", 0.45),
        floor,
    };
    let inert =
        r.environment == "studio" && r.environment_intensity == 1.0 && r.environment_rotation == 0.0 && r.backdrop == Backdrop::None && r.floor.is_none();
    (!inert).then_some(r)
}

/// `cardFrameSize(design).height`: shapes turn only metal bodies portrait.
pub fn frame_height(design: &CardDesign) -> f64 {
    let glass = design.recipe.material == "glass" || design.material_override.as_ref().and_then(|m| m.transmission).unwrap_or(0.0) > 0.5;
    let portrait = !glass && design.shape.as_ref().and_then(|s| s.get("orientation")).and_then(Value::as_str) == Some("portrait");
    if portrait {
        crate::layout::CARD_W
    } else {
        crate::layout::CARD_H
    }
}

/// `stagingView`: the framing of a scene with a floor or a sweep (else `None`).
pub fn staging_view(scene: &ResolvedScene, frame_height: f64) -> Option<StagingView> {
    if scene.floor.is_none() && scene.backdrop != Backdrop::Sweep {
        return None;
    }
    let floor_y = -frame_height / 2.0 - FLOOR_GAP;
    let floor = scene.floor.is_some();
    Some(StagingView {
        elevation: (9.0 * std::f64::consts::PI) / 180.0,
        target_y: if floor { -frame_height * 0.16 } else { 0.0 },
        distance: if floor { 1.12 } else { 1.0 },
        floor_y: Some(floor_y),
    })
}

// ── the environments (environments.ts) and the presets' HDRI looks (lighting-presets.ts) ─────────

/// The catalog (`SCENE_ENVIRONMENTS`): id, intensity, default turn (degrees).
const ENVIRONMENTS: [(&str, f64, f64); 5] =
    [("softbox", 0.65, 330.0), ("cyclorama", 0.45, 180.0), ("loft", 0.5, 60.0), ("warm-hall", 0.6, 60.0), ("sunset", 0.7, 120.0)];

/// `getSceneEnvironment`: (intensity, turn) of a catalog id.
pub fn catalog(id: &str) -> Option<(f64, f64)> {
    ENVIRONMENTS.iter().find(|e| e.0 == id).map(|e| (e.1, e.2))
}

/// Whether the environment loads from a file (`environmentUrl` isn't null): a catalog id, or a URL of a
/// `.hdr` / `.webp` file.
pub fn has_file(env: &str) -> bool {
    if env.is_empty() || env == "studio" {
        return false;
    }
    if catalog(env).is_some() {
        return true;
    }
    let path = env.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    // `/\.(hdr|webp)([?#].*)?$/i`: the query may hold no line break.
    !env.contains('\n') && (path.ends_with(".hdr") || path.ends_with(".webp"))
}

/// `EnvironmentGrade`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grade {
    pub key: f64,
    pub fill: f64,
    pub base: f64,
    pub saturation: f64,
    pub rim: f64,
    /// Degrees.
    pub turn: f64,
}

/// A lighting preset's grade of an HDRI (`preset.hdri`; none for "studio").
pub fn preset_grade(id: &str) -> Option<Grade> {
    let g = |key, fill, base| Grade { key, fill, base, saturation: 1.0, rim: 1.0, turn: 0.0 };
    match id {
        "dramatic" => Some(Grade { turn: 15.0, ..g(1.6, 0.25, 0.35) }),
        "warm" => Some(g(1.1, 1.1, 1.05)),
        "cool" => Some(g(1.2, 1.25, 1.2)),
        "dark" => Some(g(0.6, 0.4, 0.35)),
        "light" => Some(Grade { saturation: 0.9, ..g(1.5, 1.9, 2.2) }),
        _ => None,
    }
}

/// A lighting preset's backdrop (`LightingBackdrop`): inner, outer, glow centre.
pub fn preset_backdrop(id: &str) -> (&'static str, &'static str, [f64; 2]) {
    match id {
        "dramatic" => ("#454a62", "#040407", [0.6, 0.4]),
        "warm" => ("#4a3328", "#120b08", [0.5, 0.4]),
        "cool" => ("#22324a", "#060a12", [0.5, 0.36]),
        "dark" => ("#18181d", "#000000", [0.5, 0.45]),
        "light" => ("#ffffff", "#d5d8df", [0.5, 0.4]),
        _ => ("#3a3d4d", "#0b0b10", [0.55, 0.42]),
    }
}

// ── colour (three's Color with colour management) ────────────────────────────

fn srgb_to_linear(c: f64) -> f64 {
    if c < 0.04045 {
        c * 0.0773993808
    } else {
        (c * 0.9478672986 + 0.0521327014).powf(2.4)
    }
}

fn linear_to_srgb(c: f64) -> f64 {
    if c < 0.0031308 {
        c * 12.92
    } else {
        1.055 * c.powf(0.41666) - 0.055
    }
}

/// `new Color(hex)` in the working (linear) space, f64 as three keeps it.
pub fn hex_linear(hex: &str) -> [f64; 3] {
    let h = hex.trim_start_matches('#');
    let v = if h.len() == 3 {
        let d = |i: usize| u32::from_str_radix(&h[i..i + 1], 16).unwrap_or(0) as f64 / 15.0;
        return [d(0), d(1), d(2)].map(srgb_to_linear);
    } else {
        u32::from_str_radix(h, 16).unwrap_or(0)
    };
    [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(|c| srgb_to_linear(c as f64 / 255.0))
}

fn hue2rgb(p: f64, q: f64, mut t: f64) -> f64 {
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        return p + (q - p) * 6.0 * t;
    }
    if t < 1.0 / 2.0 {
        return q;
    }
    if t < 2.0 / 3.0 {
        return p + (q - p) * 6.0 * (2.0 / 3.0 - t);
    }
    p
}

/// `shadeColor`: a lighter (`k` > 0) or darker variant of a colour, by its HSL lightness in three's
/// working (linear) space, as "#rrggbb".
pub fn shade_color(hex: &str, k: f64) -> String {
    let [r, g, b] = hex_linear(hex);
    // getHSL
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let l = (min + max) / 2.0;
    let (h, s) = if min == max {
        (0.0, 0.0)
    } else {
        let d = max - min;
        let s = if l <= 0.5 { d / (max + min) } else { d / (2.0 - max - min) };
        let h = if max == r {
            (g - b) / d + if g < b { 6.0 } else { 0.0 }
        } else if max == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };
        (h / 6.0, s)
    };
    let l = (if k >= 0.0 { l + (1.0 - l) * k } else { l * (1.0 + k) }).clamp(0.0, 1.0);
    // setHSL
    let h = h.rem_euclid(1.0);
    let s = s.clamp(0.0, 1.0);
    let rgb = if s == 0.0 {
        [l; 3]
    } else {
        let p = if l <= 0.5 { l * (1.0 + s) } else { l + s - l * s };
        let q = 2.0 * l - p;
        [hue2rgb(q, p, h + 1.0 / 3.0), hue2rgb(q, p, h), hue2rgb(q, p, h - 1.0 / 3.0)]
    };
    // getHexString
    let byte = |c: f64| (linear_to_srgb(c) * 255.0).clamp(0.0, 255.0).round() as u32;
    format!("#{:02x}{:02x}{:02x}", byte(rgb[0]), byte(rgb[1]), byte(rgb[2]))
}

// ── decoding (environment.ts, three's HDRLoader and DataUtils) ───────────────

/// Decoded environment pixels: RGBA half floats, top row first.
#[derive(Clone, Debug, PartialEq)]
pub struct EnvironmentPixels {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u16>,
}

/// three's `DataUtils.toHalfFloat` (fox-toolkit tables: the f32's mantissa is truncated).
pub fn to_half(val: f64) -> u16 {
    let f = (val.clamp(-65504.0, 65504.0) as f32).to_bits();
    let e = ((f >> 23) & 0x1ff) as usize;
    let (base, shift) = half_tables(e);
    (base + ((f & 0x007f_ffff) >> shift)) as u16
}

fn half_tables(i: usize) -> (u32, u32) {
    let sign = if i & 0x100 != 0 { 0x8000 } else { 0 };
    let e = (i & 0xff) as i32 - 127;
    if e < -27 {
        (sign, 24)
    } else if e < -14 {
        ((0x0400 >> (-e - 14)) | sign, (-e - 1) as u32)
    } else if e <= 15 {
        ((((e + 15) << 10) as u32) | sign, 13)
    } else if e < 128 {
        (0x7c00 | sign, 24)
    } else {
        (0x7c00 | sign, 13)
    }
}

/// three's `DataUtils.fromHalfFloat`.
pub fn from_half(h: u16) -> f32 {
    let (sign, exp, man) = ((h >> 15) as u32, ((h >> 10) & 0x1f) as u32, (h & 0x3ff) as u32);
    let bits = match (exp, man) {
        (0, 0) => sign << 31,
        (0, m) => {
            // A subnormal: normalise.
            let mut e = -14i32;
            let mut m = m;
            while m & 0x400 == 0 {
                m <<= 1;
                e -= 1;
            }
            (sign << 31) | (((e + 127) as u32) << 23) | ((m & 0x3ff) << 13)
        }
        (31, m) => (sign << 31) | 0x7f80_0000 | (m << 13),
        (e, m) => (sign << 31) | ((e + 112) << 23) | (m << 13),
    };
    f32::from_bits(bits)
}

/// Stops of headroom of the gain plane (`GAIN_STOPS`).
pub const GAIN_STOPS: f64 = 16.0;

/// `decodeGainMap`: the W × 2H gain-mapped image (base on top, gain below) into linear half floats.
pub fn decode_gain_map(rgba: &[u8], width: u32, full_height: u32) -> EnvironmentPixels {
    let h = full_height / 2;
    let n = (width * h) as usize;
    // Float32Array tables, as the TypeScript keeps them.
    let lin: Vec<f32> = (0..256)
        .map(|i| {
            let v = i as f64 / 255.0;
            (if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }) as f32
        })
        .collect();
    let gain: Vec<f32> = (0..256).map(|i| 2f64.powf(i as f64 / 255.0 * GAIN_STOPS) as f32).collect();
    let one = to_half(1.0);
    let mut out = vec![0u16; n * 4];
    for i in 0..n {
        let k = gain[rgba[(n + i) * 4] as usize] as f64;
        let o = i * 4;
        for c in 0..3 {
            out[o + c] = to_half((lin[rgba[o + c] as usize] as f64 * k).min(65504.0));
        }
        out[o + 3] = one;
    }
    EnvironmentPixels { width, height: h, data: out }
}

/// A Radiance `.hdr` file (three's `HDRLoader` with half floats), or `None` if it doesn't parse.
pub fn decode_rgbe(bytes: &[u8]) -> Option<EnvironmentPixels> {
    // The header: lines up to the format and the dimensions.
    let mut pos = 0usize;
    let mut line = || -> Option<String> {
        let end = bytes[pos..].iter().position(|&b| b == b'\n')?;
        let s: String = bytes[pos..pos + end].iter().map(|&b| b as char).collect();
        pos += end + 1;
        Some(s)
    };
    let first = line()?;
    if !first.starts_with("#?") || first.len() < 3 || first.as_bytes()[2].is_ascii_whitespace() {
        return None;
    }
    let (mut format, mut dims) = (false, None);
    while !(format && dims.is_some()) {
        let l = line()?;
        if l.starts_with('#') {
            continue;
        }
        let t = l.trim();
        if t.starts_with("FORMAT=") && !t[7..].is_empty() && !t[7..].contains(char::is_whitespace) {
            format = true;
        }
        let w: Vec<&str> = t.split_whitespace().collect();
        if w.len() == 4 && w[0] == "-Y" && w[2] == "+X" {
            if let (Ok(h), Ok(wd)) = (w[1].parse::<u32>(), w[3].parse::<u32>()) {
                dims = Some((wd, h));
            }
        }
    }
    let (w, h) = dims?;
    let data = &bytes[pos..];
    let rgbe = read_pixels_rle(data, w, h)?;
    let n = (w * h) as usize;
    if rgbe.len() < n * 4 {
        return None;
    }
    let one = to_half(1.0);
    let mut out = vec![0u16; n * 4];
    for j in 0..n {
        let e = rgbe[j * 4 + 3] as f64;
        let scale = 2f64.powf(e - 128.0) / 255.0;
        for c in 0..3 {
            out[j * 4 + c] = to_half((rgbe[j * 4 + c] as f64 * scale).min(65504.0));
        }
        out[j * 4 + 3] = one;
    }
    Some(EnvironmentPixels { width: w, height: h, data: out })
}

/// `RGBE_ReadPixels_RLE`.
fn read_pixels_rle(buffer: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let width = w as usize;
    if !(8..=0x7fff).contains(&width) || buffer.len() < 4 || buffer[0] != 2 || buffer[1] != 2 || buffer[2] & 0x80 != 0 {
        // Not run-length encoded: the bytes as they are.
        return Some(buffer.to_vec());
    }
    if width != (((buffer[2] as usize) << 8) | buffer[3] as usize) {
        return None;
    }
    let mut out = vec![0u8; 4 * width * h as usize];
    let (mut offset, mut pos) = (0usize, 0usize);
    let mut scan = vec![0u8; 4 * width];
    let mut lines = h;
    while lines > 0 && pos < buffer.len() {
        if pos + 4 > buffer.len() {
            return None;
        }
        let s = &buffer[pos..pos + 4];
        pos += 4;
        if s[0] != 2 || s[1] != 2 || (((s[2] as usize) << 8) | s[3] as usize) != width {
            return None;
        }
        let mut ptr = 0usize;
        while ptr < 4 * width && pos < buffer.len() {
            let mut count = buffer[pos] as usize;
            pos += 1;
            let run = count > 128;
            if run {
                count -= 128;
            }
            if count == 0 || ptr + count > 4 * width {
                return None;
            }
            if run {
                let v = *buffer.get(pos)?;
                pos += 1;
                scan[ptr..ptr + count].fill(v);
            } else {
                let end = (pos + count).min(buffer.len());
                let src = &buffer[pos..end];
                scan[ptr..ptr + src.len()].copy_from_slice(src);
                pos += count;
            }
            ptr += count;
        }
        for i in 0..width {
            for c in 0..4 {
                out[offset + c] = scan[i + c * width];
            }
            offset += 4;
        }
        lines -= 1;
    }
    Some(out)
}

/// An environment file decoded.
pub fn decode(file: &EnvironmentFile) -> Option<EnvironmentPixels> {
    match file {
        EnvironmentFile::GainMap(img) => (img.width > 0 && img.height >= 2).then(|| decode_gain_map(&img.rgba, img.width, img.height)),
        EnvironmentFile::Radiance(bytes) => decode_rgbe(bytes),
    }
}

// ── environment statistics (grade.ts) ────────────────────────────────────────

/// `EnvironmentStats`: the brightness bands and the key light's direction.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EnvironmentStats {
    pub room: f64,
    pub lights: f64,
    pub key: [f64; 3],
}

/// `Math.hypot` as V8 computes it (scaled, Kahan-summed).
fn hypot3(a: f64, b: f64, c: f64) -> f64 {
    let max = a.abs().max(b.abs()).max(c.abs());
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut comp) = (0.0f64, 0.0f64);
    for v in [a, b, c] {
        let r = (v / max) * (v / max) - comp;
        let p = sum + r;
        comp = (p - sum) - r;
        sum = p;
    }
    sum.sqrt() * max
}

fn texel_direction(x: u32, y: u32, w: u32, h: u32) -> [f64; 3] {
    let phi = ((x as f64 + 0.5) / w as f64 - 0.5) * 2.0 * std::f64::consts::PI;
    let theta = (0.5 - (y as f64 + 0.5) / h as f64) * std::f64::consts::PI;
    [theta.cos() * phi.cos(), theta.sin(), theta.cos() * phi.sin()]
}

/// `environmentStats`: solid-angle weighted percentiles of luminance and the key light's direction,
/// from every other texel.
pub fn environment_stats(px: &EnvironmentPixels) -> EnvironmentStats {
    const BINS: usize = 512;
    const LO: f64 = -20.0;
    const HI: f64 = 16.0;
    let (w, h) = (px.width, px.height);
    let mut hist = vec![0f64; BINS];
    let mut lum: Vec<f32> = Vec::with_capacity(w.div_ceil(2) as usize * h.div_ceil(2) as usize);
    let mut total = 0.0;
    let half = |i: usize| from_half(px.data[i]) as f64;
    for y in (0..h).step_by(2) {
        let wt = (((y as f64 + 0.5) / h as f64 - 0.5) * std::f64::consts::PI).cos();
        for x in (0..w).step_by(2) {
            let o = ((y * w + x) * 4) as usize;
            let l = 0.2126 * half(o) + 0.7152 * half(o + 1) + 0.0722 * half(o + 2);
            lum.push(l as f32);
            let b = (((l.max(2f64.powf(LO)).log2() - LO) / (HI - LO)) * BINS as f64).floor().max(0.0).min((BINS - 1) as f64) as usize;
            hist[b] += wt;
            total += wt;
        }
    }
    let at = |share: f64| {
        let mut acc = 0.0;
        for (i, v) in hist.iter().enumerate() {
            acc += v;
            if acc >= share * total {
                return LO + ((i as f64 + 0.5) / BINS as f64) * (HI - LO);
            }
        }
        HI
    };
    let room = at(0.9);
    let lights = at(0.995).max(room + 2.0);

    const CW: usize = 32;
    const CH: usize = 16;
    let mut cells = vec![0f64; CW * CH * 4];
    let floor = 2f64.powf(room);
    let mut i = 0usize;
    for y in (0..h).step_by(2) {
        let sa = (((y as f64 + 0.5) / h as f64 - 0.5) * std::f64::consts::PI).cos();
        for x in (0..w).step_by(2) {
            let e = (lum[i] as f64 - floor).max(0.0) * sa;
            i += 1;
            if e <= 0.0 {
                continue;
            }
            let cy = ((y as f64 / h as f64) * CH as f64).floor().min((CH - 1) as f64) as usize;
            let cx = ((x as f64 / w as f64) * CW as f64).floor().min((CW - 1) as f64) as usize;
            let c = (cy * CW + cx) * 4;
            let d = texel_direction(x, y, w, h);
            cells[c] += e;
            cells[c + 1] += e * d[0];
            cells[c + 2] += e * d[1];
            cells[c + 3] += e * d[2];
        }
    }
    let lobe = (30.0 * (std::f64::consts::PI / 180.0)).cos();
    let mut best = -1.0;
    let mut key = [0.0, 0.0, 1.0];
    for a in 0..CW * CH {
        let ea = cells[a * 4];
        if ea <= 0.0 {
            continue;
        }
        let (ax, ay, az) = (cells[a * 4 + 1] / ea, cells[a * 4 + 2] / ea, cells[a * 4 + 3] / ea);
        let al = Some(hypot3(ax, ay, az)).filter(|v| *v != 0.0).unwrap_or(1.0);
        let (mut score, mut sx, mut sy, mut sz) = (0.0, 0.0, 0.0, 0.0);
        for b in 0..CW * CH {
            let eb = cells[b * 4];
            if eb <= 0.0 {
                continue;
            }
            let (bx, by, bz) = (cells[b * 4 + 1], cells[b * 4 + 2], cells[b * 4 + 3]);
            if (ax * bx + ay * by + az * bz) / (al * hypot3(bx, by, bz)) < lobe {
                continue;
            }
            score += eb;
            sx += bx;
            sy += by;
            sz += bz;
        }
        if score > best {
            best = score;
            let l = Some(hypot3(sx, sy, sz)).filter(|v| *v != 0.0).unwrap_or(1.0);
            key = [sx / l, sy / l, sz / l];
        }
    }
    EnvironmentStats { room, lights, key }
}

// ── geometry (backdrop.ts, floor.ts) ─────────────────────────────────────────

fn mesh(positions: Vec<[f32; 3]>, indices: Vec<u32>) -> Mesh {
    let n = positions.len();
    Mesh { positions, normals: vec![[0.0, 1.0, 0.0]; n], uvs: vec![[0.0; 2]; n], indices }
}

/// `sweepGeometry`: the floor from the front, a quarter-circle cove behind the card, then the wall.
pub fn sweep_geometry(floor_y: f64) -> Mesh {
    let front = 16.0;
    let cove_z = -1.6;
    let r = 2.6;
    let top = floor_y + 18.0;
    let mut profile: Vec<[f64; 2]> = Vec::new();
    let mut z = front;
    while z > cove_z {
        profile.push([z, floor_y]);
        z -= 1.0;
    }
    for i in 0..=24 {
        let a = (i as f64 / 24.0) * (std::f64::consts::PI / 2.0);
        profile.push([cove_z - r * a.sin(), floor_y + r - r * a.cos()]);
    }
    let mut y = floor_y + r + 1.0;
    while y <= top {
        profile.push([cove_z - r, y]);
        y += 2.0;
    }
    let half = 40.0f32;
    let (mut pos, mut idx) = (Vec::new(), Vec::new());
    for (i, [z, y]) in profile.iter().enumerate() {
        pos.push([-half, *y as f32, *z as f32]);
        pos.push([half, *y as f32, *z as f32]);
        if i > 0 {
            let a = ((i - 1) * 2) as u32;
            idx.extend([a, a + 1, a + 2, a + 1, a + 3, a + 2]);
        }
    }
    mesh(pos, idx)
}

/// three's `PlaneGeometry(size, size)` (one segment), in the xy plane facing +z.
fn plane(size: f32) -> Mesh {
    let h = size / 2.0;
    mesh(vec![[-h, h, 0.0], [h, h, 0.0], [-h, -h, 0.0], [h, -h, 0.0]], vec![0, 2, 1, 2, 3, 1])
}

/// `gradientTexture`'s pixels: a radial gradient on a 512² canvas, with its noise (row 0 = top).
pub fn gradient_pixels(host: &dyn Host, inner: &str, outer: &str, at: [f64; 2]) -> Vec<u8> {
    let size = 512u32;
    let mut c = host.canvas(size, size);
    let (cx, cy) = (at[0] * size as f64, at[1] * size as f64);
    c.set_fill(Paint::Radial { from: [cx, cy, 0.0], to: [cx, cy, size as f64 * 0.82], stops: vec![(0.0, inner.to_string()), (1.0, outer.to_string())] });
    c.fill_rect(0.0, 0.0, size as f64, size as f64);
    let mut data = c.get_image_data();
    gradient_noise(&mut data);
    data
}

/// The gradient's dither: ±0.8 of noise per pixel (a Park–Miller generator), into a Uint8ClampedArray.
pub fn gradient_noise(data: &mut [u8]) {
    let mut seed: f64 = 1.0;
    let mut rand = || {
        seed = (seed * 16807.0) % 2147483647.0;
        seed / 2147483647.0 - 0.5
    };
    // ToUint8Clamp: round half to even.
    let clamp = |v: f64| -> u8 {
        if v.is_nan() || v <= 0.0 {
            return 0;
        }
        if v >= 255.0 {
            return 255;
        }
        let f = v.floor();
        // Above the midpoint, or on it with an odd floor: up.
        let up = f + 0.5 < v || (f + 0.5 == v && f % 2.0 != 0.0);
        let r = if up { f + 1.0 } else { f };
        r as u8
    };
    for px in data.as_chunks_mut::<4>().0 {
        let n = rand() * 1.6;
        for c in &mut px[..3] {
            *c = clamp(*c as f64 + n);
        }
    }
}

// ── the floor's cameras ──────────────────────────────────────────────────────

/// The camera mirrored in the floor plane y = `y` (`renderReflection`): position, view direction and
/// up mirrored, then `lookAt` (a proper rotation, so the reflection renders with the usual winding).
pub fn mirror_camera(cam: &Camera, y: f64) -> Camera {
    let world = cam.view.inverse();
    let rot = DMat4::from_cols(world.x_axis, world.y_axis, world.z_axis, glam::DVec4::W);
    let eye = cam.eye;
    let look = rot.transform_point3(DVec3::new(0.0, 0.0, -1.0)) + eye;
    let mirror = |v: DVec3| DVec3::new(v.x, 2.0 * y - v.y, v.z);
    let mut up = rot.transform_point3(DVec3::Y);
    up.y = -up.y;
    let m = mirror(eye);
    let view = crate::renderer::look_at_matrix(m, mirror(look), up).inverse();
    Camera { eye: m, view, azimuth: cam.azimuth }
}

/// Side of the square the contact shadow covers, card units (centred under the card).
const SHADOW_SIZE: f64 = 7.0;
/// Height above the floor that still casts shadow.
const SHADOW_HEIGHT: f64 = 1.4;
const SHADOW_RES: u32 = 256;

/// The shadow camera's projection · view: an orthographic camera at the floor looking straight up
/// (its x is world x and its y world z), from the floor to `SHADOW_HEIGHT` above it.
pub fn shadow_view_proj(y: f64) -> DMat4 {
    let world = crate::renderer::look_at_matrix(DVec3::new(0.0, y, 0.0), DVec3::new(0.0, y + 1.0, 0.0), DVec3::Z);
    let h = SHADOW_SIZE / 2.0;
    glam::dcamera::rh::proj::directx::orthographic(-h, h, -h, h, 0.0, SHADOW_HEIGHT) * world.inverse()
}

// ── the plan (the split point) ───────────────────────────────────────────────

/// A scene's staging build, once the card is built: adds its items and passes, returns its framing.
pub type Finish = Box<dyn FnOnce(&mut Renderer, &wgpu::Device, &wgpu::Queue, &dyn Host) -> Option<StagingView>>;

/// What a scene asks of the card build: the environment and its light, and the staging's build.
pub struct Plan {
    /// The HDRI's prefiltered atlas and its size (`None`: the studio rig).
    pub environment: Option<(wgpu::Texture, EnvSize)>,
    /// `scene.environmentIntensity` and `environmentRotation.y` (radians).
    pub env_intensity: f64,
    pub env_rotation_y: f64,
    /// A backdrop is staged (a glass card's environment then loses its blue clear).
    pub staged_backdrop: bool,
    /// A floor reflects the card (its custom draws need pipelines for half-float targets).
    pub reflective: bool,
    /// Adds the staging's items and passes once the card is built; returns its framing.
    pub finish: Finish,
}

/// The scene of `design` (`None`: none, or one that changes nothing): its environment decoded and
/// prefiltered, as the stage's staging prepares and applies it. The `scene` chunk: only designs with a
/// scene download it.
#[wasm_split_helpers::wasm_split(scene, fallible)]
pub fn load(device: &wgpu::Device, queue: &wgpu::Queue, design: &CardDesign, host: &dyn Host, quality: Quality) -> Result<Option<Plan>, ChunkUnavailable> {
    Ok(plan(device, queue, design, host, quality))
}

/// An HDRI environment made for an earlier card (`Prepared`): the key it was made for, the prefiltered
/// atlas and its size, the sharp backdrop's cube, and the environment's turn.
struct Prepared {
    /// The device's address (`renderer::device_in_use`).
    device: usize,
    key: (String, u64, &'static str, bool),
    env: (wgpu::Texture, EnvSize),
    sharp: Option<wgpu::Texture>,
    rotation: f64,
}

thread_local! {
    /// The last two HDRI environments made: a stage going through designs with the same scene (the
    /// exports' and thumbnails' stages) decodes and prefilters it once.
    static PREPARED: std::cell::RefCell<Vec<Prepared>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn plan(device: &wgpu::Device, queue: &wgpu::Queue, design: &CardDesign, host: &dyn Host, quality: Quality) -> Option<Plan> {
    let scene = resolve_scene(design.scene()?)?;
    let preset = crate::lighting::preset(design.lighting.as_deref());
    let meta = catalog(&scene.environment);
    let wants_sharp = scene.backdrop == Backdrop::Environment && scene.backdrop_blur <= 0.0;
    let key = (scene.environment.clone(), scene.environment_rotation.to_bits(), preset.id, wants_sharp);
    let at = std::ptr::from_ref::<wgpu::Device>(device) as usize;
    // Entries of a device no card uses any more may be another device's at the same address.
    if !crate::renderer::device_in_use(device) {
        PREPARED.with_borrow_mut(|p| p.retain(|e| e.device != at));
    }
    let prepared = PREPARED.with_borrow(|p| p.iter().find(|e| e.device == at && e.key == key).map(|e| (e.env.clone(), e.sharp.clone(), e.rotation)));
    let pixels = match prepared {
        Some(_) => None,
        None => has_file(&scene.environment).then(|| host.environment(&scene.environment)).flatten().and_then(|f| decode(&f)),
    };
    // (A file that didn't load or decode leaves the studio environment, as three's staging does; the
    // page reports the failed load.)
    let deg = |d: f64| d * (std::f64::consts::PI / 180.0);
    let mut env = None;
    let mut sharp = None;
    let (env_intensity, env_rotation_y);
    if let Some((e, s, rotation)) = prepared {
        env = Some(e);
        sharp = s;
        env_rotation_y = rotation;
        env_intensity = preset.env_intensity * meta.map_or(1.0, |m| m.0) * scene.environment_intensity;
    } else if let Some(px) = &pixels {
        let exposure = meta.map_or(1.0, |m| m.0);
        let turn = deg(meta.map_or(0.0, |m| m.1) + scene.environment_rotation);
        let equirect = upload_equirect(device, queue, px);
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        match preset_grade(preset.id) {
            Some(grade) => {
                // The HDRI as the preset lights it: a graded cube (rotation baked in), prefiltered.
                let size = (1u32 << ((px.width / 4).max(1).ilog2())).clamp(64, 1024);
                let input = GradeInput {
                    stats: environment_stats(px),
                    grade,
                    look: preset.look.clone().unwrap_or_default(),
                    rotation: turn + deg(grade.turn),
                    exposure,
                };
                let cube = cube_from_equirect(device, queue, &equirect, &sampler, size, Some(&input));
                env = Some((env::prefilter_cube(device, queue, EnvSize::new(size), &cube), EnvSize::new(size)));
                sharp = wants_sharp.then_some(cube);
                env_rotation_y = 0.0;
            }
            None => {
                let size = EnvSize::new(px.width / 4);
                env = Some((prefilter_equirect(device, queue, size, &equirect, &sampler), size));
                // A sharp background samples a cube made from the HDRI (`WebGLCubeMaps`: its height).
                sharp = wants_sharp.then(|| cube_from_equirect(device, queue, &equirect, &sampler, px.height.max(1), None));
                env_rotation_y = turn;
            }
        }
        env_intensity = preset.env_intensity * exposure * scene.environment_intensity;
        if let Some(e) = &env {
            PREPARED.with_borrow_mut(|p| {
                p.push(Prepared { device: at, key, env: e.clone(), sharp: sharp.clone(), rotation: env_rotation_y });
                if p.len() > 2 {
                    p.remove(0);
                }
            });
        }
    } else {
        env_intensity = preset.env_intensity * scene.environment_intensity;
        env_rotation_y = preset.env_rotation_y + deg(scene.environment_rotation);
    }
    let has_env = env.is_some();
    let staged_backdrop = scene.backdrop != Backdrop::None;
    let reflective = scene.floor.is_some_and(|f| f.reflectivity > 0.0);
    let height = frame_height(design);
    let lighting = preset.id;
    let setup = Setup { scene, lighting, has_env, sharp, env_intensity, env_rotation_y, height, quality };
    Some(Plan {
        environment: env,
        env_intensity,
        env_rotation_y,
        staged_backdrop,
        reflective,
        finish: Box::new(move |r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, host: &dyn Host| finish(setup, r, device, queue, host)),
    })
}

/// What the staging's build needs from the plan.
struct Setup {
    scene: ResolvedScene,
    lighting: &'static str,
    has_env: bool,
    /// The cube a sharp environment backdrop shows.
    sharp: Option<wgpu::Texture>,
    env_intensity: f64,
    env_rotation_y: f64,
    height: f64,
    quality: Quality,
}

/// The HDRI as an equirect texture (half floats, linear filtering, clamped; bottom row first, as
/// three uploads it with `flipY`).
fn upload_equirect(device: &wgpu::Device, queue: &wgpu::Queue, px: &EnvironmentPixels) -> wgpu::TextureView {
    let (w, h) = (px.width, px.height);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("scene environment"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let row = (w * 4) as usize;
    let flipped: Vec<u16> = px.data.chunks_exact(row).rev().flatten().copied().collect();
    queue.write_texture(
        texture.as_image_copy(),
        bytemuck::cast_slice(&flipped),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 8), rows_per_image: Some(h) },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    texture.create_view(&Default::default())
}

fn env_module(device: &wgpu::Device) -> wgpu::ShaderModule {
    effects::module(device, "scene environment", &format!("{}\n{}", wgsl!("plane.wgsl"), wgsl!("scene-env.wgsl")))
}

/// `PMREMGenerator.fromEquirectangular`.
fn prefilter_equirect(device: &wgpu::Device, queue: &wgpu::Queue, size: EnvSize, equirect: &wgpu::TextureView, sampler: &wgpu::Sampler) -> wgpu::Texture {
    let module = env_module(device);
    let made = crate::renderer::memo(device, "scene equirect", 1, crate::renderer::key_of(&module), || {
        (module.clone(), env::plane_pipeline(device, &module, "fs_equirect"))
    });
    let pipeline = made.1.clone();
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(equirect) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
        ],
    });
    env::prefilter(device, queue, size, &mut |b: env::AtlasBase<'_>| env::plane_pass(b.encoder, b.atlas, b.rect, &pipeline, &bind, b.plane))
}

/// `GradedEnvironment.update`'s inputs.
struct GradeInput {
    stats: EnvironmentStats,
    grade: Grade,
    look: env::Look,
    /// Radians (baked in).
    rotation: f64,
    /// The catalog's exposure: the rim panels are divided by it.
    exposure: f64,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GradeUniform {
    face: [u32; 4],
    turn: [f32; 4],
    zones: [f32; 4],
    key_dir: [f32; 4],
    key_color: [f32; 4],
    fill_color: [f32; 4],
    base_color: [f32; 4],
    rims: [env::Panel; 8],
}

/// The HDRI drawn into a cube of `size` from its centre: as it is (`fromEquirectangularTexture`), or
/// graded by a lighting preset with its rim panels in front (`GradedEnvironment`).
fn cube_from_equirect(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    equirect: &wgpu::TextureView,
    sampler: &wgpu::Sampler,
    size: u32,
    grade: Option<&GradeInput>,
) -> wgpu::Texture {
    use wgpu::util::DeviceExt;
    let module = env_module(device);
    let make = || {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("scene cube"),
            layout: None,
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_full"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_cube"),
                targets: &[Some(wgpu::ColorTargetState { format: ATLAS_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    };
    let pipeline = crate::renderer::memo(device, "scene cube", 1, crate::renderer::key_of(&module), || (module.clone(), make())).1.clone();
    let mut u: GradeUniform = bytemuck::Zeroable::zeroed();
    u.face[1] = size;
    if let Some(g) = grade {
        let s = g.stats;
        let gr = g.grade;
        u.face[3] = 1;
        u.turn = [g.rotation.cos() as f32, g.rotation.sin() as f32, gr.saturation as f32, 0.0];
        let (outer, inner) = (65f64.to_radians().cos(), 35f64.to_radians().cos());
        u.zones = [s.room as f32, s.lights as f32, outer as f32, inner as f32];
        u.key_dir = [s.key[0] as f32, s.key[1] as f32, s.key[2] as f32, 0.0];
        // log2 of gain × tint (tints default to the look's).
        let role = |gain: f64, tint: Option<&str>| {
            let c = hex_linear(tint.unwrap_or("#ffffff")).map(|v| v * gain);
            let l = |v: f64| v.max(1e-4).log2() as f32;
            [l(c[0]), l(c[1]), l(c[2]), 0.0]
        };
        u.key_color = role(gr.key, g.look.key_tint);
        u.fill_color = role(gr.fill, g.look.fill_tint);
        u.base_color = role(gr.base, g.look.fill_tint);
        let rim_scale = (gr.rim / g.exposure.max(1e-3)) as f32;
        if rim_scale > 0.0 {
            let rims = env::rims(&g.look);
            for (k, p) in rims.iter().take(8).enumerate() {
                let mut p = *p;
                for c in &mut p.radiance[..3] {
                    *c *= rim_scale;
                }
                u.rims[k] = p;
            }
            u.face[2] = rims.len().min(8) as u32;
        }
    }
    let cube = env::cube_texture(device, size, "scene cube");
    let mut encoder = device.create_command_encoder(&Default::default());
    for face in 0..6u32 {
        u.face[0] = face;
        let buf =
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::bytes_of(&u), usage: wgpu::BufferUsages::UNIFORM });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(equirect) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: buf.as_entire_binding() },
            ],
        });
        let view = env::cube_face(&cube, face);
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("scene cube face"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..3, 0..1);
    }
    queue.submit([encoder.finish()]);
    cube
}

// ── the staging's build ──────────────────────────────────────────────────────

/// Render orders: the background first, the sweep before the card, the floor before the card's
/// transparent layers.
const BACKGROUND_ORDER: f32 = f32::NEG_INFINITY;
const SWEEP_ORDER: f32 = -20.0;
const FLOOR_ORDER: f32 = -10.0;

fn uniform_layout_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

fn texture_layout_entry(binding: u32, dimension: wgpu::TextureViewDimension) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: dimension, multisampled: false },
        count: None,
    }
}

fn sampler_layout_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    }
}

fn linear_sampler(device: &wgpu::Device, mip: bool) -> wgpu::Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: if mip { wgpu::MipmapFilterMode::Linear } else { wgpu::MipmapFilterMode::Nearest },
        ..Default::default()
    })
}

/// A world-space custom item drawn by `pipeline` (and `buffer` in the glass's buffer passes).
fn add_world_item(
    r: &mut Renderer,
    device: &wgpu::Device,
    mesh: &Mesh,
    transform: Mat4,
    order: f32,
    transparent: bool,
    pipelines: (wgpu::RenderPipeline, wgpu::RenderPipeline),
    group: wgpu::BindGroup,
    uniform: Rc<wgpu::Buffer>,
) -> usize {
    let mesh = r.mesh(device, mesh);
    let item = Item { mesh, material: Material { transparent, ..Default::default() }, transform, render_order: order, visible: true };
    let draw = CustomDraw { world: true, buffer_pipeline: Some(Rc::new(pipelines.1)), ..CustomDraw::new(Rc::new(pipelines.0), Rc::new(group), uniform) };
    r.add_custom(item, draw)
}

/// Both pipelines of a staging draw: the canvas's and the glass buffers'.
fn pipelines(r: &Renderer, device: &wgpu::Device, layout: &wgpu::BindGroupLayout, o: &PipelineOptions<'_>) -> (wgpu::RenderPipeline, wgpu::RenderPipeline) {
    (effects::pipeline(r, device, layout, o, Target::Canvas), effects::pipeline(r, device, layout, o, Target::GlassBuffer))
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BackgroundUniform {
    model_view: [[f32; 4]; 4],
    params: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct SweepUniform {
    model_view: [[f32; 4]; 4],
    model: [[f32; 4]; 4],
    frame_inv: [[f32; 4]; 4],
    color: [f32; 4],
    pool: [f32; 4],
    misc: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct FloorUniform {
    model_view: [[f32; 4]; 4],
    model: [[f32; 4]; 4],
    mirror: [[f32; 4]; 4],
    eye: [f32; 4],
    p0: [f32; 4],
    p1: [f32; 4],
    p2: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ShadowUniform {
    view_proj: [[f32; 4]; 4],
    params: [f32; 4],
}

fn finish(setup: Setup, r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, host: &dyn Host) -> Option<StagingView> {
    let s = &setup.scene;
    let view = staging_view(s, setup.height);
    let floor_y = view.and_then(|v| v.floor_y).unwrap_or(-setup.height / 2.0 - FLOOR_GAP);
    let (inner, outer, at) = preset_backdrop(setup.lighting);
    let module = effects::module(device, "scene", &format!("{}{}\n{}", r.env_size().cubeuv_prelude(), wgsl!("cubeuv.wgsl"), wgsl!("scene.wgsl")));
    let mut staging = Staging { items: Vec::new(), sweep: None, floor: None };

    // The background (`reassert`): the HDRI (blurred through its PMREM, or sharp), or a gradient.
    let env_backdrop = s.backdrop == Backdrop::Environment && setup.has_env;
    let gradient = s.backdrop == Backdrop::Gradient || (s.backdrop == Backdrop::Environment && !setup.has_env);
    if env_backdrop || gradient {
        let layout = effects::layout(
            device,
            "scene background",
            &[
                uniform_layout_entry(0),
                texture_layout_entry(1, wgpu::TextureViewDimension::Cube),
                texture_layout_entry(2, wgpu::TextureViewDimension::D2),
                sampler_layout_entry(3),
            ],
        );
        let dummy_cube = setup.sharp.clone().unwrap_or_else(|| env::cube_texture(device, 1, "scene dummy cube"));
        let cube_view = dummy_cube.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::Cube), ..Default::default() });
        let (texture, entry, intensity, turn) = if env_backdrop {
            let id = r.texture(device, queue, &[(1, 1, vec![0; 4])], false, crate::renderer::Wrap::Clamp);
            let entry = if setup.sharp.is_some() { "fs_background_cube" } else { "fs_background_env" };
            (id, entry, setup.env_intensity, setup.env_rotation_y)
        } else {
            let (inner, outer) = match &s.backdrop_color {
                Some(c) => (shade_color(c, 0.12), shade_color(c, -0.72)),
                None => (inner.to_string(), outer.to_string()),
            };
            let px = gradient_pixels(host, &inner, &outer, at);
            // CanvasTexture: sRGB, flipY, mipmapped.
            let flipped: Vec<u8> = px.as_chunks::<{ 512 * 4 }>().0.iter().rev().flatten().copied().collect();
            let id = r.texture(device, queue, &crate::material::mip_chain(&flipped, 512, 512, true), true, crate::renderer::Wrap::Clamp);
            (id, "fs_background_texture", 1.0, 0.0)
        };
        let a = -turn;
        let data = BackgroundUniform {
            model_view: Mat4::IDENTITY.to_cols_array_2d(),
            params: [a.cos() as f32, a.sin() as f32, intensity as f32, s.backdrop_blur as f32],
        };
        let uniform = effects::uniform_buffer(device, queue, "scene background", bytemuck::bytes_of(&data));
        let sampler = linear_sampler(device, true);
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&cube_view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(r.texture_view(texture)) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });
        let o =
            PipelineOptions { entries: ("vs_background", entry), depth_test: false, depth_write: false, ..PipelineOptions::new("scene background", &module) };
        let p = pipelines(r, device, &layout, &o);
        let tri = mesh(vec![[-1.0, -1.0, 0.0], [3.0, -1.0, 0.0], [-1.0, 3.0, 0.0]], vec![0, 1, 2]);
        staging.items.push(add_world_item(r, device, &tri, Mat4::IDENTITY, BACKGROUND_ORDER, false, p, group, uniform));
    }

    // The sweep.
    if s.backdrop == Backdrop::Sweep {
        let color = hex_linear(s.backdrop_color.as_deref().unwrap_or(inner));
        let data = SweepUniform {
            model_view: Mat4::IDENTITY.to_cols_array_2d(),
            model: Mat4::IDENTITY.to_cols_array_2d(),
            frame_inv: Mat4::IDENTITY.to_cols_array_2d(),
            color: [color[0] as f32, color[1] as f32, color[2] as f32, 1.0],
            pool: [0.0, (floor_y + 1.4) as f32, -2.8, floor_y as f32],
            misc: [0.0; 4],
        };
        let uniform = effects::uniform_buffer(device, queue, "scene sweep", bytemuck::bytes_of(&data));
        let layout = effects::bind_layout(device, "scene sweep", &[effects::Bind::Uniform]);
        let group = effects::bind_group(device, &layout, &[uniform.as_entire_binding()]);
        let o = PipelineOptions { entries: ("vs_sweep", "fs_sweep"), ..PipelineOptions::new("scene sweep", &module) };
        let p = pipelines(r, device, &layout, &o);
        let item = add_world_item(r, device, &sweep_geometry(floor_y - 0.004), Mat4::IDENTITY, SWEEP_ORDER, false, p, group, uniform.clone());
        staging.items.push(item);
        staging.sweep = Some(SweepState { item, uniform, data });
    }

    // The floor: reflection and contact shadow.
    if let Some(f) = s.floor {
        let state = FloorState::new(r, device, queue, &module, f, floor_y, setup.height, setup.quality);
        staging.items.push(state.item);
        staging.floor = Some(state);
    }
    r.frame_passes = Some(Box::new(staging));
    view
}

struct SweepState {
    item: usize,
    uniform: Rc<wgpu::Buffer>,
    data: SweepUniform,
}

/// The reflection target at one size: its levels and what samples them.
struct Reflection {
    size: (u32, u32),
    texture: wgpu::Texture,
    depth: wgpu::TextureView,
    /// Each level's render view, and (from level 1) the bind group sampling the level above.
    levels: Vec<(wgpu::TextureView, Option<(wgpu::BindGroup, wgpu::Buffer)>)>,
}

struct FloorState {
    item: usize,
    uniform: Rc<wgpu::Buffer>,
    data: FloorUniform,
    floor: Floor,
    y: f64,
    resolution: f64,
    layout: wgpu::BindGroupLayout,
    mip_sampler: wgpu::Sampler,
    lin_sampler: wgpu::Sampler,
    reflection: Option<Reflection>,
    /// This frame's mirror camera (`None`: the eye is under the floor, nothing to reflect).
    mirror: Option<Camera>,
    shadow_a: wgpu::Texture,
    shadow_depth: wgpu::TextureView,
    dark: wgpu::RenderPipeline,
    dark_frame: (Rc<wgpu::Buffer>, wgpu::BindGroup),
    /// Per drawn item: its model matrix, at 256-byte steps.
    models: Option<(wgpu::Buffer, wgpu::BindGroup, usize)>,
    blur: wgpu::RenderPipeline,
    blur_groups: Vec<wgpu::BindGroup>,
    shadow_b: wgpu::Texture,
    mip: wgpu::RenderPipeline,
}

const MODEL_STRIDE: u64 = 256;

impl FloorState {
    fn new(
        r: &mut Renderer,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        module: &wgpu::ShaderModule,
        f: Floor,
        y: f64,
        card_height: f64,
        quality: Quality,
    ) -> FloorState {
        let layout = effects::layout(
            device,
            "scene floor",
            &[
                uniform_layout_entry(0),
                texture_layout_entry(1, wgpu::TextureViewDimension::D2),
                texture_layout_entry(2, wgpu::TextureViewDimension::D2),
                sampler_layout_entry(3),
                sampler_layout_entry(4),
            ],
        );
        let model = Mat4::from_translation(Vec3::new(0.0, y as f32, 0.0)) * Mat4::from_rotation_x(-std::f32::consts::FRAC_PI_2);
        let data = FloorUniform {
            model_view: Mat4::IDENTITY.to_cols_array_2d(),
            model: model.to_cols_array_2d(),
            mirror: Mat4::IDENTITY.to_cols_array_2d(),
            eye: [0.0; 4],
            p0: [1.0 / 16.0, 1.0 / 16.0, 5.0, f.reflectivity as f32],
            p1: [f.blur as f32, (f.shadow * 5.0) as f32, SHADOW_SIZE as f32, (3.6f64).max(card_height * 1.9) as f32],
            p2: [(card_height * 0.85) as f32, y as f32, 0.0, 0.0],
        };
        let uniform = effects::uniform_buffer(device, queue, "scene floor", bytemuck::bytes_of(&data));
        let target = |label, size: u32, format, usage| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage,
                view_formats: &[],
            })
        };
        let colour = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        let shadow_a = target("contact shadow a", SHADOW_RES, GLASS_BUFFER_FORMAT, colour);
        let shadow_b = target("contact shadow b", SHADOW_RES, GLASS_BUFFER_FORMAT, colour);
        let shadow_depth = target("contact shadow depth", SHADOW_RES, wgpu::TextureFormat::Depth32Float, wgpu::TextureUsages::RENDER_ATTACHMENT)
            .create_view(&Default::default());
        let (mip_sampler, lin_sampler) = (linear_sampler(device, true), linear_sampler(device, false));
        let empty = r.texture(device, queue, &[(1, 1, vec![0; 4])], false, crate::renderer::Wrap::Clamp);
        let shadow_view = shadow_a.create_view(&Default::default());
        let group = Self::group(device, &layout, &uniform, r.texture_view(empty), &shadow_view, &mip_sampler, &lin_sampler);
        let o = PipelineOptions {
            entries: ("vs_floor", "fs_floor"),
            depth_write: false,
            blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            cull: Some(wgpu::Face::Back),
            ..PipelineOptions::new("scene floor", module)
        };
        let p = pipelines(r, device, &layout, &o);
        let item = add_world_item(r, device, &plane(40.0), model, FLOOR_ORDER, true, p, group, uniform.clone());

        // The passes' pipelines.
        let passes = effects::module(device, "scene passes", wgsl!("scene-passes.wgsl"));
        let frame_layout = effects::layout(device, "contact shadow", &[uniform_layout_entry(0)]);
        let model_layout = effects::layout(
            device,
            "contact shadow model",
            &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(64) },
                count: None,
            }],
        );
        let make_dark = || {
            let dark_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("contact shadow"),
                bind_group_layouts: &[Some(&frame_layout), Some(&model_layout)],
                immediate_size: 0,
            });
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("contact shadow darkness"),
                layout: Some(&dark_layout),
                vertex: wgpu::VertexState {
                    module: &passes,
                    entry_point: Some("vs_dark"),
                    buffers: crate::renderer::VERTEX_LAYOUT,
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &passes,
                    entry_point: Some("fs_dark"),
                    targets: &[Some(wgpu::ColorTargetState { format: GLASS_BUFFER_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                    compilation_options: Default::default(),
                }),
                primitive: Default::default(),
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth32Float,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(wgpu::CompareFunction::LessEqual),
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            });
            (frame_layout.clone(), model_layout.clone(), passes.clone(), pipeline)
        };
        let dark = crate::renderer::memo(device, "contact shadow", 1, crate::renderer::key_of((&frame_layout, &model_layout, &passes)), make_dark).3.clone();
        let shadow = ShadowUniform { view_proj: shadow_view_proj(y).as_mat4().to_cols_array_2d(), params: [y as f32, SHADOW_HEIGHT as f32, 0.0, 0.0] };
        let dark_buf = effects::uniform_buffer(device, queue, "contact shadow", bytemuck::bytes_of(&shadow));
        let dark_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &frame_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: dark_buf.as_entire_binding() }],
        });
        let full = |fs: &'static str| {
            let make = || {
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(fs),
                    layout: None,
                    vertex: wgpu::VertexState { module: &passes, entry_point: Some("vs_quad"), buffers: &[], compilation_options: Default::default() },
                    fragment: Some(wgpu::FragmentState {
                        module: &passes,
                        entry_point: Some(fs),
                        targets: &[Some(wgpu::ColorTargetState { format: GLASS_BUFFER_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                        compilation_options: Default::default(),
                    }),
                    primitive: Default::default(),
                    depth_stencil: None,
                    multisample: Default::default(),
                    multiview_mask: None,
                    cache: None,
                })
            };
            crate::renderer::memo(device, "contact shadow blur", 2, crate::renderer::key_of((&passes, fs)), || (passes.clone(), make())).1.clone()
        };
        let blur = full("fs_blur");
        let mip = full("fs_mip");
        // Two separable blur iterations, wider the second time: A → B across, B → A down.
        let views = [shadow_a.create_view(&Default::default()), shadow_b.create_view(&Default::default())];
        let mut blur_groups = Vec::new();
        for spread in [1.2f32, 2.6] {
            for (src, step) in [(0, [spread / SHADOW_RES as f32, 0.0]), (1, [0.0, spread / SHADOW_RES as f32])] {
                let buf = effects::uniform_buffer(device, queue, "contact shadow blur", bytemuck::bytes_of(&[step[0], step[1], 0.0, 0.0]));
                blur_groups.push(device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &blur.get_bind_group_layout(0),
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&views[src]) },
                        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&lin_sampler) },
                        wgpu::BindGroupEntry { binding: 2, resource: buf.as_entire_binding() },
                    ],
                }));
            }
        }
        let resolution = if quality == Quality::Full { 0.5 } else { 0.35 };
        FloorState {
            item,
            uniform,
            data,
            floor: f,
            y,
            resolution,
            layout,
            mip_sampler,
            lin_sampler,
            reflection: None,
            mirror: None,
            shadow_a,
            shadow_depth,
            dark,
            dark_frame: (dark_buf, dark_group),
            models: None,
            blur,
            blur_groups,
            shadow_b,
            mip,
        }
    }

    fn group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        uniform: &wgpu::Buffer,
        reflection: &wgpu::TextureView,
        shadow: &wgpu::TextureView,
        mip: &wgpu::Sampler,
        lin: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(reflection) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(shadow) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(mip) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(lin) },
            ],
        })
    }

    /// The reflection target at the drawing buffer's size × the resolution (made or remade), with the
    /// floor's bind group sampling it.
    fn ensure_reflection(&mut self, r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, width: u32, height: u32) {
        let k = self.resolution;
        let size = |v: u32| ((v as f64 * k).round() as u32).clamp(16, 2048);
        let (w, h) = (size(width), size(height));
        if self.reflection.as_ref().is_some_and(|t| t.size == (w, h)) {
            return;
        }
        let levels = w.max(h).ilog2() + 1;
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("floor reflection"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: levels,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: GLASS_BUFFER_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let depth = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("floor reflection depth"),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth32Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
            .create_view(&Default::default());
        let level = |l: u32| texture.create_view(&wgpu::TextureViewDescriptor { base_mip_level: l, mip_level_count: Some(1), ..Default::default() });
        let mut list = Vec::new();
        for l in 0..levels {
            let sampling = (l > 0).then(|| {
                let src = level(l - 1);
                let (lw, lh) = ((w >> l).max(1), (h >> l).max(1));
                let buf = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("floor reflection mip"),
                    size: 16,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                queue.write_buffer(&buf, 0, bytemuck::bytes_of(&[lw as f32, lh as f32, 0.0, 0.0]));
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.mip.get_bind_group_layout(0),
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&src) },
                        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.lin_sampler) },
                        wgpu::BindGroupEntry { binding: 2, resource: buf.as_entire_binding() },
                    ],
                });
                (group, buf)
            });
            list.push((level(l), sampling));
        }
        let full = texture.create_view(&Default::default());
        let shadow = self.shadow_a.create_view(&Default::default());
        let group = Self::group(device, &self.layout, &self.uniform, &full, &shadow, &self.mip_sampler, &self.lin_sampler);
        if let Some(c) = r.custom_mut(self.item) {
            c.bind_group = Rc::new(group);
        }
        self.data.p0[0] = 1.0 / w as f32;
        self.data.p0[1] = 1.0 / h as f32;
        self.data.p0[2] = (((w.max(h) as f64).log2()) - 3.0).max(1.0) as f32;
        self.reflection = Some(Reflection { size: (w, h), texture, depth, levels: list });
    }

    /// `renderReflection`: the scene from the mirrored camera, then its mipmaps.
    fn reflect(&self, r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, frame: &PassFrame, glass: bool, skip: &[usize]) {
        let (Some(mirror), Some(t)) = (self.mirror.as_ref(), self.reflection.as_ref()) else { return };
        r.draw_view(device, queue, &t.levels[0].0, &t.depth, mirror, frame.proj, frame.model, glass, &|i| !skip.contains(&i));
        let _ = &t.texture;
        let mut encoder = device.create_command_encoder(&Default::default());
        for (view, sampling) in &t.levels[1..] {
            let Some((group, _)) = sampling else { continue };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("floor reflection mip"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.mip);
            pass.set_bind_group(0, group, &[]);
            pass.draw(0..3, 0..1);
        }
        queue.submit([encoder.finish()]);
    }

    /// `renderShadow`: everything within `SHADOW_HEIGHT` of the floor, darker the lower, seen from below,
    /// then blurred twice.
    fn shadow(&mut self, r: &Renderer, device: &wgpu::Device, queue: &wgpu::Queue, model: Mat4, skip: &[usize]) {
        // The scene's meshes with the override material: position (and the item's transform) only.
        let mut draws = Vec::new();
        for (i, it) in r.items.iter().enumerate() {
            if !it.visible || skip.contains(&i) {
                continue;
            }
            let custom = r.custom(i);
            // Instanced draws would need their instance matrices; three's override draws them too.
            if custom.is_some_and(|c| c.instanced) {
                continue;
            }
            let world = if custom.is_some_and(|c| c.world) { it.transform } else { model * it.transform };
            let (_, _, count) = r.mesh_buffers(it.mesh);
            let range = custom.and_then(|c| c.range.clone()).unwrap_or(0..count);
            if range.is_empty() {
                continue;
            }
            draws.push((it.mesh, world, range));
        }
        let needed = draws.len().max(1);
        if self.models.as_ref().is_none_or(|m| m.2 < needed) {
            let cap = needed.next_power_of_two();
            let buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("contact shadow models"),
                size: MODEL_STRIDE * cap as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.dark.get_bind_group_layout(1),
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &buf, offset: 0, size: wgpu::BufferSize::new(64) }),
                }],
            });
            self.models = Some((buf, group, cap));
        }
        let (models, model_group, _) = self.models.as_ref().unwrap();
        let mut bytes = vec![0u8; MODEL_STRIDE as usize * draws.len()];
        for (k, d) in draws.iter().enumerate() {
            let m = d.1.to_cols_array();
            bytes[k * MODEL_STRIDE as usize..k * MODEL_STRIDE as usize + 64].copy_from_slice(bytemuck::cast_slice(&m));
        }
        if !bytes.is_empty() {
            queue.write_buffer(models, 0, &bytes);
        }
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let view = self.shadow_a.create_view(&Default::default());
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("contact shadow"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.shadow_depth,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            pass.set_pipeline(&self.dark);
            pass.set_bind_group(0, &self.dark_frame.1, &[]);
            for (k, (mesh, _, range)) in draws.iter().enumerate() {
                let (vertices, indices, _) = r.mesh_buffers(*mesh);
                pass.set_bind_group(1, model_group, &[(k as u64 * MODEL_STRIDE) as u32]);
                pass.set_vertex_buffer(0, vertices.slice(..));
                pass.set_index_buffer(indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(range.clone(), 0, 0..1);
            }
        }
        let views = [self.shadow_a.create_view(&Default::default()), self.shadow_b.create_view(&Default::default())];
        for (k, group) in self.blur_groups.iter().enumerate() {
            let dst = &views[1 - k % 2];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("contact shadow blur"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: dst,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.blur);
            pass.set_bind_group(0, group, &[]);
            pass.draw(0..3, 0..1);
        }
        queue.submit([encoder.finish()]);
    }
}

/// The staging's per-frame state: the sweep turns with an orbiting camera; the floor renders its
/// reflection and contact shadow (`ReflectiveFloor.passes`, which three runs from the floor's
/// `onBeforeRender`).
struct Staging {
    /// The staging's own items: left out of the floor's passes (three hides the backdrop and the floor,
    /// and drops the background).
    items: Vec<usize>,
    sweep: Option<SweepState>,
    floor: Option<FloorState>,
}

impl FramePasses for Staging {
    fn prepare(&mut self, r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, frame: &PassFrame) {
        if let Some(s) = self.sweep.as_mut() {
            // A backdrop stays behind the card as the camera circles it.
            let turn = Mat4::from_rotation_y(frame.camera.azimuth as f32);
            r.items[s.item].transform = turn;
            s.data.model = turn.to_cols_array_2d();
            s.data.frame_inv = DMat4::from_rotation_y(frame.camera.azimuth).inverse().as_mat4().to_cols_array_2d();
            s.data.misc[0] = frame.height as f32;
            // The renderer writes the model-view matrix (offset 0) after this.
            queue.write_buffer(&s.uniform, 64, &bytemuck::bytes_of(&s.data)[64..]);
        }
        if let Some(f) = self.floor.as_mut() {
            let p = f.floor;
            if p.reflectivity <= 0.0 && p.shadow <= 0.0 {
                f.mirror = None;
                return;
            }
            let eye = frame.camera.eye;
            f.mirror = None;
            if p.reflectivity > 0.0 && eye.y > f.y + 1e-3 {
                f.ensure_reflection(r, device, queue, frame.width, frame.height);
                let m = mirror_camera(&frame.camera, f.y);
                f.data.mirror = (frame.proj * m.view32()).to_cols_array_2d();
                f.mirror = Some(m);
            }
            f.data.eye = [eye.x as f32, eye.y as f32, eye.z as f32, 0.0];
            queue.write_buffer(&f.uniform, 64, &bytemuck::bytes_of(&f.data)[64..]);
        }
    }

    fn run(&mut self, r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, frame: &PassFrame, stage: PassStage) {
        let Some(f) = self.floor.as_mut() else { return };
        let skip = &self.items;
        f.reflect(r, device, queue, frame, stage == PassStage::AfterGlass, skip);
        if stage == PassStage::First && f.floor.shadow > 0.0 {
            f.shadow(r, device, queue, frame.model, skip);
        }
    }
}
