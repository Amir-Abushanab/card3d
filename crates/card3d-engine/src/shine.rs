//! The shine add-on (`addons.shine`; addons/shine/index.ts and rig.ts):
//! two point lights, a pastel aura ring, two streaks and a glint sprite that drift over the front face
//! and fade with the card's distance from the stage centre and with how squarely it faces the camera.
//! `intensity` scales every light and opacity. The clock runs from the build, frozen at `time` when
//! given and held at 0 under reduced motion. On the web the build is the
//! `shine` chunk; the per-frame update (`Shine::prepare`) is small and stays in main.

use crate::canvas::{Composite, Host, Paint};
use crate::effect_params::{Default as D, EffectParam as P, Kind as K};
use crate::json::Map;

use crate::effects::{bind_group, bind_layout, blend, pipeline, Bind, PipelineOptions, Target};
use crate::layout::{CARD_H, CARD_W};
use crate::renderer::{CustomDraw, Item, Material, PointLight, Renderer, Wrap};
use glam::{Mat4, Vec3};
use std::f64::consts::PI;
use std::rc::Rc;

/// `EFFECT_PARAMS.shine`.
pub const PARAMS: &[P] = &[
    P::new("tone", K::Select(&["gold", "ice"]), D::Str("gold")),
    P::new("intensity", K::Float { min: 0.0, max: 2.0 }, D::Num(1.0)),
    P::new("time", K::Float { min: 0.0, max: 3600.0 }, D::Num(0.0)).optional(),
];

/// A tone's colours (`PALETTES`): warm light, key light, streak (hex), cream (sRGB 0–255).
struct Palette {
    warm: &'static str,
    key: &'static str,
    streak: &'static str,
    cream: [f64; 3],
}

const GOLD: Palette = Palette { warm: "#ffc878", key: "#fff6e4", streak: "#ffd89a", cream: [255.0, 246.0, 228.0] };
const ICE: Palette = Palette { warm: "#7ad8ff", key: "#e8f6ff", streak: "#b8e8ff", cream: [210.0, 236.0, 255.0] };

const PASTEL: [[f64; 3]; 6] =
    [[255.0, 186.0, 186.0], [255.0, 214.0, 170.0], [255.0, 245.0, 186.0], [186.0, 235.0, 210.0], [186.0, 210.0, 255.0], [230.0, 196.0, 255.0]];
const W: f64 = CARD_W;
const H: f64 = CARD_H;
const RD: f64 = 0.58 * W;
const RO: f64 = 0.52 * H;
/// The standard metal body's front face (bodyDepth / 2), where the rig's layer offsets start.
const METAL_FACE_Z: f64 = 0.0274302 / 2.0;

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}
fn smooth(x: f64) -> f64 {
    let t = clamp01(x);
    t * t * (3.0 - 2.0 * t)
}

/// The pastel cycle at `phase` (wraps), sRGB 0–255: 0.65·stop + 0.35·cream.
fn pastel(phase: f64, cream: [f64; 3]) -> [f64; 3] {
    let p = (((phase % 1.0) + 1.0) % 1.0) * PASTEL.len() as f64;
    let i = p.floor();
    let f = p - i;
    let (a, b) = (PASTEL[i as usize % 6], PASTEL[(i as usize + 1) % 6]);
    [0, 1, 2].map(|k| 0.65 * (a[k] + (b[k] - a[k]) * f) + 0.35 * cream[k])
}

