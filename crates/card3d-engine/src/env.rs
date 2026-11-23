//! The studio environment: the Lightformer panels of `scene/quality-env.ts` rendered into a cube from
//! the origin, then prefiltered into three's CUBEUV atlas exactly as `PMREMGenerator.fromCubemap` does
//! (r180: same atlas layout, level sizes, sigmas, pole axes and blur weights).

use glam::{Mat3, Vec3};
use wgpu::util::DeviceExt;

const LOD_MIN: i32 = 4;
const EXTRA_LOD_SIGMA: [f64; 6] = [0.125, 0.215, 0.35, 0.446, 0.526, 0.582];
const MAX_SAMPLES: usize = 20;

/// The environment's resolution (`QUALITY_PRESETS[q].environmentResolution`) and the CUBEUV atlas
/// three's `PMREMGenerator` makes for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnvSize {
    /// Cube face size: a power of two (`_cubeSize = 2^floor(log2(resolution))`).
    pub cube: u32,
}

impl EnvSize {
    pub fn new(resolution: u32) -> EnvSize {
        EnvSize { cube: 1 << resolution.max(16).ilog2() }
    }
    /// `_lodMax`.
    pub fn lod_max(self) -> i32 {
        self.cube.ilog2() as i32
    }
    pub fn atlas_w(self) -> u32 {
        3 * self.cube.max(16 * 7)
    }
    pub fn atlas_h(self) -> u32 {
        4 * self.cube
    }
    /// The atlas constants of `cube_uv_reflection_fragment` (`CUBEUV_MAX_MIP`, texel size), as WGSL
    /// to put before shaders/cubeuv.wgsl.
    pub fn cubeuv_prelude(self) -> String {
        format!(
            "const CUBEUV_MAX_MIP: f32 = {}.0;\nconst CUBEUV_TEXEL_WIDTH: f32 = 1.0 / {}.0;\nconst CUBEUV_TEXEL_HEIGHT: f32 = 1.0 / {}.0;\n",
            self.lod_max(),
            self.atlas_w(),
            self.atlas_h()
        )
    }
}
pub const ATLAS_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

/// What a lighting preset's look scales on a panel (`LightformerSpec.role`); flags are never touched.
#[derive(Clone, Copy, PartialEq)]
enum Role {
    Key,
    Fill,
    Base,
    Flag,
}

struct Lightformer {
    /// Drawn only on the `full` tier (`fullOnly`: L7 and L8).
    full_only: bool,
    role: Role,
    ring: bool,
    position: [f64; 3],
    rotation: Option<[f64; 3]>,
    scale: [f64; 2],
    color: &'static str,
    intensity: f64,
}

