//! What the add-ons and the face layers share (card/effect-hooks.ts, addons/index.ts): custom-pipeline
//! items over the card, and the per-frame uniforms they read (the eye, in their own space).

use crate::renderer::{Renderer, GLASS_BUFFER_FORMAT, MSAA};
use glam::Mat4;
use std::rc::Rc;

/// One entry of an effect's group 1 (binding = its index), visible to both stages.
#[derive(Clone, Copy, Hash)]
pub enum Bind {
    Uniform,
    Texture,
    Sampler,
}

/// Where a pipeline draws.
#[derive(Clone, Copy, PartialEq, Hash)]
pub enum Target {
    /// The canvas: its format, 4× MSAA, the depth buffer.
    Canvas,
    /// The glass's buffer passes: half floats, one sample, the depth buffer.
    GlassBuffer,
    /// An offscreen texture of this format: one sample, no depth.
    Plain(wgpu::TextureFormat),
}

/// How an effect's pipeline draws (three's material flags).
pub struct PipelineOptions<'a> {
    pub label: &'a str,
    pub module: &'a wgpu::ShaderModule,
    /// Vertex and fragment entry points.
    pub entries: (&'a str, &'a str),
    /// Vertex buffers after the renderer's mesh layout (slot 1: per-vertex or per-instance data).
    pub extra: Option<wgpu::VertexBufferLayout<'a>>,
    pub depth_test: bool,
    pub depth_write: bool,
    pub blend: Option<wgpu::BlendState>,
    pub cull: Option<wgpu::Face>,
}

impl<'a> PipelineOptions<'a> {
    /// `vs_main` / `fs_main`, depth tested and written, opaque, both faces.
    pub fn new(label: &'a str, module: &'a wgpu::ShaderModule) -> Self {
        PipelineOptions { label, module, entries: ("vs_main", "fs_main"), extra: None, depth_test: true, depth_write: true, blend: None, cull: None }
    }
}

/// three's blending modes (non-premultiplied).
pub mod blend {
    use wgpu::{BlendComponent as C, BlendFactor as F, BlendOperation as O, BlendState};
    const fn c(src_factor: F, dst_factor: F, operation: O) -> C {
        C { src_factor, dst_factor, operation }
    }
    /// `NormalBlending`.
    pub const NORMAL: BlendState = BlendState { color: c(F::SrcAlpha, F::OneMinusSrcAlpha, O::Add), alpha: c(F::One, F::OneMinusSrcAlpha, O::Add) };
    /// `AdditiveBlending`.
    pub const ADDITIVE: BlendState = BlendState { color: c(F::SrcAlpha, F::One, O::Add), alpha: c(F::One, F::One, O::Add) };
}

/// A shader module from WGSL, compiled once per device (`renderer::memo`).
pub fn module(device: &wgpu::Device, label: &str, source: &str) -> wgpu::ShaderModule {
    let make = || device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source: wgpu::ShaderSource::Wgsl(source.into()) });
    (*crate::renderer::memo(device, "module", 16, crate::renderer::key_of(source), make)).clone()
}

/// A bind group layout, made once per device (`renderer::memo`), so pipelines made on it are too.
pub fn layout(device: &wgpu::Device, label: &str, entries: &[wgpu::BindGroupLayoutEntry]) -> wgpu::BindGroupLayout {
    let make = || device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries });
    (*crate::renderer::memo(device, "layout", 32, crate::renderer::key_of((label, entries)), make)).clone()
}

/// Group 1's layout: `entries[k]` at binding k.
pub fn bind_layout(device: &wgpu::Device, label: &str, entries: &[Bind]) -> wgpu::BindGroupLayout {
    let entries: Vec<wgpu::BindGroupLayoutEntry> = entries
        .iter()
        .enumerate()
        .map(|(k, b)| wgpu::BindGroupLayoutEntry {
            binding: k as u32,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: match b {
                Bind::Uniform => wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                Bind::Texture => wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                Bind::Sampler => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            },
            count: None,
        })
        .collect();
    layout(device, label, &entries)
}

