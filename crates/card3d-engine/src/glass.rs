//! The clear glass card (`scene/glass.ts`): the glass body's transmission material
//! (`createGlassMaterial` and `addGlassEdges` over drei's `MeshTransmissionMaterial`) and the card's
//! backdrop. The slab's geometry is `glass_geometry`, the chip module inside it `chip_module`; the
//! renderer draws the body with the glass shader over its two buffer passes.

use glam::{Mat4, Vec3};

use crate::chip_module::{build_chip_module, ChipModuleOptions, ModuleParent};
use crate::glass_geometry::GLASS_THICKNESS;
use crate::layout::CardFrame;
use crate::material::{srgb_hex_to_linear, srgb_hex_to_srgb, Resolved};
use crate::quality::Quality;
use crate::renderer::{FramePasses, GlassBuffer, GlassFrame, GlassGpu, GlassParams, Item, Material, PassStage, PassTarget, Renderer, Side};

/// Behind a glass card, and the colour its environment's empty directions show (`GLASS_BACKDROP`).
pub const GLASS_BACKDROP: &str = "#3d84c4";

/// `GLASS_EDGE`: the slab's polished edges.
const EDGE_ABSORPTION: f32 = 5.0;
const EDGE_SPECULAR: f32 = 1.6;

/// `GLASS_QUALITY[q]`: refraction samples and the buffers' size × the drawing buffer's.
fn glass_quality(q: Quality) -> (u32, f32) {
    match q {
        Quality::Full => (8, 1.0),
        Quality::Performance => (5, 0.75),
    }
}

fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    hi.min(lo.max(x))
}

/// The backdrop as sRGB 0..1 (the canvas clear) and linear (the environment's clear).
pub fn backdrop_srgb() -> [f32; 3] {
    srgb_hex_to_srgb(GLASS_BACKDROP).map(|c| c as f32)
}
pub fn backdrop_linear() -> [f32; 3] {
    srgb_hex_to_linear(GLASS_BACKDROP)
}

/// `createGlassMaterial`: the resolver's `thickness` (a look, 0.42–0.70 over the polish range) mapped
/// onto the slab's real thickness; low distortion and smear, a thin clearcoat (one air/glass interface)
/// and polished edges.
pub fn material(m: &Resolved, quality: Quality) -> Material {
    let thickness = (GLASS_THICKNESS * clamp(m.thickness / 0.56, 0.6, 1.4)) as f32;
    let (samples, buffer_scale) = glass_quality(quality);
    Material {
        color: m.color,
        metalness: 0.0,
        roughness: clamp(m.roughness, 0.02, 0.2) as f32,
        clearcoat: 0.25,
        clearcoat_roughness: 0.04,
        specular_intensity: 0.65,
        glass: Some(GlassParams {
            samples,
            buffer_scale,
            thickness,
            backside_thickness: 0.55 * thickness,
            ior: 1.5,
            chromatic_aberration: 0.018,
            anisotropic_blur: 0.05,
            smear: 0.3,
            distortion: 0.008,
            distortion_scale: 0.2,
            temporal_distortion: 0.0,
            transmission: 1.0,
            background: backdrop_srgb(),
            edge_absorption: EDGE_ABSORPTION,
            edge_specular: EDGE_SPECULAR,
        }),
        ..Default::default()
    }
}

/// The chip module inside a clear card (`buildChipModule`): seen only through the glass, refracted by
/// its buffer passes (face 0: the backside pass leaves it out).
pub fn add_chip_module(r: &mut Renderer, device: &wgpu::Device, frame: &CardFrame) {
    let module = build_chip_module(Some(frame), &ChipModuleOptions { body_depth: GLASS_THICKNESS, slab: None });
    let meshes: Vec<_> = module.geometries.iter().map(|g| r.mesh(device, g)).collect();
    let [bx, by, bz] = module.body_position.map(|v| v as f32);
    let body = Mat4::from_translation(Vec3::new(bx, by, bz)) * Mat4::from_rotation_z(module.body_rotation_z as f32);
    for m in &module.meshes {
        let [x, y, z] = m.position.map(|v| v as f32);
        let local = Mat4::from_translation(Vec3::new(x, y, z)) * Mat4::from_rotation_z(m.rotation_z as f32);
        let transform = match m.parent {
            ModuleParent::Body => body * local,
            ModuleParent::Group => local,
        };
        let c = m.material.color;
        let material = Material {
            color: srgb_hex_to_linear(&format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])),
            metalness: m.material.metalness,
            roughness: m.material.roughness,
            clearcoat: m.material.clearcoat,
            clearcoat_roughness: m.material.clearcoat_roughness,
            face: Some(0),
            ..Default::default()
        };
        r.add(Item { mesh: meshes[m.geometry], material, transform, render_order: 0.0, visible: true });
    }
}

