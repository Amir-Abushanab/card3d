//! The card engine in the browser: WebGPU (default features) or, built with `--features webgl`, the
//! WebGL 2 fallback for browsers without WebGPU. `CardStage` is the engine's stage
//! (`card3d_engine::stage`) or the marquee (`card3d_engine::marquee`: many cards in one frame) on a
//! canvas; the page owns the frame loop, input listeners and sizing (packages/core/wasm/loader.js,
//! marquee.js), and forwards them. Textures and text are drawn by the browser's Canvas 2D.
//!
//! The binding is small on purpose (it is in every page's main module): numbers go through one
//! `call` (operation codes below, mirrored by the page's facades), strings out through `text`, and
//! every build (a design, a marquee slot, a print job, an AR model) through one `build`.

#![cfg(target_arch = "wasm32")]

use card3d_engine::card::BuildKey;
use card3d_engine::interaction::{CardRotation, InteractionEvent};
use card3d_engine::marquee::Marquee;
use card3d_engine::quality::Quality;
use card3d_engine::stage::{Fit, Stage, StageOptions};
use card3d_engine::{CardDesign, CardOptions, CardRenderer};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::*;

mod canvas;
use canvas::BrowserHost;

/// Parses a JSON number's text for the engine's JSON reader (`card3d_engine::json`) with the
/// browser's `parseFloat`, so the main module doesn't carry core's float parser.
#[allow(unsafe_code, reason = "the engine declares it by this symbol name (card3d_engine::json::number)")]
#[allow(clippy::no_mangle_with_rust_abi, reason = "an `extern \"Rust\"` declaration in the engine calls it: same compiler, same ABI")]
#[no_mangle]
pub fn card3d_parse_number(text: &str) -> f64 {
    js_sys::parse_float(text)
}

/// The first thing that went wrong with the GPU: the device was lost, or it reported an error the
/// engine didn't handle. Once set, the view stops drawing; the page switches to the other build
/// (packages/core/wasm/loader.js).
#[derive(Clone, Default)]
struct Failure(Arc<Mutex<Option<String>>>);

