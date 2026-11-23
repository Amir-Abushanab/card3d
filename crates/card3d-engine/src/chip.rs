//! The chip: `card/chip.ts` (the finish, the base and detail layers) and `geometry/chip-texture.ts`
//! (the procedural contact plate, drawn on a host canvas).

use crate::canvas::{round_rect_path, Canvas, FillRule, Host, LineCap, LineJoin, Paint};
use crate::iso::{self, MmRect, CHIP_PLATE};

/// `chipFinish`: from the resolved material, the surface maps' anisotropy (capped by
/// quality) and `spectrum01` (iridescence σ = spectrum01^1.6). `keep_bright` nudges roughness only.
pub struct ChipFinish {
    pub roughness: f64,
    pub clearcoat: f64,
    pub clearcoat_roughness: f64,
    pub anisotropy: f64,
    pub anisotropy_rotation: f64,
    pub iridescence: f64,
    pub iridescence_ior: f64,
    /// `iridescenceThicknessRange` [min, max], nm.
    pub iridescence_thickness: [f64; 2],
}

fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    hi.min(lo.max(x))
}

pub fn chip_finish(
    roughness: f64,
    clearcoat: f64,
    clearcoat_roughness: f64,
    anisotropy: f64,
    anisotropy_rotation: f64,
    spectrum01: f64,
    keep_bright: bool,
) -> ChipFinish {
    let s = clamp(spectrum01, 0.0, 1.0).powf(1.6);
    let kb = if keep_bright { 1.0 } else { 0.0 };
    ChipFinish {
        roughness: clamp(roughness * 0.7 + 0.02 * kb, 0.08, 0.6),
        clearcoat: clamp(0.28 + clearcoat * 0.35, 0.28, 0.65),
        clearcoat_roughness: clamp(clearcoat_roughness, 0.06, 0.42),
        anisotropy,
        anisotropy_rotation,
        iridescence: 0.18 * s,
        iridescence_ior: 1.3 + 0.08 * s,
        iridescence_thickness: [260.0 + 10.0 * s, 340.0 + 40.0 * s],
    }
}

/// Opacity of the procedural detail layer over the chip base, and its bump scale.
pub const DETAIL_OPACITY: f32 = 0.78;
pub const DETAIL_BUMP_SCALE: f32 = 1.4;
/// Texels per millimetre of plate.
const PX_PER_MM: f64 = 48.0;

pub fn texture_size() -> (u32, u32) {
    ((CHIP_PLATE.width * PX_PER_MM).round() as u32, (CHIP_PLATE.height * PX_PER_MM).round() as u32)
}

/// A card-mm rectangle in plate-local mm (origin at the plate's top-left corner).
fn local(r: &MmRect) -> MmRect {
    let p = iso::chip_plate_mm();
    MmRect { x0: r.x0 - p.x0, x1: r.x1 - p.x0, y0: r.y0 - p.y0, y1: r.y1 - p.y0 }
}

/// The gap network (plate mm): every edge shared by two different pads, as segments.
pub fn gap_segments() -> Vec<[f64; 4]> {
    let pads: Vec<Vec<MmRect>> = iso::chip_pads().iter().map(|p| p.rects.iter().map(local).collect()).collect();
    let eps = 1e-6;
    let mut segs = Vec::new();
    for i in 0..pads.len() {
        for j in i + 1..pads.len() {
            for a in &pads[i] {
                for b in &pads[j] {
                    for (xa, xb) in [(a.x1, b.x0), (a.x0, b.x1)] {
                        if (xa - xb).abs() < eps {
                            let (y0, y1) = (a.y0.max(b.y0), a.y1.min(b.y1));
                            if y1 > y0 + eps {
                                segs.push([xa, y0, xa, y1]);
                            }
                        }
                    }
                    for (ya, yb) in [(a.y1, b.y0), (a.y0, b.y1)] {
                        if (ya - yb).abs() < eps {
                            let (x0, x1) = (a.x0.max(b.x0), a.x1.min(b.x1));
                            if x1 > x0 + eps {
                                segs.push([x0, ya, x1, ya]);
                            }
                        }
                    }
                }
            }
        }
    }
    segs
}

fn contact_gaps(c: &mut dyn Canvas) {
    c.begin_path();
    for [x0, y0, x1, y1] in gap_segments() {
        c.move_to(x0, y0);
        c.line_to(x1, y1);
    }
}

