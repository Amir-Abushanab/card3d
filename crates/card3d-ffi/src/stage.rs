//! `NativeStage`: the engine's stage with its GPU, surface, design state and animated stickers, as a
//! plain Rust API. The C ABI (`lib.rs`) is a thin layer over it; an Android JNI layer can call the
//! same methods.
//!
//! Threading: a stage is used from the thread that created it (the renderer caches its shader core
//! per thread and device). Only the GIF stickers' decoding runs elsewhere, on a worker thread the
//! stage starts and polls in `advance`.

use crate::host::{remote_urls, Assets, MappedHost};
use card3d_engine::interaction::{CardRotation, InteractionEvent};
use card3d_engine::quality::Quality;
use card3d_engine::stage::{CameraOrbit, Fit, Stage, StageOptions};
use card3d_engine::CardDesign;
use card3d_native::gif::AnimatedStickers;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::{CARD3D_ANIMATING as ANIMATING, CARD3D_FLIPPED_CHANGED as FLIPPED_CHANGED, CARD3D_ROTATION_CHANGED as ROTATION_CHANGED};

/// What a stage draws into.
pub enum Target {
    /// An offscreen texture (tests, exports without a view).
    Offscreen,
    /// A `CAMetalLayer` (pointer to the Objective-C object; Apple platforms).
    #[cfg(target_vendor = "apple")]
    MetalLayer(*mut std::ffi::c_void),
    /// An `ANativeWindow` (Android). The stage holds its own reference to it while it lives.
    #[cfg(target_os = "android")]
    AndroidWindow(*mut std::ffi::c_void),
}

/// Why a call failed.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// The design (or the assets JSON) couldn't be read: nothing to draw.
    Design(String),
    /// The GPU: no adapter or device, the surface, a lost device or an uncaught GPU error. The stage
    /// stops drawing; the app makes a new one.
    Gpu(String),
    /// An export couldn't be made.
    Export(String),
    /// Not possible in this state (no card yet, bad arguments).
    State(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Design(m) | Error::Gpu(m) | Error::Export(m) | Error::State(m) => f.write_str(m),
        }
    }
}

/// The first GPU failure the device reported (lost, or an error the engine didn't scope).
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

/// A design report: `validate::ensure`'s findings, plus (after a build) the face shader layers that
/// didn't compile.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    /// The complete design (JSON) as the engine draws it.
    pub design: String,
    pub errors: Vec<card3d_engine::validate::Issue>,
    pub warnings: Vec<card3d_engine::validate::Issue>,
    /// The design's `http(s)` URLs (`host::remote_urls`): download them before `set_design`.
    pub remote: Vec<String>,
    /// `CardStage.shaderErrors` (JSON array), "[]" before a build.
    pub shader_errors: String,
}

impl Report {
    /// The report as JSON: `{ design, errors: [{ path, message }], warnings, remote, shaderErrors }`
    /// (`design` left out when `with_design` is false).
    pub fn to_json(&self, with_design: bool) -> String {
        let issues = |v: &[card3d_engine::validate::Issue]| {
            let items: Vec<String> = v.iter().map(|i| format!("{{\"path\":{},\"message\":{}}}", json_string(&i.path), json_string(&i.message))).collect();
            format!("[{}]", items.join(","))
        };
        let remote: Vec<String> = self.remote.iter().map(|u| json_string(u)).collect();
        let design = if with_design { format!("\"design\":{},", self.design) } else { String::new() };
        let shader = if self.shader_errors.is_empty() { "[]" } else { &self.shader_errors };
        format!(
            "{{{design}\"errors\":{},\"warnings\":{},\"remote\":[{}],\"shaderErrors\":{shader}}}",
            issues(&self.errors),
            issues(&self.warnings),
            remote.join(",")
        )
    }
}

