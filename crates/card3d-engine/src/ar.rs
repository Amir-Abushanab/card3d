//! AR export (`ar/index.ts`, which bakes on three): the card as a light, real-scale model for AR
//! viewers, written as GLB (Scene Viewer and other glTF viewers) or USDZ (AR Quick Look).
//!
//! The live card is dozens of stacked layers with shaders no AR format can carry, so each face is
//! baked: the card, built for printing (`CardOptions::print`), is drawn face-on with an orthographic
//! camera into three maps through the print bake's passes (`print.rs`, choices `AR_*`): unlit colour
//! (shader layers as they render face-on), roughness / metalness packed glTF-style (G, B) and the
//! tangent-space normal (normal and bump maps; flat where a layer such as a sticker covers them), each
//! composited over the bare body's values. The model is the body's side walls and bevel (one metal
//! material) and its two caps carrying the maps (planar UVs over the print frame, so cutouts stay
//! holes), at ISO/IEC 7810 ID-1 scale (85.60 × 53.98 × 0.76 mm: card units are inches, the body is
//! stretched to 0.76 mm), lying face up on the floor plane (Y up) or standing.
//!
//! On the web this is the `ar` chunk (and the `print` chunk's passes): only pages that export AR
//! models download it. Textures are encoded by the host's canvas (PNG).

use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Poll, Waker};

use crate::canvas::Host;
use crate::card::CardRenderer;
use crate::geometry::Mesh;
use crate::print::{choice, role, PrintJob};

/// Metres per card unit (card units are inches: the width 3.37 is 85.6 mm).
pub const METERS_PER_UNIT: f64 = 0.0254;
/// ISO/IEC 7810 ID-1 thickness, metres.
pub const CARD_THICKNESS_M: f64 = 0.00076;
/// A clear card's model: its materials' opacity.
pub const GLASS_OPACITY: f64 = 0.55;

/// What `export` makes.
#[derive(Clone, Copy, Debug)]
pub struct ArOptions {
    /// Longest side of each baked map, px (three's default 2048).
    pub size: u32,
    /// Stand the card upright instead of lying face up.
    pub upright: bool,
    /// USDZ (AR Quick Look) instead of GLB.
    pub usdz: bool,
}

impl Default for ArOptions {
    fn default() -> Self {
        ArOptions { size: 2048, upright: false, usdz: false }
    }
}

/// A mesh of the model, not indexed (three's `toNonIndexed` order), in card units.
#[derive(Clone, Debug, Default)]
pub struct Surface {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    /// The caps' planar UVs over the print frame (v up, three's convention).
    pub uvs: Option<Vec<[f32; 2]>>,
}

