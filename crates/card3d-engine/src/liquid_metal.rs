//! Liquid metal (shaders/library/liquid-metal/): Paper Shaders' liquid metal flowing inside
//! a mask, the `liquid-metal` face shader layer.
//!
//! - The mask (`toProcessedLiquidMetal`): an image's alpha becomes a Poisson edge field (R) and
//!   the alpha itself (G), drawn and resampled on the host's canvases as the browser does it.
//! - The surface (surface.ts): the Paper fragment (shaders/liquid-metal.wgsl) drawn into a texture of
//!   the face's size, raw display values for the layer's `uSource`. A draw is pending until the next
//!   `prepare`.
//! - The clock (driver.ts): live, the tilt spring, the pointer's speed and the wheel raise a
//!   motion level that speeds the shader clock up and swells the stripes; frozen (a `time`), one frame.
//!
//! All of it is the `liquid_metal` chunk: [`kit`] hands out its entry point (the face layer's
//! runtime), and the per-frame code is reached through the trait object it makes.

use glam::Vec3;

use crate::canvas::{FillRule, Host, Image, ImagePurpose, Paint};
use crate::effects::{bind_group, bind_layout, Bind};
use crate::face_shaders::ParamValue;
use crate::json::{Map, Value};
use crate::layout::CardFrame;
use crate::renderer::{Renderer, Wrap};

const SHADER: &str = wgsl!("liquid-metal.wgsl");

/// `toProcessedLiquidMetal`'s working size (the mask's shorter side while solving) and sweeps.
const WORKING_SIZE: f64 = 512.0;
const ITERATIONS: usize = 40;

/// A face shader layer's runtime (`createRuntime`): code of this chunk, reached through this pointer.
pub type Kit = fn(&mut Renderer, &FaceLayer<'_>) -> Box<dyn Runtime>;

/// The `liquid_metal` chunk: only cards with liquid metal download it.
#[wasm_split_helpers::wasm_split(liquid_metal, fallible)]
pub fn kit() -> Result<Kit, crate::ChunkUnavailable> {
    Ok(face_runtime)
}

// ── the look (look.ts) ───────────────────────────────────────────────────────

/// `LiquidMetalLook`: the surface's tunable values.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    /// `u_colorTint` (`shaderColorFromHex(tint)`).
    pub tint: [f64; 4],
    pub contour: f64,
    pub distortion: f64,
    pub softness: f64,
    pub repetition: f64,
    pub shift_red: f64,
    pub shift_blue: f64,
    pub angle: f64,
    pub scale: f64,
    pub rotation: f64,
    pub offset: [f64; 2],
    /// Paper's procedural shape (0 full fill, 1 circle, 2 daisy, 3 diamond, 4 metaballs).
    pub shape: f64,
    pub avoid_chip: bool,
}

impl Default for Look {
    /// `LIQUID_METAL_LOOK`.
    fn default() -> Look {
        Look {
            tint: shader_color_from_hex("#606060"),
            contour: 0.12,
            distortion: 0.57,
            softness: 1.0,
            repetition: 3.03,
            shift_red: -0.76,
            shift_blue: -1.0,
            angle: -194.0,
            scale: 1.1,
            rotation: 0.0,
            offset: [-0.02, -0.025],
            shape: 3.0,
            avoid_chip: true,
        }
    }
}

/// `shaderColorFromHex`: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` → 0..1, else mid grey.
pub fn shader_color_from_hex(color: &str) -> [f64; 4] {
    let hex = color.strip_prefix('#').unwrap_or(color);
    let mut h: String = if hex.len() == 3 || hex.len() == 4 { hex.chars().flat_map(|c| [c, c]).collect() } else { hex.to_string() };
    if h.len() == 6 {
        h.push_str("ff");
    }
    if h.len() != 8 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return [0.5, 0.5, 0.5, 1.0];
    }
    std::array::from_fn(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).map_or(0.0, |v| v as f64 / 255.0))
}