/// Validates a design (`validate::ensure`) and lists its remote URLs. No GPU; any thread.
pub fn validate(json: &str) -> Result<Report, Error> {
    let ensured =
        card3d_engine::validate::ensure(json).map_err(|i| Error::Design(if i.path.is_empty() { i.message } else { format!("{}: {}", i.path, i.message) }))?;
    let value = card3d_engine::json::parse(&ensured.design).map_err(|e| Error::Design(e.to_string()))?;
    Ok(Report { remote: remote_urls(&value), design: ensured.design, errors: ensured.errors, warnings: ensured.warnings, shader_errors: String::new() })
}

/// A JSON string literal.
pub fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The design on the stage: kept to rebuild it (quality and lighting changes).
struct Current {
    design: String,
    assets: Assets,
}

/// Animated GIF stickers: decoded on a worker, then played on the stage's clock.
#[derive(Default)]
struct Gifs {
    pending: Option<std::thread::JoinHandle<AnimatedStickers>>,
    ready: Option<AnimatedStickers>,
    /// `advance` time (ms) of the first frame they showed.
    start_ms: Option<f64>,
}

pub struct NativeStage {
    // Field order is drop order: the cards before the device they were made on.
    stage: Stage,
    gifs: Gifs,
    current: Option<Current>,
    offscreen: Option<(wgpu::Texture, wgpu::TextureView)>,
    surface: Option<(wgpu::Surface<'static>, wgpu::SurfaceConfiguration)>,
    /// The Android window under `surface`, released after it.
    #[cfg(target_os = "android")]
    _window: Option<crate::android::Window>,
    queue: wgpu::Queue,
    device: wgpu::Device,
    _instance: wgpu::Instance,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
    failure: Failure,
    environments: Option<PathBuf>,
    /// The host's lighting preset (`CardDesign.lighting` overridden), if any.
    lighting: Option<String>,
    /// The slot's Euler rotation (radians).
    slot: [f64; 3],
    /// The last `advance` time (ms).
    now_ms: f64,
}

/// Stage options (`StageOptions`) plus where the scene environments are.
#[derive(Clone, Debug, Default)]
pub struct Options {
    pub stage: StageOptions,
    /// The directory of `<id>.webp` scene environments (packages/core/assets/environments).
    pub environments: Option<PathBuf>,
}

impl NativeStage {
    /// Starts the GPU (Metal on Apple platforms, Vulkan or else GLES elsewhere) on `target`, `width` ×
    /// `height` device pixels.
    /// Boxed: the renderer tells devices apart by address, so the device must not move.
    pub fn new(options: Options, target: Target, width: u32, height: u32) -> Result<Box<NativeStage>, Error> {
        let (width, height) = (width.max(1), height.max(1));
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        // Elsewhere Vulkan, else GLES; wgpu's `WGPU_BACKEND` (e.g. "gl") narrows that, for testing.
        desc.backends = if cfg!(target_vendor = "apple") {
            wgpu::Backends::METAL
        } else {
            wgpu::Backends::from_env().unwrap_or(wgpu::Backends::VULKAN | wgpu::Backends::GL)
        };
        let instance = wgpu::Instance::new(desc);
        #[cfg(target_os = "android")]
        let mut window = None;
        let surface = match target {
            Target::Offscreen => None,
            #[cfg(target_vendor = "apple")]
            Target::MetalLayer(layer) => {
                if layer.is_null() {
                    return Err(Error::State("no layer".into()));
                }
                // SAFETY: the caller passes a live CAMetalLayer and keeps it alive while the stage lives.
                let s = unsafe { instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer)) };
                Some(s.map_err(|e| Error::Gpu(format!("surface: {e}")))?)
            }
            #[cfg(target_os = "android")]
            Target::AndroidWindow(handle) => {
                // SAFETY: the caller passes a live ANativeWindow; the stage takes its own reference.
                let w = unsafe { crate::android::Window::acquire(handle) }.ok_or_else(|| Error::State("no window".into()))?;
                let raw = wgpu::SurfaceTargetUnsafe::RawHandle { raw_display_handle: Some(w.display_handle()), raw_window_handle: w.window_handle() };
                // SAFETY: `window` keeps the ANativeWindow alive until after the surface is dropped.
                let s = unsafe { instance.create_surface_unsafe(raw) };
                window = Some(w);
                Some(s.map_err(|e| Error::Gpu(format!("surface: {e}")))?)
            }
        };
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { compatible_surface: surface.as_ref(), ..Default::default() }))
            .map_err(|e| Error::Gpu(format!("no GPU adapter: {e}")))?;
        #[cfg(target_os = "android")]
        {
            let i = adapter.get_info();
            crate::android::log(&format!("GPU: {:?}, {} ({:?}, {})", i.backend, i.name, i.device_type, i.driver_info));
        }
        // WebGPU's default limits, lowered where the GPU offers less (the iOS simulator has 15
        // inter-stage variables, not 16): the engine stays within the lower values.
        let required_limits = wgpu::Limits::default().or_worse_values_from(&adapter.limits());
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_limits, ..Default::default() }))
            .map_err(|e| Error::Gpu(format!("no GPU device: {e}")))?;
        // Report, don't panic: a lost device or an unhandled GPU error stops the stage, and the app
        // starts a new one.
        let failure = Failure::default();
        let lost = failure.clone();
        device.set_device_lost_callback(move |reason, message| lost.set(format!("device lost ({reason:?}): {message}")));
        let errors = failure.clone();
        device.on_uncaptured_error(Arc::new(move |e| errors.set(format!("GPU error: {e}"))));
        let (surface, format) = match surface {
            Some(surface) => {
                let caps = surface.get_capabilities(&adapter);
                // The shader writes sRGB-encoded colour itself, so the target must not be sRGB.
                let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).ok_or_else(|| Error::Gpu("no non-sRGB surface format".into()))?;
                // Transparent around the card: Core Animation (or Android's compositor) composites the
                // premultiplied frame.
                let alpha_mode = [wgpu::CompositeAlphaMode::PreMultiplied, wgpu::CompositeAlphaMode::PostMultiplied, wgpu::CompositeAlphaMode::Inherit]
                    .into_iter()
                    .find(|m| caps.alpha_modes.contains(m))
                    .unwrap_or(caps.alpha_modes[0]);
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
                (Some((surface, config)), format)
            }
            None => (None, wgpu::TextureFormat::Rgba8Unorm),
        };
        if let Some(f) = failure.get() {
            return Err(Error::Gpu(f));
        }
        Ok(Box::new(NativeStage {
            stage: Stage::new(options.stage),
            gifs: Gifs::default(),
            current: None,
            offscreen: None,
            surface,
            #[cfg(target_os = "android")]
            _window: window,
            queue,
            device,
            _instance: instance,
            format,
            width,
            height,
            failure,
            environments: options.environments,
            lighting: None,
            slot: [0.0; 3],
            now_ms: 0.0,
        }))
    }

    fn check(&self) -> Result<(), Error> {
        self.failure.get().map_or(Ok(()), |f| Err(Error::Gpu(f)))
    }

    /// Validates `json` (`validate::ensure`), builds the card and shows it (the interaction's pose
    /// stays). `assets`: the app's downloads and provider (`host::Assets`). Returns the validation
    /// report with the face shader layers that didn't compile.
    pub fn set_design(&mut self, json: &str, assets: &str) -> Result<Report, Error> {
        let assets = Assets::parse(assets).map_err(Error::Design)?;
        let mut report = validate(json)?;
        self.build(&report.design, &assets)?;
        report.shader_errors = self.stage.shader_errors_json().to_string();
        self.current = Some(Current { design: std::mem::take(&mut report.design), assets });
        Ok(report)
    }

    /// Builds the current design again (after a quality or lighting change). Nothing without one.
    pub fn rebuild(&mut self) -> Result<(), Error> {
        let Some(c) = self.current.take() else { return Ok(()) };
        let r = self.build(&c.design, &c.assets);
        self.current = Some(c);
        r
    }

    fn build(&mut self, json: &str, assets: &Assets) -> Result<(), Error> {
        self.check()?;
        let mut design = CardDesign::from_json(json).map_err(Error::Design)?;
        if let Some(l) = &self.lighting {
            design.lighting = Some(l.clone());
        }
        let host = MappedHost::new(assets, self.environments.clone());
        let font = custom_font(&design, &host);
        let built = pollster::block_on(self.stage.set_design(&self.device, &self.queue, self.format, &design, &host, font));
        built.map_err(|e| Error::Design(e.to_string()))?;
        self.check()?;
        self.start_gifs(host, json);
        Ok(())
    }

    /// Starts decoding the card's animated GIF stickers on a worker thread.
    fn start_gifs(&mut self, host: MappedHost, json: &str) {
        self.gifs = Gifs::default();
        let decals = self.stage.animated_stickers();
        if decals.is_empty() {
            return;
        }
        let json = json.to_string();
        self.gifs.pending = Some(std::thread::spawn(move || match CardDesign::from_json(&json) {
            Ok(design) => AnimatedStickers::load(&host, &design, &decals),
            Err(_) => AnimatedStickers::default(),
        }));
    }

    /// Takes the decoded stickers once the worker is done (`wait`: blocks until then).
    fn collect_gifs(&mut self, wait: bool) {
        if self.gifs.pending.as_ref().is_some_and(|h| wait || h.is_finished()) {
            let done = self.gifs.pending.take().and_then(|h| h.join().ok());
            self.gifs.ready = done.filter(|g| !g.is_empty());
            self.gifs.start_ms = None;
        }
    }

    /// Shows the GIF frames due at `now_ms`; the ms until the next change (`None`: none).
    fn show_gif_frames(&mut self, now_ms: f64) -> Option<f64> {
        let gifs = self.gifs.ready.as_mut()?;
        let start = *self.gifs.start_ms.get_or_insert(now_ms);
        let (stage, device, queue) = (&mut self.stage, &self.device, &self.queue);
        let next = gifs.update((now_ms - start).max(0.0) / 1000.0, |decal, w, h, rgba| {
            stage.show_sticker_frame(device, queue, decal, w, h, rgba);
        });
        next.map(|s| s * 1000.0)
    }

    /// The drawing size changed (device pixels).
    pub fn resize(&mut self, width: u32, height: u32) {
        let (width, height) = (width.max(1), height.max(1));
        if (width, height) == (self.width, self.height) {
            return;
        }
        (self.width, self.height) = (width, height);
        if let Some((surface, config)) = self.surface.as_mut() {
            config.width = width;
            config.height = height;
            surface.configure(&self.device, config);
        }
        self.offscreen = None;
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn aspect(&self) -> f64 {
        self.width as f64 / self.height as f64
    }

    /// Advances the interaction and the card's animations to `now_ms` and shows the GIF frames due.
    /// Returns the flags (`ANIMATING`: draw every frame; `ROTATION_CHANGED`, `FLIPPED_CHANGED`) and
    /// the ms after which something changes even if nothing animates (a GIF's next frame, a sticker
    /// still decoding), if any.
    pub fn advance(&mut self, now_ms: f64) -> (u32, Option<f64>) {
        self.now_ms = now_ms;
        let (events, animating) = self.stage.advance(now_ms, self.aspect());
        let mut flags = if animating { ANIMATING } else { 0 };
        for e in events {
            flags |= match e {
                InteractionEvent::RotationChange(_) => ROTATION_CHANGED,
                InteractionEvent::FlippedChange(_) => FLIPPED_CHANGED,
            };
        }
        self.collect_gifs(false);
        let wake = if self.gifs.pending.is_some() { Some(50.0) } else { self.show_gif_frames(now_ms) };
        (flags, wake)
    }

    /// Draws the current state: on the layer (presented), or into the offscreen texture.
    pub fn render(&mut self) -> Result<(), Error> {
        self.check()?;
        let (w, h) = (self.width, self.height);
        if let Some((surface, config)) = self.surface.as_ref() {
            let frame = match surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
                wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => return Ok(()),
                wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                    surface.configure(&self.device, config);
                    return Ok(());
                }
                wgpu::CurrentSurfaceTexture::Validation => return Err(Error::Gpu(self.failure.get().unwrap_or_else(|| "surface validation error".into()))),
            };
            let view = frame.texture.create_view(&Default::default());
            self.stage.render(&self.device, &self.queue, &view, w, h);
            self.queue.present(frame);
        } else {
            if self.offscreen.is_none() {
                let t = self.texture(w, h);
                let v = t.create_view(&Default::default());
                self.offscreen = Some((t, v));
            }
            let (_, view) = self.offscreen.as_ref().expect("offscreen target");
            self.stage.render(&self.device, &self.queue, view, w, h);
        }
        self.check()
    }

    fn texture(&self, width: u32, height: u32) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("card3d export"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    }

    /// A still of the card, `width` × `height` px: straight-alpha RGBA rows, top first. `pose`: the
    /// slot's Euler rotation (radians, XYZ) with the interaction's pose left out (as a non-interactive
    /// stage draws it); `None`: the card as it is on screen. The GIF stickers show their current frame
    /// (the first, before the stage has played them).
    pub fn snapshot(&mut self, width: u32, height: u32, pose: Option<[f64; 3]>) -> Result<Vec<u8>, Error> {
        self.check()?;
        if !self.stage.has_card() {
            return Err(Error::State("no card yet".into()));
        }
        let max = self.device.limits().max_texture_dimension_2d;
        if width == 0 || height == 0 || width > max || height > max {
            return Err(Error::State(format!("size {width} × {height} outside 1…{max}")));
        }
        self.collect_gifs(true);
        if self.gifs.ready.is_some() && self.gifs.start_ms.is_none() {
            self.show_gif_frames(self.now_ms);
        }
        let texture = self.texture(width, height);
        let view = texture.create_view(&Default::default());
        match pose {
            Some(euler) => self.stage.render_posed(&self.device, &self.queue, &view, width, height, euler),
            None => self.stage.render(&self.device, &self.queue, &view, width, height),
        }
        let row = (4 * width).div_ceil(256) * 256;
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("card3d readback"),
            size: (row * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(height) },
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        self.queue.submit([enc.finish()]);
        let mapped = Arc::new(Mutex::new(None));
        let m = mapped.clone();
        readback.slice(..).map_async(wgpu::MapMode::Read, move |r| *m.lock().unwrap_or_else(|e| e.into_inner()) = Some(r.is_ok()));
        self.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| Error::Gpu(e.to_string()))?;
        self.check()?;
        if *mapped.lock().unwrap_or_else(|e| e.into_inner()) != Some(true) {
            return Err(Error::Gpu("readback failed".into()));
        }
        let bgra = matches!(self.format, wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb);
        let data = readback.slice(..).get_mapped_range().map_err(|e| Error::Gpu(e.to_string()))?;
        // Un-premultiplied, as the browser's canvas.toDataURL() and the harness give it.
        let mut px = Vec::with_capacity((4 * width * height) as usize);
        for y in 0..height {
            for p in data[(y * row) as usize..(y * row + 4 * width) as usize].as_chunks::<4>().0 {
                let (r, b) = if bgra { (p[2], p[0]) } else { (p[0], p[2]) };
                let a = p[3] as f32 / 255.0;
                let un = |c: u8| if a > 0.0 { (c as f32 / a).round().min(255.0) as u8 } else { 0 };
                px.extend([un(r), un(p[1]), un(b), p[3]]);
            }
        }
        drop(data);
        readback.unmap();
        Ok(px)
    }

    /// `snapshot` as a PNG file.
    pub fn export_png(&mut self, width: u32, height: u32, pose: Option<[f64; 3]>) -> Result<Vec<u8>, Error> {
        let px = self.snapshot(width, height, pose)?;
        let mut png = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut png);
        image::ImageEncoder::write_image(encoder, &px, width, height, image::ExtendedColorType::Rgba8).map_err(|e| Error::Export(e.to_string()))?;
        Ok(png)
    }

    /// The card's AR model (`card3d_engine::ar`): USDZ (AR Quick Look) or GLB, its maps `size` px
    /// (0: 2048), lying face up or `upright`.
    pub fn export_ar(&mut self, usdz: bool, size: u32, upright: bool) -> Result<Vec<u8>, Error> {
        self.check()?;
        let Some(c) = self.current.as_ref() else { return Err(Error::State("no card yet".into())) };
        let mut design = CardDesign::from_json(&c.design).map_err(Error::Design)?;
        if let Some(l) = &self.lighting {
            design.lighting = Some(l.clone());
        }
        let host = MappedHost::new(&c.assets, self.environments.clone());
        let options = card3d_engine::CardOptions { quality: Quality::Full, print: true, custom_font_family: custom_font(&design, &host), ..Default::default() };
        let card =
            pollster::block_on(card3d_engine::CardRenderer::new(&self.device, &self.queue, wgpu::TextureFormat::Rgba8UnormSrgb, &design, &host, &options))
                .map_err(|e| Error::Export(e.to_string()))?;
        let o = card3d_engine::ar::ArOptions { size: if size > 0 { size } else { 2048 }, upright, usdz };
        let export = pollster::block_on(card3d_engine::ar::export(card, &self.device, &self.queue, Box::new(host), o))
            .map_err(|_| Error::Export("the AR part is unavailable".into()))?;
        let bytes = pollster::block_on(export).map_err(|e| Error::Export(e.to_string()))?;
        self.check()?;
        if bytes.is_empty() {
            return Err(Error::Export("the AR model's textures couldn't be encoded".into()));
        }
        Ok(bytes)
    }

    // ── options ──────────────────────────────────────────────────────────────

    /// The rendering tier; rebuilds the card.
    pub fn set_quality(&mut self, quality: Quality) -> Result<(), Error> {
        if self.stage.options.quality == quality {
            return Ok(());
        }
        self.stage.options.quality = quality;
        self.rebuild()
    }

    pub fn quality(&self) -> Quality {
        self.stage.options.quality
    }

    /// The framing (applies from the next frame).
    pub fn set_fit(&mut self, fit: Fit) {
        self.stage.options.fit = fit;
    }

    /// A lighting preset id (`LIGHTING_PRESETS`) in place of the design's, or `None` for the design's
    /// own; rebuilds the card.
    pub fn set_lighting(&mut self, id: Option<&str>) -> Result<(), Error> {
        let id = id.filter(|s| !s.is_empty()).map(str::to_string);
        if self.lighting == id {
            return Ok(());
        }
        self.lighting = id;
        self.rebuild()
    }

    pub fn set_reduced_motion(&mut self, reduced: bool) {
        self.stage.options.reduced_motion = reduced;
        if let Some(i) = self.stage.interaction_mut() {
            i.set_reduced_motion(reduced);
        }
    }

    /// The app is visible (foreground) or not: hiding ends a drag and jumps a running intro or flip to
    /// its end.
    pub fn set_visible(&mut self, visible: bool) {
        if let Some(i) = self.stage.interaction_mut() {
            i.set_visible(visible);
        }
    }

    // ── the slot and camera ─────────────────────────────────────────────────

    pub fn set_rotation(&mut self, euler: [f64; 3]) {
        self.slot = euler;
        self.stage.set_rotation(euler);
    }

    pub fn set_lift(&mut self, y: f64) {
        self.stage.set_lift(y);
    }

    /// Orbits the camera (degrees, degrees, × distance); `None` returns to the plain camera.
    pub fn set_camera_orbit(&mut self, orbit: Option<[f64; 3]>) {
        self.stage.set_camera_orbit(orbit.map(|[azimuth, elevation, distance]| CameraOrbit { azimuth, elevation, distance }));
    }

    // ── input (the web stage's; positions in points from the view's top left) ─

    pub fn pointer_down(&mut self, id: i32, x: f64, y: f64, width: f64, height: f64, now: f64) -> bool {
        self.stage.pointer_down(id, x, y, width.max(1.0), height.max(1.0), now)
    }
    pub fn pointer_move(&mut self, id: i32, x: f64, y: f64, now: f64) -> bool {
        self.stage.pointer_move(id, x, y, now)
    }
    pub fn pointer_up(&mut self, id: i32, x: f64, y: f64, now: f64) {
        self.stage.pointer_up(id, x, y, now)
    }
    pub fn pointer_cancel(&mut self, id: i32) {
        self.stage.pointer_cancel(id)
    }
    /// Where the pointer is over the view, in normalised device coordinates (x right, y up, −1…1),
    /// or `None` once it left: effects that follow it (live liquid metal).
    pub fn set_pointer(&mut self, ndc: Option<[f64; 2]>) {
        self.stage.set_pointer(ndc)
    }
    pub fn wheel(&mut self, delta: f64) {
        if delta.is_finite() {
            self.stage.wheel(delta);
        }
    }
    /// Double click / double tap: reset.
    pub fn double_click(&mut self) {
        if let Some(i) = self.stage.interaction_mut() {
            i.double_click();
        }
    }
    /// A key: `reset` (Home / Escape) or flip (Enter / Space). True: handled.
    pub fn key(&mut self, reset: bool, now: f64) -> bool {
        self.stage.interaction_mut().is_some_and(|i| i.key(if reset { "Escape" } else { "Enter" }, now))
    }
    pub fn toggle_flip(&mut self, now: f64) {
        if let Some(i) = self.stage.interaction_mut() {
            i.toggle_flip(now);
        }
    }
    pub fn set_flipped(&mut self, flipped: bool, now: f64) {
        if let Some(i) = self.stage.interaction_mut() {
            i.set_flipped(flipped, now);
        }
    }
    pub fn reset(&mut self) {
        if let Some(i) = self.stage.interaction_mut() {
            i.reset();
        }
    }
    /// The interaction's rotation (degrees), at once and without events.
    pub fn set_interaction_rotation(&mut self, x: f64, y: f64) {
        if let Some(i) = self.stage.interaction_mut() {
            i.set_rotation(CardRotation { x, y });
        }
    }
    pub fn flipped(&self) -> bool {
        self.stage.interaction().is_some_and(|i| i.flipped())
    }
    /// Pitch and yaw, degrees.
    pub fn rotation(&self) -> (f64, f64) {
        self.stage.interaction().map_or((0.0, 0.0), |i| (i.rotation().x, i.rotation().y))
    }
    pub fn has_card(&self) -> bool {
        self.stage.has_card()
    }
}

