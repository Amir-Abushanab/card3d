//! The card engine's native host: `card3d_engine::canvas::Canvas` on tiny-skia (the web host uses
//! the browser's Canvas 2D instead), with text from the bundled Inter Bold (`text.rs`).

pub mod gif;
mod svg;
pub mod text;

use card3d_engine::canvas::{parse_css_color, Canvas, Composite, EnvironmentFile, FillRule, Host, Image, ImagePurpose, LineCap, LineJoin, Paint, TextMetrics};
use tiny_skia as sk;

/// Canvases and images for native hosts. Image and file `src`s are `data:` URLs or file paths
/// (relative ones from `base`); other URLs are left to the app (fetch them into a data URL or a file
/// first).
#[derive(Default, Clone)]
pub struct NativeHost {
    pub base: Option<std::path::PathBuf>,
    /// Where the scene environments' files are (`<id>.webp`: packages/core/assets/environments).
    pub environments: Option<std::path::PathBuf>,
    /// The provider's name font (`AssetProvider.nameFontFamily`); the engine's default when `None`.
    pub name_font: Option<String>,
}

impl NativeHost {
    /// The bytes `src` names: a `data:` URL, or a file (relative to `base`).
    fn read(&self, src: &str) -> Option<Vec<u8>> {
        use base64::Engine;
        if let Some(rest) = src.strip_prefix("data:") {
            let (meta, data) = rest.split_once(',')?;
            return if meta.ends_with(";base64") { base64::engine::general_purpose::STANDARD.decode(data.trim()).ok() } else { Some(data.as_bytes().to_vec()) };
        }
        let path = std::path::Path::new(src);
        let path = match (&self.base, path.is_relative()) {
            (Some(b), true) => b.join(path),
            _ => path.to_path_buf(),
        };
        std::fs::read(path).ok()
    }
}

/// Longest side of a design image handed to the engine (`MAX_DESIGN_IMAGE_SIDE`).
const MAX_IMAGE_SIDE: u32 = 1280;

impl Host for NativeHost {
    fn canvas(&self, width: u32, height: u32) -> Box<dyn Canvas> {
        Box::new(SkiaCanvas::new(width, height))
    }

    fn environment(&self, src: &str) -> Option<EnvironmentFile> {
        let catalog = card3d_engine::scene::catalog(src).is_some();
        let path = match (&self.environments, catalog) {
            (Some(dir), true) => dir.join(format!("{src}.webp")),
            (None, true) => return None,
            (_, false) => {
                let p = std::path::Path::new(src.split(['?', '#']).next().unwrap_or(src));
                match (&self.base, p.is_relative()) {
                    (Some(b), true) => b.join(p),
                    _ => p.to_path_buf(),
                }
            }
        };
        let bytes = std::fs::read(&path).ok()?;
        if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("hdr")) {
            return Some(EnvironmentFile::Radiance(bytes));
        }
        // The bytes as data: no colour management, straight alpha.
        let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
        let (width, height) = img.dimensions();
        Some(EnvironmentFile::GainMap(Image { width, height, rgba: img.into_raw() }))
    }

    fn image(&self, src: &str, purpose: ImagePurpose) -> Option<Image> {
        let bytes = self.read(src)?;
        if purpose == ImagePurpose::Mask && (src.split(['?', '#']).next().unwrap_or(src).ends_with(".svg") || src.starts_with("data:image/svg+xml")) {
            return svg::rasterize_mask(&bytes);
        }
        let mut img = image::load_from_memory(&bytes).ok()?.to_rgba8();
        let (w, h) = img.dimensions();
        let k = (MAX_IMAGE_SIDE as f64 / w.max(h).max(1) as f64).min(1.0);
        if k < 1.0 && purpose == ImagePurpose::Artwork {
            let (cw, ch) = (((w as f64 * k).round() as u32).max(1), ((h as f64 * k).round() as u32).max(1));
            img = image::imageops::resize(&img, cw, ch, image::imageops::FilterType::CatmullRom);
        }
        let (width, height) = img.dimensions();
        Some(Image { width, height, rgba: img.into_raw() })
    }

    fn name_font(&self) -> String {
        self.name_font.clone().unwrap_or_else(|| card3d_engine::fonts::DEFAULT_FAMILY.to_string())
    }

    fn file(&self, src: &str) -> Option<Vec<u8>> {
        self.read(src)
    }
}

