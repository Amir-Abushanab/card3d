//! The print bake's GPU side (`print/bake.ts`, which bakes on three): a card built for printing
//! (`CardOptions::print`, an sRGB canvas format) drawn face-on with an orthographic camera at print
//! resolution, one pass per raster, each item drawn as the pass chooses: hidden, as built, as its flat
//! print colour (the metal face shaded by its relief, or the relief alone), as unlit albedo, or as a
//! separation / coverage mask. Every pass draws the card as built (the same meshes, layer order, depth
//! and blending), swapping only materials, as three's bake does, so the rasters register exactly.
//!
//! The bake's policy (which item draws how in which pass) and its CPU steps (bleed fill, separations,
//! coverage boxes, element placement) stay in the TypeScript (`print/bake.ts`), shared with the
//! three.js bake: this module lists the card's items (`PrintJob::items`) and renders passes.
//!
//! On the web this is the `print` chunk (its shader, pipelines and the GPU readback), downloaded only
//! when a page bakes print files.

use glam::{Mat4, Vec3};
use std::collections::HashMap;
use std::rc::Rc;

use crate::card::CardRenderer;
use crate::renderer::{Camera, CustomDraw, Layers, Material, Side, TextureId, Wrap};

/// What an item is (`Renderer::tags`, `[role, kind, number, finish]`): three's mesh names and print
/// marks. Marks' kinds: 1 logo, 2 name, 3 bio, 4 text line (number: its line), 5 contactless mark;
/// finishes: 0 default, then `Finish` + 1 (embossed, engraved, etched). Faces: kind 1 is the back.
pub mod role {
    pub const OTHER: u8 = 0;
    pub const BODY: u8 = 1;
    pub const FACE: u8 = 2;
    pub const ARTWORK: u8 = 3;
    pub const FOIL: u8 = 4;
    pub const CHIP: u8 = 5;
    pub const CHIP_MASK: u8 = 6;
    pub const GLASS: u8 = 7;
    pub const MARK: u8 = 8;
    pub const STICKER: u8 = 9;
    pub const OVERLAY: u8 = 10;
    pub const ADDON: u8 = 11;
}

/// How an item draws in a pass (`PrintJob::render`).
pub mod choice {
    pub const HIDE: u8 = 0;
    /// As built (a depth-only helper stays depth-only).
    pub const KEEP: u8 = 1;
    /// The metal face's flat print colour (`SURFACE_FRAG` mode 0); body parts take the body's material.
    pub const SURFACE: u8 = 2;
    /// The surface relief as grey (mode 1).
    pub const RELIEF: u8 = 3;
    /// Unlit albedo (three's `MeshBasicMaterial` copy); custom draws stay as built.
    pub const ALBEDO: u8 = 4;
    /// Albedo with the full-resolution artwork of its side (`PrintJob::set_artwork`).
    pub const ARTWORK: u8 = 5;
    /// The pass's value where the item draws, with its alpha (`MASK_FRAG`).
    pub const MASK: u8 = 6;
    /// The AR bake's passes (`ar.rs`; three's `passMaterial` in ar/index.ts), each item choosing for
    /// itself: unlit albedo in the colour target (shader layers and unlit prints as built), packed
    /// roughness / metalness or the tangent-space normal in the mask target (shader layers hidden).
    /// Depth-only helpers stay depth-only.
    pub const AR_COLOR: u8 = 7;
    pub const AR_ORM: u8 = 8;
    pub const AR_NORMAL: u8 = 9;
}