impl Failure {
    fn set(&self, message: String) {
        let mut f = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if f.is_none() {
            *f = Some(message);
        }
    }
    fn get(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// What `advance` reports, as bit flags.
const ANIMATING: u32 = 1;
const ROTATION_CHANGED: u32 = 2;
const FLIPPED_CHANGED: u32 = 4;

/// `CardStage.call` operations (packages/core/wasm/loader.js and marquee.js name them).
mod op {
    pub(crate) const RESIZE: u32 = 0;
    pub(crate) const RENDER: u32 = 1;
    pub(crate) const POLL: u32 = 2;
    pub(crate) const SIMULATE_DEVICE_LOSS: u32 = 3;
    pub(crate) const ADVANCE: u32 = 4;
    pub(crate) const SET_ROTATION: u32 = 5;
    pub(crate) const SET_POINTER: u32 = 6;
    pub(crate) const WHEEL: u32 = 7;
    pub(crate) const SET_LIFT: u32 = 8;
    pub(crate) const SET_CAMERA_ORBIT: u32 = 9;
    pub(crate) const SET_CAMERA_DISTANCE: u32 = 10;
    pub(crate) const HAS_CARD: u32 = 11;
    pub(crate) const POINTER_DOWN: u32 = 12;
    pub(crate) const POINTER_MOVE: u32 = 13;
    pub(crate) const POINTER_UP: u32 = 14;
    pub(crate) const POINTER_CANCEL: u32 = 15;
    pub(crate) const DOUBLE_CLICK: u32 = 16;
    pub(crate) const KEY: u32 = 17;
    pub(crate) const TOGGLE_FLIP: u32 = 18;
    pub(crate) const SET_FLIPPED: u32 = 19;
    pub(crate) const RESET: u32 = 20;
    pub(crate) const RESTORE_POSE: u32 = 21;
    pub(crate) const SET_ACTIVE: u32 = 22;
    pub(crate) const SET_VISIBLE: u32 = 23;
    pub(crate) const SET_REDUCED_MOTION: u32 = 24;
    pub(crate) const FLIPPED: u32 = 25;
    pub(crate) const ROTATION_X: u32 = 26;
    pub(crate) const ROTATION_Y: u32 = 27;
    pub(crate) const INTRO_STATE: u32 = 28;
    pub(crate) const SET_QUALITY: u32 = 29;
    pub(crate) const SET_FIT: u32 = 30;
    pub(crate) const SET_INTERACTION_ROTATION: u32 = 31;
}

/// `CardStage.build` kinds.
mod build {
    pub(crate) const DESIGN: u32 = 0;
    pub(crate) const SLOT: u32 = 1;
    pub(crate) const PRINT: u32 = 2;
    pub(crate) const AR: u32 = 3;
    pub(crate) const CHECK: u32 = 4;
}

/// What a build's images (`CardStage::build`) say about the card besides the design (`BuildKey`): the
/// keys of the decoded files, which a key's source names (one source, one file), and the strings
/// whole (the name font's family), sorted (the loader adds them as they load).
fn assets(images: Option<&js_sys::Map>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(m) = images {
        m.for_each(&mut |v, k| {
            let k = k.as_string().unwrap_or_default();
            let entry = match v.as_string() {
                Some(v) => k + "=" + &v,
                None => k,
            };
            // A few entries: inserted in order (smaller code than a sort).
            out.insert(out.partition_point(|e| *e < entry), entry);
        });
    }
    out
}

/// `CardStage.mcall` operations on a card's stage (the marquee has its own, `marquee::op`).
mod vop {
    pub(crate) const VIEW: u32 = 0;
    pub(crate) const STICKER: u32 = 1;
}

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    format: wgpu::TextureFormat,
}

/// What a view draws: one card's stage, or the marquee.
#[allow(clippy::large_enum_variant, reason = "one per view, so the size difference is moot")]
enum Scene {
    Card(Stage),
    Marquee(Box<dyn Marquee>),
}

struct View {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    scene: Scene,
}

impl View {
    fn stage(&mut self) -> Option<&mut Stage> {
        match &mut self.scene {
            Scene::Card(s) => Some(s),
            Scene::Marquee(_) => None,
        }
    }
    fn marquee(&mut self) -> Option<&mut Box<dyn Marquee>> {
        match &mut self.scene {
            Scene::Marquee(m) => Some(m),
            Scene::Card(_) => None,
        }
    }
}

/// The stage (or the marquee) on a canvas. Cheap to share between the page's callbacks: an async
/// build keeps its own handle while the page goes on drawing the current card.
#[wasm_bindgen]
pub struct CardStage {
    gpu: Rc<Gpu>,
    view: Rc<RefCell<View>>,
    failure: Failure,
    /// The newest design build: an older one that finishes later is dropped.
    latest: Rc<Cell<u32>>,
}

fn load_error(e: card3d_engine::LoadError) -> JsValue {
    // A part of the engine that couldn't be downloaded is a network problem, not a GPU one: the
    // loader (packages/core/wasm/loader.js) tells them apart by the error's name.
    let error = js_sys::Error::new(&e.to_string());
    error.set_name("Card3dLoadError");
    JsValue::from(error)
}

fn flag(v: f64) -> bool {
    v != 0.0 && !v.is_nan()
}

/// A quality tier by number: 0 performance, 1 full.
fn quality(v: f64) -> Option<Quality> {
    [Quality::Performance, Quality::Full].get(v as usize).copied().filter(|_| v == 0.0 || v == 1.0)
}

#[wasm_bindgen]
impl CardStage {
    /// Starts the GPU on `canvas` (sized by the page, device pixels). The stage: `o` = [quality (0
    /// performance, 1 full), fit (0 studio, 1 contain), interactive, intro, reduced motion, fit to
    /// viewport, default rotation x, y]. The marquee (`marquee`, downloaded now): `o` = [active,
    /// quality, intro, reduced motion] and its lighting preset's id.
    pub async fn create(canvas: web_sys::HtmlCanvasElement, marquee: bool, o: Vec<f64>, lighting: Option<String>) -> Result<CardStage, JsValue> {
        let (gpu, surface, config, failure) = start(canvas).await?;
        let o = |i: usize| o.get(i).copied().unwrap_or(f64::NAN);
        let scene = if marquee {
            let options = card3d_engine::marquee::Options {
                active: o(0) != 0.0,
                quality: quality(o(1)).unwrap_or(Quality::Full),
                lighting: lighting.unwrap_or_default(),
                play_intro: flag(o(2)),
                reduced_motion: flag(o(3)),
            };
            let m = card3d_engine::marquee::create(&gpu.device, &gpu.queue, gpu.format, options)
                .await
                .map_err(|_| load_error(card3d_engine::LoadError { chunk: "marquee" }))?;
            Scene::Marquee(m)
        } else {
            let interactive = o(2) != 0.0;
            Scene::Card(Stage::new(StageOptions {
                quality: quality(o(0)).unwrap_or(Quality::Performance),
                fit: if o(1) == 1.0 { Fit::Contain } else { Fit::Studio },
                interactive,
                intro: if o(3).is_nan() { interactive } else { o(3) != 0.0 },
                reduced_motion: flag(o(4)),
                fit_to_viewport: flag(o(5)),
                default_rotation: CardRotation { x: if o(6).is_nan() { 0.0 } else { o(6) }, y: if o(7).is_nan() { 0.0 } else { o(7) } },
            }))
        };
        Ok(CardStage { gpu: Rc::new(gpu), view: Rc::new(RefCell::new(View { surface, config, scene })), failure, latest: Rc::new(Cell::new(0)) })
    }
}

/// A card built for a print bake (`CardStage.build`; `card3d_engine::print::PrintJob`).
#[wasm_bindgen]
pub struct PrintJob {
    gpu: Rc<Gpu>,
    job: Box<dyn card3d_engine::print::PrintJob>,
}

#[wasm_bindgen]
impl PrintJob {
    /// The items a pass chooses for (JSON, `PrintJob::items`).
    pub fn items(&self) -> String {
        self.job.items()
    }
    /// The largest raster side the GPU renders.
    #[wasm_bindgen(js_name = maxSize)]
    pub fn max_size(&self) -> u32 {
        self.job.max_size()
    }
    /// A side's full-resolution artwork (straight alpha, sRGB).
    #[wasm_bindgen(js_name = setArtwork)]
    pub fn set_artwork(&mut self, back: bool, image: web_sys::ImageData) {
        self.job.set_artwork(&self.gpu.device, &self.gpu.queue, back, image.width(), image.height(), &image.data().0);
    }
    /// Checks on the GPU's work: a pass's pixels arrive on a poll on the WebGL build (the page polls
    /// until `render` called back).
    pub fn poll(&self) {
        self.job.poll(&self.gpu.device);
    }
    /// Renders a pass (`PrintJob::render`) and calls `done` with its RGBA pixels (`Uint8Array`, rows
    /// top first; empty when it couldn't).
    pub fn render(&mut self, spec: &[f32], done: js_sys::Function) {
        self.job.render(&self.gpu.device, &self.gpu.queue, spec, Box::new(move |px| drop(done.call1(&JsValue::NULL, &js_sys::Uint8Array::from(&px[..])))));
    }
}

/// Starts the GPU on `canvas` (sized by the page, device pixels): the device, the configured surface,
/// and the failure the device reports.
async fn start(canvas: web_sys::HtmlCanvasElement) -> Result<(Gpu, wgpu::Surface<'static>, wgpu::SurfaceConfiguration, Failure), JsValue> {
    console_error_panic_hook::set_once();
    let err = |e: &dyn std::fmt::Display| JsValue::from_str(&e.to_string());
    let (width, height) = (canvas.width().max(1), canvas.height().max(1));
    let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
    desc.backends = if cfg!(feature = "webgl") { wgpu::Backends::GL } else { wgpu::Backends::BROWSER_WEBGPU };
    let instance = wgpu::Instance::new(desc);
    let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas)).map_err(|e| err(&e))?;
    let adapter =
        instance.request_adapter(&wgpu::RequestAdapterOptions { compatible_surface: Some(&surface), ..Default::default() }).await.map_err(|e| err(&e))?;
    // WebGL 2 cannot meet WebGPU's default limits (no compute, fewer bindings).
    let required_limits =
        if cfg!(feature = "webgl") { wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()) } else { wgpu::Limits::default() };
    let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor { required_limits, ..Default::default() }).await.map_err(|e| err(&e))?;
    // Report, don't panic: a lost device or an unhandled GPU error makes the page fall back.
    let failure = Failure::default();
    let lost = failure.clone();
    device.set_device_lost_callback(move |reason, message| lost.set(format!("device lost ({reason:?}): {message}")));
    let errors = failure.clone();
    device.on_uncaptured_error(Arc::new(move |e| errors.set(format!("GPU error: {e}"))));
    let caps = surface.get_capabilities(&adapter);
    // The shader writes sRGB-encoded colour itself (as three does), so the target must not be sRGB.
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).ok_or("no non-sRGB surface format")?;
    let alpha_mode =
        if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::PreMultiplied) { wgpu::CompositeAlphaMode::PreMultiplied } else { caps.alpha_modes[0] };
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width,
        height,
        present_mode: wgpu::PresentMode::Fifo,
        desired_maximum_frame_latency: 2,
        alpha_mode,
        view_formats: vec![],
        color_space: wgpu::SurfaceColorSpace::Auto,
    };
    surface.configure(&device, &config);
    if let Some(f) = failure.get() {
        return Err(JsValue::from_str(&f));
    }
    Ok((Gpu { device, queue, format }, surface, config, failure))
}

