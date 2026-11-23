//! The corner mark (`card/generic-mark.ts`, `drawLogoCanvas` in `card/branding.ts`) and user logo
//! rasters (`drawUserLogoCanvas`), white glyphs on transparent (alpha = shape) for the branding planes.

use crate::canvas::{FillRule, Host, Paint};

/// The public build's corner mark: an isometric cube of three facets separated by fine gaps.
pub const GENERIC_MARK_PATH: &str =
    "M19.28 2.13L37.07 12.4L19.28 22.67L1.5 12.4ZM0 15L17.78 25.27L17.78 45.8L0 35.53ZM20.78 25.27L38.57 15L38.57 35.53L20.78 45.8Z";
pub const GENERIC_MARK_VIEWBOX: [f64; 2] = [42.0, 48.0];

/// The mark raster's size (256 × 224, so the plane's aspect is 56/49).
pub const LOGO_CANVAS: (u32, u32) = (256, 224);

/// A mark: SVG path data in a view box, drawn from `origin` (the TypeScript `originX` / `originY`).
pub struct Mark<'a> {
    pub path: &'a str,
    pub view_box: [f64; 2],
    pub origin: [f64; 2],
}

impl Default for Mark<'static> {
    fn default() -> Self {
        Mark { path: GENERIC_MARK_PATH, view_box: GENERIC_MARK_VIEWBOX, origin: [0.0, 0.0] }
    }
}

/// `drawLogoCanvas`: the mark scaled to the canvas width (or height, if it is taller), filled white
/// (non-zero). RGBA rows top first.
pub fn draw_logo(host: &dyn Host, mark: &Mark<'_>) -> Vec<u8> {
    let (w, h) = LOGO_CANVAS;
    let mut c = host.canvas(w, h);
    let k = (w as f64 / mark.view_box[0]).min(h as f64 / mark.view_box[1]);
    c.scale(k, k);
    c.translate(-mark.origin[0], -mark.origin[1]);
    c.set_fill(Paint::color("#ffffff"));
    c.begin_path();
    c.svg_path(mark.path);
    c.fill(FillRule::NonZero);
    c.get_image_data()
}

/// Raster height of a user logo, px (its width follows the aspect, at most 2048).
pub const USER_LOGO_RASTER: u32 = 512;
/// Limits on a logo's aspect (`LOGO_LIMITS.aspect`).
pub const LOGO_ASPECT: [f64; 2] = [0.2, 8.0];

/// `drawUserLogoCanvas` for a path logo: the path fitted (letterboxed when the aspect was clamped)
/// into a `USER_LOGO_RASTER`-tall canvas, from `origin`, filled white with its fill rule. Returns
/// (width, height, RGBA, aspect), or `None` for an unusable view box. Raster logos come with images.
pub fn draw_user_logo_path(host: &dyn Host, path: &str, view_box: [f64; 2], origin: [f64; 2], even_odd: bool) -> Option<(u32, u32, Vec<u8>, f64)> {
    let natural = view_box[0] / view_box[1];
    if natural.is_nan() || natural <= 0.0 {
        return None;
    }
    let aspect = natural.clamp(LOGO_ASPECT[0], LOGO_ASPECT[1]);
    let round = |x: f64| (x + 0.5).floor();
    let mut h = USER_LOGO_RASTER as f64;
    let mut w = round(h * aspect);
    if w > 2048.0 {
        h = round(h * 2048.0 / w);
        w = 2048.0;
    }
    let mut c = host.canvas(w as u32, h as u32);
    let k = (w / view_box[0]).min(h / view_box[1]);
    c.translate((w - view_box[0] * k) / 2.0, (h - view_box[1] * k) / 2.0);
    c.scale(k, k);
    c.translate(-origin[0], -origin[1]);
    c.set_fill(Paint::color("#ffffff"));
    c.begin_path();
    c.svg_path(path);
    c.fill(if even_odd { FillRule::EvenOdd } else { FillRule::NonZero });
    Some((w as u32, h as u32, c.get_image_data(), aspect))
}