/// (`motionUniforms`): distortion, contour and scale at motion level `v`.
pub fn motion(look: &Look, v: f64) -> [f64; 3] {
    [look.distortion + 0.43 * 0.6 * v, look.contour + 0.07 * 0.6 * v, look.scale + (0.08 * v).min(0.25)]
}

/// (`stripeAngle`): the stripe angle for the card's world +Z (degrees, 0..360).
pub fn stripe_angle(angle: f64, normal: Option<Vec3>) -> f64 {
    let yaw = normal.map_or(0.0, |n| (n.x as f64).atan2(n.z as f64) * 180.0 / std::f64::consts::PI);
    ((angle + yaw) % 360.0 + 360.0) % 360.0
}

/// `faceHeight`: a face's height in px for `width` (the ID-1 aspect).
pub fn face_height(width: u32) -> u32 {
    (width as f64 * 2.125 / 3.37 + 0.5).floor() as u32
}

/// The face's chip ([cx, cy, hx, hy], top-origin uv) and aspect (`ShaderRuntimeContext.frame`).
pub fn frame_chip(frame: &CardFrame) -> ([f64; 4], f64) {
    let chip = crate::layout::chip_rect(Some(frame));
    ([chip.x / frame.width + 0.5, 0.5 - chip.y / frame.height, chip.w / frame.width / 2.0, chip.h / frame.height / 2.0], frame.width / frame.height)
}

// ── the mask (paper.ts `toProcessedLiquidMetal`) ──────────────────────

/// `Math.round` of a non-negative value.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// A number stored into a `Uint8ClampedArray` (ties to even, NaN to 0).
fn clamped_u8(x: f64) -> u8 {
    if x.is_nan() || x <= 0.0 {
        return 0;
    }
    if x >= 255.0 {
        return 255;
    }
    let f = x.floor();
    // Ties go to the even neighbour.
    let up = f + 0.5 < x || (f + 0.5 == x && f % 2.0 != 0.0);
    let v = if up { f + 1.0 } else { f };
    v as u8
}

/// The Poisson edge field of a shape (`mask`, row-major `width` × `height`, true inside), as
/// `toProcessedLiquidMetal`'s intermediate image (RGBA): grey 255 · (1 − u / max u) inside (white at
/// the edge), transparent white outside. Interior pixels solve −∇²u = 0.01 with u = 0 on the shape's
/// boundary (pixels with an outside neighbour, diagonals included, or on the image's border): red/black
/// SOR, ω 1.9, 40 sweeps, in single precision as `Float32Array`s keep it.
pub fn poisson_field(mask: &[bool], width: usize, height: usize) -> Vec<u8> {
    let (w, h) = (width, height);
    let mut interior: Vec<usize> = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            if !mask[idx] {
                continue;
            }
            let boundary = x == 0
                || x == w - 1
                || y == 0
                || y == h - 1
                || !mask[idx - 1]
                || !mask[idx + 1]
                || !mask[idx - w]
                || !mask[idx + w]
                || !mask[idx - w - 1]
                || !mask[idx - w + 1]
                || !mask[idx + w - 1]
                || !mask[idx + w + 1];
            if !boundary {
                interior.push(idx);
            }
        }
    }
    // E, W, N, S neighbours inside the shape (`neighbours`).
    let nb: Vec<[Option<usize>; 4]> = interior
        .iter()
        .map(|&idx| {
            let (x, y) = (idx % w, idx / w);
            [
                (x < w - 1 && mask[idx + 1]).then_some(idx + 1),
                (x > 0 && mask[idx - 1]).then_some(idx - 1),
                (y > 0 && mask[idx - w]).then_some(idx - w),
                (y < h - 1 && mask[idx + w]).then_some(idx + w),
            ]
        })
        .collect();
    // `solvePoissonSparse`.
    const C: f64 = 0.01;
    const OMEGA: f64 = 1.9;
    let mut u = vec![0f32; w * h];
    let (red, black): (Vec<usize>, Vec<usize>) = (0..interior.len()).partition(|&i| (interior[i] % w + interior[i] / w).is_multiple_of(2));
    let sweep = |u: &mut Vec<f32>, set: &[usize]| {
        for &i in set {
            let idx = interior[i];
            let sum: f64 = nb[i].iter().flatten().map(|&n| u[n] as f64).sum();
            let new_value = (C + sum) / 4.0;
            u[idx] = (OMEGA * new_value + (1.0 - OMEGA) * u[idx] as f64) as f32;
        }
    };
    for _ in 0..ITERATIONS {
        sweep(&mut u, &red);
        sweep(&mut u, &black);
    }
    let max = interior.iter().map(|&i| u[i] as f64).fold(0.0, f64::max);
    let mut out = vec![0u8; 4 * w * h];
    for (idx, px) in out.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        *px = if mask[idx] {
            let g = clamped_u8(255.0 * (1.0 - u[idx] as f64 / max));
            [g, g, g, 255]
        } else {
            [255, 255, 255, 0]
        };
    }
    out
}

