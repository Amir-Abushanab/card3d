//! The mesh renderer: meshes with a subset of three's `MeshPhysicalMaterial` (shaders/card.wgsl),
//! drawn the way three's WebGLRenderer draws them for the card: the studio lights and environment,
//! ACES filmic tone mapping at exposure 0.9, sRGB output, 4× MSAA, opaque meshes by render order then
//! transparent ones by render order and depth (`scene/renderer.ts`, `scene/lights.ts`, `scene/camera.ts`).

use glam::{Mat3, Mat4, Vec3};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use wgpu::util::DeviceExt;

use crate::env;
use crate::geometry::Mesh;

const FOV_DEG: f32 = 34.0;
const CAMERA_Z: f32 = 5.35;
const EXPOSURE: f32 = 0.9;
const KEY_LIGHT: [f32; 3] = [-4.0, 5.0, 7.0];
pub const KEY_INTENSITY: f32 = 0.34;
const AMBIENT_INTENSITY: f32 = 0.36;
/// The mesh vertex buffer: position, normal, uv.
pub const VERTEX_LAYOUT: &[Option<wgpu::VertexBufferLayout<'static>>] = &[Some(wgpu::VertexBufferLayout {
    array_stride: size_of::<Vertex>() as u64,
    step_mode: wgpu::VertexStepMode::Vertex,
    attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2],
})];

/// The canvas's multisampling (three's `antialias: true`).
pub const MSAA: u32 = 4;

/// The stage's camera (fov 34°, near 0.1, far 30): its world position and view matrix (world →
/// camera; three's `matrixWorldInverse`), in f64 as three computes them. The studio camera sits on +z
/// looking at the origin ([`Camera::axis`]); a staged scene or a camera orbit moves it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub eye: glam::DVec3,
    pub view: glam::DMat4,
    /// The orbit's azimuth (radians): a staging backdrop turns with it.
    pub azimuth: f64,
}

/// A camera's world matrix looking from `eye` at `target` (three's `Matrix4.lookAt`: z = eye − target,
/// x = up × z, y = z × x, with its fixes for degenerate inputs), placed at `eye`.
pub fn look_at_matrix(eye: glam::DVec3, target: glam::DVec3, up: glam::DVec3) -> glam::DMat4 {
    let mut z = eye - target;
    if z.length_squared() == 0.0 {
        z.z = 1.0;
    }
    z = z.normalize();
    let mut x = up.cross(z);
    if x.length_squared() == 0.0 {
        if up.z.abs() == 1.0 {
            z.x += 0.0001;
        } else {
            z.z += 0.0001;
        }
        z = z.normalize();
        x = up.cross(z);
    }
    let x = x.normalize();
    let y = z.cross(x);
    glam::DMat4::from_cols(x.extend(0.0), y.extend(0.0), z.extend(0.0), eye.extend(1.0))
}

/// The inverse of a rotation and translation: the transposed rotation, the translation turned back.
pub fn rigid_inverse(m: glam::DMat4) -> glam::DMat4 {
    let r = glam::DMat3::from_mat4(m).transpose();
    let t = -(r * m.w_axis.truncate());
    glam::DMat4::from_cols(r.x_axis.extend(0.0), r.y_axis.extend(0.0), r.z_axis.extend(0.0), t.extend(1.0))
}