#[wasm_bindgen]
impl CardStage {
    /// Builds a design (`CardDesign` JSON, as `ensureDesign` returns it); `images`: a `Map` from each
    /// image `src` the design uses to its decoded `ImageData` (packages/core/wasm/loader.js loads
    /// them); `fontFamily`: the family a custom `CardDesign.font` loaded under (core's
    /// `loadDesignFont`). Rejects with a `Card3dLoadError` when a part of the engine couldn't be
    /// downloaded. What it builds (`kind`):
    /// - 0, the stage's design: shown once built (the current card stays on screen meanwhile); resolves
    ///   to false when a newer design replaced it first;
    /// - 1, a marquee slot's card (`a` the slot, `b` the request's token): resolves to true once it is
    ///   shown, false when a newer request for the slot replaced it;
    /// - 2, a print bake's card on this GPU (`card3d_engine::print`, the `print` chunk): a `PrintJob`;
    /// - 3, the AR model (`card3d_engine::ar`, the `ar` and `print` chunks; `a` its maps' size, `b`
    ///   flags: 1 upright, 2 USDZ, else GLB): the file (`Uint8Array`). On the WebGL build the page polls
    ///   the device (`call` `POLL`) until it settles;
    /// - 4, no card: `design` is custom WGSL face shader code, checked on this GPU
    ///   (`face_shaders::check_custom`, the `faces` chunk): its errors as `text(1)` gives them.
    pub fn build(&self, kind: u32, design: String, images: Option<js_sys::Map>, font_family: Option<String>, a: f64, b: f64) -> js_sys::Promise {
        let (gpu, view, latest, failure) = (self.gpu.clone(), self.view.clone(), self.latest.clone(), self.failure.clone());
        let mine = latest.get() + (kind == build::DESIGN) as u32;
        latest.set(mine);
        wasm_bindgen_futures::future_to_promise(async move {
            if kind == build::CHECK {
                let errors = card3d_engine::face_shaders::check_custom(&gpu.device, design).await.map_err(load_error)?;
                return Ok(JsValue::from_str(&errors));
            }
            let doc = card3d_engine::json::parse(&design).map_err(|e| JsValue::from_str(&format!("card design: {e}")))?;
            let design = CardDesign::from_value(&doc).map_err(|e| JsValue::from_str(&e))?;
            let (options, format) = match kind {
                build::PRINT | build::AR => (
                    CardOptions { quality: Quality::Full, custom_font_family: font_family, print: true, ..Default::default() },
                    wgpu::TextureFormat::Rgba8UnormSrgb,
                ),
                _ => {
                    let mut v = view.borrow_mut();
                    let options = match &mut v.scene {
                        Scene::Card(s) => s.card_options(font_family),
                        Scene::Marquee(m) => m.card_options(font_family),
                    };
                    (options, gpu.format)
                }
            };
            // The stage's card takes a design that differs from its own only in values it can change in
            // place (`Stage::retune`) without a build.
            let key = (kind == build::DESIGN).then(|| BuildKey::new(doc, &options, assets(images.as_ref()))).flatten();
            if let (Some(key), Scene::Card(s)) = (&key, &mut view.borrow_mut().scene) {
                if latest.get() != mine {
                    return Ok(JsValue::FALSE);
                }
                if failure.get().is_none() && s.retune(key, &design) {
                    return Ok(JsValue::TRUE);
                }
            }
            let card = CardRenderer::new(&gpu.device, &gpu.queue, format, &design, &BrowserHost { images }, &options).await;
            if let Some(f) = failure.get() {
                return Err(JsValue::from_str(&f));
            }
            let card = card.map_err(load_error)?;
            if kind == build::AR {
                let flags = b as u32;
                let o = card3d_engine::ar::ArOptions { size: if a > 0.0 { a as u32 } else { 2048 }, upright: flags & 1 != 0, usdz: flags & 2 != 0 };
                let unavailable = |_| load_error(card3d_engine::LoadError { chunk: "ar" });
                let export = card3d_engine::ar::export(card, &gpu.device, &gpu.queue, Box::new(BrowserHost { images: None }), o).await.map_err(unavailable)?;
                let bytes = export.await.map_err(load_error)?;
                if bytes.is_empty() {
                    return Err(JsValue::from_str("the AR model's textures couldn't be encoded (no document canvas)"));
                }
                return Ok(js_sys::Uint8Array::from(&bytes[..]).into());
            }
            if kind == build::PRINT {
                let job =
                    card3d_engine::print::start(card, &gpu.device, &gpu.queue).await.map_err(|_| load_error(card3d_engine::LoadError { chunk: "print" }))?;
                return Ok(PrintJob { gpu, job }.into());
            }
            Ok(JsValue::from_bool(match &mut view.borrow_mut().scene {
                Scene::Card(s) if kind == build::DESIGN && latest.get() == mine => {
                    match key {
                        Some(key) => s.install_keyed(card, key),
                        None => s.install(card),
                    }
                    true
                }
                Scene::Marquee(m) if kind == build::SLOT => m.install(a as usize, b as u32, card),
                _ => false,
            }))
        })
    }