/// A quick hash of an image's bytes (FxHash's step over 8-byte words), for `renderer::memo`'s key.
fn fingerprint(bytes: &[u8]) -> u64 {
    let (words, rest) = bytes.as_chunks::<8>();
    let mut h = bytes.len() as u64;
    for w in words.iter().copied().chain([std::array::from_fn(|i| rest.get(i).copied().unwrap_or(0))]) {
        h = (h.rotate_left(5) ^ u64::from_le_bytes(w)).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    h
}

/// `toProcessedLiquidMetal`: the mask image (alpha = shape) as the surface's input: R the edge field
/// (white at the edge), G the alpha, B and A 255; the image's size. The shape is read at the working
/// size (the image drawn on a canvas, default smoothing); the field is drawn back up to the image's size
/// with high-quality smoothing.
pub fn process_mask(host: &dyn Host, img: &Image) -> Image {
    let (ow, oh) = (img.width.max(1), img.height.max(1));
    let k = WORKING_SIZE / ow.min(oh) as f64;
    let (w, h) = ((js_round(ow as f64 * k) as u32).max(1), (js_round(oh as f64 * k) as u32).max(1));
    let mut shape = host.canvas(w, h);
    shape.draw_image(img, 0.0, 0.0, w as f64, h as f64);
    let data = shape.get_image_data();
    let mask: Vec<bool> = data.as_chunks::<4>().0.iter().map(|p| p[3] != 0).collect();
    let field = Image { width: w, height: h, rgba: poisson_field(&mask, w as usize, h as usize) };
    let mut up = host.canvas(ow, oh);
    up.set_smoothing_high();
    up.draw_image(&field, 0.0, 0.0, ow as f64, oh as f64);
    let mut out = up.get_image_data();
    out.resize(4 * (ow * oh) as usize, 0);
    for (px, src) in out.as_chunks_mut::<4>().0.iter_mut().zip(img.rgba.as_chunks::<4>().0) {
        let a = src[3];
        if a == 0 {
            px[0] = 255;
            px[1] = 0;
        } else {
            if px[3] == 0 {
                px[0] = 0;
            }
            px[1] = a;
        }
        px[2] = 255;
        px[3] = 255;
    }
    Image { width: ow, height: oh, rgba: out }
}

/// `brandMarkUrl`: the brand mark (the corner mark), white on transparent, centred on a face-sized
/// canvas (at most 1024 wide) at 62 % of its height.
pub fn brand_mark(host: &dyn Host, face_width: u32) -> Image {
    let w = face_width.min(1024);
    let h = face_height(w);
    let vb = crate::mark::GENERIC_MARK_VIEWBOX;
    let k = 0.62 * h as f64 / vb[0].max(vb[1]);
    let mut c = host.canvas(w, h);
    c.translate((w as f64 - vb[0] * k) / 2.0, (h as f64 - vb[1] * k) / 2.0);
    c.scale(k, k);
    c.set_fill(Paint::color("#fff"));
    c.begin_path();
    c.svg_path(crate::mark::GENERIC_MARK_PATH);
    c.fill(FillRule::NonZero);
    Image { width: w, height: h, rgba: c.get_image_data() }
}

// ── the surface (surface.ts) ─────────────────────────────────────────────────

/// The Paper uniforms (`liquidMetalUniforms` and ShaderMount's), in display units.
#[derive(Clone, Copy, Debug)]
pub struct Values {
    pub look: Look,
    /// `u_chip` and `u_cardAspect`.
    pub chip: [f64; 4],
    pub card_aspect: f64,
    pub is_image: bool,
}

impl Values {
    /// `liquidMetalUniforms(look, isImage, frame)`.
    pub fn new(look: Look, is_image: bool, chip: [f64; 4], card_aspect: f64) -> Values {
        Values { look, chip: if look.avoid_chip { chip } else { [10.0, 10.0, 0.0, 0.0] }, card_aspect, is_image }
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Paper {
    a: [f32; 4],
    b: [f32; 4],
    c: [f32; 4],
    d: [f32; 4],
    color_back: [f32; 4],
    color_tint: [f32; 4],
    e: [f32; 4],
    f: [f32; 4],
    chip: [f32; 4],
}

/// The Paper fragment drawn into a texture (`LiquidMetalSurface`).
struct Surface {
    values: Values,
    size: (u32, u32),
    image_aspect: f64,
    uniform: wgpu::Buffer,
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    target: wgpu::TextureView,
    pending: bool,
    /// A draw at this frame clock waiting for a queue (`pending_frame`).
    next: Option<f64>,
}

impl Surface {
    /// A surface drawing into `target` (`size`, RGBA8), with the processed mask's texture and aspect
    /// (none: Paper's procedural shape). Nothing is drawn until `draw` and `render`.
    fn new(
        r: &mut Renderer,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        mask: Option<&(wgpu::Texture, f64)>,
        values: Values,
        target: wgpu::TextureView,
        size: (u32, u32),
    ) -> Surface {
        // Paper's mask upload: no flip, no premultiply, mipmapped trilinear, clamped.
        let image = match mask {
            Some((m, _)) => r.adopt_texture(m, Wrap::Clamp, 1),
            None => r.texture(device, queue, &[(1, 1, vec![0; 4])], false, Wrap::Clamp),
        };
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("liquid metal mask"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("liquid metal"),
            size: size_of::<Paper>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let layout = bind_layout(device, "liquid metal", &[Bind::Uniform, Bind::Texture, Bind::Sampler]);
        let bind_group = bind_group(
            device,
            &layout,
            &[uniform.as_entire_binding(), wgpu::BindingResource::TextureView(r.texture_view(image)), wgpu::BindingResource::Sampler(&sampler)],
        );
        let module = crate::effects::module(device, "liquid metal", SHADER);
        let make = || {
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("liquid metal"),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            });
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("liquid metal (Paper Shaders)"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fs"),
                    targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                    compilation_options: Default::default(),
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            });
            (layout.clone(), module.clone(), pipeline)
        };
        let pipeline = crate::renderer::memo(device, "liquid metal", 1, crate::renderer::key_of((&layout, &module)), make).2.clone();
        let image_aspect = mask.map_or(0.0, |m| m.1);
        Surface { values, size, image_aspect, uniform, pipeline, bind_group, target, pending: false, next: None }
    }

    /// Sets the uniforms and the frame clock (ms of shader time); the next `render` draws them.
    fn draw(&mut self, queue: &wgpu::Queue, frame: f64) {
        let (v, l) = (&self.values, &self.values.look);
        let f = |x: f64| x as f32;
        let data = Paper {
            a: [self.size.0 as f32, self.size.1 as f32, 1.0, f(self.image_aspect)],
            b: [0.5, 0.5, 0.0, 0.0],
            c: [1.0, f(l.scale), f(l.rotation), f(frame * 1e-3)],
            d: [f(l.offset[0]), f(l.offset[1]), v.is_image as i32 as f32, f(l.shape)],
            color_back: [0.0; 4],
            color_tint: l.tint.map(f),
            e: [f(l.softness), f(l.repetition), f(l.shift_red), f(l.shift_blue)],
            f: [f(l.distortion), f(l.contour), f(l.angle), f(v.card_aspect)],
            chip: v.chip.map(f),
        };
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&data));
        self.pending = true;
    }

    /// Draws a pending `draw` (a transparent clear, no blending).
    fn render(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
        if !std::mem::take(&mut self.pending) {
            return;
        }
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("liquid metal surface"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.target,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.draw(0..6, 0..1);
        }
        queue.submit([encoder.finish()]);
    }
}