/// L1–L8 (`STUDIO_LIGHTFORMERS`); L7 and L8 only on the full tier.
const STUDIO: [Lightformer; 8] = [
    Lightformer {
        full_only: false,
        role: Role::Base,
        ring: false,
        position: [0.0, 0.0, 6.0],
        rotation: None,
        scale: [12.0, 9.0],
        color: "#c8c8c6",
        intensity: 0.02,
    },
    Lightformer {
        full_only: false,
        role: Role::Fill,
        ring: false,
        position: [-3.15, 0.4, 4.0],
        rotation: Some([0.0, 0.48, 0.0]),
        scale: [1.45, 7.0],
        color: "#eeeeec",
        intensity: 2.5,
    },
    Lightformer {
        full_only: false,
        role: Role::Key,
        ring: false,
        position: [2.2, 0.0, 4.0],
        rotation: Some([0.0, -0.34, 0.0]),
        scale: [2.5, 7.0],
        color: "#ffffff",
        intensity: 4.6,
    },
    Lightformer {
        full_only: false,
        role: Role::Key,
        ring: false,
        position: [1.35, 0.2, 5.0],
        rotation: Some([0.0, -0.24, 0.0]),
        scale: [0.24, 6.2],
        color: "#ffffff",
        intensity: 5.0,
    },
    Lightformer {
        full_only: false,
        role: Role::Flag,
        ring: false,
        position: [-0.3, 0.0, 4.4],
        rotation: None,
        scale: [1.05, 6.8],
        color: "#000000",
        intensity: 1.0,
    },
    Lightformer {
        full_only: false,
        role: Role::Base,
        ring: false,
        position: [0.0, 0.0, -4.0],
        rotation: Some([0.0, std::f64::consts::PI, 0.0]),
        scale: [9.0, 7.0],
        color: "#080808",
        intensity: 0.08,
    },
    Lightformer {
        full_only: true,
        role: Role::Fill,
        ring: true,
        position: [0.0, 4.0, -4.0],
        rotation: Some([std::f64::consts::FRAC_PI_2, 0.0, 0.0]),
        scale: [5.0, 5.0],
        color: "#d2d2d0",
        intensity: 0.75,
    },
    Lightformer {
        full_only: true,
        role: Role::Fill,
        ring: false,
        position: [-2.6, -3.8, 2.5],
        rotation: Some([0.45, 0.35, 0.0]),
        scale: [4.5, 0.4],
        color: "#e4e4e2",
        intensity: 1.2,
    },
];

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct Panel {
    pub center: [f32; 4],
    pub axis_x: [f32; 4],
    pub axis_y: [f32; 4],
    pub radiance: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Panels {
    count: [u32; 4],
    face: [u32; 4],
    /// What empty directions show (linear rgba): transparent black, or a glass card's backdrop.
    clear: [f32; 4],
    items: [Panel; 16],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BlurUniform {
    weights: [f32; 20],
    pole_axis: [f32; 4],
    samples: i32,
    latitudinal: u32,
    d_theta: f32,
    mip_int: f32,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct PlaneVertex {
    position: [f32; 2],
    uv: [f32; 2],
    face: f32,
}

/// A lighting preset's reshaping of the panels (`EnvironmentLook`): role gains, tints, rim panels.
#[derive(Clone, Debug, Default)]
pub struct Look {
    pub key: Option<f64>,
    pub fill: Option<f64>,
    pub base: Option<f64>,
    pub key_tint: Option<&'static str>,
    pub fill_tint: Option<&'static str>,
    /// Rim panels: intensity and colour (default white).
    pub rim: Option<(f64, Option<&'static str>)>,
}

/// `rimLightformers`: narrow bright panels behind the card and ~60° off-axis.
fn rim_panels(look: &Look) -> Vec<Lightformer> {
    let Some((i, color)) = look.rim.filter(|(i, _)| *i > 0.0) else { return vec![] };
    let color = color.unwrap_or("#ffffff");
    let p = |position: [f64; 3], scale: [f64; 2], intensity: f64| Lightformer {
        full_only: false,
        role: Role::Flag,
        ring: false,
        position,
        rotation: None,
        scale,
        color,
        intensity,
    };
    vec![
        p([-4.4, 0.2, -1.4], [0.6, 6.5], i),
        p([4.4, 0.2, -1.4], [0.6, 6.5], i),
        p([0.0, 3.8, -1.2], [8.0, 0.5], i * 0.8),
        p([-4.6, 1.2, 2.6], [0.35, 5.5], i * 0.25),
        p([4.6, -0.6, 2.6], [0.35, 5.5], i * 0.25),
    ]
}

fn panels(look: Option<&Look>, full: bool) -> Vec<Panel> {
    let rims = look.map(rim_panels).unwrap_or_default();
    panel_list(STUDIO.iter().chain(rims.iter()).filter(|l| full || !l.full_only), look)
}

/// A lighting preset's rim panels alone (`rimLightformers(look)` built without the look), for a graded
/// HDRI (`marketing/grade.ts`).
pub(crate) fn rims(look: &Look) -> Vec<Panel> {
    panel_list(rim_panels(look).iter(), None)
}

fn panel_list<'a>(list: impl Iterator<Item = &'a Lightformer>, look: Option<&Look>) -> Vec<Panel> {
    list.map(|l| {
        let p = Vec3::new(l.position[0] as f32, l.position[1] as f32, l.position[2] as f32);
        let r = match l.rotation {
            // Euler XYZ: R = Rx · Ry · Rz.
            Some([x, y, z]) => Mat3::from_rotation_x(x as f32) * Mat3::from_rotation_y(y as f32) * Mat3::from_rotation_z(z as f32),
            // Object3D.lookAt(origin) for a mesh: +z towards the target, world up +y.
            None => {
                let z = (-p).normalize();
                let x = Vec3::Y.cross(z).normalize();
                Mat3::from_cols(x, z.cross(x), z)
            }
        };
        let ex = r * Vec3::X * l.scale[0] as f32;
        let ey = r * Vec3::Y * l.scale[1] as f32;
        let mut c = crate::material::srgb_hex_to_linear(l.color);
        let mut k = l.intensity as f32;
        if let Some(look) = look.filter(|_| l.role != Role::Flag) {
            // `buildLightformer`: scale and tint the panel by its role.
            let (scale, tint) = match l.role {
                Role::Key => (look.key, look.key_tint),
                Role::Fill => (look.fill, look.fill_tint),
                _ => (look.base, look.fill_tint),
            };
            k *= scale.unwrap_or(1.0) as f32;
            if let Some(t) = tint {
                let t = crate::material::srgb_hex_to_linear(t);
                c = [c[0] * t[0], c[1] * t[1], c[2] * t[2]];
            }
        }
        Panel {
            center: [p.x, p.y, p.z, if l.ring { 1.0 } else { 0.0 }],
            axis_x: [ex.x, ex.y, ex.z, 0.0],
            axis_y: [ey.x, ey.y, ey.z, 0.0],
            radiance: [c[0] * k, c[1] * k, c[2] * k, 1.0],
        }
    })
    .collect()
}

/// The lod planes of `_createPlanes(lodMax)` (11 for a 256 cube): sizes, sigmas and quad vertices (GL
/// clip space).
fn lod_planes(size: EnvSize) -> (Vec<i32>, Vec<f64>, Vec<Vec<PlaneVertex>>) {
    let lod_max = size.lod_max();
    let total = (lod_max - LOD_MIN + 1) as usize + EXTRA_LOD_SIGMA.len();
    let (mut sizes, mut sigmas, mut planes) = (vec![], vec![], vec![]);
    let mut lod = lod_max;
    for i in 0..total {
        let size = 1i32 << lod;
        sizes.push(size);
        let sigma = if i > (lod_max - LOD_MIN) as usize {
            EXTRA_LOD_SIGMA[i - (lod_max - LOD_MIN) as usize - 1]
        } else if i == 0 {
            0.0
        } else {
            1.0 / size as f64
        };
        sigmas.push(sigma);
        let texel = 1.0 / (size as f32 - 2.0);
        let (lo, hi) = (-texel, 1.0 + texel);
        let uv1 = [[lo, lo], [hi, lo], [hi, hi], [lo, lo], [hi, hi], [lo, hi]];
        let mut verts = vec![];
        for face in 0..6 {
            let x = (face % 3) as f32 * 2.0 / 3.0 - 1.0;
            let y = if face > 2 { 0.0 } else { -1.0 };
            let pos = [[x, y], [x + 2.0 / 3.0, y], [x + 2.0 / 3.0, y + 1.0], [x, y], [x + 2.0 / 3.0, y + 1.0], [x, y + 1.0]];
            for k in 0..6 {
                verts.push(PlaneVertex { position: pos[k], uv: uv1[k], face: face as f32 });
            }
        }
        planes.push(verts);
        if lod > LOD_MIN {
            lod -= 1;
        }
    }
    (sizes, sigmas, planes)
}

const AXES: [[f32; 3]; 10] = {
    const PHI: f32 = std::f32::consts::GOLDEN_RATIO;
    const INV: f32 = 1.0 / PHI;
    [
        [-PHI, INV, 0.0],
        [PHI, INV, 0.0],
        [-INV, 0.0, PHI],
        [INV, 0.0, PHI],
        [0.0, PHI, -INV],
        [0.0, PHI, INV],
        [-1.0, 1.0, -1.0],
        [1.0, 1.0, -1.0],
        [-1.0, 1.0, 1.0],
        [1.0, 1.0, 1.0],
    ]
};

fn blur_uniform(size: EnvSize, sizes: &[i32], lod_in: usize, sigma: f64, latitudinal: bool, pole: [f32; 3]) -> BlurUniform {
    let pixels = (sizes[lod_in] - 1) as f64;
    let rad_per_px = std::f64::consts::PI / (2.0 * pixels);
    let sigma_px = sigma / rad_per_px;
    let samples = 1 + (3.0 * sigma_px).floor() as i32;
    let w: [f64; MAX_SAMPLES] = std::array::from_fn(|i| {
        let x = i as f64 / sigma_px;
        (-x * x / 2.0).exp()
    });
    // The centre tap once, every other tap below `samples` twice (±θ).
    let sum = w[0] + w[1..samples.clamp(1, MAX_SAMPLES as i32) as usize].iter().map(|v| 2.0 * v).sum::<f64>();
    let weights = w.map(|v| (v / sum) as f32);
    BlurUniform {
        weights,
        pole_axis: [pole[0], pole[1], pole[2], 0.0],
        samples,
        latitudinal: latitudinal as u32,
        d_theta: rad_per_px as f32,
        mip_int: (size.lod_max() - lod_in as i32) as f32,
    }
}

/// Builds the prefiltered environment. Returns the CUBEUV atlas (768 × 1024 for a 256 cube, rgba16float).
/// `quality` sets the resolution and drops the `full`-only panels on the performance tier. `clear`
/// (linear rgb): the cube's clear colour, which empty directions show (`StudioEnvironment.setClearColor`:
/// a glass card's backdrop); `None` is transparent black, as every metal card sees.
pub fn build_environment(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    look: Option<&Look>,
    quality: crate::quality::Quality,
    clear: Option<[f32; 3]>,
) -> wgpu::Texture {
    let clear = clear.map_or([0.0; 4], |c| [c[0], c[1], c[2], 1.0]);
    let size = EnvSize::new(quality.preset().environment_resolution);
    let cube_size = size.cube;
    let cube = cube_texture(device, cube_size, "studio cube");
    let mut encoder = device.create_command_encoder(&Default::default());

    // 1. Panels → cube faces.
    let cube_module =
        device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("env cube"), source: wgpu::ShaderSource::Wgsl(wgsl!("env.wgsl").into()) });
    let cube_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("env cube"),
        layout: None,
        vertex: wgpu::VertexState { module: &cube_module, entry_point: Some("vs_full"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState {
            module: &cube_module,
            entry_point: Some("fs_cube"),
            targets: &[Some(wgpu::ColorTargetState { format: ATLAS_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    let list = panels(look, quality == crate::quality::Quality::Full);
    for face in 0..6u32 {
        let mut u = Panels { count: [list.len() as u32, 0, 0, 0], face: [face, cube_size, 0, 0], clear, items: [bytemuck::Zeroable::zeroed(); 16] };
        u.items[..list.len()].copy_from_slice(&list);
        let buf =
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::bytes_of(&u), usage: wgpu::BufferUsages::UNIFORM });
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &cube_pipeline.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() }],
        });
        let view = cube_face(&cube, face);
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("env face"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&cube_pipeline);
        pass.set_bind_group(0, &bg, &[]);
        pass.draw(0..3, 0..1);
    }
    queue.submit([encoder.finish()]);
    prefilter_cube(device, queue, size, &cube)
}

/// A cube render target (`WebGLCubeRenderTarget`, half floats) of `size`.
pub(crate) fn cube_texture(device: &wgpu::Device, size: u32, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 6 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: ATLAS_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

/// One face of a cube texture, to render into.
pub(crate) fn cube_face(cube: &wgpu::Texture, face: u32) -> wgpu::TextureView {
    cube.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2),
        base_array_layer: face,
        array_layer_count: Some(1),
        ..Default::default()
    })
}