    /// Operations that take or return several numbers: the marquee's (`Marquee::call`,
    /// `card3d_engine::marquee::op`, whose code is in the `marquee` chunk), or on a card's stage
    /// (`vop`): `VIEW`, the card's and the camera's placement for the current canvas (`Stage::view`);
    /// `STICKER`, `args` = [decal, then `CardRenderer::sticker`'s values]: a sticker moved and edited
    /// without a rebuild, returning [z, picture aspect].
    pub fn mcall(&self, op: u32, args: &[f64]) -> Vec<f64> {
        let mut guard = self.view.borrow_mut();
        let v = &mut *guard;
        let aspect = v.config.width as f64 / v.config.height.max(1) as f64;
        match &mut v.scene {
            Scene::Marquee(m) => m.call(&self.gpu.device, &self.gpu.queue, op, args),
            Scene::Card(s) => match op {
                vop::VIEW => s.view(aspect),
                vop::STICKER if !args.is_empty() => s.sticker(args[0] as usize, &args[1..]),
                _ => Vec::new(),
            },
        }
    }

    /// The marquee's lighting preset (`LIGHTING_PRESETS` id): the environment is rebuilt, the cards keep.
    #[wasm_bindgen(js_name = setLighting)]
    pub fn set_lighting(&self, id: &str) {
        if let Some(m) = self.view.borrow_mut().marquee() {
            m.set_lighting(&self.gpu.device, &self.gpu.queue, id);
        }
    }

