//! The vines add-on (`addons.vines`; addons/vines/: vines grown over any card): stems
//! and instanced leaves on both faces (the model in `vines_model`), the leaf atlas, the leaf-shadow pass
//! (stems and leaves MAX-blended into a 768×486 target, offset along the sun) and, on cards with flat
//! faces, a shadow catcher over each face that multiplies everything printed there by the leaves'
//! shadows. Draw order: catchers 70, stems 71, leaves 72. Parameters: cycle (the 80 s grow / wither
//! loop, or fully grown), density, leaf colour, frozen time. On the web the build is the `vines` chunk;
//! the per-frame code is reached through pointers set there.

use crate::canvas::{FillRule, Host, LineCap, Paint};
use crate::effect_params::{Default as D, EffectParam as P, Kind as K};
use crate::effects::{bind_group, bind_layout, blend, pipeline, Bind, PipelineOptions, Target};
use crate::geometry::Mesh;
use crate::json::Map;
use crate::renderer::{CustomDraw, Item, Material, MeshId, Renderer};
use crate::vines_model::{self as model, Lcg};
use glam::{Mat4, Vec3};
use std::rc::Rc;

/// `VINES_LEAF_DEFAULT`.
pub const LEAF_DEFAULT: &str = "#6b9e45";

/// `EFFECT_PARAMS.vines`.
pub const PARAMS: &[P] = &[
    P::new("cycle", K::Bool, D::Bool(true)),
    P::new("density", K::Float { min: 0.1, max: 1.0 }, D::Num(1.0)),
    P::new("leafColor", K::Color, D::Str(LEAF_DEFAULT)),
    P::new("time", K::Float { min: 0.0, max: 80.0 }, D::Num(0.0)).optional(),
];

/// Ivy cycle length, seconds.
pub const IVY_CYCLE: f64 = 80.0;
/// The wind clock wraps at 600 s.
pub const IVY_WIND_WRAP: f64 = 600.0;
/// Face height of the slab the model was made for (bodyDepth 0.03 / 2).
const MODEL_FACE_Z: f64 = 0.015;
/// Above the branding, below the lowest leaf hull.
const CATCHER_LIFT: f64 = 0.014;
/// The shadow target.
const SHADOW_W: u32 = 768;
const SHADOW_H: u32 = 486;
const SHADOW_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Slot 1 of the stems (aN, then phase and side) and of the leaves (per instance: aRootSize, aLife,
/// aArt, aFace).
const STEM_ATTRIBUTES: &[wgpu::VertexAttribute] = &wgpu::vertex_attr_array![3 => Float32x3, 4 => Float32x2];
const LEAF_ATTRIBUTES: &[wgpu::VertexAttribute] = &wgpu::vertex_attr_array![3 => Float32x4, 4 => Float32x4, 5 => Float32x4, 6 => Float32x3];

/// The motion tracker (`IvyMotion`): sway follows the card's yaw speed through a
/// damped spring (120 Hz substeps), rustle its angular speed, and the time / wind clocks advance.
/// Invalid or long frames reset it without advancing.
#[derive(Clone, Debug)]
pub struct IvyMotion {
    pub time: f64,
    pub wind: f64,
    pub sway: f64,
    pub rustle: f64,
    pub velocity: f64,
    prev_angle: Option<f64>,
    /// x, y, z, w.
    prev_quat: [f64; 4],
}

impl IvyMotion {
    pub fn new(time: f64, wind: f64) -> IvyMotion {
        IvyMotion {
            time: ((time % IVY_CYCLE) + IVY_CYCLE) % IVY_CYCLE,
            wind: ((wind % IVY_WIND_WRAP) + IVY_WIND_WRAP) % IVY_WIND_WRAP,
            sway: 0.0,
            rustle: 0.0,
            velocity: 0.0,
            prev_angle: None,
            prev_quat: [0.0, 0.0, 0.0, 1.0],
        }
    }

    /// Forgets the previous sample (a skipped frame).
    pub fn reset(&mut self) {
        self.prev_angle = None;
        self.velocity = 0.0;
    }

    /// One frame of `dt` seconds with the card's yaw `angle_y` and world rotation `quat` (x, y, z, w).
    pub fn update(&mut self, dt: f64, angle_y: f64, animated: bool, quat: [f64; 4]) {
        if !animated || !dt.is_finite() || dt <= 0.0 || dt > 0.25 {
            self.reset();
            return;
        }
        let first = self.prev_angle.is_none();
        let mut s = 0.0;
        if let Some(prev) = self.prev_angle {
            s = angle_y - prev;
            s = s.sin().atan2(s.cos());
        }
        // Quaternion.angleTo.
        let dot = (0..4).map(|k| quat[k] * self.prev_quat[k]).sum::<f64>();
        let quat_delta = if first { 0.0 } else { 2.0 * dot.clamp(-1.0, 1.0).abs().acos() };
        self.prev_angle = Some(angle_y);
        self.prev_quat = quat;

        let c = (-(s / dt) * 0.012).clamp(-0.035, 0.035);
        let n = (120.0 * dt).ceil();
        let h = dt / n;
        for _ in 0..n as usize {
            self.velocity += ((c - self.sway) * 18.0 - 7.0 * self.velocity) * h;
            self.sway += self.velocity * h;
        }
        let target = if first { 0.0 } else { ((quat_delta / dt - 0.2) * 1.2).clamp(0.0, 1.0) };
        self.rustle += (target - self.rustle) * (1.0 - (-dt * if target > self.rustle { 8.0 } else { 1.4 }).exp());
        self.wind = (self.wind + dt) % IVY_WIND_WRAP;
        self.time = (self.time + dt) % IVY_CYCLE;
    }
}

/// "#rrggbb" → [h (0..1), s, v] (`hexToHsv`).
fn hex_to_hsv(hex: &str) -> [f64; 3] {
    let [r, g, b] = crate::material::srgb_hex_to_srgb(hex);
    let max = r.max(g).max(b);
    let d = max - r.min(g).min(b);
    let mut h = 0.0;
    if d > 0.0 {
        h = if max == r {
            ((g - b) / d + 6.0) % 6.0
        } else if max == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        } / 6.0;
    }
    [h, if max > 0.0 { d / max } else { 0.0 }, max]
}

