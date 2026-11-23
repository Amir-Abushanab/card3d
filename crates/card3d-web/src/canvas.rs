//! The browser's Canvas 2D as the engine's `canvas::Host`: the card's textures and text are drawn
//! exactly as the three.js engine drew them (the page loads the card font as a FontFace first).

use card3d_engine::canvas::{Canvas, Composite, FillRule, Host, Image, ImagePurpose, LineCap, LineJoin, Paint, TextMetrics};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

/// `images`: what `createCard` loaded for the design, a JS `Map` (packages/core/wasm/loader.js,
/// `loadDesignImages`): images (`ImageData`) and environment files by key, and the provider's name
/// font.
pub(crate) struct BrowserHost {
    pub images: Option<js_sys::Map>,
}

impl BrowserHost {
    fn get(&self, key: &str) -> JsValue {
        self.images.as_ref().map_or(JsValue::UNDEFINED, |m| m.get(&JsValue::from_str(key)))
    }
    fn image_data(&self, key: &str) -> Option<Image> {
        let d: web_sys::ImageData = self.get(key).dyn_into().ok()?;
        Some(Image { width: d.width(), height: d.height(), rgba: d.data().0 })
    }
}

impl Host for BrowserHost {
    /// `createCard` keys artwork by `src`, the full-size images by `full:` + `src` and liquid-metal
    /// masks by `mask:` + `src`.
    fn image(&self, src: &str, purpose: ImagePurpose) -> Option<Image> {
        self.image_data(&match purpose {
            ImagePurpose::Artwork => src.to_string(),
            ImagePurpose::Full => format!("full:{src}"),
            ImagePurpose::Mask => format!("mask:{src}"),
        })
    }
    /// `font:name`.
    fn name_font(&self) -> String {
        self.get("font:name").as_string().unwrap_or_else(|| card3d_engine::fonts::DEFAULT_FAMILY.to_string())
    }
    fn number(&self, x: f64, precision: u8) -> String {
        let n = js_sys::Number::from(x);
        match precision {
            0 => n.to_string_with_radix(10),
            p => n.to_precision(p),
        }
        .map(String::from)
        .unwrap_or_default()
    }
    fn uppercase(&self, text: &str) -> String {
        js_sys::JsString::from(text).to_upper_case().into()
    }

    /// `createCard` keys a scene's environment by `env:` + its id or URL: the gain-mapped image's
    /// `ImageData`, or a `.hdr` file's bytes (`Uint8Array`).
    fn environment(&self, src: &str) -> Option<card3d_engine::canvas::EnvironmentFile> {
        use card3d_engine::canvas::EnvironmentFile;
        let v = self.get(&format!("env:{src}"));
        if let Some(d) = v.dyn_ref::<web_sys::ImageData>() {
            return Some(EnvironmentFile::GainMap(Image { width: d.width(), height: d.height(), rgba: d.data().0 }));
        }
        v.dyn_into::<js_sys::Uint8Array>().ok().map(|b| EnvironmentFile::Radiance(b.to_vec()))
    }

    fn canvas(&self, width: u32, height: u32) -> Box<dyn Canvas> {
        let canvas = document_canvas(width.max(1), height.max(1))
            .unwrap_or_else(|| web_sys::OffscreenCanvas::new(width.max(1), height.max(1)).expect("OffscreenCanvas"));
        // The engine reads its canvases back (getImageData): say so, as the browser asks.
        let options = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&options, &JsValue::from_str("willReadFrequently"), &JsValue::TRUE);
        // A document canvas's context is a CanvasRenderingContext2D: the same methods, called by name.
        let ctx = canvas.get_context_with_context_options("2d", &options).ok().flatten().expect("2d context").unchecked_into();
        Box::new(BrowserCanvas { canvas, ctx, pending: RefCell::new(None) })
    }
}