/// A card being baked.
pub trait PrintJob {
    /// The items a pass chooses for, as a JSON array in pass order: `{ i, role, kind, n, finish, side
    /// (0 front, 1 back), pos, axis (the item's x axis), plane (its mesh's size), pad, image (the
    /// size of its glyph raster or map), uv (its map's repeat), map (has a colour map), custom }`.
    fn items(&self) -> String;
    /// The largest raster side the GPU renders.
    fn max_size(&self) -> u32;
    /// A side's full-resolution artwork (RGBA rows top first, straight alpha, sRGB) for `ARTWORK`.
    fn set_artwork(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, back: bool, width: u32, height: u32, rgba: &[u8]);
    /// Renders a pass and hands its pixels to `done` (RGBA rows top first; colour: the sRGB encoding of
    /// premultiplied linear colour over transparent; mask: as written). `spec`: side (0 front, 1 back),
    /// target (0 colour, 1 mask), width, height, the camera's half width and half height (card units),
    /// then a choice and a value for each item of `items`.
    fn render(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, spec: &[f32], done: Box<dyn FnOnce(Vec<u8>)>);
    /// Checks on the GPU's work: in the browser's WebGL build a pass's pixels arrive on a later poll
    /// (the host polls until `render` called back).
    fn poll(&self, device: &wgpu::Device);
    /// How many items `items` lists (a choice and a value each in `render`'s spec).
    fn count(&self) -> usize;
}

/// Starts baking `card` (built with `CardOptions::print`, full quality, the `Rgba8UnormSrgb` canvas
/// format: the passes draw linear colour that the target encodes, as three's sRGB render targets do):
/// draws what its first frame draws (face shader skins) and makes the pass shader.
#[wasm_split_helpers::wasm_split(print, fallible)]
pub fn start(card: CardRenderer, device: &wgpu::Device, queue: &wgpu::Queue) -> Result<Box<dyn PrintJob>, crate::ChunkUnavailable> {
    Ok(Box::new(Job::new(card, device, queue)))
}

/// Pipeline state of a pass item.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Key {
    /// The fragment entry point: 0 `fs_surface`, 1 `fs_mask`, 2 `fs_orm`, 3 `fs_normal`.
    entry: u8,
    srgb: bool,
    side: Side,
    depth_test: bool,
    depth_write: bool,
    offset: Option<(u32, u32)>,
    blend: bool,
    color_write: bool,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct DrawUniform {
    model_view: [[f32; 4]; 4],
    a: [f32; 4],
    map_uv: [f32; 4],
    normal_uv: [f32; 4],
    rough_uv: [f32; 4],
    flags: [f32; 4],
}

struct Job {
    card: CardRenderer,
    /// Each item as built: material, visibility, custom draw.
    original: Vec<(Material, bool, Option<CustomDraw>)>,
    /// The items passes choose for (visible, not a scene's), in order.
    listed: Vec<usize>,
    shader: wgpu::ShaderModule,
    bind_layout: wgpu::BindGroupLayout,
    layout: wgpu::PipelineLayout,
    pipelines: HashMap<Key, Rc<wgpu::RenderPipeline>>,
    /// Finished marks' glyph rasters (item → texture, padding).
    glyphs: HashMap<usize, (TextureId, [f32; 2])>,
    artwork: [Option<TextureId>; 2],
    /// The device's largest texture side.
    max: u32,
}