// ── the live clock (driver.ts) ──────────────────────────────────────────────

/// `TiltSpring` (not snapped: it starts at rest at the origin).
#[derive(Default)]
struct Spring {
    position: [f64; 2],
    velocity: [f64; 2],
}

/// `LiquidMetalDriver`: the motion level, shader clock and stripe angle.
pub struct Driver {
    spring: Spring,
    pointer: [f64; 2],
    /// The pointer in normalised device coordinates (the last position seen).
    ndc: [f64; 2],
    pointer_init: bool,
    wheel: f64,
    elapsed: f64,
    /// The shader frame clock (ms of Paper shader time).
    pub frame: f64,
    look: Look,
    speed: f64,
    motion: bool,
}

/// What a driver step draws: the look with its angle, rotation and motion values, at `frame`.
pub struct Step {
    pub look: Look,
    pub frame: f64,
}

impl Driver {
    pub fn new(look: Look, speed: f64, motion: bool) -> Driver {
        Driver { spring: Spring::default(), pointer: [0.0; 2], ndc: [0.0; 2], pointer_init: false, wheel: 0.0, elapsed: 0.0, frame: 0.0, look, speed, motion }
    }

    /// `primeRedraw`: the next step draws.
    pub fn prime(&mut self) {
        self.elapsed = 1.0 / 30.0;
    }