/// `hsvShift(reference, target)`: [hue shift (turns), saturation ratio, value ratio].
pub fn hsv_shift(reference: &str, target: &str) -> [f64; 3] {
    let [h0, s0, v0] = hex_to_hsv(reference);
    let [h1, s1, v1] = hex_to_hsv(target);
    let dh = h1 - h0;
    [dh - model::js_round(dh), s1 / s0.max(1e-3), v1 / v0.max(1e-3)]
}

#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct Shared {
    light: [f32; 4],
    eye: [f32; 4],
    motion: [f32; 4],
    conf: [f32; 4],
    shift: [f32; 4],
}

/// The leaf-shadow pass: pipelines, its own bind group (without the target) and the mip chain.
struct ShadowPass {
    stem: wgpu::RenderPipeline,
    leaf: wgpu::RenderPipeline,
    group: wgpu::BindGroup,
    blit: wgpu::RenderPipeline,
    /// Per level: its view, and the bind group that samples the level above (none for level 0).
    levels: Vec<(wgpu::TextureView, Option<wgpu::BindGroup>)>,
    stems: MeshId,
    stem_extra: Rc<wgpu::Buffer>,
    leaves: MeshId,
    leaf_instances: Rc<wgpu::Buffer>,
    count: u32,
}

/// The vines over a card.
pub struct Vines {
    shared: Rc<wgpu::Buffer>,
    data: Shared,
    pub motion: IvyMotion,
    pub animated: bool,
    frozen: bool,
    /// The inputs of the last shadow pass: time, sway, rustle, light.
    last: Option<(f32, f32, f32, Vec3)>,
    pass: ShadowPass,
    /// `update_frame` and `prepare_frame`, reached through pointers made in the chunk so that their
    /// code stays there.
    update_fn: fn(&mut Vines, f64, Mat4),
    prepare_fn: fn(&mut Vines, &Renderer, &wgpu::Device, &wgpu::Queue, Mat4, &crate::renderer::Camera),
}

/// The card's faces for the catchers: the front and back face meshes (`sideFace`), or none when the
/// body has no flat faces.
pub struct Faces {
    pub front: MeshId,
    pub back: MeshId,
}

/// Grows the vines on the card (body thickness `body_depth`). `values`: `design.addons.vines` (its `time`
/// freezes the cycle); `glass`: a clear body (lighter catchers, and every item also draws
/// into the glass's buffers).
#[wasm_split_helpers::wasm_split(vines, fallible)]
pub fn build(
    r: &mut Renderer,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    host: &dyn Host,
    faces: Option<Faces>,
    body_depth: f64,
    values: Option<&Map>,
    reduced_motion: bool,
    glass: bool,
) -> Result<Vines, crate::ChunkUnavailable> {
    let t = tuning(values);
    let time = t.time;
    let animated = time.is_none() && !reduced_motion;
    let o = Grow {
        face_z: body_depth / 2.0,
        density: t.density,
        leaf_shift: t.leaf_shift,
        grown: t.grown,
        animated,
        motion: IvyMotion::new(time.unwrap_or(0.0), 0.0),
        glass,
    };
    Ok(grow(r, device, queue, host, faces, &o))
}

/// `vinesOptionsFromDesign`: `design.addons.vines` resolved against `EFFECT_PARAMS.vines`.
struct Tuning {
    density: f64,
    /// `hsvShift` of the leaf colour; none at the default colour.
    leaf_shift: Option<[f64; 3]>,
    /// Fully grown (no cycle).
    grown: bool,
    /// The frozen cycle time, when given.
    time: Option<f64>,
}