#[derive(Clone)]
struct State {
    transform: sk::Transform,
    fill: Paint,
    stroke: Paint,
    line_width: f32,
    cap: sk::LineCap,
    join: sk::LineJoin,
    alpha: f32,
    blend: sk::BlendMode,
    clip: Option<sk::Mask>,
    font_px: f32,
    font: String,
    letter_spacing: f32,
    /// `textBaseline = "middle"`.
    middle: bool,
    /// `imageSmoothingQuality = "high"` (bicubic; else bilinear).
    smooth_high: bool,
    /// `filter = "blur(px)"`: the Gaussian's standard deviation (0: none).
    blur: f32,
    /// `shadowColor` (straight RGBA), `shadowBlur`, `shadowOffsetX` / `Y`.
    shadow: Option<([f32; 4], f32, f32, f32)>,
}

impl Default for State {
    fn default() -> Self {
        State {
            transform: sk::Transform::identity(),
            fill: Paint::color("#000"),
            stroke: Paint::color("#000"),
            line_width: 1.0,
            cap: sk::LineCap::Butt,
            join: sk::LineJoin::Miter,
            alpha: 1.0,
            blend: sk::BlendMode::SourceOver,
            clip: None,
            font_px: 10.0,
            font: String::new(),
            letter_spacing: 0.0,
            middle: false,
            smooth_high: false,
            blur: 0.0,
            shadow: None,
        }
    }
}

/// A Canvas 2D context on a tiny-skia pixmap. Paths are kept in user space and drawn with the
/// transform current at drawing time (the engine never changes it mid-path).
pub struct SkiaCanvas {
    pixmap: sk::Pixmap,
    state: State,
    stack: Vec<State>,
    path: sk::PathBuilder,
    /// Current point and subpath start, user space.
    current: Option<(f64, f64)>,
    start: (f64, f64),
}

impl SkiaCanvas {
    pub fn new(width: u32, height: u32) -> SkiaCanvas {
        SkiaCanvas {
            pixmap: sk::Pixmap::new(width.max(1), height.max(1)).expect("canvas size"),
            state: State::default(),
            stack: Vec::new(),
            path: sk::PathBuilder::new(),
            current: None,
            start: (0.0, 0.0),
        }
    }