impl Camera {
    /// On +z at `z`, looking at the origin.
    pub fn axis(z: f64) -> Camera {
        Camera { eye: glam::DVec3::new(0.0, 0.0, z), view: glam::DMat4::from_translation(glam::DVec3::new(0.0, 0.0, -z)), azimuth: 0.0 }
    }
    /// At `eye`, looking at `target` with world up +y (`camera.lookAt`).
    pub fn look_at(eye: glam::DVec3, target: glam::DVec3, azimuth: f64) -> Camera {
        Camera { eye, view: rigid_inverse(look_at_matrix(eye, target, glam::DVec3::Y)), azimuth }
    }
    /// The eye in f32.
    pub fn eye32(&self) -> Vec3 {
        self.eye.as_vec3()
    }
    /// The view matrix in f32 (as uploaded).
    pub fn view32(&self) -> Mat4 {
        self.view.as_mat4()
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Vertex {
    position: [f32; 3],
    normal: [f32; 3],
    uv: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct FrameUniform {
    pub(crate) view: [[f32; 4]; 4],
    pub(crate) proj: [[f32; 4]; 4],
    pub(crate) light_dir: [f32; 4],
    pub(crate) light_color: [f32; 4],
    pub(crate) ambient: [f32; 4],
    pub(crate) misc: [f32; 4], // exposure, linear output, point light count
    pub(crate) env: [f32; 4],  // environment intensity, rotation about y (radians)
    /// Per point light (up to four): view-space position and distance, colour × intensity and decay.
    pub(crate) points: [[f32; 4]; 8],
    /// A second directional light (the marquee's frontal fill): view-space direction, linear colour ×
    /// intensity (w = 1 when on).
    pub(crate) fill_dir: [f32; 4],
    pub(crate) fill_color: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct HoloFrameUniform {
    view: [[f32; 4]; 4],
    proj: [[f32; 4]; 4],
    camera: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct HoloUniform {
    model: [[f32; 4]; 4],
    params: [f32; 4],
    params2: [f32; 4],
    params3: [f32; 4],
    light: [f32; 4],
}

/// The stage's lights and exposure (`scene/lights.ts`, a lighting preset's values).
#[derive(Clone, Copy, Debug)]
pub struct Lighting {
    pub exposure: f32,
    /// `scene.environmentIntensity` (three lights every card material from `scene.environment` at
    /// this intensity: a material's own envMapIntensity only scales a material envMap, and the
    /// engine sets none) and `environmentRotation.y`.
    pub env_intensity: f32,
    pub env_rotation_y: f32,
    /// Linear colour × intensity.
    pub ambient: [f32; 3],
    pub key: [f32; 3],
    /// Key light position (target: the origin), world space.
    pub key_position: [f32; 3],
    /// A second directional light (the marquee's frontal fill; black: none) and its position.
    pub fill: [f32; 3],
    pub fill_position: [f32; 3],
}

impl Default for Lighting {
    fn default() -> Self {
        Lighting {
            exposure: EXPOSURE,
            env_intensity: 1.0,
            env_rotation_y: 0.0,
            ambient: [AMBIENT_INTENSITY; 3],
            key: [KEY_INTENSITY; 3],
            key_position: KEY_LIGHT,
            fill: [0.0; 3],
            fill_position: [0.0, 0.0, 1.0],
        }
    }
}

/// A sticker's colour look (`applyDecalLook`): tint (rgb 0..1, amount) and brightness / contrast /
/// saturation, applied in display space after the map.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DecalLook {
    pub tint: [f32; 4],
    pub adjust: [f32; 3],
}

/// A holo foil draw (`holo/`): one side's values, and whether it is the bevel foil (with its side).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HoloDraw {
    pub values: crate::holo::HoloValues,
    pub edge_only: bool,
    pub edge_side: f32,
    /// The front's foil, else the back's (`CardRenderer::retune` sets each side's values).
    pub front: bool,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct MaterialUniform {
    model_view: [[f32; 4]; 4],
    normal_matrix: [[f32; 4]; 4],
    color: [f32; 4],    // linear rgb, opacity
    pbr: [f32; 4],      // metalness, roughness, clearcoat, clearcoatRoughness
    aniso: [f32; 4],    // anisotropy, anisotropyRotation, alphaTest, bumpScale
    irid: [f32; 4],     // iridescence, iridescenceIOR, thickness (nm), 0
    maps: [f32; 4],     // normalScale.xy, surface repeat.xy
    flags: [f32; 4],    // map, normal map, roughness map, bump map
    flags2: [f32; 4],   // transparent, luminance after map, unlit tone mapped, unlit
    emissive: [f32; 4], // linear rgb, 0
    map_uv: [f32; 4],   // map offset.xy, repeat.xy
    look_tint: [f32; 4],
    look_adjust: [f32; 4],     // brightness, contrast, saturation, has look
    pub(crate) spec: [f32; 4], // specularIntensity, side (0 front, 1 double, 2 back), 0, 0
}

/// A texture the renderer owns (`TextureId` indexes them).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TextureId(pub(crate) usize);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MeshId(pub(crate) usize);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Wrap {
    Repeat,
    Clamp,
}

/// Which polygons face away and are culled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Front,
    Double,
    /// three's BackSide (the glass's backside pass): back faces only, normals flipped.
    Back,
}

/// The glass body's transmission (`MeshTransmissionMaterial`, scene/transmission-material.ts, with the
/// parameters `createGlassMaterial` sets). Its item is drawn with the glass shader (`fs_glass`), over
/// two private buffers the renderer fills first (`renderTransmissionPasses`).
#[derive(Clone, Copy, Debug)]
pub struct GlassParams {
    pub samples: u32,
    /// Buffer size × the drawing buffer's (`bufferScale`).
    pub buffer_scale: f32,
    pub thickness: f32,
    pub backside_thickness: f32,
    pub ior: f32,
    pub chromatic_aberration: f32,
    pub anisotropic_blur: f32,
    pub smear: f32,
    pub distortion: f32,
    pub distortion_scale: f32,
    pub temporal_distortion: f32,
    /// `_transmission`.
    pub transmission: f32,
    /// Behind the glass in the buffer passes (`background`): sRGB 0..1.
    pub background: [f32; 3],
    /// `addGlassEdges`: absorption exponent and extra specular on the walls and bevels.
    pub edge_absorption: f32,
    pub edge_specular: f32,
}

/// The material subset the card uses (`MeshPhysicalMaterial` parameters, three's names).
#[derive(Clone, Debug)]
pub struct Material {
    /// Linear RGB.
    pub color: [f32; 3],
    pub opacity: f32,
    pub metalness: f32,
    pub roughness: f32,
    pub clearcoat: f32,
    pub clearcoat_roughness: f32,
    pub anisotropy: f32,
    pub anisotropy_rotation: f32,
    pub iridescence: f32,
    pub iridescence_ior: f32,
    /// `iridescenceThicknessRange[1]` (no thickness map: three uses the maximum).
    pub iridescence_thickness: f32,
    /// sRGB colour map (`map`), sampled at the mesh UVs.
    pub map: Option<TextureId>,
    /// Tangent-space normal map and roughness map, sampled at UV × `surface_repeat`.
    pub normal_map: Option<TextureId>,
    pub roughness_map: Option<TextureId>,
    pub normal_scale: [f32; 2],
    pub surface_repeat: [f32; 2],
    /// Linear height map (red channel) and `bumpScale`.
    pub bump_map: Option<TextureId>,
    pub bump_scale: f32,
    pub alpha_test: f32,
    pub transparent: bool,
    pub depth_test: bool,
    pub depth_write: bool,
    /// `polygonOffsetFactor`, `polygonOffsetUnits`.
    pub polygon_offset: Option<(f32, f32)>,
    pub side: Side,
    /// Replace the diffuse colour by its Rec. 709 luminance after the map (the chip's contacts).
    pub luminance_after_map: bool,
    /// Linear RGB radiance added to the outgoing light (three's `emissive`).
    pub emissive: [f32; 3],
    /// The colour map's texture transform: uv' = offset + uv · repeat (stickers' crop and flip).
    pub map_offset: [f32; 2],
    pub map_repeat: [f32; 2],
    /// Unlit and not tone mapped (`MeshBasicMaterial` with `toneMapped: false`): printed artwork.
    pub unlit: bool,
    /// With `unlit`: tone mapped all the same (`MeshBasicMaterial`'s default `toneMapped: true`).
    pub unlit_tone_mapped: bool,
    /// A sticker's colour look.
    pub look: Option<DecalLook>,
    /// false: depth only (the chip's sticker mask).
    pub color_write: bool,
    /// `specularIntensity` (three's default 1).
    pub specular_intensity: f32,
    /// The face a layer belongs to (`CARD_FACE_KEY`: 1 front, −1 back, 0 inside the body): the glass's
    /// buffer passes leave out what lies on the camera's side, and the backside pass what is inside.
    pub face: Option<i8>,
    pub glass: Option<GlassParams>,
}

impl Default for Material {
    fn default() -> Self {
        Material {
            color: [1.0; 3],
            opacity: 1.0,
            metalness: 0.0,
            roughness: 1.0,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            anisotropy: 0.0,
            anisotropy_rotation: 0.0,
            iridescence: 0.0,
            iridescence_ior: 1.3,
            iridescence_thickness: 400.0,
            map: None,
            normal_map: None,
            roughness_map: None,
            normal_scale: [1.0, 1.0],
            surface_repeat: [1.0, 1.0],
            bump_map: None,
            bump_scale: 1.0,
            alpha_test: 0.0,
            transparent: false,
            depth_test: true,
            depth_write: true,
            polygon_offset: None,
            side: Side::Front,
            luminance_after_map: false,
            map_offset: [0.0, 0.0],
            map_repeat: [1.0, 1.0],
            unlit: false,
            unlit_tone_mapped: false,
            look: None,
            color_write: true,
            emissive: [0.0; 3],
            specular_intensity: 1.0,
            face: None,
            glass: None,
        }
    }
}

/// Render state a pipeline is built for.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct PipelineKey {
    /// The holo foil's pipeline (its own shader, additive blending).
    holo: bool,
    color_write: bool,
    transparent: bool,
    depth_test: bool,
    depth_write: bool,
    /// Polygon offset (factor, units) as bits.
    offset: Option<(u32, u32)>,
    side: Side,
    /// The glass body's shader (`vs_glass` / `fs_glass`, bind group 2).
    glass: bool,
    /// Drawn into a glass buffer (rgba16float, no MSAA) instead of the canvas.
    buffer: bool,
}

pub(crate) struct GpuMesh {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    count: u32,
    /// Bounding-box centre, for sorting transparent meshes.
    centre: Vec3,
    /// Bounding box (min, max).
    pub(crate) bounds: (Vec3, Vec3),
}

pub(crate) struct Texture {
    pub(crate) texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    pub(crate) wrap: Wrap,
    /// Sampler anisotropy (three's `texture.anisotropy`; 1 = none).
    pub(crate) anisotropy: u16,
}

/// One mesh in the scene: geometry, material, transform within the card, render order.
pub struct Item {
    pub mesh: MeshId,
    pub material: Material,
    pub transform: Mat4,
    /// three's `renderOrder` (fractional: face-shader overlays sit at 8.5 + 0.001·k).
    pub render_order: f32,
    pub visible: bool,
}

pub(crate) struct GpuItem {
    /// Bound at the item's slot of the renderer's uniform buffer (`Renderer::uniforms`).
    bind_group: wgpu::BindGroup,
    pub(crate) uniform: MaterialUniform,
    key: PipelineKey,
}

/// The holo foil's own shader, layouts and frame uniform.
struct HoloGpu {
    shader: wgpu::ShaderModule,
    layout: wgpu::PipelineLayout,
    draw_layout: wgpu::BindGroupLayout,
    frame_buffer: wgpu::Buffer,
    frame_bind_group: wgpu::BindGroup,
    pipelines: HashMap<PipelineKey, wgpu::RenderPipeline>,
}

/// What renderers drawing into one frame share (the marquee's cards): the card shader for one
/// environment size, its layouts and pipelines (each built once for every card), and a sampler.
pub struct Core {
    format: wgpu::TextureFormat,
    shader: wgpu::ShaderModule,
    layout: wgpu::PipelineLayout,
    pub(crate) frame_layout: wgpu::BindGroupLayout,
    pub(crate) draw_layout: wgpu::BindGroupLayout,
    /// The glass body's bind group 2 layout and pipeline layout, made by the `glass` chunk.
    pub(crate) glass: std::cell::OnceCell<(wgpu::BindGroupLayout, wgpu::PipelineLayout)>,
    linear: wgpu::Sampler,
    env_size: env::EnvSize,
    pipelines: RefCell<HashMap<PipelineKey, wgpu::RenderPipeline>>,
}

impl Core {
    fn new(device: &wgpu::Device, format: wgpu::TextureFormat, env_size: env::EnvSize) -> Core {
        let shader =
            device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("card"), source: wgpu::ShaderSource::Wgsl(card_source(env_size).into()) });
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("frame"),
            entries: &[uniform_entry(0), texture_entry(1), sampler_entry(2)],
        });
        let draw_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("draw"),
            entries: &[slot_entry(0), texture_entry(1), texture_entry(2), texture_entry(3), texture_entry(4), sampler_entry(5), sampler_entry(6)],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&frame_layout), Some(&draw_layout)],
            immediate_size: 0,
        });
        let linear = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Core { format, shader, layout, draw_layout, frame_layout, glass: Default::default(), linear, env_size, pipelines: RefCell::new(HashMap::new()) }
    }
}

/// An environment and the core built for it, for several renderers (`Environment::Shared`): the
/// marquee's cards light from one environment and share their pipelines.
#[derive(Clone)]
pub struct Shared {
    core: Rc<Core>,
    atlas: wgpu::Texture,
}

impl Shared {
    /// The studio environment with a lighting preset's `look` at a quality tier.
    pub fn studio(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        look: Option<&env::Look>,
        quality: crate::quality::Quality,
    ) -> Shared {
        let env_size = env::EnvSize::new(quality.preset().environment_resolution);
        Shared { core: core(device, format, env_size), atlas: env::build_environment(device, queue, look, quality, None) }
    }

    /// The same core with another environment of the same size (a lighting preset's).
    pub fn with_atlas(&self, atlas: wgpu::Texture) -> Shared {
        Shared { core: self.core.clone(), atlas }
    }

    pub fn atlas(&self) -> &wgpu::Texture {
        &self.atlas
    }
}

/// A finished branding mark's glyph raster, for production exports (`Renderer::glyphs`).
pub struct Glyph {
    pub item: usize,
    pub width: u32,
    pub height: u32,
    /// Alpha, rows top first.
    pub alpha: Vec<u8>,
    /// The padding of its plane around the raster, as a fraction of the raster's size, each side.
    pub pad: [f32; 2],
}

/// A core made on a device (its address) for a canvas format and an environment size (`CORES`).
type MadeCore = (usize, wgpu::TextureFormat, env::EnvSize, std::rc::Weak<Core>);

thread_local! {
    /// Cores recently made: the next card on a device (a stage swapping designs; the exports' and
    /// thumbnails' stages go through many) reuses the core while a card still uses it, so the card
    /// shader's pipelines compile once. Devices are told apart by address, not `==`: wgpu-core's
    /// devices compare by id, which every instance (each stage on the web's WebGL build) numbers from
    /// the start. A device outlives the cards made on it, so a live core's device is still there.
    static CORES: RefCell<Vec<MadeCore>> = const { RefCell::new(Vec::new()) };
}

/// Whether a card made on `device` still uses a core (`CORES`): what's cached for the device is its own.
pub fn device_in_use(device: &wgpu::Device) -> bool {
    let at = std::ptr::from_ref::<wgpu::Device>(device) as usize;
    CORES.with_borrow(|cores| cores.iter().any(|e| e.0 == at && e.3.strong_count() > 0))
}