/// A `<canvas>` element, as the three.js engine draws on (`document.createElement`), where there is a
/// document: Chrome rasterises some paths differently on an OffscreenCanvas (the vines' leaf atlas
/// differs in places), so the element keeps the textures identical. It has the OffscreenCanvas's
/// members by name (width, height, getContext).
fn document_canvas(width: u32, height: u32) -> Option<web_sys::OffscreenCanvas> {
    let doc = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("document")).ok().filter(|d| d.is_object())?;
    let create: js_sys::Function = js_sys::Reflect::get(&doc, &JsValue::from_str("createElement")).ok()?.dyn_into().ok()?;
    let canvas = create.call1(&doc, &JsValue::from_str("canvas")).ok()?;
    let _ = js_sys::Reflect::set(&canvas, &JsValue::from_str("width"), &JsValue::from(width));
    let _ = js_sys::Reflect::set(&canvas, &JsValue::from_str("height"), &JsValue::from(height));
    Some(canvas.unchecked_into())
}

struct BrowserCanvas {
    canvas: web_sys::OffscreenCanvas,
    ctx: web_sys::OffscreenCanvasRenderingContext2d,
    /// An SVG path (`svg_path`) waiting for its fill, stroke or clip: Canvas 2D can't append SVG
    /// path data to the current path, only draw a `Path2D`.
    pending: RefCell<Option<web_sys::Path2d>>,
}

fn rule(rule: FillRule) -> web_sys::CanvasWindingRule {
    match rule {
        FillRule::NonZero => web_sys::CanvasWindingRule::Nonzero,
        FillRule::EvenOdd => web_sys::CanvasWindingRule::Evenodd,
    }
}

impl BrowserCanvas {
    /// Calls the context's method `name` with numbers (the less common ones, by name: no import each).
    fn call(&self, name: &str, args: &[f64]) {
        if let Ok(f) = js_sys::Reflect::get(&self.ctx, &JsValue::from_str(name)) {
            let a: js_sys::Array = args.iter().map(|v| JsValue::from_f64(*v)).collect();
            let _ = f.unchecked_into::<js_sys::Function>().apply(&self.ctx, &a);
        }
    }
    /// Sets the context's property `name`.
    fn set(&self, name: &str, value: JsValue) {
        let _ = js_sys::Reflect::set(&self.ctx, &JsValue::from_str(name), &value);
    }
    fn style(&self, paint: &Paint) -> JsValue {
        match paint {
            Paint::Color(css) => JsValue::from_str(css),
            Paint::Linear { from, to, stops } => {
                let g = self.ctx.create_linear_gradient(from[0], from[1], to[0], to[1]);
                for (o, c) in stops {
                    let _ = g.add_color_stop(*o as f32, c);
                }
                g.into()
            }
            Paint::Radial { from, to, stops } => {
                let Ok(g) = self.ctx.create_radial_gradient(from[0], from[1], from[2], to[0], to[1], to[2]) else { return JsValue::from_str("transparent") };
                for (o, c) in stops {
                    let _ = g.add_color_stop(*o as f32, c);
                }
                g.into()
            }
        }
    }
}

