//! 2D drawing from the host: the subset of the Canvas 2D API the card's textures are drawn with (the
//! chip's contacts, marks, text, finishes). The TypeScript engine drew them with Canvas 2D, so the
//! code ports line by line. The web host hands out real `OffscreenCanvas`es (card3d-web), which
//! keeps the browser's output identical to the three.js engine's; native hosts implement it on
//! tiny-skia (card3d-native). Colours are CSS strings (`#rgb`, `#rrggbb`, `rgb()`, `rgba()`).

/// A decoded image: RGBA8, rows top first, straight (not premultiplied) alpha.
#[derive(Clone, Debug)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// What an image is for: artwork is downscaled to ≤ 1280 px (`designTexture`); stickers and logos
/// use the image as loaded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImagePurpose {
    Artwork,
    Full,
    /// A liquid-metal mask (`toProcessedLiquidMetal`): as loaded, except that an SVG is rasterised
    /// at 4096 px on its longer side.
    Mask,
}

/// A scene environment file as the host loaded it (`CardDesign.scene.environment`: a catalog id or a
/// URL), still encoded: the engine decodes it (`scene.rs`).
#[derive(Clone, Debug)]
pub enum EnvironmentFile {
    /// A gain-mapped image (the catalog's `.webp` files, scripts/build-environments.mjs): W × 2H, its
    /// pixels as decoded without colour management or premultiplication.
    GainMap(Image),
    /// A Radiance `.hdr` file's bytes.
    Radiance(Vec<u8>),
}