/// A core for `format` and `size` on `device` (`CORES`).
fn core(device: &wgpu::Device, format: wgpu::TextureFormat, size: env::EnvSize) -> Rc<Core> {
    let at = std::ptr::from_ref::<wgpu::Device>(device) as usize;
    CORES.with_borrow_mut(|cores| {
        cores.retain(|e| e.3.strong_count() > 0);
        if let Some(core) = cores.iter().find(|e| e.0 == at && e.1 == format && e.2 == size).and_then(|e| e.3.upgrade()) {
            return core;
        }
        let core = Rc::new(Core::new(device, format, size));
        cores.push((at, format, size, Rc::downgrade(&core)));
        core
    })
}

/// A value `memo` made: its kind, its key, the value.
type Made = (&'static str, u64, Rc<dyn std::any::Any>);

/// A studio environment's inputs (`Environment::Studio`).
type StudioKey = (Option<env::Look>, crate::quality::Quality, Option<[f32; 3]>);

/// What the cards made on a device keep for the next card made on it: a stage builds the next card
/// while the last is still shown (Card Studio builds one on every panel change), and finds the maps
/// (`MapCache`) and the studio environments it needs made. It lives while a card made on the device
/// does (`DEVICE_CACHES`).
#[derive(Default)]
pub(crate) struct DeviceCache {
    maps: Rc<crate::card::MapCache>,
    /// The last two studio environments made, the latest last.
    studio: RefCell<Vec<(StudioKey, wgpu::Texture)>>,
    /// What `memo` made, by kind and key, the latest used last.
    made: RefCell<Vec<Made>>,
}

thread_local! {
    /// Each device's cache (by address, as `CORES`), while a card made on it lives.
    static DEVICE_CACHES: RefCell<Vec<(usize, std::rc::Weak<DeviceCache>)>> = const { RefCell::new(Vec::new()) };
}

/// The cache of `device` (`DEVICE_CACHES`).
fn device_cache(device: &wgpu::Device) -> Rc<DeviceCache> {
    let at = std::ptr::from_ref::<wgpu::Device>(device) as usize;
    DEVICE_CACHES.with_borrow_mut(|caches| {
        caches.retain(|e| e.1.strong_count() > 0);
        if let Some(cache) = caches.iter().find(|e| e.0 == at).and_then(|e| e.1.upgrade()) {
            return cache;
        }
        let cache = Rc::new(DeviceCache::default());
        caches.push((at, Rc::downgrade(&cache)));
        cache
    })
}

impl DeviceCache {
    /// The studio environment for `key`, made once (each compiles its shaders, renders a cube and
    /// prefilters it).
    fn studio(&self, device: &wgpu::Device, queue: &wgpu::Queue, key: StudioKey) -> wgpu::Texture {
        let mut made = self.studio.borrow_mut();
        let atlas = match made.iter().position(|e| e.0 == key) {
            Some(i) => made.remove(i).1,
            None => env::build_environment(device, queue, key.0.as_ref(), key.1, key.2),
        };
        made.push((key, atlas.clone()));
        if made.len() > 2 {
            made.remove(0);
        }
        atlas
    }

    fn get(&self, kind: &'static str, key: u64) -> Option<Rc<dyn std::any::Any>> {
        let mut made = self.made.borrow_mut();
        let i = made.iter().position(|e| e.0 == kind && e.1 == key)?;
        let e = made.remove(i);
        let value = e.2.clone();
        made.push(e);
        Some(value)
    }

    fn put(&self, kind: &'static str, keep: usize, key: u64, value: Rc<dyn std::any::Any>) {
        let mut made = self.made.borrow_mut();
        made.retain(|e| e.0 != kind || e.1 != key);
        made.push((kind, key, value));
        if made.iter().filter(|e| e.0 == kind).count() > keep {
            let oldest = made.iter().position(|e| e.0 == kind).unwrap();
            made.remove(oldest);
        }
    }
}

/// A `memo` key: the hash of what a value is made from (GPU objects hash by identity).
pub(crate) fn key_of(of: impl std::hash::Hash) -> u64 {
    use std::hash::Hasher;
    let mut h = std::hash::DefaultHasher::new();
    of.hash(&mut h);
    h.finish()
}

/// What `make` makes from `key` (`key_of` its inputs) on `device`, made once while a card made on the
/// device lives (`DeviceCache`; the next card is built while the last is shown): shader modules and
/// pipelines (compiled once instead of per card; WebGL links its programs per module), and what
/// effects draw from fixed inputs. The `keep` latest used of a `kind` stay. A value holding GPU objects
/// its key hashes by identity keeps them too, so their identities aren't reused while it's kept.
pub(crate) fn memo<T: 'static>(device: &wgpu::Device, kind: &'static str, keep: usize, key: u64, make: impl FnOnce() -> T) -> Rc<T> {
    if let Some(v) = cached(device, kind, key) {
        return v;
    }
    let v = Rc::new(make());
    remember(device, kind, keep, key, v.clone());
    v
}

/// `memo`'s value for `key`, if it has one.
pub(crate) fn cached<T: 'static>(device: &wgpu::Device, kind: &'static str, key: u64) -> Option<Rc<T>> {
    device_cache(device).get(kind, key).and_then(|v| v.downcast::<T>().ok())
}

/// Keeps `value` as `memo`'s for `key` (made apart: a custom shader is kept once it compiled).
pub(crate) fn remember<T: 'static>(device: &wgpu::Device, kind: &'static str, keep: usize, key: u64, value: Rc<T>) {
    device_cache(device).put(kind, keep, key, value);
}

/// The canvas's multisampled colour and depth for a frame several renderers draw
/// (`Renderer::render_layers`), with the frame's projection.
pub struct Layers {
    pub width: u32,
    pub height: u32,
    msaa: wgpu::TextureView,
    depth: wgpu::TextureView,
    /// The projection (fov 34°, the given aspect and far plane; wgpu's depth range).
    pub proj: Mat4,
}

impl Layers {
    /// `aspect`: the camera's (the canvas's CSS aspect, as three's camera has it); `far`: its far plane.
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, width: u32, height: u32, aspect: f32, far: f32) -> Layers {
        let make = |format, label| {
            device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some(label),
                    size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: MSAA,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                    view_formats: &[],
                })
                .create_view(&Default::default())
        };
        let proj = glam::camera::rh::proj::directx::perspective(FOV_DEG.to_radians(), aspect, 0.1, far);
        Layers { width, height, msaa: make(format, "msaa colour"), depth: make(wgpu::TextureFormat::Depth32Float, "depth"), proj }
    }
}

pub struct Renderer {
    pub(crate) core: Rc<Core>,
    /// Its device's cache (`DeviceCache`), kept while the renderer lives.
    cache: Rc<DeviceCache>,
    pub(crate) frame_buffer: wgpu::Buffer,
    frame_bind_group: wgpu::BindGroup,
    /// The environment `frame_bind_group` binds.
    atlas: wgpu::Texture,
    pub(crate) meshes: Vec<GpuMesh>,
    pub(crate) textures: Vec<Texture>,
    pub(crate) white: TextureId,
    /// Trilinear samplers by (wrap, anisotropy).
    pub(crate) samplers: HashMap<(Wrap, u16), wgpu::Sampler>,
    pub items: Vec<Item>,
    pub(crate) gpu_items: Vec<Option<GpuItem>>,
    /// Every item's uniforms, one slot of `stride` bytes per item (by index), written at once each
    /// frame (`write_items`): items bind their slot at a dynamic offset. `None` until the first item
    /// is prepared; remade larger when items are added.
    uniforms: Option<wgpu::Buffer>,
    /// A slot's size: the uniforms' size rounded up to the device's offset alignment.
    stride: u64,
    /// What `write_items` writes into `uniforms`.
    staging: Vec<u8>,
    targets: Option<(u32, u32, wgpu::TextureView, wgpu::TextureView)>,
    /// The lights, exposure and environment intensity / turn (a lighting preset's values).
    pub lighting: Lighting,
    /// Holo foil draws, by item index (`add_holo`).
    pub(crate) holo: Vec<Option<HoloDraw>>,
    /// Made by the first `add_holo` (the holo code is a lazily loaded wasm chunk).
    holo_gpu: Option<HoloGpu>,
    /// The camera's distance (studio: 5.35; taller-than-standard cards pull back to fit).
    pub camera_z: f32,
    /// The card's point lights (the shine add-on's), in the card's space.
    pub point_lights: Vec<PointLight>,
    /// The frame's point lights in world space, in place of `point_lights` (a frame of several cards:
    /// every card's lights light every card, as in three's one scene); at most four are drawn.
    pub world_lights: Option<Vec<PointLight>>,
    /// Behind the card (sRGB 0..1, opaque): a glass card's backdrop (`GLASS_BACKDROP`); else clear.
    pub background: Option<[f32; 3]>,
    pub(crate) glass_gpu: Option<GlassGpu>,
    /// A glass card's buffer passes (`glass_gpu`).
    pub(crate) glass_passes: Option<GlassPasses>,
    /// Items drawn by another module's pipeline (face-shader overlays), by item index.
    pub(crate) custom: Vec<Option<CustomDraw>>,
    /// A scene's passes (`scene.rs`).
    pub frame_passes: Option<Box<dyn FramePasses>>,
    /// The scene is also drawn into half-float views (a scene floor's reflection): custom draws need a
    /// `buffer_pipeline` to appear there, as for a glass card's buffers.
    pub offscreen: bool,
    /// Uniforms holding the camera's position in an item's space (three sets them in `onBeforeRender`
    /// from the camera drawing): written for each view drawn.
    pub eyes: Vec<crate::effects::Eye>,
    /// What each item is, for production exports (`print.rs`; three's mesh names and print marks):
    /// role, kind, number, finish (see `print::Role`). Items without one are "other".
    pub tags: Vec<[u8; 4]>,
    /// Keep the glyph rasters of finished branding marks (`glyphs`): a print bake's card.
    pub keep_glyphs: bool,
    /// Finished marks' glyph rasters (`keep_glyphs`).
    pub glyphs: Vec<Glyph>,
    /// Draw the canvas in linear colour without tone mapping (three into an sRGB render target): a
    /// print bake's passes.
    pub linear_output: bool,
}