impl Job {
    fn new(mut card: CardRenderer, device: &wgpu::Device, queue: &wgpu::Queue) -> Job {
        // The first frame's work (face shader skins), from the studio camera at the identity pose.
        card.prepare(device, queue, Mat4::IDENTITY, &Camera::axis(crate::stage::CAMERA_Z));
        let r = &mut card.renderer;
        // A scene (backdrop, floor) isn't part of the card.
        r.frame_passes = None;
        r.linear_output = true;
        r.tags.resize(r.items.len(), [0; 4]);
        let glyphs = std::mem::take(&mut r.glyphs)
            .into_iter()
            .map(|crate::renderer::Glyph { item: i, width: w, height: h, alpha, pad }| {
                // A CanvasTexture of the white-on-transparent raster (flipY).
                let rgba: Vec<u8> = alpha.chunks_exact(w as usize).rev().flatten().flat_map(|&a| [255, 255, 255, a]).collect();
                let t = r.texture(device, queue, &crate::material::mip_chain(&rgba, w, h, false), false, Wrap::Clamp);
                (i, (t, pad))
            })
            .collect();
        let original = (0..r.items.len()).map(|i| (r.items[i].material.clone(), r.items[i].visible, r.custom[i].clone())).collect();
        let listed = (0..r.items.len()).filter(|&i| r.items[i].visible && !r.custom[i].as_ref().is_some_and(|c| c.world)).collect();
        let shader =
            device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("print"), source: wgpu::ShaderSource::Wgsl(wgsl!("print.wgsl").into()) });
        use crate::effects::Bind;
        let bind_layout =
            crate::effects::bind_layout(device, "print", &[Bind::Uniform, Bind::Texture, Bind::Texture, Bind::Texture, Bind::Sampler, Bind::Sampler]);
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("print"),
            bind_group_layouts: &[Some(r.frame_layout()), Some(&bind_layout)],
            immediate_size: 0,
        });
        let max = device.limits().max_texture_dimension_2d;
        Job { card, original, listed, shader, bind_layout, layout, pipelines: HashMap::new(), glyphs, artwork: [None, None], max }
    }

    fn pipeline(&mut self, device: &wgpu::Device, key: Key) -> Rc<wgpu::RenderPipeline> {
        let (shader, layout) = (&self.shader, &self.layout);
        self.pipelines
            .entry(key)
            .or_insert_with(|| {
                let format = if key.srgb { wgpu::TextureFormat::Rgba8UnormSrgb } else { wgpu::TextureFormat::Rgba8Unorm };
                Rc::new(device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("print"),
                    layout: Some(layout),
                    vertex: wgpu::VertexState {
                        module: shader,
                        entry_point: Some("vs_main"),
                        buffers: crate::renderer::VERTEX_LAYOUT,
                        compilation_options: Default::default(),
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: shader,
                        entry_point: Some(["fs_surface", "fs_mask", "fs_orm", "fs_normal"][key.entry as usize]),
                        targets: &[Some(wgpu::ColorTargetState {
                            format,
                            blend: key.blend.then_some(crate::effects::blend::NORMAL),
                            write_mask: if key.color_write { wgpu::ColorWrites::ALL } else { wgpu::ColorWrites::empty() },
                        })],
                        compilation_options: Default::default(),
                    }),
                    primitive: wgpu::PrimitiveState {
                        cull_mode: match key.side {
                            Side::Front => Some(wgpu::Face::Back),
                            Side::Back => Some(wgpu::Face::Front),
                            Side::Double => None,
                        },
                        ..Default::default()
                    },
                    depth_stencil: Some(wgpu::DepthStencilState {
                        format: wgpu::TextureFormat::Depth32Float,
                        depth_write_enabled: Some(key.depth_write),
                        depth_compare: Some(if key.depth_test { wgpu::CompareFunction::LessEqual } else { wgpu::CompareFunction::Always }),
                        stencil: Default::default(),
                        // As the renderer maps GL's polygonOffset(factor, units).
                        bias: match key.offset {
                            Some((f, u)) => wgpu::DepthBiasState { constant: f32::from_bits(u) as i32, slope_scale: f32::from_bits(f), clamp: 0.0 },
                            None => Default::default(),
                        },
                    }),
                    multisample: wgpu::MultisampleState { count: crate::renderer::MSAA, ..Default::default() },
                    multiview_mask: None,
                    cache: None,
                }))
            })
            .clone()
    }

    /// Draws item `i` with the pass shader: `mask` (`MASK_FRAG` with `value`; depth only without
    /// `color_write`) or the surface (`relief`), with the state of `m` (the item's material as built).
    fn install(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        i: usize,
        m: &Material,
        srgb: bool,
        mask: bool,
        value: f32,
        relief: bool,
        color_write: bool,
    ) {
        let tag = self.card.renderer.tags[i];
        let key = Key {
            entry: mask as u8,
            srgb,
            side: m.side,
            depth_test: m.depth_test,
            depth_write: m.depth_write,
            offset: m.polygon_offset.map(|(f, u)| (f.to_bits(), u.to_bits())),
            blend: mask,
            color_write,
        };
        let pipeline = self.pipeline(device, key);
        let r = &mut self.card.renderer;
        let mut u = DrawUniform {
            model_view: Mat4::IDENTITY.to_cols_array_2d(),
            a: [0.0; 4],
            map_uv: [0.0, 0.0, 1.0, 1.0],
            normal_uv: [1.0; 4],
            rough_uv: [1.0, 1.0, 0.0, 0.0],
            flags: [0.0; 4],
        };
        let on = |b: bool| if b { 1.0 } else { 0.0 };
        let (map, normal, rough) = if mask {
            // The glyph itself, not a finish's padded map (an emboss shoulder isn't part of the mark);
            // else the item's map, except on the body and faces.
            let glyph = self.glyphs.get(&i).copied().filter(|_| tag[0] == role::MARK);
            let base = tag[0] == role::BODY || tag[0] == role::FACE;
            let alpha = match glyph {
                Some((t, [px, py])) => {
                    u.map_uv = [-px, -py, 1.0 + 2.0 * px, 1.0 + 2.0 * py];
                    Some(t)
                }
                None => {
                    u.map_uv = [m.map_offset[0], m.map_offset[1], m.map_repeat[0], m.map_repeat[1]];
                    m.map.filter(|_| !base)
                }
            };
            let mark = tag[0] == role::MARK;
            let alpha_test = if mark { m.alpha_test.max(0.08) } else { m.alpha_test };
            u.a = [value, if base { 1.0 } else { m.opacity }, alpha_test, on(mark)];
            u.flags = [on(alpha.is_some()), 0.0, 0.0, 0.0];
            (alpha, None, None)
        } else {
            u.a = [m.color[0], m.color[1], m.color[2], m.roughness];
            u.map_uv = [m.map_offset[0], m.map_offset[1], m.map_repeat[0], m.map_repeat[1]];
            u.normal_uv = [m.surface_repeat[0], m.surface_repeat[1], m.normal_scale[0], m.normal_scale[1]];
            u.rough_uv = [m.surface_repeat[0], m.surface_repeat[1], on(m.map.is_some()), on(m.normal_map.is_some())];
            u.flags = [on(m.roughness_map.is_some()), on(relief), 0.0, 0.0];
            (m.map, m.normal_map, m.roughness_map)
        };
        let white = r.white;
        let (map, normal, rough) = (map.unwrap_or(white), normal.unwrap_or(white), rough.unwrap_or(white));
        let sampler_of = |r: &mut crate::renderer::Renderer, t: TextureId| {
            let k = (r.textures[t.0].wrap, r.textures[t.0].anisotropy);
            r.sampler(device, k.0, k.1);
            k
        };
        let (sm, ss) = (sampler_of(r, map), sampler_of(r, normal));
        let uniform = crate::effects::uniform_buffer(device, queue, "print", bytemuck::bytes_of(&u));
        let group = crate::effects::bind_group(
            device,
            &self.bind_layout,
            &[
                uniform.as_entire_binding(),
                wgpu::BindingResource::TextureView(&r.textures[map.0].view),
                wgpu::BindingResource::TextureView(&r.textures[normal.0].view),
                wgpu::BindingResource::TextureView(&r.textures[rough.0].view),
                wgpu::BindingResource::Sampler(&r.samplers[&sm]),
                wgpu::BindingResource::Sampler(&r.samplers[&ss]),
            ],
        );
        // Masks are transparent (sorted with the transparent items); the surface is opaque.
        r.items[i].material = Material { transparent: mask, ..m.clone() };
        r.custom[i] = Some(CustomDraw::new(pipeline, Rc::new(group), uniform));
    }
}