/// A baked map: RGBA8, rows top first (the canvas three's bake fills).
#[derive(Clone, Debug, Default)]
pub struct Map {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// The side walls' material (glTF metallic-roughness), linear colour.
#[derive(Clone, Copy, Debug, Default)]
pub struct EdgeMaterial {
    pub color: [f64; 3],
    pub metalness: f64,
    pub roughness: f64,
}

/// The baked model (`bakeCardModel`): group "card" ⊃ "card body" (`matrix`) ⊃ edge, front face, back face.
#[derive(Clone, Debug, Default)]
pub struct Model {
    pub edge: Surface,
    pub front: Surface,
    pub back: Surface,
    /// [front, back] × [colour (sRGB), orm, normal].
    pub maps: [[Map; 3]; 2],
    pub edge_material: EdgeMaterial,
    /// A clear card: every material at `GLASS_OPACITY`, blended.
    pub glass: bool,
    /// The "card body" node's matrix (column-major): inches → metres, stretched to the ISO thickness,
    /// lying face up (or upright) and resting on y = 0.
    pub matrix: [f64; 16],
}

/// What `export` returns: the file's bytes once baked and written.
pub type Export = Pin<Box<dyn Future<Output = Result<Vec<u8>, crate::LoadError>>>>;

/// Bakes `card` (built with `CardOptions::print` on `device`, full quality, the
/// `Rgba8UnormSrgb` format, as for a print bake) into the AR model and writes it (`options`); empty
/// when the host's canvas couldn't encode the textures (a page without a document). The
/// passes' pixels arrive by themselves on WebGPU and natively; in the browser's WebGL build the host
/// polls the device (`device.poll`) until the future is done. Fails with a `LoadError` only when the
/// `print` chunk couldn't be downloaded.
#[wasm_split_helpers::wasm_split(ar, fallible)]
pub fn export(
    card: CardRenderer,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    host: Box<dyn Host>,
    options: ArOptions,
) -> Result<Export, crate::ChunkUnavailable> {
    let plan = Plan::new(&card, options);
    let (device, queue) = (device.clone(), queue.clone());
    Ok(Box::pin(async move {
        let mut job = crate::print::start(card, &device, &queue).await.map_err(crate::chunk("print"))?;
        let maps = plan.bake(&mut *job, &device, &queue).await;
        drop(job);
        let model = plan.model(maps);
        // Empty when the host couldn't encode the textures.
        let Some(images) = encode(&model, &*host) else { return Ok(Vec::new()) };
        Ok(match options.usdz {
            true => crate::ar_formats::usdz(&model, &images, options.upright, &*host, "card3d"),
            false => crate::ar_formats::glb(&model, &images, &*host, "card3d"),
        })
    }))
}

/// The faces' maps as PNG (the host's canvas), flipped as three's exporters write a `CanvasTexture`
/// (flipY): rows bottom first. `None` when the host can't encode.
fn encode(model: &Model, host: &dyn Host) -> Option<[[Vec<u8>; 3]; 2]> {
    let png = |m: &Map| {
        let mut c = host.canvas(m.width, m.height);
        let flipped: Vec<u8> = m.rgba.chunks_exact(4 * m.width as usize).rev().flatten().copied().collect();
        c.put_image_data(&flipped);
        let url = c.to_data_url();
        base64(url.strip_prefix("data:image/png;base64,")?)
    };
    let [f, b] = &model.maps;
    Some([[png(&f[0])?, png(&f[1])?, png(&f[2])?], [png(&b[0])?, png(&b[1])?, png(&b[2])?]])
}

/// Standard base64 (a data URL's payload).
pub fn base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in text.bytes().filter(|&c| c != b'=') {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    (!out.is_empty()).then_some(out)
}

/// What the bake needs from the card and design, read before the print job takes the card.
struct Plan {
    options: ArOptions,
    /// The print frame (`cardFrameSize`), card units.
    frame: (f64, f64),
    /// The bare body's colour (sRGB bytes), roughness and metalness: under the faces' maps.
    body: ([u8; 3], f64, f64),
    edge: EdgeMaterial,
    glass: bool,
    mesh: Mesh,
}

impl Plan {
    fn new(card: &CardRenderer, options: ArOptions) -> Plan {
        let (fw, fh) = (card.frame.width, card.frame.height);
        // The card's resolved material (`resolveMaterial`).
        let m = card.material.unwrap_or_default();
        let linear = m.color.map(|c| c as f64);
        // `Color.convertLinearToSRGB`, then `toByte`.
        let srgb = linear.map(|c| {
            let s = if c < 0.0031308 { c * 12.92 } else { 1.055 * c.powf(0.41666) - 0.055 };
            (s.clamp(0.0, 1.0) * 255.0).round() as u8
        });
        // With an edge finish the body's third material is the wall's (`bodyMesh.material[2]`).
        let r = &card.renderer;
        let bodies: Vec<usize> = (0..r.items.len()).filter(|&i| r.tags.get(i).is_some_and(|t| t[0] == role::BODY)).collect();
        let wall = (card.body.is_some() && bodies.len() == 3).then(|| &r.items[bodies[2]].material);
        let edge = EdgeMaterial {
            color: wall.map_or(linear, |w| w.color.map(|c| c as f64)),
            metalness: wall.map_or(m.metalness, |w| w.metalness as f64),
            roughness: wall.map_or(m.roughness, |w| w.roughness as f64).max(0.12),
        };
        let mesh = card.body.clone().unwrap_or_else(|| fallback_body(fw, fh));
        Plan { options, frame: (fw, fh), body: (srgb, m.roughness, m.metalness), edge, glass: m.glass(), mesh }
    }