fn tuning(values: Option<&Map>) -> Tuning {
    let p = &crate::effect_params::resolve(PARAMS, values);
    Tuning {
        density: p.num("density"),
        leaf_shift: (!p.is_default(PARAMS, "leafColor")).then(|| hsv_shift(LEAF_DEFAULT, p.str("leafColor"))),
        grown: !p.bool("cycle"),
        time: p.get("time").map(|_| p.num("time")),
    }
}

/// How vines grow (`VinesOptions`).
struct Grow {
    /// The faces' distance from the mid-plane.
    face_z: f64,
    density: f64,
    leaf_shift: Option<[f64; 3]>,
    grown: bool,
    /// The motion advances (else a frozen still).
    animated: bool,
    /// The initial motion state.
    motion: IvyMotion,
    /// A clear body: every item also draws into the glass's buffers.
    glass: bool,
}

/// `createVines`: the stems, leaves and shadow pass (with catchers over `faces` when given). The vines
/// draw over the card's layers: transparent, at render orders 71 and 72, after the catchers (70).
fn grow(r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, host: &dyn Host, faces: Option<Faces>, o: &Grow) -> Vines {
    let (leaf_shift, grown, face_z, glass, animated) = (o.leaf_shift, o.grown, o.face_z, o.glass, o.animated);
    let ivy = model::generate_ivy(10729);
    let (leaves, strands) = model::select_vines(&ivy, o.density);

    // The atlas (canvas rows, flipped to GL's order: v = 0 first), mipmapped, linear data.
    let atlas_px = leaf_atlas(host);
    let flipped: Vec<u8> = atlas_px.as_chunks::<{ 4 * 256 }>().0.iter().rev().flatten().copied().collect();
    let atlas = r.texture(device, queue, &crate::material::mip_chain(&flipped, 256, 384, false), false, crate::renderer::Wrap::Clamp);

    // Stem ribbons: two vertices per node; z rescaled from the ivy slab's faces to this body's.
    let (mut stem_mesh, mut stem_extra) = (Mesh { positions: Vec::new(), normals: Vec::new(), uvs: Vec::new(), indices: Vec::new() }, Vec::<f32>::new());
    let mut node = 0u32;
    for strand in &strands {
        let at = |k: usize| {
            let nd = &strand[k];
            let s = if face_z != MODEL_FACE_Z { (face_z + nd.width / 2.0) / (MODEL_FACE_Z + nd.width / 2.0) } else { 1.0 };
            [nd.p[0], nd.p[1], nd.p[2] * s]
        };
        for (k, nd) in strand.iter().enumerate() {
            let prev = at(k.saturating_sub(1));
            let next = at((k + 1).min(strand.len() - 1));
            let p = at(k).map(|v| v as f32);
            let t = [0, 1, 2].map(|i| (next[i] - prev[i]) as f32);
            for s in [-1.0f32, 1.0] {
                stem_mesh.positions.push(p);
                stem_mesh.normals.push(t);
                stem_mesh.uvs.push([nd.width as f32, nd.progress as f32]);
                stem_extra.extend_from_slice(&[nd.n[0] as f32, nd.n[1] as f32, nd.n[2] as f32, nd.phase as f32, s]);
            }
            if k > 0 {
                let b = 2 * node;
                stem_mesh.indices.extend_from_slice(&[b - 2, b - 1, b, b - 1, b + 1, b]);
            }
            node += 1;
        }
    }
    // Leaves: a 1 × 1 plane in six rows (only its uvs are read), one instance per leaf.
    let mut leaf_mesh = Mesh { positions: Vec::new(), normals: Vec::new(), uvs: Vec::new(), indices: Vec::new() };
    for iy in 0..=6u32 {
        for ix in 0..=1u32 {
            leaf_mesh.positions.push([ix as f32 - 0.5, 0.5 - iy as f32 / 6.0, 0.0]);
            leaf_mesh.normals.push([0.0, 0.0, 1.0]);
            leaf_mesh.uvs.push([ix as f32, 1.0 - iy as f32 / 6.0]);
        }
    }
    for iy in 0..6u32 {
        let (a, b, c, d) = (2 * iy, 2 * (iy + 1), 1 + 2 * (iy + 1), 1 + 2 * iy);
        leaf_mesh.indices.extend_from_slice(&[a, b, d, b, c, d]);
    }
    let instances: Vec<f32> = leaves
        .iter()
        .flat_map(|l| [l.x, l.y, l.width, l.height, l.angle, l.phase, l.progress, l.lift, l.variant, l.kz, l.seed, l.side, l.face[0], l.face[1], l.face[2]])
        .map(|v| v as f32)
        .collect();
    let vertex_buffer = |data: &[f32]| {
        use wgpu::util::DeviceExt;
        Rc::new(device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("vines"),
            contents: bytemuck::cast_slice(data),
            usage: wgpu::BufferUsages::VERTEX,
        }))
    };
    // A zero-sized buffer can't be bound: keep one entry when nothing grows.
    let stem_extra = vertex_buffer(if stem_extra.is_empty() { &[0.0; 5] } else { &stem_extra });
    let leaf_instances = vertex_buffer(if instances.is_empty() { &[0.0; 15] } else { &instances });
    let stems = r.mesh(device, &stem_mesh);
    let leaf_plane = r.mesh(device, &leaf_mesh);

    // The shared uniforms (motion, sun, eye, the GLSL's defines).
    let motion = o.motion.clone();
    let fz = ((face_z * 1e7).round() / 1e7) as f32; // `faceZ.toFixed(7)`
    let shift = leaf_shift.unwrap_or([0.0, 1.0, 1.0]).map(|v| v as f32);
    let data =
        Shared { conf: [fz, grown as i32 as f32, leaf_shift.is_some() as i32 as f32, 0.0], shift: [shift[0], shift[1], shift[2], 0.0], ..Default::default() };
    let shared = crate::effects::uniform_buffer(device, queue, "vines", bytemuck::bytes_of(&data));

    let shadow_tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("leaf shadows"),
        size: wgpu::Extent3d { width: SHADOW_W, height: SHADOW_H, depth_or_array_layers: 1 },
        mip_level_count: 10,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: SHADOW_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let shadow_view = shadow_tex.create_view(&Default::default());
    let trilinear = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..Default::default()
    });
    let module =
        device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("vines"), source: wgpu::ShaderSource::Wgsl(wgsl!("vines.wgsl").into()) });
    let layout = bind_layout(device, "vines", &[Bind::Uniform, Bind::Uniform, Bind::Texture, Bind::Texture, Bind::Sampler]);
    let atlas_view = r.texture_view(atlas).clone();
    let group = |uniform: &wgpu::Buffer, shadow: &wgpu::TextureView| {
        bind_group(
            device,
            &layout,
            &[
                uniform.as_entire_binding(),
                shared.as_entire_binding(),
                wgpu::BindingResource::TextureView(&atlas_view),
                wgpu::BindingResource::TextureView(shadow),
                wgpu::BindingResource::Sampler(&trilinear),
            ],
        )
    };
    let stem_layout = wgpu::VertexBufferLayout { array_stride: 20, step_mode: wgpu::VertexStepMode::Vertex, attributes: STEM_ATTRIBUTES };
    let leaf_layout = wgpu::VertexBufferLayout { array_stride: 60, step_mode: wgpu::VertexStepMode::Instance, attributes: LEAF_ATTRIBUTES };

    // The shadow pass (no depth, MAX-blended, both faces).
    let max = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Max };
    let cast = |vs: &'static str, fs: &'static str, extra: &wgpu::VertexBufferLayout<'static>| {
        let o = PipelineOptions {
            entries: (vs, fs),
            extra: Some(extra.clone()),
            blend: Some(wgpu::BlendState { color: max, alpha: max }),
            ..PipelineOptions::new("leaf shadows", &module)
        };
        pipeline(r, device, &layout, &o, Target::Plain(SHADOW_FORMAT))
    };
    let (stem_cast, leaf_cast) = (cast("vs_stem_shadow", "fs_stem_shadow", &stem_layout), cast("vs_leaf_shadow", "fs_leaf_shadow", &leaf_layout));
    let dummy = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: SHADOW_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let item_uniform = |misc: [f32; 4]| {
        let mut bytes = [0u8; 80];
        bytes[64..].copy_from_slice(bytemuck::bytes_of(&misc));
        crate::effects::uniform_buffer(device, queue, "vines item", &bytes)
    };
    let cast_group = group(&item_uniform([0.0; 4]), &dummy.create_view(&Default::default()));
    // The mip chain: one bilinear tap per texel of the level above.
    let blit_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("leaf shadow mips"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    });
    let blit = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("leaf shadow mips"),
        layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[None, None, Some(&blit_layout)],
            immediate_size: 0,
        })),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_blit"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs_blit"),
            targets: &[Some(wgpu::ColorTargetState { format: SHADOW_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    let bilinear =
        device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
    let level = |k: u32| shadow_tex.create_view(&wgpu::TextureViewDescriptor { base_mip_level: k, mip_level_count: Some(1), ..Default::default() });
    let levels = (0..10)
        .map(|k| {
            let source = (k > 0).then(|| {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &blit_layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&level(k - 1)) },
                        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&bilinear) },
                    ],
                })
            });
            (level(k), source)
        })
        .collect();

    // The scene items: catchers (multiplied over the faces), stems, leaves.
    let pipelines = |r: &Renderer, o: &PipelineOptions<'_>| {
        (
            Rc::new(pipeline(r, device, &layout, o, Target::Canvas)),
            (glass || r.offscreen).then(|| Rc::new(pipeline(r, device, &layout, o, Target::GlassBuffer))),
        )
    };
    let item = |r: &mut Renderer,
                mesh: MeshId,
                transform: Mat4,
                order: f32,
                face: Option<i8>,
                (pl, buffer): &(Rc<wgpu::RenderPipeline>, Option<Rc<wgpu::RenderPipeline>>),
                uniform: Rc<wgpu::Buffer>,
                extra: Option<(Rc<wgpu::Buffer>, u32)>| {
        let draw = CustomDraw {
            buffer_pipeline: buffer.clone(),
            extra: extra.as_ref().map(|e| e.0.clone()),
            instances: extra.map_or(1, |e| e.1),
            ..CustomDraw::new(pl.clone(), Rc::new(group(&uniform, &shadow_view)), uniform)
        };
        r.add_custom(Item { mesh, material: Material { transparent: true, face, ..Default::default() }, transform, render_order: order, visible: true }, draw)
    };
    if let Some(f) = faces {
        // Multiply: dst × src colour, alpha kept.
        let multiply = wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::Src, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
        };
        let catcher = pipelines(
            r,
            &PipelineOptions {
                entries: ("vs_catcher", "fs_catcher"),
                depth_write: false,
                blend: Some(multiply),
                cull: Some(wgpu::Face::Back),
                ..PipelineOptions::new("vines shadow catcher", &module)
            },
        );
        let strength = if glass { 0.55 } else { 1.0 };
        for (side, mesh) in [(1i8, f.front), (-1, f.back)] {
            let z = side as f32 * (face_z + CATCHER_LIFT) as f32;
            let mut transform = Mat4::from_translation(Vec3::new(0.0, 0.0, z));
            if side < 0 {
                transform *= Mat4::from_rotation_y(std::f32::consts::PI);
            }
            item(r, mesh, transform, 70.0, Some(side), &catcher, item_uniform([side as f32, strength, 0.0, 0.0]), None);
        }
    }
    let stem_pipelines = pipelines(
        r,
        &PipelineOptions {
            entries: ("vs_stem", "fs_stem"),
            extra: Some(stem_layout.clone()),
            blend: Some(blend::NORMAL),
            ..PipelineOptions::new("ivy stems", &module)
        },
    );
    item(r, stems, Mat4::IDENTITY, 71.0, None, &stem_pipelines, item_uniform([0.0; 4]), Some((stem_extra.clone(), 1)));
    let leaf_pipelines = pipelines(
        r,
        &PipelineOptions {
            entries: ("vs_leaf", "fs_leaf"),
            extra: Some(leaf_layout.clone()),
            blend: Some(blend::NORMAL),
            ..PipelineOptions::new("ivy leaves", &module)
        },
    );
    let count = leaves.len() as u32;
    let leaves_item = item(r, leaf_plane, Mat4::IDENTITY, 72.0, None, &leaf_pipelines, item_uniform([0.0; 4]), Some((leaf_instances.clone(), count)));
    // The leaves are an InstancedBufferGeometry in three: the stage's box leaves them out.
    if let Some(c) = r.custom_mut(leaves_item) {
        c.instanced = true;
    }

    // uEye follows the camera drawing (`prepare` from every receiver's onBeforeRender).
    r.eyes.push(crate::effects::Eye { transform: Mat4::IDENTITY, buffer: shared.clone(), offset: std::mem::offset_of!(Shared, eye) as u64 });
    Vines {
        shared,
        data,
        motion,
        animated,
        frozen: !animated,
        last: None,
        update_fn: update_frame,
        prepare_fn: prepare_frame,
        pass: ShadowPass { stem: stem_cast, leaf: leaf_cast, group: cast_group, blit, levels, stems, stem_extra, leaves: leaf_plane, leaf_instances, count },
    }
}