impl Job {
    /// Draws item `i` with an AR pass material (`fs_orm`, or `fs_normal` with `normal`), with the state
    /// of `m`: blended when the item is transparent, not fully opaque or has a colour map (three's pass
    /// `ShaderMaterial`). Unlit prints are rough (0.6) and not metal, with no relief.
    fn install_ar(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, i: usize, m: &Material, normal: bool) {
        let blend = m.transparent || m.opacity < 1.0 || m.map.is_some();
        let key = Key {
            entry: 2 + normal as u8,
            srgb: false,
            side: m.side,
            depth_test: m.depth_test,
            depth_write: m.depth_write,
            offset: m.polygon_offset.map(|(f, u)| (f.to_bits(), u.to_bits())),
            blend,
            color_write: true,
        };
        let pipeline = self.pipeline(device, key);
        let r = &mut self.card.renderer;
        let lit = !m.unlit;
        let on = |b: bool| if b { 1.0 } else { 0.0 };
        let (normal_map, rough, bump) = (m.normal_map.filter(|_| lit), m.roughness_map.filter(|_| lit), m.bump_map.filter(|_| lit));
        let u = DrawUniform {
            model_view: Mat4::IDENTITY.to_cols_array_2d(),
            a: if lit { [m.roughness, m.metalness, m.opacity, m.alpha_test] } else { [0.6, 0.0, m.opacity, m.alpha_test] },
            map_uv: [m.map_offset[0], m.map_offset[1], m.map_repeat[0], m.map_repeat[1]],
            normal_uv: [m.surface_repeat[0], m.surface_repeat[1], m.normal_scale[0], m.normal_scale[1]],
            rough_uv: [on(m.map.is_some()), on(normal_map.is_some()), on(rough.is_some()), on(bump.is_some())],
            flags: [if lit { m.bump_scale } else { 0.0 }, 0.0, 0.0, 0.0],
        };
        // Bindings: the colour map (its alpha); the normal map; the roughness map (orm) or the bump
        // map (normal). The surface sampler goes with the normal (normal pass) or roughness map.
        let white = r.white;
        let map = m.map.unwrap_or(white);
        let normal_t = normal_map.unwrap_or(white);
        let third = if normal { bump } else { rough }.unwrap_or(white);
        let sampler_of = |r: &mut crate::renderer::Renderer, t: TextureId| {
            let k = (r.textures[t.0].wrap, r.textures[t.0].anisotropy);
            r.sampler(device, k.0, k.1);
            k
        };
        let (sm, ss) = (sampler_of(r, map), sampler_of(r, if normal { normal_t } else { third }));
        let uniform = crate::effects::uniform_buffer(device, queue, "ar", bytemuck::bytes_of(&u));
        let group = crate::effects::bind_group(
            device,
            &self.bind_layout,
            &[
                uniform.as_entire_binding(),
                wgpu::BindingResource::TextureView(&r.textures[map.0].view),
                wgpu::BindingResource::TextureView(&r.textures[normal_t.0].view),
                wgpu::BindingResource::TextureView(&r.textures[third.0].view),
                wgpu::BindingResource::Sampler(&r.samplers[&sm]),
                wgpu::BindingResource::Sampler(&r.samplers[&ss]),
            ],
        );
        r.items[i].material = Material { transparent: blend, glass: None, ..m.clone() };
        r.custom[i] = Some(CustomDraw::new(pipeline, Rc::new(group), uniform));
    }
}