/// Where a renderer's environment comes from.
pub enum Environment<'a> {
    /// The studio rig at a quality tier: `look`, a lighting preset's reshaping; `clear`, what its empty
    /// directions show (linear; a glass card's backdrop).
    Studio { look: Option<&'a env::Look>, quality: crate::quality::Quality, clear: Option<[f32; 3]> },
    /// A prefiltered CUBEUV atlas made elsewhere (a scene's HDRI), and its size.
    Atlas(wgpu::Texture, env::EnvSize),
    /// Another renderer's environment and core (the marquee's cards).
    Shared(Shared),
}

/// How a custom item draws: its own pipeline (built on `frame_layout` for group 0, `format` and
/// `MSAA`) and bind group 1. The renderer writes the item's model-view matrix at offset 0 of `uniform`
/// each frame. Custom items take part in the glass's buffer passes only with a `buffer_pipeline`.
#[derive(Clone)]
pub struct CustomDraw {
    pub pipeline: Rc<wgpu::RenderPipeline>,
    pub bind_group: Rc<wgpu::BindGroup>,
    pub uniform: Rc<wgpu::Buffer>,
    /// The same draw into the glass's buffers (`GLASS_BUFFER_FORMAT`, one sample).
    pub buffer_pipeline: Option<Rc<wgpu::RenderPipeline>>,
    /// A second vertex buffer (slot 1), per vertex or per instance as the pipeline says.
    pub extra: Option<Rc<wgpu::Buffer>>,
    pub instances: u32,
    /// The indices drawn (three's draw range); `None`: all.
    pub range: Option<std::ops::Range<u32>>,
    /// Drawn per instance from a template (three's `InstancedBufferGeometry`): the mesh's bounds
    /// don't say where it draws, so the card's box (`local_box`) leaves it out.
    pub instanced: bool,
    /// The item's transform is in world space, not the card's (a scene's backdrop and floor): the
    /// card's pose doesn't move it, and the card's box leaves it out.
    pub world: bool,
}

impl CustomDraw {
    pub fn new(pipeline: Rc<wgpu::RenderPipeline>, bind_group: Rc<wgpu::BindGroup>, uniform: Rc<wgpu::Buffer>) -> Self {
        CustomDraw { pipeline, bind_group, uniform, buffer_pipeline: None, extra: None, instances: 1, range: None, instanced: false, world: false }
    }
}

/// A point light of the card (three's `PointLight`), in the card's space.
#[derive(Clone, Copy, Debug, Default)]
pub struct PointLight {
    pub position: [f32; 3],
    /// Linear colour × intensity.
    pub color: [f32; 3],
    pub distance: f32,
    pub decay: f32,
}

/// Where `draw_pass` draws: the canvas (through the MSAA target), one of the glass buffers, or another
/// view's targets.
#[derive(Clone, Copy)]
pub(crate) enum PassTarget<'a> {
    Canvas(&'a wgpu::TextureView),
    GlassMain,
    GlassBack,
    /// Another view of the scene (a scene floor's reflection): colour (`GLASS_BUFFER_FORMAT`) and depth.
    View(&'a wgpu::TextureView, &'a wgpu::TextureView),
}

/// When a card's [`FramePasses`] run in a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PassStage {
    /// Before anything is drawn (and before a glass card's buffer passes, so its glass isn't ready).
    First,
    /// A glass card's: after its buffer passes, before the canvas.
    AfterGlass,
}

/// What [`FramePasses`] get for a frame.
#[derive(Clone, Copy, Debug)]
pub struct PassFrame {
    pub camera: Camera,
    /// The canvas's projection (wgpu's depth range).
    pub proj: Mat4,
    /// The card's world transform (slot · root).
    pub model: Mat4,
    pub width: u32,
    pub height: u32,
}

/// Passes a card runs around its frame besides the renderer's own (a scene's floor reflection and
/// contact shadow): code of a lazily loaded chunk, called through the vtable.
pub trait FramePasses {
    /// Before the frame's uniforms are written: move world items, write their uniforms.
    fn prepare(&mut self, r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, frame: &PassFrame);
    /// Draw into the pass's own targets ([`Renderer::draw_view`] and its own pipelines).
    fn run(&mut self, r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, frame: &PassFrame, stage: PassStage);
}

/// The glass buffer the glass item refracts in a pass.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum GlassBuffer {
    Main,
    Back,
}

/// The glass buffers' format (three's HalfFloatType render targets).
pub const GLASS_BUFFER_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

/// `Draw.spec.y`: how the shader treats the faces (front, double-sided, back).
pub(crate) fn side_mode(side: Side) -> f32 {
    match side {
        Side::Front => 0.0,
        Side::Double => 1.0,
        Side::Back => 2.0,
    }
}

/// The glass body's buffers (`fboMain`, `fboBack`) and what its shader binds (group 2): made, with
/// its passes (`Renderer::glass_passes`), by the `glass` chunk.
pub(crate) struct GlassGpu {
    pub(crate) sampler: wgpu::Sampler,
    pub(crate) uniform: wgpu::Buffer,
    /// (width, height, main, back, depth, bind group sampling main, bind group sampling back).
    #[allow(clippy::type_complexity, reason = "named in the doc comment above")]
    pub(crate) targets: Option<(u32, u32, wgpu::TextureView, wgpu::TextureView, wgpu::TextureView, wgpu::BindGroup, wgpu::BindGroup)>,
}

/// A glass card's buffer passes before the canvas (`renderTransmissionPasses`; the `glass` chunk's
/// code): `GlassFrame` says what the frame draws, and the scene's passes run again after them.
pub(crate) type GlassPasses = fn(&mut Renderer, &wgpu::Device, &wgpu::Queue, &GlassFrame<'_>, &mut Option<Box<dyn FramePasses>>);

/// What a glass card's buffer passes draw (`GlassPasses`).
pub(crate) struct GlassFrame<'a> {
    /// The glass item, and the frame's items in draw order.
    pub(crate) item: usize,
    pub(crate) order: &'a [usize],
    pub(crate) frame: FrameUniform,
    pub(crate) pass_frame: PassFrame,
    pub(crate) view: Mat4,
    pub(crate) eye: Vec3,
}

/// The card shader's text for an environment size (shaders/card.wgsl after the PMREM lookup); effects
/// derive their own materials from it.
pub fn card_source(env_size: env::EnvSize) -> String {
    format!("{}{}\n{}", env_size.cubeuv_prelude(), wgsl!("cubeuv.wgsl"), wgsl!("card.wgsl"))
}

pub(crate) fn mat(m: Mat4) -> [[f32; 4]; 4] {
    m.to_cols_array_2d()
}