/// `drawChipDetailCanvases`: the colour map (sRGB) and height map of the contact plate, RGBA8 rows
/// with v = 0 first (drawn flipped, so it reads upright on the chip's planar UVs).
pub fn draw_detail(host: &dyn Host) -> (u32, u32, Vec<u8>, Vec<u8>) {
    let (w, h) = texture_size();
    let (pw, ph, pr) = (CHIP_PLATE.width, CHIP_PLATE.height, CHIP_PLATE.corner_radius);
    let mut color = host.canvas(w, h);
    let mut height = host.canvas(w, h);
    for ctx in [&mut color, &mut height] {
        ctx.translate(0.0, h as f64);
        ctx.scale(1.0, -1.0);
        ctx.scale(w as f64 / pw, h as f64 / ph);
        ctx.set_line_cap(LineCap::Butt);
        ctx.set_line_join(LineJoin::Miter);
    }
    let gap = CHIP_PLATE.gap;
    let centre = local(&iso::chip_pads().into_iter().find(|p| p.contact == 0).unwrap().rects[0]);

    // ── colour ──
    let c = color.as_mut();
    c.save();
    round_rect_path(c, 0.0, 0.0, pw, ph, pr, true);
    c.clip(FillRule::NonZero);
    c.set_fill(Paint::Linear {
        from: [0.0, 0.0],
        to: [pw, ph],
        stops: [(0.0, "#d9d9d4"), (0.35, "#c3c4bf"), (0.55, "#e4e4df"), (0.8, "#b9bab5"), (1.0, "#cfd0cb")].iter().map(|(o, c)| (*o, c.to_string())).collect(),
    });
    c.fill_rect(0.0, 0.0, pw, ph);
    let dw = (centre.x1 - centre.x0) * 0.56;
    let dh = (centre.y1 - centre.y0) * 0.58;
    c.set_fill(Paint::color("rgba(70, 72, 68, 0.16)"));
    round_rect_path(c, (centre.x0 + centre.x1 - dw) / 2.0, (centre.y0 + centre.y1 - dh) / 2.0, dw, dh, 0.35, true);
    c.fill(FillRule::NonZero);
    c.set_stroke(Paint::color("rgba(40, 42, 38, 0.35)"));
    c.set_line_width(0.06);
    c.stroke();
    contact_gaps(c);
    c.set_stroke(Paint::color("rgba(30, 31, 29, 0.25)"));
    c.set_line_width(gap * 2.4);
    c.stroke();
    c.set_stroke(Paint::color("#262724"));
    c.set_line_width(gap);
    c.stroke();
    c.restore();
    add_grain(c, 14.0);
    c.save();
    c.set_stroke(Paint::color("rgba(38, 40, 36, 0.7)"));
    c.set_line_width(0.12);
    round_rect_path(c, 0.06, 0.06, pw - 0.12, ph - 0.12, pr - 0.06, true);
    c.stroke();
    c.restore();

    // ── height: pads high, gaps low with a soft shoulder, rim bevelled ──
    let g = height.as_mut();
    g.set_fill(Paint::color("#000"));
    g.fill_rect(0.0, 0.0, pw, ph);
    g.save();
    round_rect_path(g, 0.0, 0.0, pw, ph, pr, true);
    g.clip(FillRule::NonZero);
    g.set_fill(Paint::color("#fff"));
    g.fill_rect(0.0, 0.0, pw, ph);
    contact_gaps(g);
    g.set_stroke(Paint::color("rgba(0,0,0,0.35)"));
    g.set_line_width(gap * 2.1);
    g.stroke();
    g.set_stroke(Paint::color("#000"));
    g.set_line_width(gap);
    g.stroke();
    g.restore();
    g.set_stroke(Paint::color("rgba(0,0,0,0.5)"));
    g.set_line_width(0.17);
    round_rect_path(g, 0.09, 0.09, pw - 0.18, ph - 0.18, pr - 0.09, true);
    g.stroke();

    let (cd, hd) = (color.get_image_data(), height.get_image_data());
    (w, h, cd, hd)
}

/// Fine deterministic grain (satin metal look): the TypeScript LCG, ±amount/2 per pixel.
fn add_grain(c: &mut dyn Canvas, amount: f64) {
    let mut d = c.get_image_data();
    let mut seed: u32 = 0x2f6b1d;
    let mut rand = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        seed as f64 / 4294967296.0
    };
    for px in d.as_chunks_mut::<4>().0 {
        let n = (rand() - 0.5) * amount;
        for v in &mut px[..3] {
            // Uint8ClampedArray stores round-half-to-even.
            let x = (*v as f64 + n).clamp(0.0, 255.0);
            *v = round_half_even(x) as u8;
        }
    }
    c.put_image_data(&d);
}

fn round_half_even(x: f64) -> f64 {
    let r = x.round();
    if (x - x.trunc()).abs() == 0.5 && r % 2.0 != 0.0 {
        r - x.signum()
    } else {
        r
    }
}