/// The contactless mark (`card/contactless.ts`): EMVCo's Contactless Indicator, four graduating arcs
/// facing right, in units of the ink box's height (origin top-left, y down).
const ARC_CENTRE: (f64, f64) = (-0.1652, 0.5);
const ARC_STROKE: f64 = 0.1119;
const ARCS: [(f64, f64); 4] = [(0.2633, 0.6328), (0.4747, 0.5378), (0.6986, 0.5202), (0.9099, 0.5103)];
/// Antialiasing margin, as a fraction of the canvas height.
const MARGIN: f64 = 0.02;
/// Width / height of the mark (the traced ink box, 107 × 134).
pub const CONTACTLESS_ASPECT: f64 = 107.0 / 134.0;

/// `drawContactlessCanvas`: the mark, white round-capped strokes on transparent. (width, height, RGBA).
pub fn draw_contactless(host: &dyn Host, height_px: f64) -> (u32, u32, Vec<u8>) {
    let h = height_px.round().max(32.0);
    let w = (h * CONTACTLESS_ASPECT + 0.5).floor();
    let mut c = host.canvas(w as u32, h as u32);
    let s = h * (1.0 - 2.0 * MARGIN);
    let (ox, oy) = ((w - s * CONTACTLESS_ASPECT) / 2.0, h * MARGIN);
    c.set_stroke(Paint::color("#ffffff"));
    c.set_line_cap(crate::canvas::LineCap::Round);
    c.set_line_width(ARC_STROKE * s);
    for (r, half) in ARCS {
        c.begin_path();
        c.arc(ox + ARC_CENTRE.0 * s, oy + ARC_CENTRE.1 * s, r * s, -half, half, false);
        c.stroke();
    }
    (w as u32, h as u32, c.get_image_data())
}

/// `drawUserLogoCanvas` for a raster logo: the image fitted (letterboxed when the aspect was clamped)
/// into a `USER_LOGO_RASTER`-tall canvas, keeping only its alpha, filled white. (width, height, RGBA, aspect).
pub fn draw_user_logo_image(host: &dyn Host, image: &crate::canvas::Image) -> Option<(u32, u32, Vec<u8>, f64)> {
    let natural = image.width as f64 / image.height.max(1) as f64;
    if natural.is_nan() || natural <= 0.0 {
        return None;
    }
    let aspect = natural.clamp(LOGO_ASPECT[0], LOGO_ASPECT[1]);
    let round = |x: f64| (x + 0.5).floor();
    let mut h = USER_LOGO_RASTER as f64;
    let mut w = round(h * aspect);
    if w > 2048.0 {
        h = round(h * 2048.0 / w);
        w = 2048.0;
    }
    let mut c = host.canvas(w as u32, h as u32);
    let k = (w / image.width as f64).min(h / image.height as f64);
    let (dw, dh) = (image.width as f64 * k, image.height as f64 * k);
    c.draw_image(image, (w - dw) / 2.0, (h - dh) / 2.0, dw, dh);
    // `source-in` white: keep the alpha, discard the colour.
    let mut px = c.get_image_data();
    for p in px.as_chunks_mut::<4>().0 {
        if p[3] > 0 {
            p[..3].fill(255);
        } else {
            p[..3].fill(0);
        }
    }
    Some((w as u32, h as u32, px, aspect))
}

/// `imageEdgeColor`: the mean colour (sRGB 0..1) of an image's 2-px border at 32 × 32, opaque-ish
/// texels only; `None` if the border is transparent. A "match" edge takes it from the artwork.
pub fn image_edge_color(host: &dyn Host, image: &crate::canvas::Image) -> Option<[f64; 3]> {
    const S: usize = 32;
    let mut c = host.canvas(S as u32, S as u32);
    c.draw_image(image, 0.0, 0.0, S as f64, S as f64);
    let d = c.get_image_data();
    let (mut r, mut g, mut b, mut n) = (0.0, 0.0, 0.0, 0.0);
    for y in 0..S {
        for x in 0..S {
            if x > 1 && x < S - 2 && y > 1 && y < S - 2 {
                continue;
            }
            let i = (y * S + x) * 4;
            if (d[i + 3] as f64) / 255.0 < 0.2 {
                continue;
            }
            r += d[i] as f64;
            g += d[i + 1] as f64;
            b += d[i + 2] as f64;
            n += 1.0;
        }
    }
    (n > 0.0).then(|| [r / n / 255.0, g / n / 255.0, b / n / 255.0])
}