/// The top level of the atlas being made: `base` draws it (`_textureToCubeUV`) with the lod plane's
/// vertices (`vs_plane` of shaders/plane.wgsl) into `rect`.
pub struct AtlasBase<'a> {
    pub encoder: &'a mut wgpu::CommandEncoder,
    pub atlas: &'a wgpu::TextureView,
    pub plane: &'a wgpu::Buffer,
    pub rect: [f32; 4],
}

/// The lod planes' vertex layout (position, uv, face).
pub fn plane_layout() -> wgpu::VertexBufferLayout<'static> {
    const ATTRIBUTES: [wgpu::VertexAttribute; 3] = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32];
    wgpu::VertexBufferLayout { array_stride: size_of::<PlaneVertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &ATTRIBUTES }
}

/// Draws one lod plane (36 vertices) into `rect` of `view` with `pipeline` and `bind`.
pub fn plane_pass(
    encoder: &mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    rect: [f32; 4],
    pipeline: &wgpu::RenderPipeline,
    bind: &wgpu::BindGroup,
    plane: &wgpu::Buffer,
) {
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: None,
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            resolve_target: None,
            depth_slice: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
        })],
        ..Default::default()
    });
    pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
    pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bind, &[]);
    pass.set_vertex_buffer(0, plane.slice(..));
    pass.draw(0..36, 0..1);
}