    fn shader(&self, paint: &Paint) -> sk::Shader<'static> {
        let color = |css: &str| {
            let c = parse_css_color(css).unwrap_or([0.0, 0.0, 0.0, 1.0]);
            sk::Color::from_rgba(c[0], c[1], c[2], c[3] * self.state.alpha).unwrap_or(sk::Color::BLACK)
        };
        match paint {
            Paint::Color(css) => sk::Shader::SolidColor(color(css)),
            Paint::Linear { from, to, stops } => {
                let stops: Vec<sk::GradientStop> = stops.iter().map(|(o, c)| sk::GradientStop::new(*o as f32, color(c))).collect();
                sk::LinearGradient::new(
                    sk::Point::from_xy(from[0] as f32, from[1] as f32),
                    sk::Point::from_xy(to[0] as f32, to[1] as f32),
                    stops,
                    sk::SpreadMode::Pad,
                    sk::Transform::identity(),
                )
                .unwrap_or(sk::Shader::SolidColor(sk::Color::TRANSPARENT))
            }
            Paint::Radial { to, from, stops } => {
                // Concentric: the inner circle's radius moves the stops outwards.
                let (r0, r1) = (from[2], to[2]);
                let at = |o: f64| ((r0 + o * (r1 - r0)) / r1) as f32;
                let stops: Vec<sk::GradientStop> = stops.iter().map(|(o, c)| sk::GradientStop::new(at(*o), color(c))).collect();
                let centre = sk::Point::from_xy(to[0] as f32, to[1] as f32);
                sk::RadialGradient::new(centre, 0.0, centre, r1 as f32, stops, sk::SpreadMode::Pad, sk::Transform::identity())
                    .unwrap_or(sk::Shader::SolidColor(sk::Color::TRANSPARENT))
            }
        }
    }

    fn sk_paint(&self, paint: &Paint) -> sk::Paint<'static> {
        sk::Paint { shader: self.shader(paint), anti_alias: true, blend_mode: self.state.blend, ..Default::default() }
    }

    fn built_path(&self) -> Option<sk::Path> {
        self.path.clone().finish()
    }

    fn rule(rule: FillRule) -> sk::FillRule {
        match rule {
            FillRule::NonZero => sk::FillRule::Winding,
            FillRule::EvenOdd => sk::FillRule::EvenOdd,
        }
    }

    fn ensure_point(&mut self, x: f64, y: f64) {
        if self.current.is_none() {
            self.move_to(x, y);
        }
    }

    /// Runs a drawing operation through the canvas's filter and shadow (when set): the source is drawn
    /// alone into a layer, blurred by the filter, its shadow (the shadow colour where it has ink,
    /// blurred by σ = shadowBlur / 2, offset in device pixels) composited first, then the source, each
    /// with the global alpha, composite mode and clip.
    fn with_effects(&mut self, op: impl FnOnce(&mut Self)) {
        let shadow = self.state.shadow.filter(|s| s.0[3] > 0.0 && (s.1 > 0.0 || s.2 != 0.0 || s.3 != 0.0));
        if self.state.blur <= 0.0 && shadow.is_none() {
            return op(self);
        }
        let layer = sk::Pixmap::new(self.pixmap.width(), self.pixmap.height()).expect("layer");
        let main = std::mem::replace(&mut self.pixmap, layer);
        let saved = self.state.clone();
        self.state.alpha = 1.0;
        self.state.blend = sk::BlendMode::SourceOver;
        self.state.clip = None;
        self.state.blur = 0.0;
        self.state.shadow = None;
        op(self);
        let mut layer = std::mem::replace(&mut self.pixmap, main);
        self.state = saved;
        gaussian_blur(&mut layer, self.state.blur);
        let paint = sk::PixmapPaint { opacity: self.state.alpha, blend_mode: self.state.blend, quality: sk::FilterQuality::Nearest };
        if let Some((c, blur, dx, dy)) = shadow {
            let mut sh = layer.clone();
            for p in sh.data_mut().as_chunks_mut::<4>().0 {
                let a = p[3] as f32 / 255.0 * c[3];
                *p = [(c[0] * a * 255.0).round() as u8, (c[1] * a * 255.0).round() as u8, (c[2] * a * 255.0).round() as u8, (a * 255.0).round() as u8];
            }
            gaussian_blur(&mut sh, blur / 2.0);
            self.pixmap.draw_pixmap(0, 0, sh.as_ref(), &paint, sk::Transform::from_translate(dx, dy), self.state.clip.as_ref());
        }
        self.pixmap.draw_pixmap(0, 0, layer.as_ref(), &paint, sk::Transform::identity(), self.state.clip.as_ref());
    }

    /// Appends an elliptical arc (centre, radii, rotation, start angle, signed sweep) as cubic Béziers
    /// (the circle's, mapped onto the ellipse), joined by a line from the current point.
    fn ellipse_segments(&mut self, cx: f64, cy: f64, rx: f64, ry: f64, rot: f64, a0: f64, sweep: f64) {
        let (cr, sr) = (rot.cos(), rot.sin());
        let map = |x: f64, y: f64| (cx + rx * x * cr - ry * y * sr, cy + rx * x * sr + ry * y * cr);
        let (sx, sy) = map(a0.cos(), a0.sin());
        if self.current.is_some() {
            self.line_to(sx, sy);
        } else {
            self.move_to(sx, sy);
        }
        let n = (sweep.abs() / std::f64::consts::FRAC_PI_2).ceil().max(1.0) as usize;
        let step = sweep / n as f64;
        let k = 4.0 / 3.0 * (step / 4.0).tan();
        let mut a = a0;
        for _ in 0..n {
            let b = a + step;
            let (c1x, c1y) = map(a.cos() - k * a.sin(), a.sin() + k * a.cos());
            let (c2x, c2y) = map(b.cos() + k * b.sin(), b.sin() - k * b.cos());
            let (ex, ey) = map(b.cos(), b.sin());
            self.bezier_curve_to(c1x, c1y, c2x, c2y, ex, ey);
            a = b;
        }
    }

    /// Appends a circular arc (centre, radius, start angle, signed sweep) as cubic Béziers, joined by
    /// a line from the current point (or starting a subpath).
    fn arc_segments(&mut self, cx: f64, cy: f64, r: f64, a0: f64, sweep: f64) {
        let (sx, sy) = (cx + r * a0.cos(), cy + r * a0.sin());
        if self.current.is_some() {
            self.line_to(sx, sy);
        } else {
            self.move_to(sx, sy);
        }
        let n = (sweep.abs() / std::f64::consts::FRAC_PI_2).ceil().max(1.0) as usize;
        let step = sweep / n as f64;
        let k = 4.0 / 3.0 * (step / 4.0).tan();
        let mut a = a0;
        for _ in 0..n {
            let b = a + step;
            let (x0, y0, x3, y3) = (cx + r * a.cos(), cy + r * a.sin(), cx + r * b.cos(), cy + r * b.sin());
            let (x1, y1) = (x0 - k * r * a.sin(), y0 + k * r * a.cos());
            let (x2, y2) = (x3 + k * r * b.sin(), y3 - k * r * b.cos());
            self.bezier_curve_to(x1, y1, x2, y2, x3, y3);
            a = b;
        }
    }
}