    /// Text out: 0, what went wrong with the GPU, if anything (the device was lost or reported an
    /// error: the page checks it after drawing and switches builds when it is set); 1, face shader
    /// layers of the current card that couldn't be built, a JSON array of `{ index, side: "front" |
    /// "back", errors: [{ line, message }] }` (`FaceShaderLayerError`; lines of the layer's own code, 0
    /// for the whole shader).
    pub fn text(&self, what: u32) -> Option<String> {
        if what == 0 {
            return self.failure.get();
        }
        Some(self.view.borrow_mut().stage()?.shader_errors_json().to_string())
    }

    /// A frame for animated sticker `decal`: the GIF frame inside its die-cut border (as
    /// `card/gif-decal.ts` draws it). False when that sticker isn't animated.
    #[wasm_bindgen(js_name = setStickerFrame)]
    pub fn set_sticker_frame(&self, decal: u32, frame: web_sys::ImageData) -> bool {
        let rgba = frame.data().0;
        let mut v = self.view.borrow_mut();
        v.stage().is_some_and(|s| s.show_sticker_frame(&self.gpu.device, &self.gpu.queue, decal as usize, frame.width(), frame.height(), &rgba))
    }

    /// Everything else, by number (`op`; booleans as 0 / 1, times in ms from `performance.now()`,
    /// pointer positions in element-relative CSS pixels). The interaction's operations are no-ops
    /// before the first card or when not interactive. NaN for "nothing".
    pub fn call(&self, op: u32, a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) -> f64 {
        let gpu = &self.gpu;
        let mut guard = self.view.borrow_mut();
        let v = &mut *guard;
        match op {
            // The canvas's drawing-buffer size changed (device pixels).
            op::RESIZE => {
                let (width, height) = (a as u32, b as u32);
                if width > 0 && height > 0 && (width, height) != (v.config.width, v.config.height) {
                    v.config.width = width;
                    v.config.height = height;
                    v.surface.configure(&gpu.device, &v.config);
                }
            }
            // Draws the current state (the marquee: its last step's frame).
            op::RENDER => {
                if self.failure.get().is_some() {
                    return f64::NAN;
                }
                let frame = match v.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
                    _ => {
                        v.surface.configure(&gpu.device, &v.config);
                        return f64::NAN;
                    }
                };
                let target = frame.texture.create_view(&Default::default());
                let (w, h) = (v.config.width, v.config.height);
                match &mut v.scene {
                    Scene::Card(s) => s.render(&gpu.device, &gpu.queue, &target, w, h),
                    Scene::Marquee(m) => m.render(&gpu.device, &gpu.queue, &target, w, h),
                }
                gpu.queue.present(frame);
            }
            // Checks on the GPU's work (readbacks arrive on a poll on the WebGL build).
            op::POLL => drop(gpu.device.poll(wgpu::PollType::Poll)),
            // Testing only: destroys the device, as a driver crash or a GPU reset would.
            op::SIMULATE_DEVICE_LOSS => gpu.device.destroy(),
            _ => {
                let aspect = v.config.width as f64 / v.config.height.max(1) as f64;
                let Some(s) = v.stage() else { return f64::NAN };
                return stage_call(s, op, aspect, [a, b, c, d, e, f]);
            }
        }
        f64::NAN
    }
}