/// A pipeline drawing the lod planes into the atlas with `module`'s `vs_plane` and fragment `fs`.
pub fn plane_pipeline(device: &wgpu::Device, module: &wgpu::ShaderModule, fs: &str) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(fs),
        layout: None,
        vertex: wgpu::VertexState { module, entry_point: Some("vs_plane"), buffers: &[Some(plane_layout())], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(fs),
            targets: &[Some(wgpu::ColorTargetState { format: ATLAS_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    })
}

/// `PMREMGenerator.fromCubemap`: the cube (`size` faces) into a prefiltered CUBEUV atlas.
pub fn prefilter_cube(device: &wgpu::Device, queue: &wgpu::Queue, size: EnvSize, cube: &wgpu::Texture) -> wgpu::Texture {
    let cube_view = cube.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::Cube), ..Default::default() });
    prefilter(device, queue, size, &mut |base: AtlasBase<'_>| {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("pmrem base"),
            source: wgpu::ShaderSource::Wgsl(format!("{}\n{}", wgsl!("plane.wgsl"), wgsl!("pmrem-base.wgsl")).into()),
        });
        let pipeline = plane_pipeline(device, &module, "fs_base");
        let linear = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&cube_view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&linear) },
            ],
        });
        plane_pass(base.encoder, base.atlas, base.rect, &pipeline, &bind, base.plane);
    })
}