#[allow(deprecated, reason = "set_fill_style / set_stroke_style take a JsValue for colours and gradients alike")]
impl Canvas for BrowserCanvas {
    fn width(&self) -> u32 {
        self.canvas.width()
    }
    fn height(&self) -> u32 {
        self.canvas.height()
    }
    fn resize(&mut self, width: u32, height: u32) {
        self.canvas.set_width(width.max(1));
        self.canvas.set_height(height.max(1));
    }
    fn save(&mut self) {
        self.ctx.save();
    }
    fn restore(&mut self) {
        self.ctx.restore();
    }
    fn translate(&mut self, x: f64, y: f64) {
        let _ = self.ctx.translate(x, y);
    }
    fn scale(&mut self, x: f64, y: f64) {
        let _ = self.ctx.scale(x, y);
    }
    fn rotate(&mut self, angle: f64) {
        let _ = self.ctx.rotate(angle);
    }
    fn transform(&mut self, m: [f64; 6]) {
        self.call("transform", &m);
    }
    fn set_transform(&mut self, m: [f64; 6]) {
        self.call("setTransform", &m);
    }
    fn begin_path(&mut self) {
        self.ctx.begin_path();
        self.pending.borrow_mut().take();
    }
    fn move_to(&mut self, x: f64, y: f64) {
        self.ctx.move_to(x, y);
    }
    fn line_to(&mut self, x: f64, y: f64) {
        self.ctx.line_to(x, y);
    }
    fn quadratic_curve_to(&mut self, cx: f64, cy: f64, x: f64, y: f64) {
        self.ctx.quadratic_curve_to(cx, cy, x, y);
    }
    fn bezier_curve_to(&mut self, c1x: f64, c1y: f64, c2x: f64, c2y: f64, x: f64, y: f64) {
        self.ctx.bezier_curve_to(c1x, c1y, c2x, c2y, x, y);
    }
    fn arc_to(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, r: f64) {
        let _ = self.ctx.arc_to(x1, y1, x2, y2, r);
    }
    fn arc(&mut self, cx: f64, cy: f64, radius: f64, start: f64, end: f64, ccw: bool) {
        let _ = self.ctx.arc_with_anticlockwise(cx, cy, radius, start, end, ccw);
    }
    fn rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.ctx.rect(x, y, w, h);
    }
    fn round_rect(&mut self, x: f64, y: f64, w: f64, h: f64, r: f64) {
        self.call("roundRect", &[x, y, w, h, r]);
    }
    fn ellipse(&mut self, x: f64, y: f64, rx: f64, ry: f64, rotation: f64, start: f64, end: f64) {
        self.call("ellipse", &[x, y, rx, ry, rotation, start, end]);
    }
    fn close_path(&mut self) {
        self.ctx.close_path();
    }
    fn svg_path(&mut self, d: &str) {
        if let Ok(p) = web_sys::Path2d::new_with_path_string(d) {
            *self.pending.borrow_mut() = Some(p);
        }
    }
    fn fill(&mut self, r: FillRule) {
        match self.pending.borrow().as_ref() {
            Some(p) => self.ctx.fill_with_path_2d_and_winding(p, rule(r)),
            None => self.ctx.fill_with_canvas_winding_rule(rule(r)),
        }
    }
    fn stroke(&mut self) {
        match self.pending.borrow().as_ref() {
            Some(p) => self.ctx.stroke_with_path(p),
            None => self.ctx.stroke(),
        }
    }
    fn clip(&mut self, r: FillRule) {
        match self.pending.borrow().as_ref() {
            Some(p) => self.ctx.clip_with_path_2d_and_winding(p, rule(r)),
            None => self.ctx.clip_with_canvas_winding_rule(rule(r)),
        }
    }
    fn fill_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.ctx.fill_rect(x, y, w, h);
    }
    fn clear_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.ctx.clear_rect(x, y, w, h);
    }
    fn set_fill(&mut self, paint: Paint) {
        self.ctx.set_fill_style(&self.style(&paint));
    }
    fn set_stroke(&mut self, paint: Paint) {
        self.ctx.set_stroke_style(&self.style(&paint));
    }
    fn set_line_width(&mut self, width: f64) {
        self.ctx.set_line_width(width);
    }
    fn set_line_cap(&mut self, cap: LineCap) {
        self.ctx.set_line_cap(match cap {
            LineCap::Butt => "butt",
            LineCap::Round => "round",
            LineCap::Square => "square",
        });
    }
    fn set_line_join(&mut self, join: LineJoin) {
        self.ctx.set_line_join(match join {
            LineJoin::Miter => "miter",
            LineJoin::Round => "round",
            LineJoin::Bevel => "bevel",
        });
    }
    fn set_global_alpha(&mut self, alpha: f64) {
        self.ctx.set_global_alpha(alpha);
    }
    fn set_composite(&mut self, op: Composite) {
        let _ = self.ctx.set_global_composite_operation(match op {
            Composite::SourceOver => "source-over",
            Composite::Lighter => "lighter",
            Composite::SourceIn => "source-in",
            Composite::DestinationIn => "destination-in",
            Composite::DestinationOut => "destination-out",
        });
    }
    fn set_blur(&mut self, px: f64) {
        // The number through JS (no float formatting in the wasm).
        let f: JsValue = match px > 0.0 {
            true => js_sys::JsString::from("blur(").concat(&js_sys::Number::from(px).to_string(10).unwrap_or_else(|_| "0".into())).concat(&"px)".into()).into(),
            false => JsValue::from_str("none"),
        };
        self.set("filter", f);
    }
    fn set_shadow(&mut self, color: &str, blur: f64, dx: f64, dy: f64) {
        self.set("shadowColor", JsValue::from_str(color));
        self.set("shadowBlur", JsValue::from_f64(blur));
        self.set("shadowOffsetX", JsValue::from_f64(dx));
        self.set("shadowOffsetY", JsValue::from_f64(dy));
    }
    fn set_font(&mut self, css: &str) {
        self.ctx.set_font(css);
        self.ctx.set_text_align("left");
        self.ctx.set_text_baseline("alphabetic");
    }
    fn set_middle_baseline(&mut self) {
        self.ctx.set_text_baseline("middle");
    }
    fn set_letter_spacing(&mut self, px: f64) {
        // Not in web-sys yet: set the property directly.
        let _ = js_sys::Reflect::set(
            &self.ctx,
            &JsValue::from_str("letterSpacing"),
            &js_sys::Number::from(px).to_string(10).unwrap_or_else(|_| "0".into()).concat(&"px".into()),
        );
    }
    fn measure_text(&mut self, text: &str) -> TextMetrics {
        match self.ctx.measure_text(text) {
            Ok(m) => TextMetrics { width: m.width(), ascent: m.actual_bounding_box_ascent(), descent: m.actual_bounding_box_descent() },
            Err(_) => TextMetrics::default(),
        }
    }
    fn fill_text(&mut self, text: &str, x: f64, y: f64) {
        let _ = self.ctx.fill_text(text, x, y);
    }
    fn draw_image(&mut self, image: &Image, x: f64, y: f64, w: f64, h: f64) {
        let Ok(src) = web_sys::OffscreenCanvas::new(image.width.max(1), image.height.max(1)) else { return };
        let Some(ctx) = src.get_context("2d").ok().flatten().and_then(|c| c.dyn_into::<web_sys::OffscreenCanvasRenderingContext2d>().ok()) else { return };
        if let Ok(d) = web_sys::ImageData::new_with_u8_clamped_array_and_sh(wasm_bindgen::Clamped(&image.rgba), image.width, image.height) {
            let _ = ctx.put_image_data(&d, 0.0, 0.0);
            let _ = self.ctx.draw_image_with_offscreen_canvas_and_dw_and_dh(&src, x, y, w, h);
        }
    }
    fn draw_canvas(&mut self, source: &dyn Canvas, x: f64, y: f64, w: f64, h: f64) {
        if let Some(src) = source.as_any().downcast_ref::<BrowserCanvas>() {
            let _ = self.ctx.draw_image_with_offscreen_canvas_and_dw_and_dh(&src.canvas, x, y, w, h);
        }
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn set_smoothing_high(&mut self) {
        let _ = js_sys::Reflect::set(&self.ctx, &JsValue::from_str("imageSmoothingQuality"), &JsValue::from_str("high"));
    }
    fn get_image_data(&mut self) -> Vec<u8> {
        self.ctx.get_image_data(0.0, 0.0, self.canvas.width() as f64, self.canvas.height() as f64).map(|d| d.data().0).unwrap_or_default()
    }
    fn put_image_data(&mut self, rgba: &[u8]) {
        let (w, h) = (self.canvas.width(), self.canvas.height());
        if let Ok(d) = web_sys::ImageData::new_with_u8_clamped_array_and_sh(wasm_bindgen::Clamped(rgba), w, h) {
            let _ = self.ctx.put_image_data(&d, 0.0, 0.0);
        }
    }
    /// A document `<canvas>`'s `toDataURL("image/png")` (an `OffscreenCanvas` has none: empty).
    fn to_data_url(&mut self) -> String {
        js_sys::Reflect::get(&self.canvas, &JsValue::from_str("toDataURL"))
            .ok()
            .and_then(|f| f.dyn_into::<js_sys::Function>().ok())
            .and_then(|f| f.call1(&self.canvas, &JsValue::from_str("image/png")).ok())
            .and_then(|v| v.as_string())
            .unwrap_or_default()
    }
}