/// What the engine gets from its platform: 2D canvases (textures, text) and decoded images. Hosts
/// are cheap to share; canvases are independent.
pub trait Host {
    fn canvas(&self, width: u32, height: u32) -> Box<dyn Canvas>;
    /// The image a design refers to by `src` (a URL, a `data:` URL), decoded, or `None` if it isn't
    /// available (the layer is then skipped, as the TypeScript engine skips an image that fails to load).
    /// Web hosts load every image a design uses before the card is built (`createCard`).
    fn image(&self, src: &str, purpose: ImagePurpose) -> Option<Image> {
        let _ = (src, purpose);
        None
    }
    /// The scene environment `src` refers to (a catalog id such as "softbox", or a `.hdr` / `.webp`
    /// URL), or `None` if it isn't available (the studio environment stays, as three's staging falls
    /// back to it). Web hosts load it with the design's images (packages/core/wasm/loader.js).
    fn environment(&self, src: &str) -> Option<EnvironmentFile> {
        let _ = src;
        None
    }
    /// The provider's name and bio family (`AssetProvider.nameFontFamily`), for designs without a
    /// font of their own.
    fn name_font(&self) -> String {
        crate::fonts::DEFAULT_FAMILY.to_string()
    }
    /// A file's bytes, or `None` if it isn't available: what native hosts decode themselves (GIF
    /// stickers, a custom font file). The engine doesn't read files; web pages decode them.
    fn file(&self, src: &str) -> Option<Vec<u8>> {
        let _ = src;
        None
    }
    /// `text.toUpperCase()`. Web hosts use the browser's, which spares the build Rust's Unicode case
    /// tables.
    /// `x` as JavaScript writes it: `String(x)` (`precision` 0) or `x.toPrecision(precision)`, for the
    /// AR files' text (`ar_formats`). The browser host lets JavaScript write it.
    fn number(&self, x: f64, precision: u8) -> String {
        match precision {
            0 => crate::ar_formats::js_number(x),
            p => crate::ar_formats::js_precision(x, p as usize),
        }
    }
    fn uppercase(&self, text: &str) -> String {
        text.to_uppercase()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Paint {
    Color(String),
    /// `createLinearGradient(x0, y0, x1, y1)` with colour stops (offset 0..1, CSS colour), in the user
    /// space current when it is set.
    Linear {
        from: [f64; 2],
        to: [f64; 2],
        stops: Vec<(f64, String)>,
    },
    /// `createRadialGradient(x0, y0, r0, x1, y1, r1)` as (x, y, r) circles. Native hosts draw
    /// concentric ones (the only kind the engine uses).
    Radial {
        from: [f64; 3],
        to: [f64; 3],
        stops: Vec<(f64, String)>,
    },
}

impl Paint {
    pub fn color(css: &str) -> Paint {
        Paint::Color(css.to_string())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineCap {
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineJoin {
    Miter,
    Round,
    Bevel,
}

/// `globalCompositeOperation`: the modes the engine draws with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Composite {
    SourceOver,
    /// "lighter": the colours add.
    Lighter,
    /// "source-in": the source where the canvas has ink, nothing elsewhere.
    SourceIn,
    /// "destination-in": the canvas kept where the source has ink.
    DestinationIn,
    /// "destination-out": the canvas erased where the source has ink.
    DestinationOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FillRule {
    NonZero,
    EvenOdd,
}

/// `measureText`: advance width and the ink's ascent / descent from the alphabetic baseline.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TextMetrics {
    pub width: f64,
    pub ascent: f64,
    pub descent: f64,
}

/// A Canvas 2D context. Text is drawn left-aligned on the alphabetic baseline (or the middle one).
pub trait Canvas {
    fn width(&self) -> u32;
    fn height(&self) -> u32;
    /// Resizes and clears the canvas, resetting all state (like setting `canvas.width`).
    fn resize(&mut self, width: u32, height: u32);

    fn save(&mut self);
    fn restore(&mut self);
    fn translate(&mut self, x: f64, y: f64);
    fn scale(&mut self, x: f64, y: f64);
    fn rotate(&mut self, angle: f64);
    /// `transform(a, b, c, d, e, f)`: multiplies the current transform by [a c e; b d f].
    fn transform(&mut self, m: [f64; 6]);
    /// `setTransform(a, b, c, d, e, f)`: replaces the current transform.
    fn set_transform(&mut self, m: [f64; 6]);

    fn begin_path(&mut self);
    fn move_to(&mut self, x: f64, y: f64);
    fn line_to(&mut self, x: f64, y: f64);
    fn quadratic_curve_to(&mut self, cx: f64, cy: f64, x: f64, y: f64);
    fn bezier_curve_to(&mut self, c1x: f64, c1y: f64, c2x: f64, c2y: f64, x: f64, y: f64);
    fn arc_to(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, radius: f64);
    fn arc(&mut self, cx: f64, cy: f64, radius: f64, start: f64, end: f64, counter_clockwise: bool);
    fn rect(&mut self, x: f64, y: f64, w: f64, h: f64);
    /// `roundRect(x, y, w, h, r)` with one radius.
    fn round_rect(&mut self, x: f64, y: f64, w: f64, h: f64, r: f64);
    /// `ellipse(x, y, rx, ry, rotation, start, end)` (clockwise).
    fn ellipse(&mut self, x: f64, y: f64, rx: f64, ry: f64, rotation: f64, start: f64, end: f64);
    fn close_path(&mut self);
    /// Appends an SVG path (`new Path2D(d)`) to the current path.
    fn svg_path(&mut self, d: &str);

    fn fill(&mut self, rule: FillRule);
    fn stroke(&mut self);
    fn clip(&mut self, rule: FillRule);
    fn fill_rect(&mut self, x: f64, y: f64, w: f64, h: f64);
    fn clear_rect(&mut self, x: f64, y: f64, w: f64, h: f64);

    fn set_fill(&mut self, paint: Paint);
    fn set_stroke(&mut self, paint: Paint);
    fn set_line_width(&mut self, width: f64);
    fn set_line_cap(&mut self, cap: LineCap);
    fn set_line_join(&mut self, join: LineJoin);
    fn set_global_alpha(&mut self, alpha: f64);
    fn set_composite(&mut self, op: Composite);
    /// `filter = "blur(<px>px)"` (0: `"none"`) for the following draws.
    fn set_blur(&mut self, px: f64);
    /// `shadowColor`, `shadowBlur` and `shadowOffsetX` / `Y` (device pixels, whatever the transform).
    fn set_shadow(&mut self, color: &str, blur: f64, dx: f64, dy: f64);

    /// A CSS font, e.g. `700 100px "Inter", Arial, sans-serif`.
    fn set_font(&mut self, css: &str);
    /// `letterSpacing` in px: added after every character, including the last (as browsers measure it).
    fn set_letter_spacing(&mut self, px: f64);
    /// `textBaseline = "middle"` (the em box's middle) for the following `fill_text`s, until the next
    /// `set_font`.
    fn set_middle_baseline(&mut self);
    fn measure_text(&mut self, text: &str) -> TextMetrics;
    fn fill_text(&mut self, text: &str, x: f64, y: f64);

    /// `drawImage(image, x, y, w, h)`: the image scaled into the rectangle (user space), source-over,
    /// with the canvas's default smoothing.
    fn draw_image(&mut self, image: &Image, x: f64, y: f64, w: f64, h: f64);
    /// `drawImage(canvas, x, y, w, h)` of another canvas of the same host.
    fn draw_canvas(&mut self, source: &dyn Canvas, x: f64, y: f64, w: f64, h: f64);
    /// The host's canvas type (for `draw_canvas`).
    fn as_any(&self) -> &dyn std::any::Any;

    /// `imageSmoothingQuality = "high"` for the following `draw_image`s (the default is "low").
    fn set_smoothing_high(&mut self) {}

    /// The pixels, RGBA8 rows top first, not premultiplied (`getImageData`).
    fn get_image_data(&mut self) -> Vec<u8>;
    /// Replaces the pixels (`putImageData` at 0, 0).
    fn put_image_data(&mut self, rgba: &[u8]);
    /// The canvas as a PNG data URL (`toDataURL("image/png")`; AR models' textures), or empty when the
    /// host can't encode.
    fn to_data_url(&mut self) -> String {
        String::new()
    }
}

/// `roundRectPath` of the TypeScript engine: a rounded rectangle from `arcTo`s (a new path unless `begin` is false).
pub fn round_rect_path(c: &mut dyn Canvas, x: f64, y: f64, w: f64, h: f64, r: f64, begin: bool) {
    if begin {
        c.begin_path();
    }
    c.move_to(x + r, y);
    c.arc_to(x + w, y, x + w, y + h, r);
    c.arc_to(x + w, y + h, x, y + h, r);
    c.arc_to(x, y + h, x, y, r);
    c.arc_to(x, y, x + w, y, r);
    c.close_path();
}

/// Parses a CSS colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)`, `rgba(r, g, b, a)`, a
/// few names) into straight RGBA 0..1. For hosts that don't take CSS themselves.
pub fn parse_css_color(css: &str) -> Option<[f32; 4]> {
    let s = css.trim().to_ascii_lowercase();
    if let Some(hex) = s.strip_prefix('#') {
        let v: Vec<u8> = hex.chars().map(|c| c.to_digit(16).map(|d| d as u8)).collect::<Option<_>>()?;
        let full = |a: u8, b: u8| (a * 16 + b) as f32 / 255.0;
        return match v.len() {
            3 => Some([v[0] as f32 / 15.0, v[1] as f32 / 15.0, v[2] as f32 / 15.0, 1.0]),
            4 => Some([v[0] as f32 / 15.0, v[1] as f32 / 15.0, v[2] as f32 / 15.0, v[3] as f32 / 15.0]),
            6 => Some([full(v[0], v[1]), full(v[2], v[3]), full(v[4], v[5]), 1.0]),
            8 => Some([full(v[0], v[1]), full(v[2], v[3]), full(v[4], v[5]), full(v[6], v[7])]),
            _ => None,
        };
    }
    if let Some(args) = s.strip_prefix("rgba(").or_else(|| s.strip_prefix("rgb(")).and_then(|r| r.strip_suffix(')')) {
        let n: Vec<f32> = args.split(',').map(|p| p.trim().parse::<f32>().ok()).collect::<Option<_>>()?;
        return match n.len() {
            3 => Some([n[0] / 255.0, n[1] / 255.0, n[2] / 255.0, 1.0]),
            4 => Some([n[0] / 255.0, n[1] / 255.0, n[2] / 255.0, n[3].clamp(0.0, 1.0)]),
            _ => None,
        };
    }
    match s.as_str() {
        "white" => Some([1.0, 1.0, 1.0, 1.0]),
        "black" => Some([0.0, 0.0, 0.0, 1.0]),
        "transparent" => Some([0.0; 4]),
        _ => None,
    }
}