    /// The pointer moved (normalised device coordinates); ignored without motion.
    pub fn set_pointer(&mut self, ndc: [f64; 2]) {
        if self.motion {
            self.ndc = ndc;
        }
    }

    /// A wheel event (its larger delta); ignored without motion.
    pub fn wheel(&mut self, delta: f64) {
        if self.motion {
            self.wheel = (self.wheel + 0.002 * delta).clamp(-1.0, 1.0);
        }
    }

    /// One tick of `dt` seconds with the card's world +Z; a draw when the 30 Hz cap allows one.
    pub fn step(&mut self, dt: f64, normal: Vec3) -> Option<Step> {
        let h = dt.clamp(0.0, 1.0 / 30.0);
        // 1. Pointer speed (before smoothing) and smoothing.
        let mut f = 0.0;
        if !self.pointer_init {
            self.pointer = self.ndc;
            self.pointer_init = true;
        } else {
            let d = (self.pointer[0] - self.ndc[0]).hypot(self.pointer[1] - self.ndc[1]);
            f = (d / h.max(1.0 / 120.0) / 18.0).clamp(0.0, 1.0);
        }
        let k = (12.0 * h).min(1.0);
        for i in 0..2 {
            self.pointer[i] += (self.ndc[i] - self.pointer[i]) * k;
        }
        // 2–3. The tilt spring toward the card normal.
        let target = [normal.x as f64, normal.y as f64];
        let s = &mut self.spring;
        for i in 0..2 {
            let a = (target[i] - s.position[i]) * 32.0 - 5.8 * s.velocity[i];
            s.velocity[i] += a * h;
            s.position[i] += s.velocity[i] * h;
        }
        // 4. The 30 Hz cap.
        self.elapsed += h;
        if self.elapsed < 1.0 / 30.0 {
            return None;
        }
        let p_ms = 1000.0 * self.elapsed;
        self.elapsed %= 1.0 / 30.0;
        // 5–6.
        let g = self.wheel;
        self.wheel *= (-3.5 * h).exp();
        let speed = s.velocity[0].hypot(s.velocity[1]);
        let v = if self.motion { speed.max(f).max(g.abs()).clamp(0.0, 1.0) } else { 0.0 };
        // 7–9.
        let mut look = self.look;
        look.angle = stripe_angle(self.look.angle, self.motion.then_some(normal));
        self.frame += p_ms * (0.006 + 0.35 * v) * self.speed;
        look.rotation = ((self.look.rotation + if self.motion { 12.0 * self.pointer[0] } else { 0.0 }) % 360.0 + 360.0) % 360.0;
        [look.distortion, look.contour, look.scale] = motion(&self.look, v);
        Some(Step { look, frame: self.frame })
    }
}