/// Reads `texture` (RGBA8, one level) back, rows top first, and hands the pixels to `done` (empty if
/// the read failed).
fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture, done: Box<dyn FnOnce(Vec<u8>)>) {
    let (w, h) = (texture.width(), texture.height());
    let row = (4 * w).div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("print readback"),
        size: (row * h) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);
    let unpad = move |b: &wgpu::Buffer, ok: bool| {
        let mut out = Vec::new();
        if ok {
            if let Ok(data) = b.slice(..).get_mapped_range() {
                out.reserve_exact((4 * w * h) as usize);
                for y in 0..h as usize {
                    out.extend_from_slice(&data[y * row as usize..y * row as usize + 4 * w as usize]);
                }
            }
            b.unmap();
        }
        out
    };
    // In the browser the map calls back once done (WebGL: on the poll below); natively the poll waits.
    #[cfg(target_arch = "wasm32")]
    {
        let b = buffer.clone();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| done(unpad(&b, result.is_ok())));
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let ok = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = ok.clone();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| flag.store(result.is_ok(), std::sync::atomic::Ordering::SeqCst));
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        done(unpad(&buffer, ok.load(std::sync::atomic::Ordering::SeqCst)));
    }
}

impl PrintJob for Job {
    fn items(&self) -> String {
        let r = &self.card.renderer;
        let f = |v: f32| if v.is_finite() { v } else { 0.0 };
        let items: Vec<String> = self
            .listed
            .iter()
            .map(|&i| {
                let it = &r.items[i];
                let (m, custom) = (&self.original[i].0, self.original[i].2.as_ref());
                let mut tag = r.tags[i];
                // Depth-only helpers (three: every material without colour writes) work as the chip's mask.
                if tag[0] == role::OTHER && custom.is_none() && !m.color_write {
                    tag[0] = role::CHIP_MASK;
                }
                let n = match tag[0] {
                    role::STICKER => (it.render_order - crate::decals::RENDER_ORDER).round().max(0.0) as u8,
                    _ => tag[2],
                };
                let pos = it.transform.w_axis.truncate();
                let axis = it.transform.x_axis.truncate();
                let (lo, hi) = r.meshes[it.mesh.0].bounds;
                let size = (hi - lo).max(Vec3::ZERO);
                let glyph = self.glyphs.get(&i).filter(|_| tag[0] == role::MARK);
                let pad = glyph.map_or([0.0; 2], |g| g.1);
                let image = match (glyph, m.map) {
                    (Some(&(t, _)), _) | (None, Some(t)) => {
                        let t = &r.textures[t.0].texture;
                        [t.width(), t.height()]
                    }
                    _ => [0, 0],
                };
                format!(
                    "{{\"i\":{i},\"role\":{},\"kind\":{},\"n\":{n},\"finish\":{},\"side\":{},\"pos\":[{},{},{}],\"axis\":[{},{},{}],\"plane\":[{},{}],\"pad\":[{},{}],\"image\":[{},{}],\"uv\":[{},{}],\"map\":{},\"custom\":{}}}",
                    tag[0],
                    tag[1],
                    tag[3],
                    (pos.z < 0.0) as u8,
                    f(pos.x),
                    f(pos.y),
                    f(pos.z),
                    f(axis.x),
                    f(axis.y),
                    f(axis.z),
                    f(size.x),
                    f(size.y),
                    pad[0],
                    pad[1],
                    image[0],
                    image[1],
                    f(m.map_repeat[0].abs()),
                    f(m.map_repeat[1].abs()),
                    m.map.is_some(),
                    custom.is_some(),
                )
            })
            .collect();
        format!("[{}]", items.join(","))
    }

