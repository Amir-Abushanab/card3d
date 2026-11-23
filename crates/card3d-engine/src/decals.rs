//! Stickers (`card/decals.ts`, `design/decal.ts`): one textured quad per decal on the front or back,
//! placed by the planar algorithm, with its picture edits (crop, flip, opacity, tint,
//! brightness / contrast / saturation). Animated GIF stickers (`card/gif-decal.ts`) get their item here
//! and their frames from the host, which decodes the GIF and draws each frame's die-cut border
//! (`AnimatedSticker::show_frame`).

use crate::design::{b, n, obj, s};
use crate::json::Value;
use glam::{Mat4, Vec3};

use crate::canvas::{Host, ImagePurpose};
use crate::geometry;
use crate::material::mip_chain;
use crate::renderer::{DecalLook, Item, Material, MeshId, Renderer, TextureId, Wrap};

/// Sticker z above the body cap and per-index step, render order base (`LAYER.decal`).
const DECAL_Z: f64 = 0.0048;
const DECAL_Z_STEP: f64 = 0.0008;
pub const RENDER_ORDER: f32 = 30.0;

#[derive(Clone, Copy, Debug, Default)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Flip {
    pub h: bool,
    pub v: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Tint {
    pub color: String,
    pub amount: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Adjust {
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
}

/// `Decal` (types.ts): x / y / width are percentages of the face; rotation in degrees.
#[derive(Clone, Debug)]
pub struct Decal {
    pub id: String,
    pub side: Option<String>,
    pub src: Option<String>,
    pub aspect: Option<f64>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub rotation: f64,
    pub scale: Option<f64>,
    pub crop: Option<Crop>,
    pub flip: Option<Flip>,
    pub tint: Option<Tint>,
    pub adjust: Option<Adjust>,
    pub opacity: Option<f64>,
}

impl Default for Decal {
    fn default() -> Self {
        Decal {
            id: String::new(),
            side: None,
            src: None,
            aspect: None,
            x: 50.0,
            y: 50.0,
            width: 18.0,
            rotation: 0.0,
            scale: None,
            crop: None,
            flip: None,
            tint: None,
            adjust: None,
            opacity: None,
        }
    }
}

impl Decal {
    pub fn read(v: &Value) -> Self {
        let d = Self::default();
        Self {
            id: s(v, "id").unwrap_or_default(),
            side: s(v, "side"),
            src: s(v, "src"),
            aspect: n(v, "aspect"),
            x: n(v, "x").unwrap_or(d.x),
            y: n(v, "y").unwrap_or(d.y),
            width: n(v, "width").unwrap_or(d.width),
            rotation: n(v, "rotation").unwrap_or(d.rotation),
            scale: n(v, "scale"),
            crop: obj(v, "crop", |c| Crop {
                x: n(c, "x").unwrap_or(0.0),
                y: n(c, "y").unwrap_or(0.0),
                w: n(c, "w").unwrap_or(0.0),
                h: n(c, "h").unwrap_or(0.0),
            }),
            flip: obj(v, "flip", |f| Flip { h: b(f, "h").unwrap_or(false), v: b(f, "v").unwrap_or(false) }),
            tint: obj(v, "tint", |t| Tint { color: s(t, "color").unwrap_or_default(), amount: n(t, "amount").unwrap_or(0.0) }),
            adjust: obj(v, "adjust", |a| Adjust {
                brightness: n(a, "brightness").unwrap_or(0.0),
                contrast: n(a, "contrast").unwrap_or(0.0),
                saturation: n(a, "saturation").unwrap_or(0.0),
            }),
            opacity: n(v, "opacity"),
        }
    }

    pub fn back(&self) -> bool {
        self.side.as_deref() == Some("back")
    }
    /// An animated GIF (`isGifSource`): a `.gif` URL or a `data:image/gif` URL.
    pub fn gif(&self) -> bool {
        self.src
            .as_deref()
            .is_some_and(|s| s.starts_with("data:image/gif") || s.split(['?', '#']).next().is_some_and(|p| p.to_ascii_lowercase().ends_with(".gif")))
    }
}

/// `frontDecalMaxIndex`: the largest index of a decal not on the back, else −1.
pub fn front_decal_max_index(decals: &[Decal]) -> i32 {
    decals.iter().rposition(|d| !d.back()).map_or(-1, |i| i as i32)
}

/// `decalZ`: z of sticker `r` on the front (negate for the back).
pub fn decal_z(body_depth: f64, r: usize) -> f64 {
    body_depth / 2.0 + DECAL_Z + DECAL_Z_STEP * r as f64
}

fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    hi.min(lo.max(x))
}