/// `Color.setRGB(r / 255, g / 255, b / 255, SRGBColorSpace)`: linear.
fn srgb255_to_linear(c: [f64; 3]) -> [f32; 3] {
    c.map(|v| {
        let c = v / 255.0;
        (if c < 0.04045 { c * 0.0773993808 } else { (c * 0.9478672986 + 0.0521327014).powf(2.4) }) as f32
    })
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct LayerUniform {
    color: [f32; 4],
    misc: [f32; 4],
}

/// The rig over a card: its items (aura, streak, rainbow streak, glint) and their state.
pub struct Shine {
    items: [usize; 4],
    uniforms: [Rc<wgpu::Buffer>; 4],
    /// The rig's offset off the body (a glass body is thicker than the metal one the rig was laid out for).
    z0: f64,
    gain: f64,
    key: [f32; 3],
    warm: [f32; 3],
    streak: [f32; 3],
    cream: [f64; 3],
    clock: f64,
    pub animated: bool,
    /// The glint's position and scale (kept while it is faded out).
    glint: ([f64; 3], [f64; 2]),
    /// `prepare_frame`, reached through a pointer made in the chunk so that its code stays there.
    prepare_fn: fn(&mut Shine, &mut Renderer, &wgpu::Queue, Mat4, &crate::renderer::Camera),
}

/// Adds the rig to the card (body thickness `body_depth`). `values`: `design.addons.shine` (its `time`
/// freezes the clock); `glass`: the items also draw into the glass's buffers.
#[wasm_split_helpers::wasm_split(shine, fallible)]
pub fn build(
    r: &mut Renderer,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    host: &dyn Host,
    body_depth: f64,
    values: Option<&Map>,
    reduced_motion: bool,
    glass: bool,
) -> Result<Shine, crate::ChunkUnavailable> {
    // `addons.shine` supplies the tone and intensity (`resolveEffectParams`).
    let p = crate::effect_params::resolve(PARAMS, values);
    let pal = if p.str("tone") == "ice" { ICE } else { GOLD };
    let cream = pal.cream;

    // Aura: a 256×384 ring, pastel hue by angle.
    let aura_px = pixels(256, 384, |x, y| {
        let d = crate::vines_model::hypot(x, y);
        let a = (-((d - 0.82) / 0.16).powi(2)).exp() * smooth((d - 0.55) / 0.23) * (1.0 - smooth((d - 0.92) / 0.2));
        let c = pastel((crate::vines_model::atan2(y, x) / (2.0 * PI) + 1.0) % 1.0, cream);
        [c[0], c[1], c[2], a]
    });
    // Streak: white, alpha (1 − |x|)^1.25 · (1 − |y|)^3.1.
    let streak_px = pixels(256, 64, |x, y| [255.0, 255.0, 255.0, (1.0 - x.abs()).powf(1.25) * (1.0 - y.abs()).powf(3.1)]);
    // Rainbow streak: pastel along x, alpha exponents 1.2 / 3.4.
    let rainbow_px = pixels(256, 64, |x, y| {
        let c = pastel((x + 1.0) / 2.0, cream);
        [c[0], c[1], c[2], (1.0 - x.abs()).powf(1.2) * (1.0 - y.abs()).powf(3.4)]
    });
    let [cr, cg, cb] = cream;
    let mut textures = Vec::new();
    for (w, h, px) in [(256, 384, Some(aura_px)), (256, 64, Some(streak_px)), (256, 64, Some(rainbow_px)), (64, 64, None)] {
        let mut c = host.canvas(w, h);
        match px {
            Some(px) => c.put_image_data(&px),
            None => {
                // Glint: a radial core and two crossed soft bars, added.
                c.set_fill(Paint::Radial {
                    from: [32.0, 32.0, 0.0],
                    to: [32.0, 32.0, 12.8],
                    stops: vec![(0.0, "rgba(255,255,255,1)".into()), (0.38, format!("rgba({cr},{cg},{cb},0.5)")), (1.0, format!("rgba({cr},{cg},{cb},0)"))],
                });
                c.fill_rect(0.0, 0.0, 64.0, 64.0);
                c.set_composite(Composite::Lighter);
                for (half, thickness, alpha, vertical) in [(28.8, 1.4, 0.7, false), (19.2, 1.05, 0.48, true)] {
                    let stops = vec![(0.0, "rgba(255,255,255,0)".into()), (0.5, format!("rgba(255,255,255,{alpha})")), (1.0, "rgba(255,255,255,0)".into())];
                    if vertical {
                        c.set_fill(Paint::Linear { from: [32.0, 32.0 - half], to: [32.0, 32.0 + half], stops });
                        c.fill_rect(32.0 - thickness / 2.0, 32.0 - half, thickness, 2.0 * half);
                    } else {
                        c.set_fill(Paint::Linear { from: [32.0 - half, 32.0], to: [32.0 + half, 32.0], stops });
                        c.fill_rect(32.0 - half, 32.0 - thickness / 2.0, 2.0 * half, thickness);
                    }
                }
            }
        }
        // A CanvasTexture (flipY: the top row at v = 1), sRGB, trilinear.
        let data = c.get_image_data();
        let flipped: Vec<u8> = data.chunks_exact(4 * w as usize).rev().flatten().copied().collect();
        textures.push(r.texture_with(device, queue, &crate::material::mip_chain(&flipped, w, h, true), true, Wrap::Clamp, 1));
    }

    let module =
        device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("shine"), source: wgpu::ShaderSource::Wgsl(wgsl!("shine.wgsl").into()) });
    let layout = bind_layout(device, "shine", &[Bind::Uniform, Bind::Texture, Bind::Sampler]);
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..Default::default()
    });
    let pipelines = |vs: &'static str| {
        let o = PipelineOptions { entries: (vs, "fs_main"), depth_write: false, blend: Some(blend::ADDITIVE), ..PipelineOptions::new("shine", &module) };
        (
            Rc::new(pipeline(r, device, &layout, &o, Target::Canvas)),
            (glass || r.offscreen).then(|| Rc::new(pipeline(r, device, &layout, &o, Target::GlassBuffer))),
        )
    };
    let (plane, plane_buffer) = pipelines("vs_main");
    let (sprite, sprite_buffer) = pipelines("vs_sprite");
    let sprite_mesh = crate::geometry::Mesh {
        positions: vec![[-0.5, -0.5, 0.0], [0.5, -0.5, 0.0], [0.5, 0.5, 0.0], [-0.5, 0.5, 0.0]],
        normals: vec![[0.0, 0.0, 1.0]; 4],
        uvs: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
        indices: vec![0, 1, 2, 0, 2, 3],
    };
    let meshes = [
        r.mesh(device, &crate::geometry::plane((1.12 * W) as f32, (1.1 * H) as f32)),
        r.mesh(device, &crate::geometry::plane((0.82 * W) as f32, (0.11 * H) as f32)),
        r.mesh(device, &crate::geometry::plane((0.72 * W) as f32, (0.07 * H) as f32)),
        r.mesh(device, &sprite_mesh),
    ];
    let z0 = (body_depth / 2.0 - METAL_FACE_Z).max(0.0);
    let mut items = [0; 4];
    let uniforms = [0, 1, 2, 3].map(|_| crate::effects::uniform_buffer(device, queue, "shine", &[0; 96]));
    for k in 0..4 {
        let group = bind_group(
            device,
            &layout,
            &[uniforms[k].as_entire_binding(), wgpu::BindingResource::TextureView(r.texture_view(textures[k])), wgpu::BindingResource::Sampler(&sampler)],
        );
        let (pl, buffer) = if k == 3 { (&sprite, &sprite_buffer) } else { (&plane, &plane_buffer) };
        let draw = CustomDraw { buffer_pipeline: buffer.clone(), ..CustomDraw::new(pl.clone(), Rc::new(group), uniforms[k].clone()) };
        let material = Material { transparent: true, depth_write: false, ..Default::default() };
        let transform = Mat4::from_translation(Vec3::new(0.0, 0.0, (z0 + if k == 0 { 0.047 } else { 0.0 }) as f32));
        items[k] = r.add_custom(Item { mesh: meshes[k], material, transform, render_order: [7.0, 8.0, 8.0, 9.0][k], visible: true }, draw);
    }

    let frozen = p.get("time").map(|_| p.num("time"));
    let animated = frozen.is_none() && !reduced_motion;
    Ok(Shine {
        items,
        uniforms,
        z0,
        gain: p.num("intensity"),
        key: crate::material::srgb_hex_to_linear(pal.key),
        warm: crate::material::srgb_hex_to_linear(pal.warm),
        streak: crate::material::srgb_hex_to_linear(pal.streak),
        cream,
        clock: frozen.unwrap_or(0.0),
        animated,
        glint: ([0.0; 3], [1.0, 1.0]),
        prepare_fn: prepare_frame,
    })
}

