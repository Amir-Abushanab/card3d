//! The branding (`buildBranding` in `card/branding.ts`): the corner mark or the design's logo, the
//! cardholder name (front) and bio (back), the contactless mark and the extra text lines, each a plane
//! at ±(J + 0.013) with a glyph raster as colour and bump map, or a finished mark's maps.

use glam::{Mat4, Vec3};

use crate::canvas::Host;
use crate::design::CardDesign;
use crate::finish::{self, Finish};
use crate::layout::{self, BrandingLayout, CardFrame, FrontLayoutOverride, LineBox, LogoPlacement, Rect};
use crate::mark;
use crate::material::{mip_chain, srgb_hex_to_linear, Resolved};
use crate::renderer::{Item, Material, Renderer, TextureId, Wrap};
use crate::text;
use crate::LoadError;

/// Render order of the branding planes (`LAYER.branding`).
const RENDER_ORDER: f32 = 12.0;

/// The branding material input `T`: the resolved material ⊕ the design's branding override.
struct BrandingInput {
    color_hex: String,
    metalness: f64,
    roughness: f64,
    clearcoat: f64,
    clearcoat_roughness: f64,
    branding_clearcoat: Option<f64>,
}

/// A white-on-transparent raster (rows top first) to place on the card.
struct Raster {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

struct Ctx<'a> {
    r: &'a mut Renderer,
    device: &'a wgpu::Device,
    queue: &'a wgpu::Queue,
    t: BrandingInput,
    l: BrandingLayout,
    /// A clear (glass) card: one print layer, on the front, double-sided so it reads from behind.
    clear: bool,
    /// The next plane's kind and number for production exports (`print::role`).
    kind: [u8; 2],
}

impl Ctx<'_> {
    /// An sRGB / linear texture from canvas rows (flipY: the top row lands at v = 1).
    fn texture(&mut self, w: u32, h: u32, rgba: &[u8], srgb: bool, anisotropy: u16) -> TextureId {
        let row = 4 * w as usize;
        let flipped: Vec<u8> = rgba.chunks_exact(row).rev().flatten().copied().collect();
        self.r.texture_with(self.device, self.queue, &mip_chain(&flipped, w, h, srgb), srgb, Wrap::Clamp, anisotropy)
    }

    /// One branding plane (`plane()` in buildBranding): `bump` is the default material's bumpScale.
    async fn plane(&mut self, raster: &Raster, w: f64, h: f64, x: f64, y: f64, back: bool, bump: f32, finish: Option<Finish>) -> Result<Rect, LoadError> {
        self.plane_item(raster, w, h, x, y, back, bump, finish).await?;
        Ok(Rect { x, y, w, h })
    }

    /// `plane`, returning the renderer item's index.
    async fn plane_item(&mut self, raster: &Raster, w: f64, h: f64, x: f64, y: f64, back: bool, bump: f32, finish: Option<Finish>) -> Result<usize, LoadError> {
        let z = if back { -self.l.z } else { self.l.z };
        let place = |pw: f64, ph: f64| {
            let mut m = Mat4::from_translation(Vec3::new(x as f32, y as f32, z as f32));
            if back {
                m *= Mat4::from_rotation_y(std::f32::consts::PI);
            }
            (m, pw, ph)
        };
        let common = Material {
            transparent: true,
            depth_write: false,
            polygon_offset: Some((-2.0, -2.0)),
            face: Some(if back { -1 } else { 1 }),
            side: if self.clear { crate::renderer::Side::Double } else { crate::renderer::Side::Front },
            ..Default::default()
        };
        let mut glyph = None;
        let (material, (transform, pw, ph)) = match finish {
            None => {
                let tex = self.texture(raster.width, raster.height, &raster.rgba, true, 1);
                let t = &self.t;
                let m = Material {
                    color: srgb_hex_to_linear(&t.color_hex),
                    map: Some(tex),
                    bump_map: Some(tex),
                    bump_scale: bump,
                    metalness: t.metalness as f32,
                    roughness: (t.roughness * 0.7).clamp(0.04, 0.6) as f32,
                    clearcoat: t.branding_clearcoat.unwrap_or(0.35) as f32,
                    clearcoat_roughness: 0.28,
                    alpha_test: 0.08,
                    ..common
                };
                (m, place(w, h))
            }
            Some(f) => {
                // Text smaller than the name gets a shallower relief (`reliefScaleFor`).
                let relief_scale = (h / (self.l.e * 1.13)).min(1.0);
                let alpha: Vec<u8> = raster.rgba.as_chunks::<4>().0.iter().map(|p| p[3]).collect();
                let px_per_unit = raster.height as f64 / h;
                let ff = finish::compute_finish_fields_lazy(&alpha, raster.width as usize, raster.height as usize, f, px_per_unit, relief_scale)
                    .await
                    .map_err(crate::chunk("finish"))?;
                let (pad_x, pad_y) = (ff.pad as f64 / raster.width as f64, ff.pad as f64 / raster.height as f64);
                if self.r.keep_glyphs {
                    glyph = Some((raster.width, raster.height, alpha, [pad_x as f32, pad_y as f32]));
                }
                // three uploads the maps from a canvas (putImageData): its premultiplied 8-bit storage
                // quantises the colour of soft-edge texels. Do the same round trip.
                let map = self.texture(ff.width, ff.height, &canvas_round_trip(&ff.color), true, 4);
                let normal = self.texture(ff.width, ff.height, &ff.normal, false, 4);
                let rough = ff.roughness.as_ref().map(|r| self.texture(ff.width, ff.height, r, false, 4));
                let t = &self.t;
                let small = ((1.0 - relief_scale) / 0.6).clamp(0.0, 1.0);
                let fm = finish::finish_material(f, &t.color_hex, Some(t.metalness), Some(t.roughness), Some(t.clearcoat), Some(t.clearcoat_roughness), small);
                let m = Material {
                    color: fm.color,
                    metalness: fm.metalness,
                    roughness: fm.roughness,
                    clearcoat: fm.clearcoat,
                    clearcoat_roughness: fm.clearcoat_roughness,
                    map: Some(map),
                    normal_map: Some(normal),
                    roughness_map: rough,
                    normal_scale: [1.0, 1.0],
                    alpha_test: 0.01,
                    ..common
                };
                (m, place(w * (1.0 + 2.0 * pad_x), h * (1.0 + 2.0 * pad_y)))
            }
        };
        let mesh = self.r.mesh(self.device, &crate::geometry::plane(pw as f32, ph as f32));
        let i = self.r.add(Item { mesh, material, transform, render_order: RENDER_ORDER, visible: true });
        self.r.tag(i, [crate::print::role::MARK, self.kind[0], self.kind[1], finish.map_or(0, |f| f as u8 + 1)]);
        if let Some((width, height, alpha, pad)) = glyph {
            self.r.glyphs.push(crate::renderer::Glyph { item: i, width, height, alpha, pad });
        }
        Ok(i)
    }
}