    fn max_size(&self) -> u32 {
        self.max
    }

    fn poll(&self, device: &wgpu::Device) {
        let _ = device.poll(wgpu::PollType::Poll);
    }

    fn count(&self) -> usize {
        self.listed.len()
    }

    fn set_artwork(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, back: bool, width: u32, height: u32, rgba: &[u8]) {
        if width == 0 || height == 0 || rgba.len() != (4 * width * height) as usize {
            return;
        }
        // `artworkTexture`: sRGB, trilinear, anisotropy 4, flipY.
        let flipped: Vec<u8> = rgba.chunks_exact(4 * width as usize).rev().flatten().copied().collect();
        let t = self.card.renderer.texture_with(device, queue, &crate::material::mip_chain(&flipped, width, height, true), true, Wrap::Clamp, 4);
        self.artwork[back as usize] = Some(t);
    }

    fn render(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, spec: &[f32], done: Box<dyn FnOnce(Vec<u8>)>) {
        let &[side, target, w, h, hw, hh, ref choices @ ..] = spec else { return done(Vec::new()) };
        let (back, mask) = (side > 0.5, target > 0.5);
        let (w, h) = (w as u32, h as u32);
        if w == 0 || h == 0 || w > self.max || h > self.max {
            return done(Vec::new());
        }
        let srgb = !mask;
        // Every item as built, then this pass's choices.
        {
            let r = &mut self.card.renderer;
            for (i, (m, visible, custom)) in self.original.iter().enumerate() {
                r.items[i].material = m.clone();
                r.items[i].visible = *visible && self.listed.contains(&i);
                r.custom[i] = custom.clone();
                if let Some(g) = r.gpu_items.get_mut(i) {
                    *g = None;
                }
            }
        }
        // The body's material: every body part shades as the caps (three's material 0).
        let body = self.listed.iter().copied().find(|&i| self.card.renderer.tags[i][0] == role::BODY);
        for (k, &i) in self.listed.clone().iter().enumerate() {
            let (c, value) = (choices.get(2 * k).copied().unwrap_or(0.0) as u8, choices.get(2 * k + 1).copied().unwrap_or(0.0));
            let (m, custom) = (self.original[i].0.clone(), self.original[i].2.is_some());
            let depth_only = !custom && !m.color_write;
            // A shader layer for the AR passes: a custom draw, or a holo foil (three's `ShaderMaterial`s).
            let shader = custom || self.card.renderer.holo.get(i).is_some_and(|h| h.is_some());
            match c {
                choice::AR_COLOR | choice::AR_ORM | choice::AR_NORMAL if depth_only => self.install(device, queue, i, &m, srgb, true, 0.0, false, false),
                // Shader layers and unlit prints as they render face-on.
                choice::AR_COLOR if shader || m.unlit => {}
                choice::AR_COLOR => {
                    let mut color = m.color;
                    for (c, e) in color.iter_mut().zip(m.emissive) {
                        *c += e;
                    }
                    self.card.renderer.items[i].material = Material { unlit: true, unlit_tone_mapped: false, emissive: [0.0; 3], color, glass: None, ..m };
                }
                choice::AR_ORM | choice::AR_NORMAL if shader => self.card.renderer.items[i].visible = false,
                choice::AR_ORM | choice::AR_NORMAL => self.install_ar(device, queue, i, &m, c == choice::AR_NORMAL),
                choice::KEEP if depth_only => self.install(device, queue, i, &m, srgb, true, 0.0, false, false),
                // A mask pass draws only the pass materials (the card's pipelines are for its colour format).
                choice::KEEP | choice::ALBEDO | choice::ARTWORK if custom && !mask => {}
                choice::KEEP if !mask => {}
                choice::ALBEDO | choice::ARTWORK if !mask => {
                    let back = self.card.renderer.items[i].transform.w_axis.z < 0.0;
                    let map = if c == choice::ARTWORK { self.artwork[back as usize].or(m.map) } else { m.map };
                    let mut color = m.color;
                    for (c, e) in color.iter_mut().zip(m.emissive) {
                        *c += e;
                    }
                    self.card.renderer.items[i].material = Material { unlit: true, unlit_tone_mapped: false, emissive: [0.0; 3], color, map, ..m };
                }
                choice::SURFACE | choice::RELIEF if !custom => {
                    let src = match (self.card.renderer.tags[i][0], body) {
                        (role::BODY, Some(b)) => Material {
                            side: m.side,
                            depth_test: m.depth_test,
                            depth_write: m.depth_write,
                            polygon_offset: m.polygon_offset,
                            ..self.original[b].0.clone()
                        },
                        _ => m,
                    };
                    self.install(device, queue, i, &src, srgb, false, 0.0, c == choice::RELIEF, true);
                }
                choice::MASK => {
                    let instanced = self.original[i].2.as_ref().is_some_and(|d| d.instanced || d.extra.is_some());
                    if instanced {
                        self.card.renderer.items[i].visible = false;
                    } else {
                        self.install(device, queue, i, &m, srgb, true, value, false, true);
                    }
                }
                _ => self.card.renderer.items[i].visible = false,
            }
        }
        let format = if srgb { wgpu::TextureFormat::Rgba8UnormSrgb } else { wgpu::TextureFormat::Rgba8Unorm };
        let mut layers = Layers::new(device, format, w, h, 1.0, 20.0);
        layers.proj = glam::camera::rh::proj::directx::orthographic(-hw, hw, -hh, hh, 0.01, 20.0);
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("print"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let cam = Camera::look_at(glam::DVec3::new(0.0, 0.0, if back { -10.0 } else { 10.0 }), glam::DVec3::ZERO, 0.0);
        crate::renderer::Renderer::render_layers(&mut [(&mut self.card.renderer, Mat4::IDENTITY)], device, queue, &view, &layers, &cam);
        read_back(device, queue, &texture, done);
    }
}