impl Renderer {
    /// `format` must be a non-sRGB 8-bit format: the shader writes sRGB-encoded colour, as three does.
    /// `environment`: the studio rig (a lighting preset's look, the quality tier, the clear colour) or
    /// a scene's prefiltered HDRI.
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, format: wgpu::TextureFormat, environment: Environment<'_>) -> Self {
        let cache = device_cache(device);
        let (core, atlas) = match environment {
            Environment::Studio { look, quality, clear } => {
                let size = env::EnvSize::new(quality.preset().environment_resolution);
                (core(device, format, size), cache.studio(device, queue, (look.cloned(), quality, clear)))
            }
            Environment::Atlas(atlas, size) => (core(device, format, size), atlas),
            Environment::Shared(s) => (s.core, s.atlas),
        };
        let frame_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("frame"),
            size: size_of::<FrameUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let frame_bind_group = frame_bind_group(device, &core, &frame_buffer, &atlas);
        let samplers = HashMap::new();
        let mut r = Renderer {
            core,
            cache,
            frame_buffer,
            frame_bind_group,
            atlas,
            meshes: Vec::new(),
            textures: Vec::new(),
            white: TextureId(0),
            samplers,
            items: Vec::new(),
            gpu_items: Vec::new(),
            uniforms: None,
            stride: (size_of::<MaterialUniform>().max(size_of::<HoloUniform>()) as u64)
                .next_multiple_of(device.limits().min_uniform_buffer_offset_alignment as u64),
            staging: Vec::new(),
            targets: None,
            lighting: Lighting::default(),
            holo: Vec::new(),
            holo_gpu: None,
            background: None,
            glass_gpu: None,
            glass_passes: None,
            custom: Vec::new(),
            camera_z: CAMERA_Z,
            point_lights: Vec::new(),
            world_lights: None,
            frame_passes: None,
            offscreen: false,
            eyes: Vec::new(),
            tags: Vec::new(),
            keep_glyphs: false,
            glyphs: Vec::new(),
            linear_output: false,
        };
        r.white = r.texture(device, queue, &[(1, 1, vec![255; 4])], false, Wrap::Clamp);
        r
    }

    /// The maps the cards made on this renderer's device share (`DeviceCache`).
    pub(crate) fn device_maps(&self) -> Rc<crate::card::MapCache> {
        self.cache.maps.clone()
    }

    /// Tags the untagged items from `from` on (`tags`).
    #[inline(never)]
    pub fn tag(&mut self, from: usize, tag: [u8; 4]) {
        self.tags.resize(self.items.len(), [0; 4]);
        for t in self.tags.iter_mut().skip(from).filter(|t| t[0] == 0) {
            *t = tag;
        }
    }

    pub(crate) fn sampler(&mut self, device: &wgpu::Device, wrap: Wrap, anisotropy: u16) {
        self.samplers.entry((wrap, anisotropy)).or_insert_with(|| {
            let mode = if wrap == Wrap::Repeat { wgpu::AddressMode::Repeat } else { wgpu::AddressMode::ClampToEdge };
            device.create_sampler(&wgpu::SamplerDescriptor {
                address_mode_u: mode,
                address_mode_v: mode,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::MipmapFilterMode::Linear,
                anisotropy_clamp: anisotropy,
                ..Default::default()
            })
        });
    }

    pub fn mesh(&mut self, device: &wgpu::Device, m: &Mesh) -> MeshId {
        let verts: Vec<Vertex> = (0..m.positions.len()).map(|i| Vertex { position: m.positions[i], normal: m.normals[i], uv: m.uvs[i] }).collect();
        let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for p in &m.positions {
            lo = lo.min(Vec3::from(*p));
            hi = hi.max(Vec3::from(*p));
        }
        self.meshes.push(GpuMesh {
            vertices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&verts),
                usage: wgpu::BufferUsages::VERTEX,
            }),
            indices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&m.indices),
                usage: wgpu::BufferUsages::INDEX,
            }),
            count: m.indices.len() as u32,
            centre: (lo + hi) / 2.0,
            bounds: (lo, hi),
        });
        MeshId(self.meshes.len() - 1)
    }

    /// A mesh's vertex and index buffers and index count (for passes other modules record).
    pub fn mesh_buffers(&self, id: MeshId) -> (&wgpu::Buffer, &wgpu::Buffer, u32) {
        let m = &self.meshes[id.0];
        (&m.vertices, &m.indices, m.count)
    }

    /// A texture from its mip chain (`material::mip_chain`), RGBA8 rows with v = 0 first.
    pub fn texture(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, levels: &[(u32, u32, Vec<u8>)], srgb: bool, wrap: Wrap) -> TextureId {
        self.texture_with(device, queue, levels, srgb, wrap, 1)
    }

    /// `texture` with a sampler anisotropy (three's `texture.anisotropy`).
    pub fn texture_with(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        levels: &[(u32, u32, Vec<u8>)],
        srgb: bool,
        wrap: Wrap,
        anisotropy: u16,
    ) -> TextureId {
        let tex = upload(device, queue, levels, srgb);
        self.textures.push(Texture { view: tex.create_view(&Default::default()), texture: tex, wrap, anisotropy: anisotropy.max(1) });
        TextureId(self.textures.len() - 1)
    }

    /// Replaces texture `id`'s image (an animated sticker's next frame): written in place when the size
    /// and level count are the same, else a new texture that the items using it pick up next frame.
    pub fn replace_texture(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, id: TextureId, levels: &[(u32, u32, Vec<u8>)], srgb: bool) {
        let old = &self.textures[id.0];
        let (w, h, _) = levels[0];
        let size = old.texture.size();
        if (size.width, size.height, old.texture.mip_level_count()) == (w, h, levels.len() as u32) {
            for (i, (lw, lh, data)) in levels.iter().enumerate() {
                queue.write_texture(
                    wgpu::TexelCopyTextureInfo { texture: &old.texture, mip_level: i as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                    data,
                    wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * lw), rows_per_image: Some(*lh) },
                    wgpu::Extent3d { width: *lw, height: *lh, depth_or_array_layers: 1 },
                );
            }
            return;
        }
        let (wrap, anisotropy) = (old.wrap, old.anisotropy);
        self.texture_with(device, queue, levels, srgb, wrap, anisotropy);
        let fresh = self.textures.pop().expect("the texture just made");
        self.textures[id.0] = fresh;
        // Bind groups hold the old view: rebuild those of the items that sample it.
        for (i, it) in self.items.iter().enumerate() {
            let m = &it.material;
            if [m.map, m.normal_map, m.roughness_map, m.bump_map].contains(&Some(id)) {
                if let Some(g) = self.gpu_items.get_mut(i) {
                    *g = None;
                }
            }
        }
    }

    pub fn add(&mut self, item: Item) -> usize {
        self.items.push(item);
        self.holo.push(None);
        self.custom.push(None);
        self.items.len() - 1
    }

    /// An item with its own pipeline (`CustomDraw`).
    pub fn add_custom(&mut self, item: Item, draw: CustomDraw) -> usize {
        let i = self.add(item);
        self.custom[i] = Some(draw);
        i
    }

    /// Item `i`'s custom draw, to change what it draws.
    pub fn custom_mut(&mut self, i: usize) -> Option<&mut CustomDraw> {
        self.custom.get_mut(i).and_then(|c| c.as_mut())
    }

    pub fn custom(&self, i: usize) -> Option<&CustomDraw> {
        self.custom.get(i).and_then(|c| c.as_ref())
    }

    /// The environment atlas's size (for shaders that sample it: `card_source`).
    pub fn env_size(&self) -> env::EnvSize {
        self.core.env_size
    }

    /// Lights the card from another environment of the same size (a frame's new lighting preset).
    pub fn set_environment(&mut self, device: &wgpu::Device, atlas: &wgpu::Texture) {
        self.frame_bind_group = frame_bind_group(device, &self.core, &self.frame_buffer, atlas);
        self.atlas = atlas.clone();
    }

    /// The frame bind group's layout (group 0 of every pipeline), for custom pipelines.
    pub fn frame_layout(&self) -> &wgpu::BindGroupLayout {
        &self.core.frame_layout
    }

    /// The frame bind group (group 0), for passes other modules record.
    pub fn frame_bind_group(&self) -> &wgpu::BindGroup {
        &self.frame_bind_group
    }

    /// The canvas format.
    pub fn format(&self) -> wgpu::TextureFormat {
        self.core.format
    }

    /// A texture made elsewhere (shared by several renderers: the marquee's surface maps), sampled
    /// with `wrap` and `anisotropy`.
    pub fn adopt_texture(&mut self, texture: &wgpu::Texture, wrap: Wrap, anisotropy: u16) -> TextureId {
        self.textures.push(Texture { view: texture.create_view(&Default::default()), texture: texture.clone(), wrap, anisotropy: anisotropy.max(1) });
        TextureId(self.textures.len() - 1)
    }

    /// A texture other passes render into (a face-shader skin): `Rgba8UnormSrgb` (the hardware encodes
    /// on store and decodes on sampling, as three's SRGB8_ALPHA8 targets), one level, sampled through a
    /// clamped sampler with `anisotropy`.
    pub fn render_texture(&mut self, device: &wgpu::Device, width: u32, height: u32, anisotropy: u16) -> TextureId {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("render texture"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        self.textures.push(Texture { view: texture.create_view(&Default::default()), texture, wrap: Wrap::Clamp, anisotropy: anisotropy.max(1) });
        TextureId(self.textures.len() - 1)
    }

    /// A texture's view (to render into a `render_texture`, or to bind elsewhere).
    pub fn texture_view(&self, id: TextureId) -> &wgpu::TextureView {
        &self.textures[id.0].view
    }

    /// A holo foil mesh (render order 9, additive, its own shader).
    pub fn add_holo(&mut self, device: &wgpu::Device, mesh: MeshId, transform: Mat4, draw: HoloDraw) -> usize {
        self.holo_gpu.get_or_insert_with(|| HoloGpu::new(device));
        let material = Material { transparent: true, depth_write: false, polygon_offset: Some((-2.0, -2.0)), ..Default::default() };
        self.items.push(Item { mesh, material, transform, render_order: crate::holo::RENDER_ORDER, visible: true });
        self.holo.push(Some(draw));
        self.custom.push(None);
        self.items.len() - 1
    }

    /// Makes the pipeline for `key` if it isn't made yet: the holo foil's in the renderer, the card
    /// shader's in the core (shared by the renderers that share it).
    fn pipeline(&mut self, device: &wgpu::Device, key: PipelineKey) {
        let core = &*self.core;
        let (shader, layout, entry) = match (&self.holo_gpu, key.holo) {
            (Some(h), true) => (&h.shader, &h.layout, ("vs_main", "fs_main")),
            _ if key.glass => (&core.shader, &core.glass.get().expect("glass layouts").1, ("vs_glass", "fs_glass")),
            _ => (&core.shader, &core.layout, ("vs_main", "fs_main")),
        };
        let (format, samples) = if key.buffer { (GLASS_BUFFER_FORMAT, 1) } else { (core.format, MSAA) };
        let holo = key.holo && self.holo_gpu.is_some();
        let made = match holo {
            true => self.holo_gpu.as_ref().is_some_and(|h| h.pipelines.contains_key(&key)),
            false => core.pipelines.borrow().contains_key(&key),
        };
        if made {
            return;
        }
        let pipeline = {
            // three's AdditiveBlending (non-premultiplied): rgb += src.rgb · src.a, alpha += src.a.
            let additive = wgpu::BlendState {
                color: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::SrcAlpha,
                    dst_factor: wgpu::BlendFactor::One,
                    operation: wgpu::BlendOperation::Add,
                },
                alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
            };
            let normal = key.transparent.then_some(wgpu::BlendState {
                color: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::SrcAlpha,
                    dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                    operation: wgpu::BlendOperation::Add,
                },
                alpha: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::One,
                    dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                    operation: wgpu::BlendOperation::Add,
                },
            });
            let blend = if key.holo { Some(additive) } else { normal };
            let write_mask = if key.color_write { wgpu::ColorWrites::ALL } else { wgpu::ColorWrites::empty() };
            let bias = match key.offset {
                // GL polygonOffset(factor, units) ≈ depth bias slope × factor + constant × units.
                Some((f, u)) => wgpu::DepthBiasState { constant: f32::from_bits(u) as i32, slope_scale: f32::from_bits(f), clamp: 0.0 },
                None => Default::default(),
            };
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("card"),
                layout: Some(layout),
                vertex: wgpu::VertexState { module: shader, entry_point: Some(entry.0), buffers: VERTEX_LAYOUT, compilation_options: Default::default() },
                fragment: Some(wgpu::FragmentState {
                    module: shader,
                    entry_point: Some(entry.1),
                    targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask })],
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
                    bias,
                }),
                multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
                multiview_mask: None,
                cache: None,
            })
        };
        match self.holo_gpu.as_mut().filter(|_| holo) {
            Some(h) => h.pipelines.insert(key, pipeline),
            None => self.core.pipelines.borrow_mut().insert(key, pipeline),
        };
    }

    /// Makes every item's bind group and pipelines now, while the card is built (the last one still
    /// shown), so that its first frame doesn't stall on them: the canvas's, and the half-float
    /// targets' when the card draws into them (a glass card's buffers, a scene floor's reflection).
    pub(crate) fn warm(&mut self, device: &wgpu::Device) {
        let buffers = self.glass_passes.is_some() || self.offscreen;
        self.slots(device);
        for i in 0..self.items.len() {
            if self.custom[i].is_some() {
                continue;
            }
            self.prepare(device, i);
            let mut key = self.gpu_items[i].as_ref().unwrap().key;
            self.pipeline(device, key);
            if buffers && !key.holo {
                key.buffer = true;
                self.pipeline(device, key);
                if key.glass {
                    key.side = Side::Back;
                    self.pipeline(device, key);
                }
            }
        }
    }

    /// Makes `uniforms` hold a slot for every item; a new buffer drops the bind groups on the old.
    fn slots(&mut self, device: &wgpu::Device) {
        let size = self.items.len().max(1) as u64 * self.stride;
        if self.uniforms.as_ref().is_some_and(|b| b.size() >= size) {
            return;
        }
        self.uniforms = Some(device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("items"),
            size,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        }));
        self.gpu_items.clear();
    }

    /// A slot of `uniforms` as a binding, `size` bytes at the item's dynamic offset.
    fn slot(&self, size: usize) -> wgpu::BindingResource<'_> {
        let buffer = self.uniforms.as_ref().expect("slots made before items are prepared");
        wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer, offset: 0, size: wgpu::BufferSize::new(size as u64) })
    }

    /// Item `i`'s dynamic offset into `uniforms`.
    fn offset(&self, i: usize) -> u32 {
        (i as u64 * self.stride) as u32
    }

    /// Writes item `i`'s material uniforms alone (a glass pass turning its faces).
    pub(crate) fn write_item(&self, queue: &wgpu::Queue, i: usize) {
        if let (Some(b), Some(g)) = (&self.uniforms, self.gpu_items.get(i).and_then(|g| g.as_ref())) {
            queue.write_buffer(b, i as u64 * self.stride, bytemuck::bytes_of(&g.uniform));
        }
    }

    fn prepare(&mut self, device: &wgpu::Device, i: usize) {
        if self.gpu_items.len() <= i {
            self.gpu_items.resize_with(i + 1, || None);
        }
        if self.gpu_items[i].is_some() {
            return;
        }
        if self.holo[i].is_some() {
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.holo_gpu.as_ref().expect("holo items come from add_holo").draw_layout,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: self.slot(size_of::<HoloUniform>()) }],
            });
            let key = PipelineKey {
                holo: true,
                color_write: true,
                transparent: true,
                depth_test: true,
                depth_write: false,
                offset: Some(((-2.0f32).to_bits(), (-2.0f32).to_bits())),
                side: Side::Front,
                glass: false,
                buffer: false,
            };
            self.gpu_items[i] = Some(GpuItem { bind_group, uniform: bytemuck::Zeroable::zeroed(), key });
            return;
        }
        let (surface, colour) = {
            let m = &self.items[i].material;
            let t = |id: Option<TextureId>| &self.textures[id.unwrap_or(self.white).0];
            let (s, c) = (t(m.normal_map.or(m.roughness_map)), t(m.map.or(m.bump_map)));
            ((s.wrap, s.anisotropy), (c.wrap, c.anisotropy))
        };
        self.sampler(device, surface.0, surface.1);
        self.sampler(device, colour.0, colour.1);
        let m = &self.items[i].material;
        let tex = |t: Option<TextureId>| &self.textures[t.unwrap_or(self.white).0];
        let sampler = |k: (Wrap, u16)| &self.samplers[&k];
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.core.draw_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.slot(size_of::<MaterialUniform>()) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&tex(m.normal_map).view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&tex(m.roughness_map).view) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&tex(m.map).view) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&tex(m.bump_map).view) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::Sampler(sampler(surface)) },
                wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::Sampler(sampler(colour)) },
            ],
        });
        let on = |b: bool| if b { 1.0 } else { 0.0 };
        let uniform = MaterialUniform {
            model_view: mat(Mat4::IDENTITY),
            normal_matrix: mat(Mat4::IDENTITY),
            color: [m.color[0], m.color[1], m.color[2], m.opacity],
            pbr: [m.metalness, m.roughness, m.clearcoat, m.clearcoat_roughness],
            aniso: [m.anisotropy, m.anisotropy_rotation, m.alpha_test, m.bump_scale],
            irid: [m.iridescence, m.iridescence_ior, m.iridescence_thickness, 0.0],
            maps: [m.normal_scale[0], m.normal_scale[1], m.surface_repeat[0], m.surface_repeat[1]],
            flags: [on(m.map.is_some()), on(m.normal_map.is_some()), on(m.roughness_map.is_some()), on(m.bump_map.is_some())],
            flags2: [on(m.transparent), on(m.luminance_after_map), on(m.unlit_tone_mapped), on(m.unlit)],
            map_uv: [m.map_offset[0], m.map_offset[1], m.map_repeat[0], m.map_repeat[1]],
            look_tint: m.look.map_or([0.0; 4], |l| l.tint),
            look_adjust: m.look.map_or([0.0; 4], |l| [l.adjust[0], l.adjust[1], l.adjust[2], 1.0]),
            emissive: [m.emissive[0], m.emissive[1], m.emissive[2], 0.0],
            spec: [m.specular_intensity, side_mode(m.side), 0.0, 0.0],
        };
        let key = PipelineKey {
            holo: false,
            color_write: m.color_write,
            transparent: m.transparent,
            depth_test: m.depth_test,
            depth_write: m.depth_write,
            offset: m.polygon_offset.map(|(f, u)| (f.to_bits(), u.to_bits())),
            side: m.side,
            glass: m.glass.is_some(),
            buffer: false,
        };
        self.gpu_items[i] = Some(GpuItem { bind_group, uniform, key });
    }

    /// Renders the scene with the card turned by Euler XYZ angles (radians) into `target`, the camera
    /// at `camera_z` (the harness's fixed poses).
    pub fn render(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::TextureView, width: u32, height: u32, euler: [f32; 3]) {
        let slot = Mat4::from_rotation_x(euler[0]) * Mat4::from_rotation_y(euler[1]) * Mat4::from_rotation_z(euler[2]);
        let cam = Camera::axis(self.camera_z as f64);
        self.render_with(device, queue, target, width, height, slot, &cam);
    }

    /// The bounding box of the visible items in the card's own space (`localBox`), or `None`.
    pub fn local_box(&self) -> Option<(Vec3, Vec3)> {
        let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for (_, it) in self.items.iter().enumerate().filter(|(i, it)| it.visible && !self.custom[*i].as_ref().is_some_and(|c| c.instanced || c.world)) {
            let (a, b) = self.meshes[it.mesh.0].bounds;
            if a.cmpgt(b).any() {
                continue;
            }
            for k in 0..8 {
                let c = Vec3::new(if k & 1 == 0 { a.x } else { b.x }, if k & 2 == 0 { a.y } else { b.y }, if k & 4 == 0 { a.z } else { b.z });
                let p = it.transform.transform_point3(c);
                lo = lo.min(p);
                hi = hi.max(p);
            }
        }
        (lo.x <= hi.x).then_some((lo, hi))
    }

    /// The frame uniform for a view (`linear`: the half-float passes' output, without tone mapping).
    fn frame_uniform(&self, view: Mat4, proj: Mat4, model: Mat4, linear: bool) -> FrameUniform {
        let lt = self.lighting;
        let light = (Mat3::from_mat4(view) * Vec3::from(lt.key_position)).normalize();
        let mut points = [[0.0; 4]; 8];
        let (lights, to_view) = match &self.world_lights {
            Some(w) => (w, view),
            None => (&self.point_lights, view * model),
        };
        // A black light adds nothing (a shine add-on turned away still has its two): left out, it
        // costs the shader no loop and leaves its slot to a light that shows.
        let mut count = 0;
        for (k, p) in lights.iter().filter(|p| p.color != [0.0; 3]).take(4).enumerate() {
            let v = to_view.transform_point3(Vec3::from(p.position));
            points[2 * k] = [v.x, v.y, v.z, p.distance];
            points[2 * k + 1] = [p.color[0], p.color[1], p.color[2], p.decay];
            count = k + 1;
        }
        let fill = (Mat3::from_mat4(view) * Vec3::from(lt.fill_position)).normalize();
        let fill_on = if lt.fill == [0.0; 3] { 0.0 } else { 1.0 };
        FrameUniform {
            view: mat(view),
            proj: mat(proj),
            light_dir: [light.x, light.y, light.z, 0.0],
            light_color: [lt.key[0], lt.key[1], lt.key[2], 0.0],
            ambient: [lt.ambient[0], lt.ambient[1], lt.ambient[2], 0.0],
            misc: [lt.exposure, if linear { 1.0 } else { 0.0 }, count as f32, 0.0],
            env: [lt.env_intensity, lt.env_rotation_y, 0.0, 0.0],
            points,
            fill_dir: [fill.x, fill.y, fill.z, 0.0],
            fill_color: [lt.fill[0], lt.fill[1], lt.fill[2], fill_on],
        }
    }

    /// Writes every visible item's uniforms for `view` (the card at `slot`; `write` false: only orders
    /// them, for a frame whose passes write their own first) and returns them in three's draw order:
    /// opaque by render order (then insertion), transparent by render order then farthest first. The
    /// card's own items' go into `uniforms` in one write.
    pub(crate) fn write_items(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, view: Mat4, slot: Mat4, write: bool) -> Vec<usize> {
        let mut order: Vec<(bool, f32, f32, usize)> = Vec::new();
        self.slots(device);
        let stride = self.stride as usize;
        let mut end = 0;
        for i in 0..self.items.len() {
            if !self.items[i].visible {
                continue;
            }
            if let Some(c) = &self.custom[i] {
                let it = &self.items[i];
                let mv = if c.world { view * it.transform } else { view * slot * it.transform };
                if write {
                    queue.write_buffer(&c.uniform, 0, bytemuck::bytes_of(&mat(mv)));
                }
                let z = (mv * self.meshes[it.mesh.0].centre.extend(1.0)).z;
                order.push((it.material.transparent, it.render_order, if it.material.transparent { z } else { 0.0 }, i));
                continue;
            }
            self.prepare(device, i);
            let it = &self.items[i];
            let mv = view * slot * it.transform;
            let z = (mv * self.meshes[it.mesh.0].centre.extend(1.0)).z;
            order.push((it.material.transparent, it.render_order, if it.material.transparent { z } else { 0.0 }, i));
            if !write {
                continue;
            }
            let g = self.gpu_items[i].as_mut().unwrap();
            if self.staging.len() < (i + 1) * stride {
                self.staging.resize((i + 1) * stride, 0);
            }
            let at = &mut self.staging[i * stride..];
            if let Some(h) = self.holo[i] {
                let v = h.values;
                let l = crate::holo::light_direction();
                let u = HoloUniform {
                    model: mat(slot * it.transform),
                    params: [v.style, v.texture, v.intensity, v.glare],
                    params2: [v.responsive, v.scale, v.coverage, if h.edge_only { 1.0 } else { 0.0 }],
                    params3: [h.edge_side, 0.0, 0.0, 0.0],
                    light: [l[0], l[1], l[2], 0.0],
                };
                at[..size_of::<HoloUniform>()].copy_from_slice(bytemuck::bytes_of(&u));
            } else {
                let m = &it.material;
                // Opacity may change from frame to frame (an effect fading a layer), and a sticker's
                // picture edits while Card Studio drags it (`CardRenderer::sticker`).
                g.uniform.color[3] = m.opacity;
                g.uniform.map_uv = [m.map_offset[0], m.map_offset[1], m.map_repeat[0], m.map_repeat[1]];
                if let Some(l) = m.look {
                    g.uniform.look_tint = l.tint;
                    g.uniform.look_adjust = [l.adjust[0], l.adjust[1], l.adjust[2], 1.0];
                } else {
                    g.uniform.look_adjust[3] = 0.0;
                }
                g.uniform.model_view = mat(mv);
                g.uniform.normal_matrix = mat(Mat4::from_mat3(Mat3::from_mat4(mv).inverse().transpose()));
                at[..size_of::<MaterialUniform>()].copy_from_slice(bytemuck::bytes_of(&g.uniform));
            }
            end = (i + 1) * stride;
        }
        if end > 0 {
            queue.write_buffer(self.uniforms.as_ref().unwrap(), 0, &self.staging[..end]);
        }
        order.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)).then(a.2.total_cmp(&b.2)).then(a.3.cmp(&b.3)));
        order.iter().map(|o| o.3).collect()
    }

    /// The canvas's projection at `aspect`: right-handed, depth 0..1, clip y up (WebGPU's and D3D's
    /// convention).
    pub fn projection(aspect: f32) -> Mat4 {
        glam::camera::rh::proj::directx::perspective(FOV_DEG.to_radians(), aspect, 0.1, 30.0)
    }

    /// Draws the visible items `keep` accepts (and that can draw into half-float targets: not the holo
    /// foils, and custom draws only with a `buffer_pipeline`; the glass body only with `glass`, once its
    /// buffers are made this frame) into `color` (`GLASS_BUFFER_FORMAT`, one sample) and `depth`
    /// (Depth32Float, same size), from `cam` with `proj`, the card at `model`, in linear colour (no
    /// tone mapping, as three renders into a render target), cleared to transparent. Leaves the items'
    /// uniforms as this view's: the renderer writes the canvas's again after its frame passes.
    pub fn draw_view(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        color: &wgpu::TextureView,
        depth: &wgpu::TextureView,
        cam: &Camera,
        proj: Mat4,
        model: Mat4,
        glass: bool,
        keep: &dyn Fn(usize) -> bool,
    ) {
        let view = cam.view32();
        let frame = self.frame_uniform(view, proj, model, true);
        queue.write_buffer(&self.frame_buffer, 0, bytemuck::bytes_of(&frame));
        let order = self.write_items(device, queue, view, model, true);
        for e in &self.eyes {
            e.write(queue, model, cam);
        }
        let glass_item = order.iter().copied().find(|&i| self.items[i].material.glass.is_some());
        let list: Vec<usize> = order
            .into_iter()
            .filter(|&i| {
                keep(i) && self.holo[i].is_none() && self.custom[i].as_ref().is_none_or(|c| c.buffer_pipeline.is_some()) && (glass || Some(i) != glass_item)
            })
            .collect();
        let glass = glass_item.filter(|gi| glass && list.contains(gi)).map(|gi| (gi, GlassBuffer::Main));
        self.draw_pass(device, queue, PassTarget::View(color, depth), wgpu::Color::TRANSPARENT, &list, glass);
    }

    /// Renders the scene into `target` with the card's world transform `model` (slot · root), seen
    /// from `cam`.
    pub fn render_with(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::TextureView, width: u32, height: u32, model: Mat4, cam: &Camera) {
        let proj = Self::projection(width as f32 / height as f32);
        self.render_frame(device, queue, target, width, height, model, cam, proj);
    }

    /// Draws several renderers' cards (each with its world transform) into one frame (the marquee),
    /// in order: every card's uniforms and its own passes first (a glass card's buffers), then all of
    /// them in one pass over `layers`, resolved into `target` once, each depth tested against those
    /// before it. Cards whose frame uniform and environment are the same share the first one's.
    pub fn render_layers(
        cards: &mut [(&mut Renderer, Mat4)],
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        layers: &Layers,
        cam: &Camera,
    ) {
        let mut draws = Vec::with_capacity(cards.len());
        let mut first: Option<(FrameUniform, wgpu::Texture)> = None;
        for (k, (r, model)) in cards.iter_mut().enumerate() {
            let (order, glass, frame) = r.prepare_frame(device, queue, layers.width, layers.height, *model, cam, layers.proj);
            let shares = first.as_ref().is_some_and(|(f, atlas)| bytemuck::bytes_of(f) == bytemuck::bytes_of(&frame) && *atlas == r.atlas);
            if !shares {
                queue.write_buffer(&r.frame_buffer, 0, bytemuck::bytes_of(&frame));
            }
            if k == 0 {
                first = Some((frame, r.atlas.clone()));
            }
            let glass = glass.map(|gi| (gi, GlassBuffer::Main));
            let keys = r.keys(device, &order, glass, false);
            draws.push((order, glass, keys, if shares { 0 } else { k }));
        }
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("cards"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &layers.msaa,
                    resolve_target: Some(target),
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Discard },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &layers.depth,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            for ((r, _), (order, glass, keys, frame)) in cards.iter().zip(&draws) {
                r.record(&mut pass, order, keys, *glass, false, &cards[*frame].0.frame_bind_group);
            }
        }
        queue.submit([encoder.finish()]);
    }

    fn render_frame(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
        model: Mat4,
        cam: &Camera,
        proj: Mat4,
    ) {
        if self.targets.as_ref().map(|t| (t.0, t.1)) != Some((width, height)) {
            let make = |format, label| {
                device
                    .create_texture(&wgpu::TextureDescriptor {
                        label: Some(label),
                        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                        mip_level_count: 1,
                        sample_count: MSAA,
                        dimension: wgpu::TextureDimension::D2,
                        format,
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                        view_formats: &[],
                    })
                    .create_view(&Default::default())
            };
            self.targets = Some((width, height, make(self.core.format, "msaa colour"), make(wgpu::TextureFormat::Depth32Float, "depth")));
        }
        let (order, glass_item, frame) = self.prepare_frame(device, queue, width, height, model, cam, proj);
        queue.write_buffer(&self.frame_buffer, 0, bytemuck::bytes_of(&frame));
        let clear = match self.background {
            Some(c) => wgpu::Color { r: c[0] as f64, g: c[1] as f64, b: c[2] as f64, a: 1.0 },
            None => wgpu::Color::TRANSPARENT,
        };
        self.draw_pass(device, queue, PassTarget::Canvas(target), clear, &order, glass_item.map(|gi| (gi, GlassBuffer::Main)));
    }

    /// Everything a frame needs before the canvas's pass: the items' uniforms and order, a scene's
    /// passes, a glass card's buffer passes. Returns the order, the glass item and the canvas's frame
    /// uniform (for the caller to write: the passes leave `frame_buffer` as they need it).
    fn prepare_frame(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        width: u32,
        height: u32,
        model: Mat4,
        cam: &Camera,
        proj: Mat4,
    ) -> (Vec<usize>, Option<usize>, FrameUniform) {
        let view = cam.view32();
        let eye = cam.eye32();
        let pass_frame = PassFrame { camera: *cam, proj, model, width, height };
        let mut passes = self.frame_passes.take();
        if let Some(p) = passes.as_mut() {
            p.prepare(self, device, queue, &pass_frame);
        }
        let frame = self.frame_uniform(view, proj, model, self.linear_output);
        let holo_frame = HoloFrameUniform { view: mat(view), proj: mat(proj), camera: [eye.x, eye.y, eye.z, 1.0] };
        if let Some(h) = &self.holo_gpu {
            queue.write_buffer(&h.frame_buffer, 0, bytemuck::bytes_of(&holo_frame));
        }
        let slot = model;
        // A scene's passes draw other views first and write the items' uniforms for each: the canvas's
        // follow them.
        let order = self.write_items(device, queue, view, slot, passes.is_none());
        if passes.is_none() {
            for e in &self.eyes {
                e.write(queue, model, cam);
            }
        }
        let glass_item = order.iter().copied().find(|&i| self.items[i].material.glass.is_some());
        // A scene's passes: its reflection and contact shadow (for a glass card, its reflection without
        // the glass; the glass's buffers come next).
        if let Some(p) = passes.as_mut() {
            p.run(self, device, queue, &pass_frame, PassStage::First);
            self.write_items(device, queue, view, slot, true);
            for e in &self.eyes {
                e.write(queue, model, cam);
            }
        }

        // A glass body: its two buffer passes first (the `glass` chunk's).
        if let (Some(item), Some(run)) = (glass_item, self.glass_passes) {
            run(self, device, queue, &GlassFrame { item, order: &order, frame, pass_frame, view, eye }, &mut passes);
        }
        self.frame_passes = passes;
        (order, glass_item, frame)
    }

    /// The pipeline keys `list` draws with into the canvas or (`buffer`) a half-float target, each
    /// pipeline made if it isn't yet; `None` for custom items.
    fn keys(&mut self, device: &wgpu::Device, list: &[usize], glass: Option<(usize, GlassBuffer)>, buffer: bool) -> Vec<Option<PipelineKey>> {
        let keys: Vec<Option<PipelineKey>> = list
            .iter()
            .map(|&i| {
                self.gpu_items.get(i).and_then(|g| g.as_ref()).filter(|_| self.custom[i].is_none())?;
                let mut k = self.gpu_items[i].as_ref().unwrap().key;
                k.buffer = buffer;
                if glass.is_some_and(|(gi, b)| gi == i && b == GlassBuffer::Back) {
                    k.side = Side::Back;
                }
                Some(k)
            })
            .collect();
        for k in keys.iter().flatten() {
            self.pipeline(device, *k);
        }
        keys
    }

    /// Draws `list` (already in draw order) into one target, in its own submission. `glass`: the glass
    /// item and the buffer it refracts in this pass (the main buffer pass draws its back faces).
    pub(crate) fn draw_pass(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: PassTarget<'_>,
        clear: wgpu::Color,
        list: &[usize],
        glass: Option<(usize, GlassBuffer)>,
    ) {
        let buffer = !matches!(target, PassTarget::Canvas(..));
        let keys = self.keys(device, list, glass, buffer);
        let (colour, resolve, depth) = match target {
            PassTarget::Canvas(view) => {
                let (_, _, msaa, depth) = self.targets.as_ref().unwrap();
                (msaa, Some(view), depth)
            }
            PassTarget::GlassMain | PassTarget::GlassBack => {
                let t = self.glass_gpu.as_ref().and_then(|g| g.targets.as_ref()).unwrap();
                (if matches!(target, PassTarget::GlassMain) { &t.2 } else { &t.3 }, None, &t.4)
            }
            PassTarget::View(colour, depth) => (colour, None, depth),
        };
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("card"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: colour,
                    resolve_target: resolve,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(clear),
                        store: if resolve.is_some() { wgpu::StoreOp::Discard } else { wgpu::StoreOp::Store },
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: depth,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            self.record(&mut pass, list, &keys, glass, buffer, &self.frame_bind_group);
        }
        queue.submit([encoder.finish()]);
    }

    /// Records `list` into `pass` with its `keys` (`keys`), group 0 from `frame` (a frame bind group
    /// holding the same values as the renderer's own).
    fn record(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        list: &[usize],
        keys: &[Option<PipelineKey>],
        glass: Option<(usize, GlassBuffer)>,
        buffer: bool,
        frame: &wgpu::BindGroup,
    ) {
        let shared = self.core.pipelines.borrow();
        pass.set_bind_group(0, frame, &[]);
        for (&i, key) in list.iter().zip(keys) {
            let it = &self.items[i];
            let m = &self.meshes[it.mesh.0];
            let Some(key) = key else {
                // A custom item: its own pipeline and bind group 1, the frame's group 0.
                let c = self.custom[i].as_ref().unwrap();
                let range = c.range.clone().unwrap_or(0..m.count);
                if range.is_empty() || c.instances == 0 {
                    continue;
                }
                pass.set_bind_group(0, frame, &[]);
                pass.set_pipeline(if buffer { c.buffer_pipeline.as_ref().unwrap() } else { &c.pipeline });
                pass.set_bind_group(1, &*c.bind_group, &[]);
                pass.set_vertex_buffer(0, m.vertices.slice(..));
                if let Some(extra) = &c.extra {
                    pass.set_vertex_buffer(1, extra.slice(..));
                }
                pass.set_index_buffer(m.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(range, 0, 0..c.instances);
                continue;
            };
            let g = self.gpu_items[i].as_ref().unwrap();
            let (frame_group, pipeline) = match (&self.holo_gpu, key.holo) {
                (Some(h), true) => (&h.frame_bind_group, &h.pipelines[key]),
                _ => (frame, &shared[key]),
            };
            pass.set_bind_group(0, frame_group, &[]);
            pass.set_pipeline(pipeline);
            pass.set_bind_group(1, &g.bind_group, &[self.offset(i)]);
            if key.glass {
                let t = self.glass_gpu.as_ref().and_then(|g| g.targets.as_ref()).expect("glass buffers");
                let back = glass.is_some_and(|(gi, b)| gi == i && b == GlassBuffer::Back);
                pass.set_bind_group(2, if back { &t.6 } else { &t.5 }, &[]);
            }
            pass.set_vertex_buffer(0, m.vertices.slice(..));
            pass.set_index_buffer(m.indices.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(0..m.count, 0, 0..1);
        }
    }
}

/// A texture from its mip chain (`material::mip_chain`), RGBA8 rows with v = 0 first.
pub fn upload(device: &wgpu::Device, queue: &wgpu::Queue, levels: &[(u32, u32, Vec<u8>)], srgb: bool) -> wgpu::Texture {
    let (w, h, _) = levels[0];
    let format = if srgb { wgpu::TextureFormat::Rgba8UnormSrgb } else { wgpu::TextureFormat::Rgba8Unorm };
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: levels.len() as u32,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for (i, (lw, lh, data)) in levels.iter().enumerate() {
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: i as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            data,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * lw), rows_per_image: Some(*lh) },
            wgpu::Extent3d { width: *lw, height: *lh, depth_or_array_layers: 1 },
        );
    }
    tex
}