// ── the face shader layer (index.ts `createRuntime`) ────────────────────────

/// A face shader layer's runtime: the surface its `uSource` samples.
pub trait Runtime {
    /// The surface (`uSource`); `None` while there is none (no mask: the layer stays transparent).
    fn source(&self) -> Option<&wgpu::TextureView>;
    /// A live step of `dt` seconds (clamped) with the card's world +Z; true when the surface changed.
    fn update(&mut self, dt: f64, normal: Vec3) -> bool;
    /// Draws a pending frame (before the layer samples it).
    fn prepare(&mut self, device: &wgpu::Device, queue: &wgpu::Queue);
    fn set_pointer(&mut self, ndc: [f64; 2]);
    fn wheel(&mut self, delta: f64);
}

/// What a layer's runtime is built from (`ShaderRuntimeContext`).
pub struct FaceLayer<'a> {
    pub device: &'a wgpu::Device,
    pub queue: &'a wgpu::Queue,
    pub host: &'a dyn Host,
    pub look: LayerLook,
    /// This side's artwork (`artworkUrl`), for the artwork mask.
    pub artwork: Option<&'a str>,
    pub face_width: u32,
    pub frame: &'a CardFrame,
    pub live: bool,
    /// The frozen time (s; 0 when neither live nor frozen).
    pub time: f64,
}

/// A layer's resolved params as the runtime reads them (`lookFromParams`, mask, speed, motion).
#[derive(Clone, Copy, Debug)]
pub struct LayerLook {
    pub look: Look,
    /// 0 the face's artwork, 1 the brand mark, 2–6 a procedural shape (6 the whole face).
    pub mask: i32,
    pub speed: f64,
    pub motion: bool,
}

/// `lookFromParams` over a layer's resolved params (`keys[i]` ↔ `values[i]`); `given`: the layer's
/// `params` as written (a tint given as a [r, g, b] array resolves to an array, which the runtime
/// ignores for the default).
pub fn layer_look(keys: &[&str], values: &[ParamValue], given: Option<&Map>) -> LayerLook {
    let get = |k: &str| keys.iter().position(|q| *q == k).and_then(|i| values.get(i));
    let d = Look::default();
    let num = |k: &str, default: f64| get(k).map_or(default, ParamValue::num);
    let flag = |k: &str| !matches!(get(k), Some(ParamValue::Bool(false)));
    let mask = num("mask", 0.0) as i32;
    let tint = match (get("tint"), given.and_then(|m| m.get("tint"))) {
        (_, Some(Value::Array(_))) | (None, _) => d.tint,
        (Some(v), _) => match v {
            ParamValue::Vec(c) if c.len() >= 3 => [c[0], c[1], c[2], 1.0],
            _ => d.tint,
        },
    };
    let offset = match get("offset") {
        Some(ParamValue::Vec(o)) => [o.first().copied().unwrap_or(0.0), o.get(1).copied().unwrap_or(0.0)],
        _ => d.offset,
    };
    let shape = match mask {
        2 => 1.0,
        3 => 2.0,
        4 => 3.0,
        5 => 4.0,
        _ => 0.0,
    };
    let look = Look {
        tint,
        contour: num("contour", d.contour),
        distortion: num("distortion", d.distortion),
        softness: num("softness", d.softness),
        repetition: num("repetition", d.repetition),
        shift_red: num("shiftRed", d.shift_red),
        shift_blue: num("shiftBlue", d.shift_blue),
        angle: num("angle", d.angle),
        scale: num("scale", d.scale),
        rotation: num("rotation", d.rotation),
        offset,
        shape,
        avoid_chip: flag("avoidChip"),
    };
    LayerLook { look, mask, speed: num("speed", 1.0), motion: flag("motion") }
}