/// The sun, in world space.
fn light_world() -> Vec3 {
    glam::DVec3::new(-0.32, 0.74, 0.59).normalize().as_vec3()
}

impl Vines {
    /// One frame of motion (`tick`, yaw from the world rotation) for the card at `model`.
    pub fn update(&mut self, dt: f64, model: Mat4) {
        if self.animated {
            (self.update_fn)(self, dt, model)
        }
    }

    /// Before drawing (`prepare`): the sun and eye into the card's space, the motion, and the shadow
    /// pass when its inputs changed (a frozen still only reuses a pass drawn from exactly its state).
    pub fn prepare(&mut self, r: &Renderer, device: &wgpu::Device, queue: &wgpu::Queue, model: Mat4, cam: &crate::renderer::Camera) {
        (self.prepare_fn)(self, r, device, queue, model, cam)
    }
}

/// `Vines::update`; only the `vines` chunk refers to it (by address), so its code lives there.
fn update_frame(this: &mut Vines, dt: f64, model: Mat4) {
    let (_, q, _) = model.to_scale_rotation_translation();
    let q = q.as_dquat();
    // Euler XYZ's y: asin(m13) of the rotation matrix (`makeRotationFromQuaternion`).
    let m13 = q.x * (q.z + q.z) + q.w * (q.y + q.y);
    this.motion.update(dt, m13.clamp(-1.0, 1.0).asin(), true, [q.x, q.y, q.z, q.w]);
}