/// The glass card's own layers: the slab with its transmission material, and the chip module inside it.
/// On the web this is the `glass` chunk (the slab's extrusion, the triangulation, the coil's tubes),
/// downloaded only by glass cards.
#[wasm_split_helpers::wasm_split(glass, fallible)]
pub fn build(r: &mut Renderer, device: &wgpu::Device, m: &Resolved, quality: Quality, frame: &CardFrame) -> Result<(), crate::ChunkUnavailable> {
    let body = r.mesh(device, crate::glass_geometry::glass_body_geometry());
    r.add(Item { mesh: body, material: material(m, quality), transform: Mat4::IDENTITY, render_order: 0.0, visible: true });
    add_chip_module(r, device, frame);
    // The glass shader's layouts (once per core), its buffers and passes.
    let core = r.core.clone();
    core.glass.get_or_init(|| {
        use crate::renderer::{sampler_entry, texture_entry, uniform_entry};
        let bind = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2)],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("glass"),
            bind_group_layouts: &[Some(&core.frame_layout), Some(&core.draw_layout), Some(&bind)],
            immediate_size: 0,
        });
        (bind, layout)
    });
    // drei's FBOs: LinearFilter, no mipmaps.
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("glass buffer"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });
    let uniform = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("glass"),
        size: size_of::<GlassUniform>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    r.glass_gpu = Some(GlassGpu { sampler, uniform, targets: None });
    r.glass_passes = Some(buffer_passes);
    Ok(())
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GlassUniform {
    model: [[f32; 4]; 4],
    camera: [f32; 4],
    params: [f32; 4],
    params2: [f32; 4],
    params3: [f32; 4],
    viewport: [f32; 4],
}

/// The glass buffers at `w` × `h` (`setBufferSize`), made or remade.
fn ensure_buffers(r: &mut Renderer, device: &wgpu::Device, w: u32, h: u32) {
    let core = r.core.clone();
    let Some(g) = r.glass_gpu.as_mut() else { return };
    if g.targets.as_ref().is_some_and(|t| (t.0, t.1) == (w, h)) {
        return;
    }
    let make = |format, label, usage| {
        device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage,
                view_formats: &[],
            })
            .create_view(&Default::default())
    };
    let colour = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
    let main = make(crate::renderer::GLASS_BUFFER_FORMAT, "glass main buffer", colour);
    let back = make(crate::renderer::GLASS_BUFFER_FORMAT, "glass back buffer", colour);
    let depth = make(wgpu::TextureFormat::Depth32Float, "glass depth", wgpu::TextureUsages::RENDER_ATTACHMENT);
    let bind_layout = &core.glass.get().expect("glass layouts").0;
    let bind = |view: &wgpu::TextureView| {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: bind_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: g.uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&g.sampler) },
            ],
        })
    };
    let (bind_main, bind_back) = (bind(&main), bind(&back));
    g.targets = Some((w, h, main, back, depth, bind_main, bind_back));
}