/// three's PMREM (`_applyPMREM` after `_textureToCubeUV`): `base` draws the atlas's top level, then
/// the levels below are blurred from it. Returns the atlas.
pub fn prefilter(device: &wgpu::Device, queue: &wgpu::Queue, size: EnvSize, base: &mut dyn FnMut(AtlasBase<'_>)) -> wgpu::Texture {
    let (cube_size, atlas_w, atlas_h, lod_max) = (size.cube, size.atlas_w(), size.atlas_h(), size.lod_max());
    let atlas_desc = |label| wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: atlas_w, height: atlas_h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: ATLAS_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    };
    let atlas = device.create_texture(&atlas_desc("pmrem atlas"));
    let ping = device.create_texture(&atlas_desc("pmrem ping-pong"));
    let atlas_view = atlas.create_view(&Default::default());
    let ping_view = ping.create_view(&Default::default());
    let linear =
        device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
    let mut encoder = device.create_command_encoder(&Default::default());

    // 2–3. PMREM.
    let common = wgsl!("plane.wgsl");
    let blur_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("pmrem blur"),
        source: wgpu::ShaderSource::Wgsl(format!("{}\n{common}\n{}", size.cubeuv_prelude() + wgsl!("cubeuv.wgsl"), wgsl!("pmrem-blur.wgsl")).into()),
    });
    let blur_pipeline = plane_pipeline(device, &blur_module, "fs_blur");
    let (sizes, sigmas, planes) = lod_planes(size);
    let plane_bufs: Vec<wgpu::Buffer> = planes
        .iter()
        .map(|v| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(v), usage: wgpu::BufferUsages::VERTEX })
        })
        .collect();

    let s = cube_size as f32;
    base(AtlasBase { encoder: &mut encoder, atlas: &atlas_view, plane: &plane_bufs[0], rect: [0.0, 0.0, 3.0 * s, 2.0 * s] });

    let n = planes.len();
    let viewport = |lod_out: usize| {
        let out = sizes[lod_out];
        let x = 3 * out * if lod_out as i32 > lod_max - LOD_MIN { lod_out as i32 - lod_max + LOD_MIN } else { 0 };
        let y = 4 * (cube_size as i32 - out);
        [x as f32, y as f32, (3 * out) as f32, (2 * out) as f32]
    };
    for i in 1..n {
        let sigma = (sigmas[i] * sigmas[i] - sigmas[i - 1] * sigmas[i - 1]).sqrt();
        let pole = AXES[(n - i - 1) % AXES.len()];
        for (latitudinal, lod_in, src, dst) in [(true, i - 1, &atlas_view, &ping_view), (false, i, &ping_view, &atlas_view)] {
            let u = blur_uniform(size, &sizes, lod_in, sigma, latitudinal, pole);
            let buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::bytes_of(&u),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &blur_pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(src) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&linear) },
                    wgpu::BindGroupEntry { binding: 2, resource: buf.as_entire_binding() },
                ],
            });
            plane_pass(&mut encoder, dst, viewport(i), &blur_pipeline, &bg, &plane_bufs[i]);
        }
    }
    queue.submit([encoder.finish()]);
    atlas
}