/// `Vines::prepare`; only the `vines` chunk refers to it (by address).
fn prepare_frame(this: &mut Vines, r: &Renderer, device: &wgpu::Device, queue: &wgpu::Queue, model: Mat4, cam: &crate::renderer::Camera) {
    this.prepare_frame(r, device, queue, model, cam)
}

impl Vines {
    #[inline(always)]
    fn prepare_frame(&mut self, r: &Renderer, device: &wgpu::Device, queue: &wgpu::Queue, model: Mat4, cam: &crate::renderer::Camera) {
        let inv = model.inverse();
        let light = inv.transform_vector3(light_world()).normalize();
        let eye = inv.transform_point3(cam.eye32());
        let m = &self.motion;
        let (time, sway, rustle) = (m.time as f32, m.sway as f32, m.rustle as f32);
        self.data.light = [light.x, light.y, light.z, 0.0];
        self.data.eye = [eye.x, eye.y, eye.z, 0.0];
        self.data.motion = [time, sway, rustle, m.wind as f32];
        queue.write_buffer(&self.shared, 0, bytemuck::bytes_of(&self.data));
        let skip = self.last.is_some_and(|(t, s, ru, l)| {
            if self.frozen {
                t == time && s == sway && ru == rustle && l == light
            } else {
                rustle < 0.01 && (time - t).abs() < 1.0 / 15.0 && l.distance_squared(light) < 1e-5 && (sway - s).abs() < 5e-4
            }
        });
        if skip {
            return;
        }
        self.last = Some((time, sway, rustle, light));
        let p = &self.pass;
        let mut encoder = device.create_command_encoder(&Default::default());
        for (view, source) in &p.levels {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("leaf shadows"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            match source {
                None => {
                    pass.set_bind_group(0, r.frame_bind_group(), &[]);
                    pass.set_bind_group(1, &p.group, &[]);
                    let (v, i, n) = r.mesh_buffers(p.stems);
                    pass.set_pipeline(&p.stem);
                    pass.set_vertex_buffer(0, v.slice(..));
                    pass.set_vertex_buffer(1, p.stem_extra.slice(..));
                    pass.set_index_buffer(i.slice(..), wgpu::IndexFormat::Uint32);
                    pass.draw_indexed(0..n, 0, 0..1);
                    let (v, i, n) = r.mesh_buffers(p.leaves);
                    pass.set_pipeline(&p.leaf);
                    pass.set_vertex_buffer(0, v.slice(..));
                    pass.set_vertex_buffer(1, p.leaf_instances.slice(..));
                    pass.set_index_buffer(i.slice(..), wgpu::IndexFormat::Uint32);
                    pass.draw_indexed(0..n, 0, 0..p.count);
                }
                Some(g) => {
                    pass.set_pipeline(&p.blit);
                    pass.set_bind_group(2, g, &[]);
                    pass.draw(0..3, 0..1);
                }
            }
        }
        queue.submit([encoder.finish()]);
    }
}

// ── the leaf atlas (leaf-atlas.ts) ─────────────────────────────

type P2 = [f64; 2];

const LEAF_SHAPES: [&[P2]; 4] = [
    &[
        [0.5, 0.15],
        [0.37, 0.1],
        [0.24, 0.14],
        [0.15, 0.24],
        [0.12, 0.38],
        [0.07, 0.7],
        [0.23, 0.63],
        [0.32, 0.6],
        [0.36, 0.71],
        [0.48, 0.96],
        [0.61, 0.75],
        [0.66, 0.62],
        [0.76, 0.65],
        [0.91, 0.76],
        [0.88, 0.47],
        [0.84, 0.29],
        [0.75, 0.17],
        [0.62, 0.12],
    ],
    &[
        [0.5, 0.16],
        [0.38, 0.09],
        [0.22, 0.12],
        [0.12, 0.26],
        [0.1, 0.46],
        [0.04, 0.74],
        [0.2, 0.66],
        [0.33, 0.55],
        [0.38, 0.7],
        [0.5, 0.98],
        [0.62, 0.7],
        [0.67, 0.55],
        [0.8, 0.66],
        [0.96, 0.74],
        [0.9, 0.46],
        [0.88, 0.26],
        [0.78, 0.12],
        [0.62, 0.09],
    ],
    &[
        [0.5, 0.13],
        [0.36, 0.06],
        [0.21, 0.1],
        [0.05, 0.3],
        [0.2, 0.36],
        [0.23, 0.43],
        [0.11, 0.63],
        [0.3, 0.61],
        [0.37, 0.7],
        [0.5, 0.97],
        [0.63, 0.7],
        [0.7, 0.61],
        [0.89, 0.63],
        [0.77, 0.43],
        [0.8, 0.36],
        [0.95, 0.3],
        [0.79, 0.1],
        [0.64, 0.06],
    ],
    &[
        [0.5, 0.15],
        [0.36, 0.05],
        [0.18, 0.08],
        [0.08, 0.22],
        [0.06, 0.42],
        [0.14, 0.62],
        [0.28, 0.78],
        [0.42, 0.9],
        [0.5, 0.98],
        [0.58, 0.9],
        [0.72, 0.78],
        [0.86, 0.62],
        [0.94, 0.42],
        [0.92, 0.22],
        [0.82, 0.08],
        [0.64, 0.05],
    ],
];

const VEIN_ENDS: [&[P2]; 4] = [
    &[[0.48, 0.96], [0.07, 0.7], [0.91, 0.76]],
    &[[0.5, 0.98], [0.04, 0.74], [0.96, 0.74]],
    &[[0.5, 0.97], [0.11, 0.63], [0.89, 0.63], [0.05, 0.3], [0.95, 0.3]],
    &[[0.5, 0.98]],
];

/// The leaf atlas: 256 × 384 RGBA, six 128² tiles, rows top first. R shading, G vein, B edge
/// distance, A coverage. Drawn on the host's canvas as the TypeScript draws it.
pub fn leaf_atlas(host: &dyn Host) -> Vec<u8> {
    const W: usize = 256;
    let mut g = host.canvas(256, 256);
    let mut out = vec![0u8; W * 384 * 4];
    for e in 0..6usize {
        let t = [0, 1, 2, 0, 2, 3][e];
        let mut rand = Lcg::new(827 + 43 * e as u32);
        let a = (e as f64 - 2.5) * 0.02;
        let m = if e == 3 { -1.0 } else { 1.0 };
        let pt = |x: f64, y: f64| -> P2 { [(0.5 + (x - 0.5) * m + a * y + 0.01 * model::sin(9.0 * y + e as f64)) * 224.0 + 16.0, (1.0 - y) * 224.0 + 16.0] };
        let shape = LEAF_SHAPES[t];
        // The outline: each edge in thirds, the middle third pushed out on the first two shapes.
        let mut outline: Vec<P2> = vec![pt(shape[0][0], shape[0][1])];
        for i in 1..=shape.len() {
            let (pa, pb) = (shape[i - 1], shape[i % shape.len()]);
            let (dx, dy) = (pb[0] - pa[0], pb[1] - pa[1]);
            let len = model::hypot(dx, dy);
            let len = if len == 0.0 { 1.0 } else { len };
            let o = if t < 2 { 0.008 + 0.007 * rand.next() } else { 0.0 };
            for (k, f) in [1.0 / 3.0, 2.0 / 3.0, 1.0].into_iter().enumerate() {
                let (mut x, mut y) = (pa[0] + dx * f, pa[1] + dy * f);
                if k == 1 {
                    x += (-dy / len) * o;
                    y += (dx / len) * o;
                }
                outline.push(pt(x, y));
            }
        }
        let clip = |g: &mut Box<dyn crate::canvas::Canvas>| {
            g.begin_path();
            g.move_to(outline[0][0], outline[0][1]);
            for p in &outline[1..] {
                g.line_to(p[0], p[1]);
            }
            g.close_path();
            g.clip(FillRule::NonZero);
        };
        let d = |g: &mut Box<dyn crate::canvas::Canvas>, a: P2, b: P2, width: f64, style: &str, bend: f64| {
            g.begin_path();
            let (s, c, t) = (pt(a[0], a[1]), pt((a[0] + b[0]) / 2.0 + bend, (a[1] + b[1]) / 2.0), pt(b[0], b[1]));
            g.move_to(s[0], s[1]);
            g.quadratic_curve_to(c[0], c[1], t[0], t[1]);
            g.set_line_width(width);
            g.set_stroke(Paint::color(style));
            g.set_line_cap(LineCap::Round);
            g.stroke();
        };
        let veins = VEIN_ENDS[t];

        // Shading pass → F.
        g.clear_rect(0.0, 0.0, 256.0, 256.0);
        g.save();
        clip(&mut g);
        let [gx, gy] = pt(0.5, 0.16);
        g.set_fill(Paint::Radial {
            from: [gx, gy, 4.0],
            to: [gx, gy, 230.0],
            stops: vec![(0.0, "#585858".into()), (0.5, "#a2a2a2".into()), (1.0, "#cfcfcf".into())],
        });
        g.fill_rect(0.0, 0.0, 256.0, 256.0);
        for v in veins {
            d(&mut g, [0.5, 0.2], *v, 30.0, "rgba(255,255,255,.22)", 0.05);
            d(&mut g, [0.5, 0.22], [0.85 * v[0] + 0.075, 0.85 * v[1]], 12.0, "rgba(255,255,255,.14)", 0.1);
            d(&mut g, [0.5, 0.18], [0.8 * v[0] + 0.1, 0.8 * v[1]], 18.0, "rgba(0,0,0,.16)", -0.06);
        }
        for _ in 0..26 {
            let cx = 256.0 * rand.next();
            let cy = 256.0 * rand.next();
            let r = 6.0 + 22.0 * rand.next();
            let first = if rand.next() > 0.5 { "rgba(255,255,255,.16)" } else { "rgba(0,0,0,.14)" };
            g.set_fill(Paint::Radial { from: [cx, cy, 0.0], to: [cx, cy, r], stops: vec![(0.0, first.into()), (1.0, "transparent".into())] });
            g.fill_rect(cx - r, cy - r, 2.0 * r, 2.0 * r);
        }
        g.restore();
        d(&mut g, [0.5, 0.02], [0.5, 0.19], 6.0, "#4a4a4a", -0.01);
        let f_px = g.get_image_data();

        // Vein pass → Vn.
        g.clear_rect(0.0, 0.0, 256.0, 256.0);
        g.save();
        clip(&mut g);
        for v in veins {
            d(&mut g, [0.5, 0.16], *v, 3.6, "#ffffff", 0.012);
            for k in 1..=4 {
                let r = k as f64 / 5.0;
                let ap = 0.5 + (v[0] - 0.5) * r;
                let np = 0.16 + (v[1] - 0.16) * r;
                for side in [-1.0, 1.0] {
                    d(&mut g, [ap, np], [ap + side * (0.04 + 0.06 * r), np + 0.05], 1.7, "rgba(255,255,255,.7)", 0.0);
                }
            }
        }
        g.restore();
        let vn = g.get_image_data();

        // 2 × 2 downsample into the tile.
        let (tx, ty) = ((e % 2) * 128, 128 * (e / 2));
        let mut dist = vec![0.0f64; 128 * 128];
        for y in 0..128 {
            for x in 0..128 {
                let (mut alpha, mut lum, mut vein) = (0.0f64, 0.0f64, 0.0f64);
                for (sx, sy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let k = ((2 * y + sy) * 256 + 2 * x + sx) * 4;
                    let ai = f_px[k + 3] as f64 / 255.0;
                    alpha += ai;
                    lum += f_px[k] as f64 * ai;
                    vein += vn[k + 3] as f64 * ai;
                }
                let o = ((ty + y) * W + tx + x) * 4;
                dist[y * 128 + x] = if alpha > 2.0 { 1e4 } else { 0.0 };
                if alpha == 0.0 {
                    out[o] = 150;
                    continue;
                }
                lum /= alpha;
                vein /= alpha;
                if rand.next() < 0.3 {
                    let w = rand.next() > 0.5;
                    lum += ((if w { 255.0 } else { 0.0 }) - lum) * rand.next() * if w { 0.2 } else { 0.18 };
                }
                out[o] = model::js_round(lum) as u8;
                out[o + 1] = model::js_round(vein) as u8;
                out[o + 3] = model::js_round(255.0 * alpha / 4.0) as u8;
            }
        }
        // Chamfer distance from the edge, forward then backward.
        let at = |d: &[f64], x: i32, y: i32| if x < 0 || y < 0 || x >= 128 || y >= 128 { f64::INFINITY } else { d[(y * 128 + x) as usize] };
        for y in 0..128i32 {
            for x in 0..128i32 {
                let i = (y * 128 + x) as usize;
                if dist[i] == 0.0 {
                    continue;
                }
                dist[i] = dist[i]
                    .min(at(&dist, x - 1, y) + 1.0)
                    .min(at(&dist, x, y - 1) + 1.0)
                    .min(at(&dist, x - 1, y - 1) + 1.414)
                    .min(at(&dist, x + 1, y - 1) + 1.414);
            }
        }
        for y in (0..128i32).rev() {
            for x in (0..128i32).rev() {
                let i = (y * 128 + x) as usize;
                if dist[i] == 0.0 {
                    continue;
                }
                dist[i] = dist[i]
                    .min(at(&dist, x + 1, y) + 1.0)
                    .min(at(&dist, x, y + 1) + 1.0)
                    .min(at(&dist, x - 1, y + 1) + 1.414)
                    .min(at(&dist, x + 1, y + 1) + 1.414);
            }
        }
        for y in 0..128 {
            for x in 0..128 {
                out[((ty + y) * W + tx + x) * 4 + 2] = model::js_round(255.0 * (dist[y * 128 + x] / 20.0).min(1.0)) as u8;
            }
        }
    }
    out
}