/// `CardStage.call`'s stage operations.
fn stage_call(s: &mut Stage, op: u32, aspect: f64, [a, b, c, d, e, f]: [f64; 6]) -> f64 {
    let n = |v: bool| v as u32 as f64;
    let with = |s: &mut Stage, f: &mut dyn FnMut(&mut card3d_engine::interaction::CardInteraction) -> f64| s.interaction_mut().map_or(f64::NAN, f);
    match op {
        // Advances the interaction to `a` (ms): bit 1 = keep drawing every frame (an intro, flip or
        // interruption is running), 2 = the rotation changed, 4 = flipped changed.
        op::ADVANCE => {
            let (events, animating) = s.advance(a, aspect);
            let mut flags = if animating { ANIMATING } else { 0 };
            for e in events {
                flags |= match e {
                    InteractionEvent::RotationChange(_) => ROTATION_CHANGED,
                    InteractionEvent::FlippedChange(_) => FLIPPED_CHANGED,
                };
            }
            flags as f64
        }
        // The slot's rotation, radians, Euler XYZ (independent of the interaction).
        op::SET_ROTATION => {
            s.set_rotation([a, b, c]);
            f64::NAN
        }
        // The page's pointer over the canvas, in normalised device coordinates (x right, y up, −1..1;
        // beyond ±1 outside the canvas), or NaN once it left the page. Effects that follow it (live
        // liquid metal) read its speed; they keep drawing by themselves.
        op::SET_POINTER => {
            s.set_pointer((a.is_finite() && b.is_finite()).then_some([a, b]));
            f64::NAN
        }
        // A wheel event on the page (`deltaX`, `deltaY`, px): effects that react to scrolling (liquid
        // metal) take the larger one.
        op::WHEEL => {
            let d = if a.abs() > b.abs() { a } else { b };
            if d.is_finite() {
                s.wheel(d);
            }
            f64::NAN
        }
        op::SET_LIFT => {
            s.set_lift(a);
            f64::NAN
        }
        // Orbits the camera around its framing target (camera paths): azimuth and extra elevation in
        // degrees, `distance` × the framing distance; (0, 0, 1) returns to the plain camera.
        op::SET_CAMERA_ORBIT => {
            let o = [a, b, c].iter().all(|v| v.is_finite()).then_some(card3d_engine::stage::CameraOrbit { azimuth: a, elevation: b, distance: c });
            s.set_camera_orbit(o);
            f64::NAN
        }
        // Places the camera `a` from its target (the page frames the card itself, as Card Studio's
        // exports do); not finite or ≤ 0: the stage's own distance.
        op::SET_CAMERA_DISTANCE => {
            s.host_z = (a > 0.0 && a.is_finite()).then_some(a);
            f64::NAN
        }
        op::HAS_CARD => n(s.has_card()),
        // Pointer id, position, the element's size, time. True: the card took the pointer (capture
        // it).
        op::POINTER_DOWN => n(s.pointer_down(a as i32, b, c, d, e, f)),
        // True: the move belongs to the drag (prevent the default).
        op::POINTER_MOVE => n(s.pointer_move(a as i32, b, c, d)),
        op::POINTER_UP => {
            s.pointer_up(a as i32, b, c, d);
            f64::NAN
        }
        op::POINTER_CANCEL => {
            s.pointer_cancel(a as i32);
            f64::NAN
        }
        op::DOUBLE_CLICK => with(s, &mut |i| {
            i.double_click();
            f64::NAN
        }),
        // A `KeyboardEvent.key` by code (1 "Home" / "Escape", 2 "Enter" / " "); true: handled (prevent
        // the default).
        op::KEY => with(s, &mut |i| n(i.key(if a == 1.0 { "Escape" } else { "Enter" }, b))),
        op::TOGGLE_FLIP => with(s, &mut |i| {
            i.toggle_flip(a);
            f64::NAN
        }),
        op::SET_FLIPPED => with(s, &mut |i| {
            i.set_flipped(flag(a), b);
            f64::NAN
        }),
        op::RESET => with(s, &mut |i| {
            i.reset();
            f64::NAN
        }),
        // Puts the card at a pose at once (degrees), without events: a parked card resuming.
        op::RESTORE_POSE => with(s, &mut |i| {
            i.restore(CardRotation { x: a, y: b }, flag(c));
            f64::NAN
        }),
        // The interaction's rotation (degrees; `setRotation`, no events): a flip in progress goes on.
        op::SET_INTERACTION_ROTATION => with(s, &mut |i| {
            i.set_rotation(CardRotation { x: a, y: b });
            f64::NAN
        }),
        op::SET_ACTIVE => with(s, &mut |i| {
            i.set_active(flag(a), b);
            f64::NAN
        }),
        // The document's visibility (hiding ends a drag and jumps a running intro or flip to its end).
        op::SET_VISIBLE => with(s, &mut |i| {
            i.set_visible(flag(a));
            f64::NAN
        }),
        op::SET_REDUCED_MOTION => {
            s.options.reduced_motion = flag(a);
            with(s, &mut |i| {
                i.set_reduced_motion(flag(a));
                f64::NAN
            })
        }
        op::FLIPPED => with(s, &mut |i| n(i.flipped())),
        // Pitch and yaw, degrees (`CardRotation`).
        op::ROTATION_X => with(s, &mut |i| i.rotation().x),
        op::ROTATION_Y => with(s, &mut |i| i.rotation().y),
        // The intro's `data-intro` state if it ever ran (`IntroState` in order), else NaN.
        op::INTRO_STATE => with(s, &mut |i| i.intro_state().map_or(f64::NAN, |s| s as u8 as f64)),
        // The rendering tier (0 performance, 1 full) and fit (0 studio, 1 contain) for the next design
        // (the page rebuilds the design after changing them).
        op::SET_QUALITY => {
            if let Some(q) = quality(a) {
                s.options.quality = q;
            }
            f64::NAN
        }
        op::SET_FIT => {
            if a == 0.0 || a == 1.0 {
                s.options.fit = if a == 1.0 { Fit::Contain } else { Fit::Studio };
            }
            f64::NAN
        }
        _ => f64::NAN,
    }
}