/// `decalPlacement`: quad size, position and Euler XYZ rotation of decal `r` (its index in the whole
/// array). `frame`: the print area (portrait: 2.125 × 3.37).
pub fn placement(d: &Decal, image_aspect: Option<f64>, r: usize, body_depth: f64, frame: (f64, f64)) -> (f64, f64, [f64; 3], [f64; 3]) {
    let (card_w, card_h) = frame;
    let picture = d.aspect.unwrap_or_else(|| image_aspect.filter(|a| a.is_finite()).map_or(2.0, |a| clamp(a, 0.2, 5.0)));
    let aspect = d.crop.map_or(picture, |c| picture * c.w / c.h);
    let width = card_w * (d.width / 100.0) * d.scale.unwrap_or(1.0);
    let height = width / aspect;
    let theta = (-d.rotation).to_radians();
    let (c, s) = (theta.cos().abs(), theta.sin().abs());
    let hx = ((width / 2.0) * c + (height / 2.0) * s) / card_w * 100.0;
    let hy = ((width / 2.0) * s + (height / 2.0) * c) / card_h * 100.0;
    let px = if hx >= 50.0 { 50.0 } else { clamp(d.x, hx, 100.0 - hx) };
    let py = if hy >= 50.0 { 50.0 } else { clamp(d.y, hy, 100.0 - hy) };
    let z = decal_z(body_depth, r);
    let back = d.back();
    (
        width,
        height,
        [(px / 100.0 - 0.5) * card_w, (0.5 - py / 100.0) * card_h, if back { -z } else { z }],
        [0.0, if back { std::f64::consts::PI } else { 0.0 }, theta],
    )
}

/// `decalUvTransform`: `uv' = offset + uv · repeat` showing `crop`, flipped, for a flipY texture.
pub fn uv_transform(d: &Decal) -> ([f32; 2], [f32; 2]) {
    let c = d.crop.unwrap_or(Crop { x: 0.0, y: 0.0, w: 1.0, h: 1.0 });
    let f = d.flip.unwrap_or_default();
    let bottom = 1.0 - c.y - c.h;
    (
        [(if f.h { c.x + c.w } else { c.x }) as f32, (if f.v { bottom + c.h } else { bottom }) as f32],
        [(if f.h { -c.w } else { c.w }) as f32, (if f.v { -c.h } else { c.h }) as f32],
    )
}

/// The colour look (`applyDecalLook`): tint (rgb 0..1, amount) and brightness / contrast / saturation.
pub fn look(d: &Decal) -> Option<DecalLook> {
    let tint = d.tint.as_ref().filter(|t| t.amount > 0.0);
    let adjust = d.adjust.unwrap_or_default();
    if tint.is_none() && adjust.brightness == 0.0 && adjust.contrast == 0.0 && adjust.saturation == 0.0 {
        return None;
    }
    let tint = tint.map(|t| {
        let n = u32::from_str_radix(t.color.trim_start_matches('#'), 16).unwrap_or(0);
        [((n >> 16) & 255) as f32 / 255.0, ((n >> 8) & 255) as f32 / 255.0, (n & 255) as f32 / 255.0, t.amount as f32]
    });
    Some(DecalLook { tint: tint.unwrap_or([0.0; 4]), adjust: [adjust.brightness as f32, adjust.contrast as f32, adjust.saturation as f32] })
}

/// `createDecalMaterial` (matte vinyl with a faint clearcoat) with the sticker's picture edits.
fn sticker_material(d: &Decal, i: usize, map: TextureId) -> Material {
    let (offset, repeat) = uv_transform(d);
    Material {
        map: Some(map),
        map_offset: offset,
        map_repeat: repeat,
        opacity: d.opacity.unwrap_or(1.0) as f32,
        transparent: true,
        alpha_test: 0.02,
        depth_write: false,
        metalness: 0.0,
        roughness: 0.58,
        clearcoat: 0.2,
        clearcoat_roughness: 0.38,
        polygon_offset: Some((-6.0 - i as f32, -3.0)),
        look: look(d),
        face: Some(if d.back() { -1 } else { 1 }),
        ..Default::default()
    }
}

/// The quad of sticker `i` and its transform (`decalPlacement`).
fn sticker_quad(r: &mut Renderer, device: &wgpu::Device, d: &Decal, image_aspect: Option<f64>, i: usize, body_depth: f64, frame: (f64, f64)) -> (MeshId, Mat4) {
    let (w, h, pos, rot) = placement(d, image_aspect, i, body_depth, frame);
    let mesh = r.mesh(device, &geometry::plane(w as f32, h as f32));
    let transform = Mat4::from_translation(Vec3::new(pos[0] as f32, pos[1] as f32, pos[2] as f32))
        * Mat4::from_rotation_x(rot[0] as f32)
        * Mat4::from_rotation_y(rot[1] as f32)
        * Mat4::from_rotation_z(rot[2] as f32);
    (mesh, transform)
}