/// The family a design's custom font (`CardDesign.font`, a `url` or `upload` source) registers under,
/// once registered with the native text (`card3d_native::text::register`); `None` without one or when
/// it couldn't be read (the default font draws, as on the web). Google Fonts families aren't fetched
/// natively yet.
fn custom_font(design: &CardDesign, host: &MappedHost) -> Option<String> {
    use card3d_engine::canvas::Host;
    let font = design.font.as_ref()?.as_object()?;
    let source = font.get("source")?.as_str()?;
    let src = font.get("src")?.as_str()?;
    if source != "url" && source != "upload" {
        return None;
    }
    // FNV-1a of the source, as core's custom-font.ts names its families.
    let key = format!("{source}|{src}");
    let h = key.encode_utf16().fold(0x811c9dc5u32, |h, c| (h ^ c as u32).wrapping_mul(0x01000193));
    let family = format!("card3d custom {h:x}");
    let bytes = host.file(src)?;
    card3d_native::text::register(&family, 700, bytes).then_some(family)
}

/// Quality by number: 0 performance, 1 full.
pub fn quality(n: u32) -> Option<Quality> {
    match n {
        0 => Some(Quality::Performance),
        1 => Some(Quality::Full),
        _ => None,
    }
}

/// Fit by number: 0 studio, 1 contain.
pub fn fit(n: u32) -> Option<Fit> {
    match n {
        0 => Some(Fit::Studio),
        1 => Some(Fit::Contain),
        _ => None,
    }
}