struct LayerRuntime {
    surface: Option<Surface>,
    driver: Option<Driver>,
    texture: Option<wgpu::TextureView>,
}

/// `createRuntime`: the mask (the face's artwork at its full size, the brand mark, or none for a
/// procedural shape), the surface at the face's width, then one frame: frozen, at the at-rest clock
/// (6 ms of shader frame per second × speed); live, frame 0 and the driver.
fn face_runtime(r: &mut Renderer, o: &FaceLayer<'_>) -> Box<dyn Runtime> {
    let mask = match o.look.mask {
        0 => match o.artwork.and_then(|src| o.host.image(src, ImagePurpose::Mask).or_else(|| o.host.image(src, ImagePurpose::Artwork))) {
            Some(img) => Some(img),
            None => return Box::new(LayerRuntime { surface: None, driver: None, texture: None }),
        },
        1 => Some(brand_mark(o.host, o.face_width)),
        _ => None,
    };
    // The processed mask, made once per device for the same image (`renderer::memo`).
    let key = match o.look.mask {
        1 => crate::renderer::key_of(("brand", o.face_width)),
        _ => mask.as_ref().map_or(0, |m| crate::renderer::key_of((m.width, m.height, fingerprint(&m.rgba)))),
    };
    let mask = mask.map(|m| {
        crate::renderer::memo(o.device, "liquid metal mask", 2, key, || {
            let p = process_mask(o.host, &m);
            (
                crate::renderer::upload(o.device, o.queue, &crate::material::mip_chain(&p.rgba, p.width, p.height, false), false),
                p.width as f64 / p.height as f64,
            )
        })
    });
    let w = o.face_width.max(16);
    let size = (w, face_height(w));
    let texture = o.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("liquid metal face shader"),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    let (chip, aspect) = frame_chip(o.frame);
    let values = Values::new(o.look.look, mask.is_some(), chip, aspect);
    let mut surface = Surface::new(r, o.device, o.queue, mask.as_deref(), values, view.clone(), size);
    let driver = if o.live {
        surface.draw(o.queue, 0.0);
        let mut d = Driver::new(o.look.look, o.look.speed, o.look.motion);
        d.prime();
        Some(d)
    } else {
        [surface.values.look.distortion, surface.values.look.contour, surface.values.look.scale] = motion(&o.look.look, 0.0);
        surface.draw(o.queue, 6.0 * o.look.speed * o.time);
        None
    };
    Box::new(LayerRuntime { surface: Some(surface), driver, texture: Some(view) })
}

impl Runtime for LayerRuntime {
    fn source(&self) -> Option<&wgpu::TextureView> {
        self.texture.as_ref()
    }
    fn update(&mut self, dt: f64, normal: Vec3) -> bool {
        let (Some(d), Some(s)) = (self.driver.as_mut(), self.surface.as_mut()) else { return false };
        match d.step(dt, normal) {
            Some(step) => {
                s.values.look = step.look;
                s.pending_frame(step.frame);
                true
            }
            None => false,
        }
    }
    fn prepare(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
        if let Some(s) = self.surface.as_mut() {
            s.flush(queue);
            s.render(device, queue);
        }
    }
    fn set_pointer(&mut self, ndc: [f64; 2]) {
        if let Some(d) = self.driver.as_mut() {
            d.set_pointer(ndc);
        }
    }
    fn wheel(&mut self, delta: f64) {
        if let Some(d) = self.driver.as_mut() {
            d.wheel(delta);
        }
    }
}

impl Surface {
    /// A draw at `frame` whose uniforms are written at the next `flush` (update has no queue).
    fn pending_frame(&mut self, frame: f64) {
        self.next = Some(frame);
    }
    fn flush(&mut self, queue: &wgpu::Queue) {
        if let Some(frame) = self.next.take() {
            self.draw(queue, frame);
        }
    }
}