/// A bind group of `layout` from its resources, in binding order.
pub fn bind_group(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, resources: &[wgpu::BindingResource<'_>]) -> wgpu::BindGroup {
    let entries: Vec<wgpu::BindGroupEntry<'_>> =
        resources.iter().enumerate().map(|(k, r)| wgpu::BindGroupEntry { binding: k as u32, resource: r.clone() }).collect();
    device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout, entries: &entries })
}

/// A pipeline on the frame's group 0 and `layout` as group 1, drawing the renderer's vertex layout
/// (plus `o.extra`) into `target`: made once per device for the same module and layouts (`module`,
/// `layout`; `renderer::memo`).
pub fn pipeline(r: &Renderer, device: &wgpu::Device, layout: &wgpu::BindGroupLayout, o: &PipelineOptions<'_>, target: Target) -> wgpu::RenderPipeline {
    let inputs = (r.frame_layout(), layout, o.module, o.entries, &o.extra, o.depth_test, o.depth_write, o.blend, o.cull, target, r.format());
    let key = crate::renderer::key_of((o.label, inputs));
    let made = crate::renderer::memo(device, "pipeline", 64, key, || {
        (r.frame_layout().clone(), layout.clone(), o.module.clone(), make_pipeline(r, device, layout, o, target))
    });
    made.3.clone()
}

fn make_pipeline(r: &Renderer, device: &wgpu::Device, layout: &wgpu::BindGroupLayout, o: &PipelineOptions<'_>, target: Target) -> wgpu::RenderPipeline {
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(o.label),
        bind_group_layouts: &[Some(r.frame_layout()), Some(layout)],
        immediate_size: 0,
    });
    let mut buffers = crate::renderer::VERTEX_LAYOUT.to_vec();
    buffers.push(o.extra.clone());
    let (format, samples, depth) = match target {
        Target::Canvas => (r.format(), MSAA, true),
        Target::GlassBuffer => (GLASS_BUFFER_FORMAT, 1, true),
        Target::Plain(f) => (f, 1, false),
    };
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(o.label),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: o.module,
            entry_point: Some(o.entries.0),
            buffers: if o.extra.is_some() { &buffers } else { crate::renderer::VERTEX_LAYOUT },
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: o.module,
            entry_point: Some(o.entries.1),
            targets: &[Some(wgpu::ColorTargetState { format, blend: o.blend, write_mask: wgpu::ColorWrites::ALL })],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState { cull_mode: o.cull, ..Default::default() },
        depth_stencil: depth.then(|| wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(o.depth_write),
            depth_compare: Some(if o.depth_test { wgpu::CompareFunction::LessEqual } else { wgpu::CompareFunction::Always }),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
        multiview_mask: None,
        cache: None,
    })
}

/// An effect item's uniform buffer, holding `data` (which starts with the model-view matrix).
pub fn uniform_buffer(device: &wgpu::Device, queue: &wgpu::Queue, label: &str, data: &[u8]) -> Rc<wgpu::Buffer> {
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: data.len() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&buffer, 0, data);
    Rc::new(buffer)
}

/// A uniform that holds the camera position in an item's space (`uEye`), at `offset`.
pub struct Eye {
    pub transform: Mat4,
    pub buffer: Rc<wgpu::Buffer>,
    pub offset: u64,
}

impl Eye {
    /// The camera `cam`, into the item's space under the card's `model`.
    pub fn write(&self, queue: &wgpu::Queue, model: Mat4, cam: &crate::renderer::Camera) {
        let eye = (model * self.transform).inverse().transform_point3(cam.eye32());
        queue.write_buffer(&self.buffer, self.offset, bytemuck::bytes_of(&[eye.x, eye.y, eye.z, 0.0]));
    }
}