/// Group 0: the frame uniform and the environment atlas.
fn frame_bind_group(device: &wgpu::Device, core: &Core, frame_buffer: &wgpu::Buffer, atlas: &wgpu::Texture) -> wgpu::BindGroup {
    let atlas_view = atlas.create_view(&Default::default());
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &core.frame_layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: frame_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&atlas_view) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&core.linear) },
        ],
    })
}

pub(crate) fn uniform_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

/// An item's uniforms: its slot of the renderer's buffer, at a dynamic offset (`Renderer::uniforms`).
fn slot_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: None },
        count: None,
    }
}

pub(crate) fn texture_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

pub(crate) fn sampler_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    }
}

impl HoloGpu {
    fn new(device: &wgpu::Device) -> HoloGpu {
        let shader =
            device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("holo"), source: wgpu::ShaderSource::Wgsl(wgsl!("holo.wgsl").into()) });
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("holo frame"), entries: &[uniform_entry(0)] });
        let draw_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("holo draw"), entries: &[slot_entry(0)] });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("holo"),
            bind_group_layouts: &[Some(&frame_layout), Some(&draw_layout)],
            immediate_size: 0,
        });
        let frame_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("holo frame"),
            size: size_of::<HoloFrameUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let frame_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &frame_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: frame_buffer.as_entire_binding() }],
        });
        HoloGpu { shader, layout, draw_layout, frame_buffer, frame_bind_group, pipelines: HashMap::new() }
    }
}