impl SkiaCanvas {
    /// `drawImage` of a premultiplied pixmap into (x, y, w, h).
    fn draw_pixmap_into(&mut self, src: &sk::Pixmap, x: f64, y: f64, w: f64, h: f64) {
        let t = self.state.transform.pre_translate(x as f32, y as f32).pre_scale((w / src.width() as f64) as f32, (h / src.height() as f64) as f32);
        let quality = if self.state.smooth_high { sk::FilterQuality::Bicubic } else { sk::FilterQuality::Bilinear };
        self.with_effects(|c| {
            let paint = sk::PixmapPaint { opacity: c.state.alpha, quality, blend_mode: c.state.blend };
            c.pixmap.draw_pixmap(0, 0, src.as_ref(), &paint, t, c.state.clip.as_ref());
        });
    }
}

/// A Gaussian blur of standard deviation `sigma` px (premultiplied, transparent outside), separable,
/// over 3σ each side.
fn gaussian_blur(p: &mut sk::Pixmap, sigma: f32) {
    if sigma <= 0.0 {
        return;
    }
    let r = (3.0 * sigma).ceil() as i32;
    let kernel: Vec<f32> = (-r..=r).map(|i| (-((i * i) as f32) / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = kernel.iter().sum();
    let kernel: Vec<f32> = kernel.iter().map(|k| k / sum).collect();
    let (w, h) = (p.width() as i32, p.height() as i32);
    let mut buf: Vec<f32> = p.data().iter().map(|&v| v as f32).collect();
    for (dx, dy) in [(1, 0), (0, 1)] {
        let mut out = vec![0.0f32; buf.len()];
        for y in 0..h {
            for x in 0..w {
                let mut acc = [0.0f32; 4];
                for (k, wt) in kernel.iter().enumerate() {
                    let o = k as i32 - r;
                    let (sx, sy) = (x + o * dx, y + o * dy);
                    if sx < 0 || sy < 0 || sx >= w || sy >= h {
                        continue;
                    }
                    let i = 4 * (sy * w + sx) as usize;
                    for c in 0..4 {
                        acc[c] += buf[i + c] * wt;
                    }
                }
                let i = 4 * (y * w + x) as usize;
                out[i..i + 4].copy_from_slice(&acc);
            }
        }
        buf = out;
    }
    for (d, s) in p.data_mut().iter_mut().zip(buf) {
        *d = s.round().clamp(0.0, 255.0) as u8;
    }
}

impl Canvas for SkiaCanvas {
    fn width(&self) -> u32 {
        self.pixmap.width()
    }
    fn height(&self) -> u32 {
        self.pixmap.height()
    }
    fn resize(&mut self, width: u32, height: u32) {
        *self = SkiaCanvas::new(width, height);
    }

    fn save(&mut self) {
        self.stack.push(self.state.clone());
    }
    fn restore(&mut self) {
        if let Some(s) = self.stack.pop() {
            self.state = s;
        }
    }
    fn translate(&mut self, x: f64, y: f64) {
        self.state.transform = self.state.transform.pre_translate(x as f32, y as f32);
    }
    fn scale(&mut self, x: f64, y: f64) {
        self.state.transform = self.state.transform.pre_scale(x as f32, y as f32);
    }
    fn rotate(&mut self, angle: f64) {
        self.state.transform = self.state.transform.pre_concat(sk::Transform::from_rotate(angle.to_degrees() as f32));
    }
    fn transform(&mut self, m: [f64; 6]) {
        let [a, b, c, d, e, f] = m.map(|v| v as f32);
        self.state.transform = self.state.transform.pre_concat(sk::Transform::from_row(a, b, c, d, e, f));
    }
    fn set_transform(&mut self, m: [f64; 6]) {
        let [a, b, c, d, e, f] = m.map(|v| v as f32);
        self.state.transform = sk::Transform::from_row(a, b, c, d, e, f);
    }

    fn begin_path(&mut self) {
        self.path = sk::PathBuilder::new();
        self.current = None;
    }
    fn move_to(&mut self, x: f64, y: f64) {
        self.path.move_to(x as f32, y as f32);
        self.current = Some((x, y));
        self.start = (x, y);
    }
    fn line_to(&mut self, x: f64, y: f64) {
        if self.current.is_none() {
            return self.move_to(x, y);
        }
        self.path.line_to(x as f32, y as f32);
        self.current = Some((x, y));
    }
    fn quadratic_curve_to(&mut self, cx: f64, cy: f64, x: f64, y: f64) {
        self.ensure_point(cx, cy);
        self.path.quad_to(cx as f32, cy as f32, x as f32, y as f32);
        self.current = Some((x, y));
    }
    fn bezier_curve_to(&mut self, c1x: f64, c1y: f64, c2x: f64, c2y: f64, x: f64, y: f64) {
        self.ensure_point(c1x, c1y);
        self.path.cubic_to(c1x as f32, c1y as f32, c2x as f32, c2y as f32, x as f32, y as f32);
        self.current = Some((x, y));
    }
    fn arc_to(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, r: f64) {
        let Some((x0, y0)) = self.current else { return self.move_to(x1, y1) };
        let (v1x, v1y, v2x, v2y) = (x0 - x1, y0 - y1, x2 - x1, y2 - y1);
        let (l1, l2) = (v1x.hypot(v1y), v2x.hypot(v2y));
        let cross = v1x * v2y - v1y * v2x;
        if r == 0.0 || l1 == 0.0 || l2 == 0.0 || cross.abs() < 1e-12 {
            return self.line_to(x1, y1);
        }
        let (u1x, u1y, u2x, u2y) = (v1x / l1, v1y / l1, v2x / l2, v2y / l2);
        let theta = (u1x * u2x + u1y * u2y).clamp(-1.0, 1.0).acos();
        let d = r / (theta / 2.0).tan();
        let (t1x, t1y, t2x, t2y) = (x1 + u1x * d, y1 + u1y * d, x1 + u2x * d, y1 + u2y * d);
        let (bx, by) = (u1x + u2x, u1y + u2y);
        let bl = bx.hypot(by);
        let h = r / (theta / 2.0).sin();
        let (cx, cy) = (x1 + bx / bl * h, y1 + by / bl * h);
        let a0 = (t1y - cy).atan2(t1x - cx);
        let a1 = (t2y - cy).atan2(t2x - cx);
        let mut sweep = a1 - a0;
        // The short way round, turning the same way as the corner.
        while sweep > std::f64::consts::PI {
            sweep -= std::f64::consts::TAU;
        }
        while sweep < -std::f64::consts::PI {
            sweep += std::f64::consts::TAU;
        }
        self.arc_segments(cx, cy, r, a0, sweep);
    }
    fn arc(&mut self, cx: f64, cy: f64, radius: f64, start: f64, end: f64, ccw: bool) {
        use std::f64::consts::TAU;
        let mut sweep = end - start;
        if !ccw {
            if sweep >= TAU {
                sweep = TAU;
            } else {
                sweep = sweep.rem_euclid(TAU);
            }
        } else if sweep <= -TAU {
            sweep = -TAU;
        } else {
            sweep = -((-sweep).rem_euclid(TAU));
        }
        self.arc_segments(cx, cy, radius, start, sweep);
    }
    fn rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.move_to(x, y);
        self.line_to(x + w, y);
        self.line_to(x + w, y + h);
        self.line_to(x, y + h);
        self.close_path();
    }
    fn round_rect(&mut self, x: f64, y: f64, w: f64, h: f64, r: f64) {
        use std::f64::consts::{FRAC_PI_2, PI};
        let r = r.min(w.abs() / 2.0).min(h.abs() / 2.0).max(0.0);
        self.move_to(x + r, y);
        self.line_to(x + w - r, y);
        self.arc_segments(x + w - r, y + r, r, -FRAC_PI_2, FRAC_PI_2);
        self.line_to(x + w, y + h - r);
        self.arc_segments(x + w - r, y + h - r, r, 0.0, FRAC_PI_2);
        self.line_to(x + r, y + h);
        self.arc_segments(x + r, y + h - r, r, FRAC_PI_2, FRAC_PI_2);
        self.line_to(x, y + r);
        self.arc_segments(x + r, y + r, r, PI, FRAC_PI_2);
        self.close_path();
        self.move_to(x, y);
    }
    fn ellipse(&mut self, x: f64, y: f64, rx: f64, ry: f64, rotation: f64, start: f64, end: f64) {
        use std::f64::consts::TAU;
        let sweep = end - start;
        let sweep = if sweep >= TAU { TAU } else { sweep.rem_euclid(TAU) };
        self.ellipse_segments(x, y, rx, ry, rotation, start, sweep);
    }
    fn close_path(&mut self) {
        if self.current.is_some() {
            self.path.close();
            self.current = Some(self.start);
        }
    }
    fn svg_path(&mut self, d: &str) {
        svg::append(self, d);
    }

    fn fill(&mut self, rule: FillRule) {
        if let Some(path) = self.built_path() {
            self.with_effects(|c| {
                let paint = c.sk_paint(&c.state.fill.clone());
                c.pixmap.fill_path(&path, &paint, Self::rule(rule), c.state.transform, c.state.clip.as_ref());
            });
        }
    }
    fn stroke(&mut self) {
        if let Some(path) = self.built_path() {
            self.with_effects(|c| {
                let paint = c.sk_paint(&c.state.stroke.clone());
                let stroke = sk::Stroke { width: c.state.line_width, line_cap: c.state.cap, line_join: c.state.join, miter_limit: 10.0, dash: None };
                c.pixmap.stroke_path(&path, &paint, &stroke, c.state.transform, c.state.clip.as_ref());
            });
        }
    }
    fn clip(&mut self, rule: FillRule) {
        let Some(path) = self.built_path() else { return };
        let mask = match self.state.clip.take() {
            Some(mut m) => {
                m.intersect_path(&path, Self::rule(rule), true, self.state.transform);
                m
            }
            None => {
                let mut m = sk::Mask::new(self.pixmap.width(), self.pixmap.height()).expect("mask");
                m.fill_path(&path, Self::rule(rule), true, self.state.transform);
                m
            }
        };
        self.state.clip = Some(mask);
    }
    fn fill_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        if let Some(r) = sk::Rect::from_xywh(x as f32, y as f32, w as f32, h as f32) {
            self.with_effects(|c| {
                let paint = c.sk_paint(&c.state.fill.clone());
                c.pixmap.fill_path(&sk::PathBuilder::from_rect(r), &paint, sk::FillRule::Winding, c.state.transform, c.state.clip.as_ref());
            });
        }
    }
    fn clear_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        if let Some(r) = sk::Rect::from_xywh(x as f32, y as f32, w as f32, h as f32) {
            let paint = sk::Paint { blend_mode: sk::BlendMode::Clear, anti_alias: false, ..Default::default() };
            self.pixmap.fill_path(&sk::PathBuilder::from_rect(r), &paint, sk::FillRule::Winding, self.state.transform, None);
        }
    }

    fn set_fill(&mut self, paint: Paint) {
        self.state.fill = paint;
    }
    fn set_stroke(&mut self, paint: Paint) {
        self.state.stroke = paint;
    }
    fn set_line_width(&mut self, width: f64) {
        self.state.line_width = width as f32;
    }
    fn set_line_cap(&mut self, cap: LineCap) {
        self.state.cap = match cap {
            LineCap::Butt => sk::LineCap::Butt,
            LineCap::Round => sk::LineCap::Round,
            LineCap::Square => sk::LineCap::Square,
        };
    }
    fn set_line_join(&mut self, join: LineJoin) {
        self.state.join = match join {
            LineJoin::Miter => sk::LineJoin::Miter,
            LineJoin::Round => sk::LineJoin::Round,
            LineJoin::Bevel => sk::LineJoin::Bevel,
        };
    }
    fn set_global_alpha(&mut self, alpha: f64) {
        self.state.alpha = alpha.clamp(0.0, 1.0) as f32;
    }
    fn set_composite(&mut self, op: Composite) {
        self.state.blend = match op {
            Composite::SourceOver => sk::BlendMode::SourceOver,
            Composite::Lighter => sk::BlendMode::Plus,
            Composite::SourceIn => sk::BlendMode::SourceIn,
            Composite::DestinationIn => sk::BlendMode::DestinationIn,
            Composite::DestinationOut => sk::BlendMode::DestinationOut,
        };
    }
    fn set_blur(&mut self, px: f64) {
        self.state.blur = px.max(0.0) as f32;
    }
    fn set_shadow(&mut self, color: &str, blur: f64, dx: f64, dy: f64) {
        let c = parse_css_color(color).unwrap_or([0.0; 4]);
        self.state.shadow = Some((c, blur.max(0.0) as f32, dx as f32, dy as f32));
    }

    /// A CSS font (`700 100px "card3d Inter", Arial, sans-serif`): the size and the first catalog
    /// family (the bundled card fonts, all bold).
    fn set_font(&mut self, css: &str) {
        if let Some(px) = css.split_whitespace().find_map(|t| t.strip_suffix("px").and_then(|n| n.parse::<f32>().ok())) {
            self.state.font_px = px;
        }
        self.state.font = css.to_string();
        self.state.middle = false;
    }
    fn set_middle_baseline(&mut self) {
        self.state.middle = true;
    }
    fn set_letter_spacing(&mut self, px: f64) {
        self.state.letter_spacing = px as f32;
    }
    fn measure_text(&mut self, s: &str) -> TextMetrics {
        let f = text::SizedFont::new(&self.state.font, self.state.font_px);
        let (asc, desc) = f.ink(s);
        let width = f.layout(s).1 + self.state.letter_spacing * s.chars().count() as f32;
        TextMetrics { width: width as f64, ascent: asc as f64, descent: desc as f64 }
    }
    fn fill_text(&mut self, s: &str, x: f64, y: f64) {
        // Glyph coverage straight into the pixmap: the engine draws text without rotation; a uniform
        // scale scales the glyphs (a condensing x scale only moves the pen).
        let t = self.state.transform;
        let k = if (t.sx - t.sy).abs() < 1e-6 { t.sx } else { 1.0 };
        // The middle baseline: half the font's ascent above its descent, over the alphabetic one.
        let y = if self.state.middle { y + text::SizedFont::new(&self.state.font, self.state.font_px).middle() as f64 } else { y };
        let (ox, oy) = (t.tx + x as f32 * t.sx, t.ty + y as f32 * t.sy);
        let c = match &self.state.fill {
            Paint::Color(css) => parse_css_color(css).unwrap_or([0.0, 0.0, 0.0, 1.0]),
            Paint::Linear { stops, .. } | Paint::Radial { stops, .. } => stops.first().and_then(|s| parse_css_color(&s.1)).unwrap_or([0.0; 4]),
        };
        let alpha = c[3] * self.state.alpha;
        let (w, h) = (self.pixmap.width() as i32, self.pixmap.height() as i32);
        let mut cover = vec![0.0f32; (w * h) as usize];
        text::SizedFont::new(&self.state.font, self.state.font_px * k).draw(s, ox, oy, self.state.letter_spacing * t.sx, |px, py, cv| {
            if px >= 0 && py >= 0 && px < w && py < h {
                let i = (py * w + px) as usize;
                cover[i] = (cover[i] + cv).min(1.0);
            }
        });
        let data = self.pixmap.data_mut();
        for (i, &cv) in cover.iter().enumerate() {
            if cv <= 0.0 {
                continue;
            }
            // Source-over in premultiplied space.
            let a = cv * alpha;
            let o = 4 * i;
            for k in 0..3 {
                data[o + k] = (c[k] * a * 255.0 + data[o + k] as f32 * (1.0 - a)).round().clamp(0.0, 255.0) as u8;
            }
            data[o + 3] = (a * 255.0 + data[o + 3] as f32 * (1.0 - a)).round().clamp(0.0, 255.0) as u8;
        }
    }

    fn draw_image(&mut self, image: &Image, x: f64, y: f64, w: f64, h: f64) {
        let Some(mut src) = sk::Pixmap::new(image.width.max(1), image.height.max(1)) else { return };
        for (d, s) in src.data_mut().as_chunks_mut::<4>().0.iter_mut().zip(image.rgba.as_chunks::<4>().0) {
            let a = s[3] as f32 / 255.0;
            d.copy_from_slice(&[(s[0] as f32 * a).round() as u8, (s[1] as f32 * a).round() as u8, (s[2] as f32 * a).round() as u8, s[3]]);
        }
        self.draw_pixmap_into(&src, x, y, w, h);
    }
    fn draw_canvas(&mut self, source: &dyn Canvas, x: f64, y: f64, w: f64, h: f64) {
        if let Some(src) = source.as_any().downcast_ref::<SkiaCanvas>() {
            let src = src.pixmap.clone();
            self.draw_pixmap_into(&src, x, y, w, h);
        }
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn set_smoothing_high(&mut self) {
        self.state.smooth_high = true;
    }
    fn get_image_data(&mut self) -> Vec<u8> {
        let mut out = self.pixmap.data().to_vec();
        for p in out.as_chunks_mut::<4>().0 {
            let a = p[3] as f32;
            if a > 0.0 && a < 255.0 {
                for v in &mut p[..3] {
                    *v = (*v as f32 * 255.0 / a).round().min(255.0) as u8;
                }
            }
        }
        out
    }
    fn put_image_data(&mut self, rgba: &[u8]) {
        let data = self.pixmap.data_mut();
        for (d, s) in data.as_chunks_mut::<4>().0.iter_mut().zip(rgba.as_chunks::<4>().0) {
            let a = s[3] as f32 / 255.0;
            d[0] = (s[0] as f32 * a).round() as u8;
            d[1] = (s[1] as f32 * a).round() as u8;
            d[2] = (s[2] as f32 * a).round() as u8;
            d[3] = s[3];
        }
    }
    /// A PNG (the `image` crate) as a data URL.
    fn to_data_url(&mut self) -> String {
        use base64::Engine;
        let (w, h) = (self.width(), self.height());
        let rgba = self.get_image_data();
        let mut png = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut png);
        if image::ImageEncoder::write_image(encoder, &rgba, w, h, image::ExtendedColorType::Rgba8).is_err() {
            return String::new();
        }
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
    }
}