/// `pixelTexture`'s pixels: `f(x, y)` over x, y ∈ [−1, 1] (rows top first), stored as a
/// Uint8ClampedArray stores them (colour rounded half to even, alpha by `Math.round`).
fn pixels(w: u32, h: u32, f: impl Fn(f64, f64) -> [f64; 4]) -> Vec<u8> {
    let mut out = vec![0u8; (4 * w * h) as usize];
    for j in 0..h {
        for i in 0..w {
            let [r, g, b, a] = f((i as f64 + 0.5) / w as f64 * 2.0 - 1.0, (j as f64 + 0.5) / h as f64 * 2.0 - 1.0);
            let o = (4 * (j * w + i)) as usize;
            for (k, v) in [r, g, b].into_iter().enumerate() {
                out[o + k] = v.clamp(0.0, 255.0).round_ties_even() as u8;
            }
            out[o + 3] = (clamp01(a) * 255.0 + 0.5).floor() as u8;
        }
    }
    out
}

impl Shine {
    /// Advances the clock (when it runs).
    pub fn update(&mut self, dt: f64) {
        if self.animated {
            self.clock += dt.max(0.0);
        }
    }

    /// The per-frame state (`rig.update`) for the card at `model`, the camera `cam`:
    /// the lights, the layers' placement, colours and opacities.
    pub fn prepare(&mut self, r: &mut Renderer, queue: &wgpu::Queue, model: Mat4, cam: &crate::renderer::Camera) {
        (self.prepare_fn)(self, r, queue, model, cam)
    }
}