/// An animated GIF sticker: its item shows whatever frame the host last sent.
pub struct AnimatedSticker {
    /// The sticker's index in `CardDesign.decals`.
    pub decal: usize,
    sticker: Decal,
    item: usize,
    texture: TextureId,
    /// The quad's picture aspect: `decal.aspect ?? 1` until the first frame, then the bordered frame's.
    aspect: f64,
    body_depth: f64,
    frame: (f64, f64),
    /// `show_frame`'s code, in the `stickers` chunk.
    show: ShowFrame,
}

type ShowFrame = fn(&mut AnimatedSticker, &mut Renderer, &wgpu::Device, &wgpu::Queue, u32, u32, &[u8]);

impl AnimatedSticker {
    /// Shows a frame (RGBA, straight alpha, row 0 = top), as `drawFrame` leaves it on the GIF's canvas:
    /// the scaled frame inside its die-cut border. The quad follows the frame's aspect.
    pub fn show_frame(&mut self, r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, width: u32, height: u32, rgba: &[u8]) {
        (self.show)(self, r, device, queue, width, height, rgba)
    }

    fn show_impl(&mut self, r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, width: u32, height: u32, rgba: &[u8]) {
        if width == 0 || height == 0 || rgba.len() != (4 * width * height) as usize {
            return;
        }
        // A CanvasTexture: flipY, sRGB, linear filtering without mipmaps.
        let row = 4 * width as usize;
        let flipped: Vec<u8> = rgba.chunks_exact(row).rev().flatten().copied().collect();
        r.replace_texture(device, queue, self.texture, &[(width, height, flipped)], true);
        let aspect = width as f64 / height as f64;
        if (aspect - self.aspect).abs() > 0.001 {
            self.aspect = aspect;
            let d = Decal { aspect: Some(aspect), ..self.sticker.clone() };
            let (mesh, transform) = sticker_quad(r, device, &d, None, self.decal, self.body_depth, self.frame);
            let it = &mut r.items[self.item];
            it.mesh = mesh;
            it.transform = transform;
        }
    }
}

/// A sticker on the card: its item, and its picture's aspect (width / height), for live edits
/// (`CardRenderer::sticker`).
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    /// The sticker's index in `CardDesign.decals`.
    pub decal: usize,
    pub item: usize,
    pub aspect: f64,
}

/// The stickers a card shows (`build`).
#[derive(Default)]
pub struct Stickers {
    pub placed: Vec<Placed>,
    pub animated: Vec<AnimatedSticker>,
}

/// Adds the stickers (`buildDecals`). Static stickers whose image the host doesn't have are skipped;
/// animated ones start blank (the host sends their frames).
/// On the web this is the `stickers` chunk, downloaded only by cards with stickers.
#[wasm_split_helpers::wasm_split(stickers, fallible)]
pub fn build(
    r: &mut Renderer,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    host: &dyn Host,
    decals: &[Decal],
    body_depth: f64,
    frame: (f64, f64),
) -> Result<Stickers, crate::ChunkUnavailable> {
    let mut out = Stickers::default();
    for (i, d) in decals.iter().enumerate() {
        let Some(src) = d.src.as_deref() else { continue };
        if d.gif() {
            // `createGifDecalSource`: a 1 × 1 transparent canvas until the first frame.
            let texture = r.texture(device, queue, &[(1, 1, vec![0; 4])], true, Wrap::Clamp);
            let aspect = d.aspect.unwrap_or(1.0);
            let (mesh, transform) = sticker_quad(r, device, &Decal { aspect: Some(aspect), ..d.clone() }, None, i, body_depth, frame);
            let item = r.add(Item { mesh, material: sticker_material(d, i, texture), transform, render_order: RENDER_ORDER + i as f32, visible: true });
            out.placed.push(Placed { decal: i, item, aspect });
            out.animated.push(AnimatedSticker { decal: i, sticker: d.clone(), item, texture, aspect, body_depth, frame, show: AnimatedSticker::show_impl });
            continue;
        }
        let Some(img) = host.image(src, ImagePurpose::Full) else { continue };
        // `stickerTexture`: sRGB, flipY, mipmapped, anisotropy 2.
        let row = 4 * img.width as usize;
        let flipped: Vec<u8> = img.rgba.chunks_exact(row).rev().flatten().copied().collect();
        let tex = r.texture_with(device, queue, &mip_chain(&flipped, img.width, img.height, true), true, Wrap::Clamp, 2);
        let aspect = img.width as f64 / img.height as f64;
        let (mesh, transform) = sticker_quad(r, device, d, Some(aspect), i, body_depth, frame);
        let item = r.add(Item { mesh, material: sticker_material(d, i, tex), transform, render_order: RENDER_ORDER + i as f32, visible: true });
        out.placed.push(Placed { decal: i, item, aspect });
    }
    Ok(out)
}