    /// The six passes: per side, colour, orm and normal, each composited over the bare body.
    async fn bake(&self, job: &mut dyn PrintJob, device: &wgpu::Device, queue: &wgpu::Queue) -> [[Map; 3]; 2] {
        // The longest side `size` (at most what the GPU renders), the other in the frame's proportion.
        let (fw, fh) = self.frame;
        let size = self.options.size.clamp(1, job.max_size().max(1));
        let (w, h) = if fw >= fh { (size, (size as f64 * fh / fw).round() as u32) } else { ((size as f64 * fw / fh).round() as u32, size) };
        let (w, h) = (w.max(1), h.max(1));
        let byte = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        let unders = [self.body.0, [255, byte(self.body.1), byte(self.body.2)], [128, 128, 255]];
        let mut maps: [[Map; 3]; 2] = Default::default();
        for (side, out) in maps.iter_mut().enumerate() {
            for (pass, (c, target)) in [(choice::AR_COLOR, 0.0), (choice::AR_ORM, 1.0), (choice::AR_NORMAL, 1.0)].into_iter().enumerate() {
                let mut spec = vec![side as f32, target, w as f32, h as f32, (self.frame.0 / 2.0) as f32, (self.frame.1 / 2.0) as f32];
                for _ in 0..job.count() {
                    spec.extend([c as f32, 0.0]);
                }
                let mut px = read(job, device, queue, &spec).await;
                if px.len() != (4 * w * h) as usize {
                    px = vec![0; (4 * w * h) as usize];
                }
                out[pass] = Map { width: w, height: h, rgba: composite(&px, unders[pass]) };
            }
        }
        maps
    }