/// Lift of a clear card's print above the glass face (`GLASS_PRINT_Z`: just enough to never z-fight it).
pub const GLASS_PRINT_Z: f64 = 0.002;
/// Size of the bio on a clear card's front, × the name's line box (`CLEAR_BIO_SIZE`).
const CLEAR_BIO_SIZE: f64 = 0.8;

/// Adds the branding planes for `design` (front: mark or logo, name, contactless, text lines; back: bio).
/// `material_override`: the design's. `card_frame`: the card's ID-1 frame (`layout::public_frame()` for the
/// standard card; a shaped card's own).
pub async fn build(
    r: &mut Renderer,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    host: &dyn Host,
    design: &CardDesign,
    material_override: Option<&crate::design::MaterialOverride>,
    m: &Resolved,
    body_depth: f64,
    card_frame: &CardFrame,
    custom_font: Option<&str>,
    clear: bool,
) -> Result<(), LoadError> {
    let frame = Some(card_frame);
    let b = design.branding_override.clone().unwrap_or_default();
    // Three's `T = { ...R }`: the resolved colour, which a glass recipe whitens (`whitenGlass`).
    let base_hex = match material_override.and_then(|o| o.color.clone()) {
        Some(c) => c,
        None if design.recipe.material == "glass" => {
            crate::material::whiten_glass(if design.recipe.color.is_empty() { "#c5dde4" } else { &design.recipe.color })
        }
        None => design.recipe.color.clone(),
    };
    let t = BrandingInput {
        color_hex: b.color.clone().unwrap_or(base_hex),
        metalness: b.metalness.unwrap_or(m.metalness),
        roughness: b.roughness.unwrap_or(m.roughness),
        clearcoat: b.clearcoat.unwrap_or(m.clearcoat),
        clearcoat_roughness: b.clearcoat_roughness.unwrap_or(m.clearcoat_roughness),
        branding_clearcoat: b.branding_clearcoat,
    };
    let fl = design.front_layout.unwrap_or_default();
    let over = FrontLayoutOverride { name_font_height: fl.name_font_height, name_bottom: fl.name_bottom, ..Default::default() };
    let mut l = layout::branding_layout(&over, body_depth, frame);
    // Print on glass lies on the face itself (the metal stack's lift would float it visibly).
    if clear {
        l.z = body_depth / 2.0 + GLASS_PRINT_Z;
    }
    let mut c = Ctx { r, device, queue, t, l, clear, kind: [1, 0] };
    let finishes = design.finish.clone().unwrap_or_default();
    let (logo_finish, name_finish, bio_finish) =
        (Finish::parse(finishes.logo.as_deref()), Finish::parse(finishes.name.as_deref()), Finish::parse(finishes.bio.as_deref()));
    let fonts = crate::fonts::resolve(design, custom_font, &host.name_font());
    let family = fonts.name.as_str();

    // Obstacles for the logo and the text lines: the chip, then the contactless mark.
    let mut obstacles = vec![layout::chip_rect(frame)];
    let contactless = design.contactless.as_ref().map(|cl| layout::contactless_rect(frame, cl.scale.unwrap_or(layout::CONTACTLESS_SCALE.default)));
    if let Some(rect) = contactless {
        obstacles.push(rect);
    }

    // Logo: the design's path logo, else the corner mark.
    // A path logo, else a raster logo's mask (`validLogo`, `drawUserLogoCanvas`).
    let user = design.logo.as_ref().and_then(|lg| {
        let drawn = match (lg.path.as_deref().filter(|p| !p.trim().is_empty()), lg.view_box) {
            (Some(path), Some(vb)) => mark::draw_user_logo_path(host, path, vb, lg.origin.unwrap_or([0.0, 0.0]), lg.fill_rule.as_deref() == Some("evenodd")),
            _ => {
                let img = host.image(lg.src.as_deref().filter(|s| !s.is_empty())?, crate::canvas::ImagePurpose::Full)?;
                mark::draw_user_logo_image(host, &img)
            }
        };
        let (w, h, rgba, aspect) = drawn?;
        Some((lg, Raster { width: w, height: h, rgba }, aspect))
    });
    let logo_rect = if let Some((lg, raster, aspect)) = user {
        let placement = LogoPlacement { position: lg.position.as_deref().and_then(layout::LogoPosition::parse), scale: lg.scale };
        let rect = layout::user_logo_rect(&placement, aspect, &c.l, Some(&obstacles));
        c.plane(&raster, rect.w, rect.h, rect.x, rect.y, false, 0.16, logo_finish).await?
    } else {
        let (w, h) = mark::LOGO_CANVAS;
        let raster = Raster { width: w, height: h, rgba: mark::draw_logo(host, &mark::Mark::default()) };
        let lb = c.l.logo;
        c.plane(&raster, lb.width, lb.height, lb.left + lb.width / 2.0, lb.top - lb.height / 2.0, false, 0.16, logo_finish).await?
    };

    // Name: left edge on the name column, bottom edge on the text baseline band.
    c.kind = [2, 0];
    let mut name_top = c.l.text_bottom;
    let mut name_rect: Option<Rect> = None;
    if let Some(tr) = text::rasterize_card_text(host, &design.cardholder_name, family, c.l.t, c.l.i) {
        let h = c.l.e * tr.height_in_line_boxes;
        let w = h * tr.aspect;
        let x = c.l.name_left.unwrap_or(c.l.logo.left) + w / 2.0;
        let y = c.l.text_bottom + h / 2.0;
        name_top = c.l.text_bottom + h;
        name_rect = Some(Rect { x, y, w, h });
        c.plane(&Raster { width: tr.width, height: tr.height, rgba: tr.rgba }, w, h, x, y, false, 0.1, name_finish).await?;
    }

    // Bio: the back, bottom-left as seen from behind (the right edge of the front's text column). A
    // clear card prints it on the front with the text lines below.
    let bio = text::rasterize_card_text(host, &design.cardholder_bio, family, c.l.t, c.l.i);
    let (bio, front_bio) = if clear { (None, bio) } else { (bio, None) };
    c.kind = [3, 0];
    if let Some(tr) = bio {
        let h = c.l.e * tr.height_in_line_boxes;
        let w = h * tr.aspect;
        let right = c.l.text_right.unwrap_or(layout::CARD_W / 2.0 - c.l.m);
        c.plane(&Raster { width: tr.width, height: tr.height, rgba: tr.rgba }, w, h, right - w / 2.0, c.l.text_bottom + h / 2.0, true, 0.1, bio_finish).await?;
    }

    // Contactless mark beside the chip (front only); finished, embossed by default.
    if let (Some(cl), Some(rect)) = (&design.contactless, contactless) {
        let (w, h, rgba) = mark::draw_contactless(host, 384.0);
        c.kind = [5, 0];
        let f = Finish::parse(cl.finish.as_deref()).unwrap_or(Finish::Embossed);
        let item = c.plane_item(&Raster { width: w, height: h, rgba }, rect.w, rect.h, rect.x, rect.y, false, 0.12, Some(f)).await?;
        // Above the stickers (`30 + D + 0.5`): the next render order up, the only higher sticker being on the back.
        let d_max = crate::decals::front_decal_max_index(&design.decals);
        if d_max >= 0 {
            c.r.items[item].render_order = crate::decals::RENDER_ORDER + d_max as f32 + 1.0;
        }
    }

    // Extra text lines (front), rasterised like the name and finished like it. A clear card's bio joins
    // them as the last bottom-right line (on the name's baseline band), kept clear of the name; when the
    // name leaves too little room beside it, it goes above the name instead.
    if !design.text_lines.is_empty() || front_bio.is_some() {
        // The lines with text, at most three, each in its own family (`textLineFamilies`).
        let lines: Vec<&crate::design::CardTextLine> = design.text_lines.iter().filter(|l| !l.text.trim().is_empty()).take(3).collect();
        let rasters: Vec<Option<text::TextRaster>> =
            lines.iter().zip(&fonts.lines).map(|(ln, fam)| text::rasterize_text_line(host, &ln.text, fam, ln.tracking.unwrap_or(0.0))).collect();
        let mut boxes = Vec::new();
        let mut which = Vec::new();
        for (i, (ln, tr)) in lines.iter().zip(&rasters).enumerate() {
            let Some(tr) = tr else { continue };
            boxes.push(LineBox {
                aspect: tr.aspect,
                height_in_line_boxes: tr.height_in_line_boxes,
                size: ln.size,
                align: ln.align.as_deref().and_then(layout::Align::parse),
                placement: ln.placement.as_deref().and_then(layout::Placement::parse),
                with_name: false,
            });
            which.push(i);
        }
        let mut top_obstacles = obstacles.clone();
        top_obstacles.push(logo_rect);
        let mut which: Vec<Option<usize>> = which.into_iter().map(Some).collect();
        if let Some(fb) = &front_bio {
            let w = c.l.e * CLEAR_BIO_SIZE * fb.height_in_line_boxes * fb.aspect;
            let right = c.l.text_right.unwrap_or(card_frame.width / 2.0 - c.l.m);
            let room = name_rect.map_or(f64::INFINITY, |n| right - (n.x + n.w / 2.0) - 0.08);
            let placement = if room >= 0.75 * w { layout::Placement::BottomRight } else { layout::Placement::BottomLeft };
            let align = if placement == layout::Placement::BottomRight { layout::Align::Right } else { layout::Align::Left };
            boxes.push(LineBox {
                aspect: fb.aspect,
                height_in_line_boxes: fb.height_in_line_boxes,
                size: Some(CLEAR_BIO_SIZE),
                align: Some(align),
                placement: Some(placement),
                with_name: true,
            });
            which.push(None);
            if let Some(n) = name_rect {
                top_obstacles.push(n);
            }
        }
        let rects = layout::layout_text_lines(&boxes, &c.l, name_top, &top_obstacles);
        for (rect, i) in rects.iter().zip(which) {
            let (tr, finish) = match i {
                Some(i) => (rasters[i].as_ref().unwrap(), name_finish),
                None => (front_bio.as_ref().unwrap(), bio_finish),
            };
            c.kind = i.map_or([3, 0], |i| [4, i as u8 + 1]);
            c.plane(&Raster { width: tr.width, height: tr.height, rgba: tr.rgba.clone() }, rect.w, rect.h, rect.x, rect.y, false, 0.1, finish).await?;
        }
    }
    Ok(())
}

/// What `putImageData` then a straight-alpha read gives back: premultiplied 8-bit storage, then
/// un-premultiplied (browsers round both ways).
fn canvas_round_trip(rgba: &[u8]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    for p in out.as_chunks_mut::<4>().0 {
        let a = p[3] as f64;
        for v in &mut p[..3] {
            *v = if a == 0.0 {
                0
            } else {
                let pre = (*v as f64 * a / 255.0).round();
                (pre * 255.0 / a).round().min(255.0) as u8
            };
        }
    }
    out
}