/// `Shine::prepare`. Only the `shine` chunk refers to it (by address), so its code lives there.
fn prepare_frame(this: &mut Shine, r: &mut Renderer, queue: &wgpu::Queue, model: Mat4, cam: &crate::renderer::Camera) {
    this.prepare_frame(r, queue, model, cam)
}

impl Shine {
    #[inline(always)]
    fn prepare_frame(&mut self, r: &mut Renderer, queue: &wgpu::Queue, model: Mat4, cam: &crate::renderer::Camera) {
        let t = self.clock + 0.37 * PI;
        let gain = self.gain;
        let pos = model.w_axis.truncate().as_dvec3();
        let centre = smooth(1.0 - clamp01(pos.x.abs() / 5.2)).powf(1.25);
        let light = |position: [f64; 3], color: [f32; 3], intensity: f64, distance: f32| PointLight {
            position: [position[0] as f32, position[1] as f32, (position[2] + self.z0) as f32],
            color: color.map(|c| c * intensity as f32),
            distance,
            decay: 2.0,
        };
        let visible = centre >= 0.004;
        for &i in &self.items {
            r.items[i].visible = visible;
        }
        if !visible {
            r.point_lights = vec![light([0.0; 3], self.key, 0.0, 5.0), light([0.0; 3], self.warm, 0.0, 4.5)];
            return;
        }
        let normal = model.z_axis.truncate().as_dvec3().normalize();
        let to_cam = (cam.eye - pos).normalize();
        let facing = clamp01(normal.dot(to_cam)).powf(1.55);
        let amp = (0.38 + 0.62 * facing) * (0.58 + 0.42 * centre);

        let key = [(0.38 * t).cos() * RD, (0.29 * t).sin() * RO + 0.2 * RO, 1.05 + 0.28 * (0.22 * t).sin()];
        let t2 = t + 0.9 * PI;
        let warm = [(0.33 * t2).cos() * 0.85 * RD, (0.26 * t2).sin() * 0.9 * RO - 0.15 * RO, 0.85 + 0.22 * (0.2 * t2).cos()];
        r.point_lights = vec![light(key, self.key, 4.2 * amp * gain, 5.0), light(warm, self.warm, 2.95 * amp * gain, 4.5)];

        let s = (key[0] / RD).clamp(-1.0, 1.0);
        let tt = ((key[1] - 0.2 * RO) / RO).clamp(-1.0, 1.0);
        let pulse = (0.5 + 0.5 * (0.5 * t + 0.35).sin()).powi(4);
        let a = (0.07 + 0.32 * pulse) * facing * (0.65 + 0.35 * centre);
        let place =
            |x: f64, y: f64, z: f64, rz: f64| Mat4::from_translation(Vec3::new(x as f32, y as f32, (z + self.z0) as f32)) * Mat4::from_rotation_z(rz as f32);
        let lin = |c: [f64; 3]| srgb255_to_linear(c);

        // Aura.
        let aura_opacity = if centre < 0.03 { 0.0 } else { (0.06 + 0.1 * (0.55 + 0.45 * (0.7 * t).sin())) * facing * centre * gain };
        let aura_color = if centre < 0.03 { None } else { Some(lin(pastel(0.035 * t + 0.08 * (0.38 * t), self.cream))) };
        r.items[self.items[0]].transform = place(0.0, 0.0, 0.047, 0.04 * (0.15 * t).sin());
        // Streak and rainbow streak.
        r.items[self.items[1]].transform = place(0.2 * W * s, 0.1 * H * tt, 0.055, -0.12 + 0.06 * s);
        r.items[self.items[2]].transform = place(0.22 * W * s, 0.11 * H * tt, 0.057, -0.1 + 0.07 * s + 0.03 * (0.2 * t).sin());
        let rainbow = lin(pastel(0.12 * (0.38 * t) + 0.04 * t, self.cream));
        // Glint.
        let mut glint_opacity = 0.0;
        if centre >= 0.02 {
            let g = (0.5 + 0.5 * (1.85 * t).sin()).powi(14) * facing * centre;
            glint_opacity = 0.78 * g * gain;
            let k = 0.18 + 0.48 * g;
            self.glint = ([0.18 * W * s, 0.14 * H * tt, 0.065], [1.35 * k, k]);
        }
        let ([gx, gy, gz], [sx, sy]) = self.glint;
        r.items[self.items[3]].transform =
            Mat4::from_translation(Vec3::new(gx as f32, gy as f32, (gz + self.z0) as f32)) * Mat4::from_scale(Vec3::new(sx as f32, sy as f32, 1.0));

        let write = |k: usize, color: [f32; 3], opacity: f64| {
            let u = LayerUniform { color: [color[0], color[1], color[2], opacity as f32], misc: [(0.04 * t) as f32, 0.0, 0.0, 0.0] };
            queue.write_buffer(&self.uniforms[k], 64, bytemuck::bytes_of(&u));
        };
        if let Some(c) = aura_color {
            write(0, c, aura_opacity);
        } else {
            // The colour keeps its last value; only the opacity changes.
            queue.write_buffer(&self.uniforms[0], 76, bytemuck::bytes_of(&0.0f32));
        }
        write(1, self.streak, a * gain);
        write(2, rainbow, 0.55 * a * (0.45 + 0.55 * pulse) * gain);
        if centre >= 0.02 {
            write(3, [1.0; 3], glint_opacity);
        } else {
            queue.write_buffer(&self.uniforms[3], 76, bytemuck::bytes_of(&0.0f32));
        }
    }
}