    fn model(&self, maps: [[Map; 3]; 2]) -> Model {
        let (front, back, edge, depth) = split_body(&self.mesh, self.frame.0, self.frame.1);
        // Inches → metres, the body stretched to the ISO thickness; lying face up (rotated −π/2 about
        // x) or upright, resting on y = 0 (three's `Matrix4.compose`).
        let (sx, sz) = (METERS_PER_UNIT, CARD_THICKNESS_M / depth.max(1e-6));
        let (position, angle) = match self.options.upright {
            true => ([0.0, self.frame.1 / 2.0 * METERS_PER_UNIT, 0.0], 0.0),
            false => ([0.0, CARD_THICKNESS_M / 2.0, 0.0], -std::f64::consts::FRAC_PI_2),
        };
        Model { edge, front, back, maps, edge_material: self.edge, glass: self.glass, matrix: compose(position, angle, [sx, sx, sz]) }
    }
}

/// three's `Matrix4.compose(position, quaternion (Euler XYZ (x, 0, 0)), scale)`, column-major.
pub fn compose(p: [f64; 3], angle_x: f64, s: [f64; 3]) -> [f64; 16] {
    // `Quaternion.setFromEuler`: x = sin(x / 2), w = cos(x / 2); fdlibm, as V8.
    let (x, y, z, w) = (libm::sin(angle_x / 2.0), 0.0, 0.0, libm::cos(angle_x / 2.0));
    let (x2, y2, z2) = (x + x, y + y, z + z);
    let (xx, xy, xz) = (x * x2, x * y2, x * z2);
    let (yy, yz, zz) = (y * y2, y * z2, z * z2);
    let (wx, wy, wz) = (w * x2, w * y2, w * z2);
    [
        (1.0 - (yy + zz)) * s[0],
        (xy + wz) * s[0],
        (xz - wy) * s[0],
        0.0,
        (xy - wz) * s[1],
        (1.0 - (xx + zz)) * s[1],
        (yz + wx) * s[1],
        0.0,
        (xz + wy) * s[2],
        (yz - wx) * s[2],
        (1.0 - (xx + yy)) * s[2],
        0.0,
        p[0],
        p[1],
        p[2],
        1.0,
    ]
}

/// A pass's pixels (`PrintJob::render`, rows top first, premultiplied by the blending) composited over
/// `under` (the bare body: the face's outer edge and any gaps carry its values), opaque (`toCanvas`).
pub fn composite(px: &[u8], under: [u8; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(px.len());
    for p in px.as_chunks::<4>().0 {
        let a = p[3] as f64 / 255.0;
        for k in 0..3 {
            // Uint8ClampedArray: round half to even, clamp.
            out.push((p[k] as f64 + under[k] as f64 * (1.0 - a)).round_ties_even().clamp(0.0, 255.0) as u8);
        }
        out.push(255);
    }
    out
}

/// Renders a pass and waits for its pixels.
async fn read(job: &mut dyn PrintJob, device: &wgpu::Device, queue: &wgpu::Queue, spec: &[f32]) -> Vec<u8> {
    type Slot = Rc<RefCell<(Option<Vec<u8>>, Option<Waker>)>>;
    let slot: Slot = Rc::new(RefCell::new((None, None)));
    let s = slot.clone();
    job.render(
        device,
        queue,
        spec,
        Box::new(move |px| {
            let waker = {
                let mut s = s.borrow_mut();
                s.0 = Some(px);
                s.1.take()
            };
            if let Some(w) = waker {
                w.wake();
            }
        }),
    );
    std::future::poll_fn(move |cx| {
        let mut s = slot.borrow_mut();
        match s.0.take() {
            Some(px) => Poll::Ready(px),
            None => {
                s.1 = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    })
    .await
}

/// `splitCardBody`: the body's flat caps (planar UVs over the print frame; the back's seen from its
/// own side) and everything else (with the body's normals), and its depth.
pub fn split_body(body: &Mesh, frame_w: f64, frame_h: f64) -> (Surface, Surface, Surface, f64) {
    let index: Vec<usize> = match body.indices.is_empty() {
        true => (0..body.positions.len()).collect(),
        false => body.indices.iter().map(|&i| i as usize).collect(),
    };
    let (mut front, mut back, mut edge) = (Vec::new(), Vec::new(), Surface::default());
    let (mut z_min, mut z_max) = (f64::INFINITY, f64::NEG_INFINITY);
    let v = |i: usize| glam::DVec3::from_array(body.positions[i].map(|c| c as f64));
    for t in index.as_chunks::<3>().0 {
        let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
        let n = (b - a).cross(c - a).normalize_or_zero();
        for p in [a, b, c] {
            z_min = z_min.min(p.z);
            z_max = z_max.max(p.z);
        }
        let tri = [t[0], t[1], t[2]].map(|i| body.positions[i]);
        if n.z > 0.985 {
            front.extend(tri);
        } else if n.z < -0.985 {
            back.extend(tri);
        } else {
            edge.positions.extend(tri);
            for &i in t {
                edge.normals.push(body.normals.get(i).copied().unwrap_or(n.as_vec3().to_array()));
            }
        }
    }
    let cap = |positions: Vec<[f32; 3]>, sign: f64| {
        let normals = vec![[0.0, 0.0, sign as f32]; positions.len()];
        let uvs = positions.iter().map(|p| [(0.5 + sign * p[0] as f64 / frame_w) as f32, (0.5 + p[1] as f64 / frame_h) as f32]).collect();
        Surface { positions, normals, uvs: Some(uvs) }
    };
    (cap(front, 1.0), cap(back, -1.0), edge, z_max - z_min)
}

/// A plain rounded slab of the frame's size, for cards without a metal body (glass, one-offs, moss):
/// ID-1 corners (3.18 mm, circular), extruded without a bevel (`fallbackBody`).
pub fn fallback_body(frame_w: f64, frame_h: f64) -> Mesh {
    use std::f64::consts::PI;
    let r = 3.18 / crate::iso::MM_PER_UNIT;
    let (x, y) = (frame_w / 2.0, frame_h / 2.0);
    let mut shape = crate::extrude::Shape::new();
    shape.move_to(-x + r, -y);
    shape.line_to(x - r, -y);
    shape.absarc(x - r, -y + r, r, -PI / 2.0, 0.0, false);
    shape.line_to(x, y - r);
    shape.absarc(x - r, y - r, r, 0.0, PI / 2.0, false);
    shape.line_to(-x + r, y);
    shape.absarc(-x + r, y - r, r, PI / 2.0, PI, false);
    shape.line_to(-x, -y + r);
    shape.absarc(-x + r, -y + r, r, PI, 1.5 * PI, false);
    let depth = 0.0274302;
    let mut g =
        crate::extrude::extrude_geometry(&shape, &crate::extrude::ExtrudeOptions { depth, bevel_enabled: false, curve_segments: 8, ..Default::default() });
    crate::extrude::translate(&mut g, 0.0, 0.0, -depth / 2.0);
    g
}