/// A glass card's two buffer passes before the canvas (`renderTransmissionPasses`), each its own
/// submission so that it sees its own uniforms; then the scene's reflection again, now with the glass.
fn buffer_passes(r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, f: &GlassFrame<'_>, passes: &mut Option<Box<dyn FramePasses>>) {
    let (gi, order, frame, eye, slot) = (f.item, f.order, f.frame, f.eye, f.pass_frame.model);
    let (width, height) = (f.pass_frame.width, f.pass_frame.height);
    let glass_uniform = |r: &mut Renderer, g: &GlassParams, thickness: f32, target_height: u32| {
        let u = GlassUniform {
            model: crate::renderer::mat(slot * r.items[gi].transform),
            camera: [eye.x, eye.y, eye.z, 1.0],
            params: [thickness, g.ior, g.chromatic_aberration, g.anisotropic_blur],
            params2: [g.smear, g.distortion, g.distortion_scale, g.temporal_distortion],
            params3: [0.0, g.samples as f32, g.edge_absorption, g.edge_specular],
            viewport: [target_height as f32, g.transmission, 0.0, 0.0],
        };
        if let Some(gpu) = &r.glass_gpu {
            queue.write_buffer(&gpu.uniform, 0, bytemuck::bytes_of(&u));
        }
    };
    let set_side = |r: &mut Renderer, i: usize, side: Side| {
        let g = r.gpu_items[i].as_mut().unwrap();
        g.uniform.spec[1] = crate::renderer::side_mode(side);
        queue.write_buffer(&g.buffer, 0, bytemuck::bytes_of(&g.uniform));
    };
    let g = r.items[gi].material.glass.unwrap();
    // Which face the camera is on, in the glass's own space (`placedObjects`).
    let local = (slot * r.items[gi].transform).inverse().transform_point3(eye);
    let side: i8 = if local.z > 0.0 {
        1
    } else if local.z < 0.0 {
        -1
    } else {
        0
    };
    let size = |v: u32| ((v as f32 * g.buffer_scale).round() as u32).max(1);
    let (bw, bh) = (size(width), size(height));
    ensure_buffers(r, device, bw, bh);
    let lin = |c: f32| if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) } as f64;
    let clear = wgpu::Color { r: lin(g.background[0]), g: lin(g.background[1]), b: lin(g.background[2]), a: 1.0 };
    let face = |r: &Renderer, i: usize| r.items[i].material.face;
    let near = |r: &Renderer, i: usize| side != 0 && face(r, i) == Some(side);
    let in_buffers = |r: &Renderer, i: usize| r.custom[i].as_ref().is_none_or(|c| c.buffer_pipeline.is_some());
    // Linear output, no tone mapping, into the half-float buffers.
    let mut linear = frame;
    linear.misc[1] = 1.0;
    queue.write_buffer(&r.frame_buffer, 0, bytemuck::bytes_of(&linear));
    // Backside pass: what lies beyond the glass (not the glass, nor what's near or inside it).
    let back: Vec<usize> =
        order.iter().copied().filter(|&i| i != gi && r.holo[i].is_none() && in_buffers(r, i) && !near(r, i) && face(r, i) != Some(0)).collect();
    r.draw_pass(device, queue, PassTarget::GlassBack, clear, &back, None);
    // Main buffer pass: the glass's back faces refracting the backside buffer, and what's inside.
    glass_uniform(r, &g, g.backside_thickness, bh);
    set_side(r, gi, Side::Back);
    let main: Vec<usize> = order.iter().copied().filter(|&i| r.holo[i].is_none() && in_buffers(r, i) && !near(r, i)).collect();
    r.draw_pass(device, queue, PassTarget::GlassMain, clear, &main, Some((gi, GlassBuffer::Back)));
    // The canvas: the glass's front faces refracting the main buffer.
    queue.write_buffer(&r.frame_buffer, 0, bytemuck::bytes_of(&frame));
    glass_uniform(r, &g, g.thickness, height);
    let front = r.items[gi].material.side;
    set_side(r, gi, front);
    // The scene's reflection again, now with the glass.
    if let Some(p) = passes.as_mut() {
        p.run(r, device, queue, &f.pass_frame, PassStage::AfterGlass);
        r.write_items(device, queue, f.view, slot);
        for e in &r.eyes {
            e.write(queue, slot, &f.pass_frame.camera);
        }
        queue.write_buffer(&r.frame_buffer, 0, bytemuck::bytes_of(&frame));
    }
}
