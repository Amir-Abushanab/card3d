//! The standard card (`card/metal-card.ts`): the layers ported so far, with the materials of
//! `card/body.ts`, `card/chip.ts` and `card/branding.ts`, placed per `card/layers.ts`.

use glam::{Mat4, Vec3};
use std::cell::RefCell;
use std::rc::Rc;

use crate::canvas::{Host, ImagePurpose};
use crate::chip;
use crate::design::CardDesign;
use crate::edge;
use crate::geometry::{self, BODY_DEPTH, CHIP_DEPTH_NATIVE, CHIP_SCALE};
use crate::iso;
use crate::json::{Map, Value};
use crate::material::{self, srgb_hex_to_linear};
use crate::renderer::{Item, Material, Renderer, Wrap};
use crate::shape;

/// Layer z offsets above the body cap and render orders (`card/layers.ts`).
const FACE_Z: f32 = 0.0015;
/// How the host wants the card built (more stage options come with phase 2).
#[derive(Clone, Debug, Default)]
pub struct CardOptions {
    /// The rendering budget (surface map size, anisotropy cap, environment resolution). Default `Full`.
    pub quality: crate::quality::Quality,
    /// The family a custom font (`CardDesign.font` as Google / URL / upload) loaded under, from the
    /// host's font loader (`loadDesignFont`); `None` (or a failed load) draws with the default font.
    pub custom_font_family: Option<String>,
    /// The viewer prefers reduced motion: face shaders don't run their clocks.
    pub reduced_motion: bool,
    /// `keepChipBright` (the marquee's cards).
    pub keep_chip_bright: bool,
    /// The face shader skins' width in px (the marquee's `faceWidth`); default 1280 at full quality,
    /// else 640.
    pub face_width: Option<u32>,
    /// One frame's cards (the marquee): the environment, pipelines and maps they share. The card then
    /// lights from that environment (no lighting preset's look, no staged scene, no glass backdrop);
    /// the host sets its lights.
    pub shared: Option<SharedCards>,
    /// A print bake's card (`print.rs`): keeps what production exports read (finished marks' glyphs).
    pub print: bool,
}

/// What the cards drawn into one frame share (the marquee's): the environment and the card shader's
/// pipelines (`renderer::Shared`), and the maps already made (`MapCache`).
#[derive(Clone)]
pub struct SharedCards {
    pub gpu: crate::renderer::Shared,
    pub maps: Rc<MapCache>,
}

impl std::fmt::Debug for SharedCards {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SharedCards")
    }
}

/// The recipe keys whose values a built card takes in place (`CardRenderer::retune`): its foils'
/// uniform values, which only `holo::sides` reads. A side gaining or losing its foil still needs a
/// build. A key added here must change nothing but uniforms that `retune` sets.
const RETUNABLE: [&str; 14] = [
    "holoStyle",
    "foilTexture",
    "foilIntensity",
    "holoGlare",
    "holoMotion",
    "foilScale",
    "foilCoverage",
    "backHoloStyle",
    "backFoilTexture",
    "backFoilIntensity",
    "backHoloGlare",
    "backHoloMotion",
    "backFoilScale",
    "backFoilCoverage",
];

/// What a card is built from but for the values it takes in place (`CardRenderer::retune`): the
/// design's JSON without the `RETUNABLE` recipe keys, the card's options, and what else the host
/// supplies for it (`assets`; the web's: its images' sources). Cards built with equal keys differ only
/// in those values.
#[derive(PartialEq)]
pub struct BuildKey {
    design: Value,
    options: (crate::quality::Quality, Option<String>, bool, bool, Option<u32>, bool),
    assets: Vec<String>,
}

impl BuildKey {
    /// `None` for a card of a frame's (`CardOptions::shared`), which is never retuned.
    pub fn new(mut design: Value, options: &CardOptions, assets: Vec<String>) -> Option<BuildKey> {
        // Every option, so that a new one can't be left out of the key.
        let CardOptions { quality, custom_font_family, reduced_motion, keep_chip_bright, face_width, shared, print } = options;
        if shared.is_some() {
            return None;
        }
        if let Value::Object(Map(members)) = &mut design {
            for (k, v) in members.iter_mut() {
                if let (true, Value::Object(Map(recipe))) = (k == "recipe", v) {
                    recipe.retain(|(k, _)| !RETUNABLE.contains(&k.as_str()));
                }
            }
        }
        let options = (*quality, custom_font_family.clone(), *reduced_motion, *keep_chip_bright, *face_width, *print);
        Some(BuildKey { design, options, assets })
    }
}

/// A surface's inputs: map size, grain and relief (bits), texture, orbit pattern.
type SurfaceKey = (u32, u64, u64, String, bool);

/// Maps several cards use alike: cards with the same surface inputs share their surface maps (as
/// three's surface texture cache; one no card uses any more is dropped when the next is made), and
/// every card the chip's detail maps. The marquee's cards share the marquee's (`SharedCards`); a
/// stage's cards those of their device (`renderer::DeviceCache`), so the next card, built while the
/// last is still shown (Card Studio builds one on every panel change), finds them made.
#[derive(Default)]
pub struct MapCache {
    /// A few at a time: a list (no hash map's code in the main wasm module).
    surfaces: RefCell<Vec<(SurfaceKey, Rc<SharedSurface>)>>,
    chip: RefCell<Option<(wgpu::Texture, wgpu::Texture)>>,
}

impl MapCache {
    /// The surface maps for `recipe` at `size` (a card keeps the `Rc` while it uses them).
    pub fn surface(&self, device: &wgpu::Device, queue: &wgpu::Queue, size: u32, recipe: &crate::design::Recipe) -> Rc<SharedSurface> {
        let orbit = recipe.pattern == "orbit";
        let key = (size, recipe.grain.to_bits(), recipe.relief.to_bits(), recipe.texture.clone(), orbit);
        let mut cache = self.surfaces.borrow_mut();
        if let Some((_, s)) = cache.iter().find(|e| e.0 == key) {
            return s.clone();
        }
        cache.retain(|(_, s)| Rc::strong_count(s) > 1);
        let mut maps = material::surface_maps(size, recipe.grain, recipe.relief, &recipe.texture, orbit);
        let up = |px: &[u8]| crate::renderer::upload(device, queue, &material::mip_chain(px, size, size, false), false);
        let (normal, rough) = (up(&maps.normal), up(&maps.roughness));
        maps.normal = Vec::new();
        maps.roughness = Vec::new();
        let s = Rc::new(SharedSurface { normal, rough, maps });
        cache.push((key, s.clone()));
        s
    }

    /// The chip's detail maps (colour, height): the same for every card.
    pub fn chip(&self, device: &wgpu::Device, queue: &wgpu::Queue, host: &dyn Host) -> (wgpu::Texture, wgpu::Texture) {
        self.chip
            .borrow_mut()
            .get_or_insert_with(|| {
                let (w, h, color, height) = chip::draw_detail(host);
                let up = |px: &[u8], srgb| crate::renderer::upload(device, queue, &material::mip_chain(px, w, h, srgb), srgb);
                (up(&color, true), up(&height, false))
            })
            .clone()
    }
}

/// A surface's maps on the GPU (normal, roughness) and its values (`SurfaceMaps` without the pixels).
pub struct SharedSurface {
    pub normal: wgpu::Texture,
    pub rough: wgpu::Texture,
    pub maps: material::SurfaceMaps,
}

pub struct CardRenderer {
    pub renderer: Renderer,
    /// The card's ID-1 frame (portrait for a taller-than-standard shape).
    pub frame: crate::layout::CardFrame,
    /// The stickers; the animated GIF ones wait for the host's frames (`show_sticker_frame`).
    stickers: crate::decals::Stickers,
    /// The design's face shader layers (`shaders`).
    faces: Option<crate::face_shaders::FaceLayers>,
    /// The add-ons (`design.addons`).
    shine: Option<crate::shine::Shine>,
    vines: Option<crate::vines::Vines>,
    /// A staged scene's framing (`stagingView`: a floor or a sweep moves the camera).
    pub staging: Option<crate::stage::StagingView>,
    /// The surface maps this card uses (shared with other cards: `MapCache`).
    _surface: Rc<SharedSurface>,
    /// A print bake's card (`CardOptions::print`): the metal body's geometry ("card body") and the
    /// resolved material, for the AR model (`ar.rs`).
    pub body: Option<geometry::Mesh>,
    pub material: Option<material::Resolved>,
}

impl CardRenderer {
    /// `format` must be a non-sRGB 8-bit format (the shader writes sRGB-encoded colour, as three does).
    /// Async because optional features load on demand on the web (wasm-split chunks); natively nothing awaits, so `pollster::block_on` returns at once. Fails only when
    /// such a feature couldn't be downloaded.
    pub async fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        design: &CardDesign,
        host: &dyn Host,
        options: &CardOptions,
    ) -> Result<Self, crate::LoadError> {
        // The design's lighting preset (`applyLightingPreset`; studio = the untouched rig).
        let preset = crate::lighting::preset(design.lighting.as_deref());
        let q = options.quality.preset();
        let recipe = &design.recipe;
        let material_override = design.material_override.as_ref();
        let m = material::resolve(recipe, material_override);
        // A clear card: the glass slab, its backdrop, and an environment whose empty directions show it.
        let glass = m.glass();
        // A staged scene (`CardDesign.scene`): its environment (an HDRI in place of the studio rig),
        // backdrop and floor. A lazily loaded chunk: only designs with a scene download it.
        let mut scene = match design.scene().filter(|_| options.shared.is_none()) {
            Some(_) => crate::scene::load(device, queue, design, host, options.quality).await.map_err(crate::chunk("scene"))?,
            None => None,
        };
        // A staged backdrop replaces a glass card's blue one, so its environment loses the blue too.
        let staged = scene.as_ref().is_some_and(|s| s.staged_backdrop);
        let environment = match scene.as_mut().and_then(|s| s.environment.take()) {
            Some((atlas, size)) => crate::renderer::Environment::Atlas(atlas, size),
            None => crate::renderer::Environment::Studio {
                look: preset.look.as_ref(),
                quality: options.quality,
                clear: (glass && !staged).then(crate::glass::backdrop_linear),
            },
        };
        let environment = match &options.shared {
            Some(s) => crate::renderer::Environment::Shared(s.gpu.clone()),
            None => environment,
        };
        let mut r = Renderer::new(device, queue, format, environment);
        r.keep_glyphs = options.print;
        use crate::print::role::*;
        // A reflective floor draws the card again into a half-float target.
        r.offscreen = scene.as_ref().is_some_and(|s| s.reflective);
        if glass {
            r.background = Some(crate::glass::backdrop_srgb());
        }
        let lin = |hex: &str, k: f64| srgb_hex_to_linear(hex).map(|c| c * k as f32);
        r.lighting = crate::renderer::Lighting {
            exposure: preset.exposure as f32,
            env_intensity: preset.env_intensity as f32,
            env_rotation_y: preset.env_rotation_y as f32,
            ambient: lin(preset.ambient.0, preset.ambient.1),
            key: lin(preset.key.0, preset.key.1),
            key_position: preset.key.2.map(|v| v as f32),
            ..Default::default()
        };
        if let Some(s) = &scene {
            r.lighting.env_intensity = s.env_intensity as f32;
            r.lighting.env_rotation_y = s.env_rotation_y as f32;
        }
        let maps = match &options.shared {
            Some(sh) => sh.maps.clone(),
            None => r.device_maps(),
        };
        let shared_surface = maps.surface(device, queue, q.surface_size, recipe);
        let surface = &shared_surface.maps;
        let (normal, rough) = (r.adopt_texture(&shared_surface.normal, Wrap::Repeat, 1), r.adopt_texture(&shared_surface.rough, Wrap::Repeat, 1));
        let anisotropy = surface.anisotropy.min(q.body_anisotropy);
        let body_depth = if glass { crate::glass_geometry::GLASS_THICKNESS } else { BODY_DEPTH };
        let j = (body_depth / 2.0) as f32;

        // Layers 1–3b: body and face skins (`createMetalFaceMaterial`; the back skin is the duller
        // variant without back branding: roughness ≥ 0.5, no clearcoat).
        let metal = |back: bool| Material {
            color: m.color,
            metalness: m.metalness as f32,
            roughness: if back { m.roughness.max(0.5) } else { m.roughness } as f32,
            clearcoat: if back { 0.0 } else { m.clearcoat as f32 },
            clearcoat_roughness: m.clearcoat_roughness as f32,
            anisotropy,
            anisotropy_rotation: surface.anisotropy_rotation,
            normal_map: Some(normal),
            roughness_map: Some(rough),
            normal_scale: surface.normal_scale,
            surface_repeat: surface.repeat,
            ..Default::default()
        };
        // Card shapes apply to the metal body only (glass keeps its own slab); the standard shape keeps
        // the standard geometry.
        let metal_body = !glass;
        // The shape code is a lazily loaded wasm chunk: only shaped cards download it.
        let shaped = match design.shape.as_ref().filter(|_| metal_body).and_then(shape::parse_shape) {
            Some(s) => shape::geometry_for_shape_lazy(&s).await.map_err(crate::chunk("shape"))?,
            None => None,
        };
        let frame = shaped.as_ref().map_or_else(crate::layout::public_frame, |s| s.frame.clone());
        let body_mesh = shaped.as_ref().map_or_else(geometry::card_body, |s| s.body.clone());
        let face_mesh = shaped.as_ref().map_or_else(geometry::face_plane, |s| s.face.clone());
        let back_face_mesh = shaped.as_ref().map_or_else(|| face_mesh.clone(), |s| s.back_face.clone());
        // Studio framing (`stage.ts`): a taller-than-standard (portrait) card pulls the camera back so
        // its full height stays in view when it turns edge-on.
        if frame.portrait {
            let tv = (17.0_f64).to_radians().tan() * 0.9;
            r.camera_z = r.camera_z.max((frame.width / 2.0 + frame.height / 2.0 / tv) as f32);
        }
        let item = |mesh, material, transform, render_order| Item { mesh, material, transform, render_order, visible: true };
        let mut faces = None;
        // The face planes (front, back) the add-ons' shadow catchers lie on.
        let mut face_meshes = None;
        let n = r.items.len();
        if glass {
            // The glass slab; no face skins, artwork or holo.
            // A lazily loaded chunk: only glass cards download the slab and the chip module.
            crate::glass::build(&mut r, device, &m, options.quality, &frame).await.map_err(crate::chunk("glass"))?;
            r.tag(n + 1, [CHIP, 0, 0, 0]);
            r.tag(n, [GLASS, 0, 0, 0]);
            // Face shader overlays on the glass's faces (three's `FaceShaderLayers` without skins: the
            // slab has no face skin to paint), drawn into the glass's buffers too, as three's are.
            if !design.shaders.is_empty() {
                let specs = crate::face_shaders::specs(&design.shaders, options.reduced_motion).await.map_err(crate::chunk("faces"))?;
                r.offscreen = true;
                let faces_mesh = [r.mesh(device, &face_mesh), r.mesh(device, &back_face_mesh)];
                let base_hex = match design.material_override.as_ref().and_then(|o| o.color.clone()) {
                    Some(c) => c,
                    None => material::whiten_glass(if recipe.color.is_empty() { "#c5dde4" } else { &recipe.color }),
                };
                let inputs = crate::face_shaders::FaceInputs {
                    faces: faces_mesh,
                    artwork: [None; 2],
                    j: body_depth / 2.0,
                    frame: &frame,
                    base_color: material::srgb_hex_to_srgb(&base_hex),
                    skins: [None; 2],
                    face_width: options.face_width.unwrap_or(if options.quality == crate::quality::Quality::Full { 1280 } else { 640 }),
                    host,
                    artwork_src: [None; 2],
                };
                let build = specs.build;
                let n = r.items.len();
                faces = Some(build(&mut r, device, queue, specs, &inputs).await?);
                r.tag(n, [OVERLAY, 0, 0, 0]);
            }
        } else {
            // With an edge finish the body is sorted into caps / bevel / walls, one material each.
            match design.edge.as_ref().filter(|_| metal_body).and_then(edge::parse_edge).filter(edge::has_edge) {
                // Edge finishes are a lazily loaded chunk: only cards with one download it.
                Some(e) => edge::build(&mut r, device, host, design, &e, &m, metal(false), &body_mesh).await.map_err(crate::chunk("edge"))?,
                None => {
                    let body = r.mesh(device, &body_mesh);
                    r.add(item(body, metal(false), Mat4::IDENTITY, 0.0));
                }
            }
            r.tag(n, [BODY, 0, 0, 0]);
            let face = r.mesh(device, &face_mesh);
            let back_face = r.mesh(device, &back_face_mesh);
            face_meshes = Some((face, back_face));
            // Face shader skins: each side with skin layers renders them into a target that becomes
            // its face skin's map, under a white material colour.
            // The `faces` chunk parses the layers; only cards with face shaders download it.
            let face_specs = match design.shaders.is_empty() {
                true => None,
                false => Some(crate::face_shaders::specs(&design.shaders, options.reduced_motion).await.map_err(crate::chunk("faces"))?),
            };
            let plan = face_specs.as_ref().map(|s| s.plan).unwrap_or_default();
            let face_width = options.face_width.unwrap_or(if options.quality == crate::quality::Quality::Full { 1280 } else { 640 });
            let (sw, sh) = crate::face_shaders::skin_size(face_width, &frame);
            let skin_tex: [Option<crate::renderer::TextureId>; 2] = [0, 1].map(|k| plan.skins[k].then(|| r.render_texture(device, sw, sh, 4)));
            let skin = |back: bool| {
                let base = Material { depth_test: false, ..metal(back) };
                match skin_tex[back as usize] {
                    Some(t) => Material { map: Some(t), color: [1.0; 3], ..base },
                    None => base,
                }
            };
            let f = r.add(item(face, skin(false), Mat4::from_translation(Vec3::new(0.0, 0.0, j + FACE_Z)), 5.0));
            r.tag(f, [FACE, 0, 0, 0]);
            let b = r.add(item(
                back_face,
                skin(true),
                Mat4::from_translation(Vec3::new(0.0, 0.0, -(j + FACE_Z))) * Mat4::from_rotation_y(std::f32::consts::PI),
                5.0,
            ));
            r.tag(b, [FACE, 0, 1, 0]);

            // Layers 5/5b: artwork (`createDesignMaterial` / `createDesignMesh`). A face shader that
            // renders the artwork itself (halftone, liquid metal, ...) replaces it.
            let mut artwork: [Option<crate::renderer::TextureId>; 2] = [None, None];
            for (side, plane, back) in [("front", face, false), ("back", back_face, true)] {
                let Some(img) = design.surface_sources.get(side).and_then(|src| host.image(src, ImagePurpose::Artwork)) else { continue };
                let tex = crate::artwork::texture(&mut r, device, queue, &img, 1);
                artwork[back as usize] = Some(tex);
                let inlay = design.surface_treatments.get(side).is_some_and(|t| t == "inlay");
                let i = crate::artwork::add(&mut r, plane, body_depth, back, crate::artwork::material(tex, inlay, &m, surface, normal, rough));
                r.items[i].visible = !plan.hides_artwork[back as usize];
                r.tag(i, [ARTWORK, 0, 0, 0]);
            }

            // Face shaders: skin layers into the targets above, overlays over the artwork.
            if let Some(specs) = face_specs {
                let base_hex = design.material_override.as_ref().and_then(|o| o.color.clone()).unwrap_or_else(|| recipe.color.clone());
                let inputs = crate::face_shaders::FaceInputs {
                    faces: [face, back_face],
                    artwork,
                    j: body_depth / 2.0,
                    frame: &frame,
                    base_color: material::srgb_hex_to_srgb(&base_hex),
                    skins: skin_tex,
                    face_width,
                    host,
                    artwork_src: [design.surface_sources.get("front").map(String::as_str), design.surface_sources.get("back").map(String::as_str)],
                };
                let build = specs.build;
                let n = r.items.len();
                faces = Some(build(&mut r, device, queue, specs, &inputs).await?);
                r.tag(n, [OVERLAY, 0, 0, 0]);
            }

            // Layer 6: holo foil per side (a lazily loaded chunk; only holo cards download it).
            if crate::holo::any(recipe) {
                let n = r.items.len();
                crate::holo::build(&mut r, device, recipe, &body_mesh, j).await.map_err(crate::chunk("holo"))?;
                r.tag(n, [FOIL, 0, 0, 0]);
            }
        }

        // Layers 7–8: the chip (base and contact-plate detail), on the ISO contacts.
        let mut finish = chip::chip_finish(
            m.roughness,
            m.clearcoat,
            m.clearcoat_roughness,
            anisotropy as f64,
            surface.anisotropy_rotation as f64,
            recipe.spectrum / 100.0,
            options.keep_chip_bright,
        );
        let at = iso::chip_placement(frame.portrait);
        let chip_depth = CHIP_DEPTH_NATIVE * CHIP_SCALE;
        // A clear card's plate is inlaid flush with the face, as thin as a real plate, in a satin finish
        // of its own (the glass's near-mirror finish would make it a black mirror of the room).
        let flatten = if glass { crate::chip_module::CHIP_PLATE_DEPTH / chip_depth } else { 1.0 };
        if glass {
            finish.roughness = finish.roughness.max(0.3);
            finish.anisotropy = 0.0;
        }
        let chip_z = if glass {
            body_depth / 2.0 + crate::chip_module::CHIP_FLUSH_TOP - crate::chip_module::CHIP_PLATE_DEPTH / 2.0
        } else {
            body_depth / 2.0 + at.top - chip_depth / 2.0
        };
        let chip_scale = Vec3::new(CHIP_SCALE as f32, CHIP_SCALE as f32, (CHIP_SCALE * flatten) as f32);
        let chip_transform = Mat4::from_translation(Vec3::new(at.x as f32, at.y as f32, chip_z as f32))
            * Mat4::from_rotation_z(at.rotation as f32)
            * Mat4::from_scale(chip_scale);
        let chip_material = Material {
            metalness: 1.0,
            roughness: finish.roughness as f32,
            clearcoat: finish.clearcoat as f32,
            clearcoat_roughness: finish.clearcoat_roughness as f32,
            anisotropy: finish.anisotropy as f32,
            anisotropy_rotation: finish.anisotropy_rotation as f32,
            iridescence: finish.iridescence as f32,
            iridescence_ior: finish.iridescence_ior as f32,
            iridescence_thickness: finish.iridescence_thickness[1] as f32,
            // The plate lies on the front face (a clear card leaves it out of its buffer passes when seen
            // from the front).
            face: Some(1),
            ..Default::default()
        };
        let shell = r.mesh(device, &geometry::chip_shell());
        let n = r.items.len();
        r.add(item(shell, Material { color: srgb_hex_to_linear("#c6c8c5"), ..chip_material.clone() }, chip_transform, 10.0));
        // `createProceduralChipDetailMaterial`: anisotropy 4 on both maps.
        let (chip_color, chip_height) = {
            let (c, h) = maps.chip(device, queue, host);
            (r.adopt_texture(&c, Wrap::Clamp, 4), r.adopt_texture(&h, Wrap::Clamp, 4))
        };
        let detail = Material {
            color: srgb_hex_to_linear("#e0e1de"),
            opacity: chip::DETAIL_OPACITY,
            map: Some(chip_color),
            bump_map: Some(chip_height),
            bump_scale: chip::DETAIL_BUMP_SCALE,
            transparent: true,
            depth_write: false,
            polygon_offset: Some((-1.0, -1.0)),
            luminance_after_map: true,
            ..chip_material
        };
        r.add(item(shell, detail, chip_transform, 11.0));
        r.tag(n, [CHIP, 0, 0, 0]);

        // Layer 14: a depth-only copy of the chip just above the highest front sticker, so front
        // stickers never paint over the chip.
        let d_max = crate::decals::front_decal_max_index(&design.decals);
        if d_max >= 0 {
            let mask_z = (crate::decals::decal_z(body_depth, d_max as usize) + 0.0001 - chip_depth * flatten / 2.0) as f32;
            let mask_transform =
                Mat4::from_translation(Vec3::new(at.x as f32, at.y as f32, mask_z)) * Mat4::from_rotation_z(at.rotation as f32) * Mat4::from_scale(chip_scale);
            let mask = Material {
                transparent: true,
                color_write: false,
                depth_write: true,
                polygon_offset: Some((-64.0, -64.0)),
                face: Some(1),
                ..Default::default()
            };
            let i = r.add(item(shell, mask, mask_transform, 29.0));
            r.tag(i, [CHIP_MASK, 0, 0, 0]);
        }

        // Layers 9–13: the branding (mark or logo, name, bio, contactless, text lines).
        crate::branding::build(&mut r, device, queue, host, design, material_override, &m, body_depth, &frame, options.custom_font_family.as_deref(), glass)
            .await?;

        // Layer 15: stickers (render order 30 + index).
        let n = r.items.len();
        let stickers = if design.decals.iter().any(|d| d.src.is_some()) {
            crate::decals::build(&mut r, device, queue, host, &design.decals, body_depth, (frame.width, frame.height))
                .await
                .map_err(crate::chunk("stickers"))?
        } else {
            Default::default()
        };

        r.tag(n, [STICKER, 0, 0, 0]);
        let n = r.items.len();
        // Add-on rigs (`attachAddons`) over every layer, each a lazily loaded chunk.
        let shine = match design.addon("shine") {
            Some(values) => {
                let s = crate::shine::build(&mut r, device, queue, host, body_depth, values, options.reduced_motion, glass).await;
                Some(s.map_err(crate::chunk("shine"))?)
            }
            None => None,
        };
        let vines = match design.addon("vines") {
            Some(values) => {
                // The catchers lie on the face planes (a clear card's are the standard ones).
                let faces = match face_meshes {
                    Some((front, back)) => Some(crate::vines::Faces { front, back }),
                    None if glass => {
                        let f = r.mesh(device, &geometry::face_plane());
                        Some(crate::vines::Faces { front: f, back: f })
                    }
                    None => None,
                };
                let v = crate::vines::build(&mut r, device, queue, host, faces, body_depth, values, options.reduced_motion, glass).await;
                Some(v.map_err(crate::chunk("vines"))?)
            }
            None => None,
        };
        r.tag(n, [ADDON, 0, 0, 0]);
        let staging = scene.and_then(|s| (s.finish)(&mut r, device, queue, host));
        r.warm(device);
        let body = (options.print && !glass).then_some(body_mesh);
        let material = options.print.then_some(m);
        Ok(CardRenderer { renderer: r, frame, stickers, faces, shine, vines, staging, _surface: shared_surface, body, material })
    }

    /// Takes `design`'s foil values (each side's style, texture, intensity, glare, motion, scale and
    /// coverage) in place: all that tells it from the design this card was built from when their
    /// `BuildKey`s are equal. False, changing nothing, when a side would gain or lose its foil.
    pub fn retune(&mut self, design: &CardDesign) -> bool {
        let (front, back) = crate::holo::sides(&design.recipe);
        let holo = &mut self.renderer.holo;
        let has = |front: bool| holo.iter().flatten().any(|h| h.front == front);
        if has(true) != front.is_some() || has(false) != back.is_some() {
            return false;
        }
        for h in holo.iter_mut().flatten() {
            if let Some(values) = if h.front { front } else { back } {
                h.values = values;
            }
        }
        true
    }

    /// Face shader layers that couldn't be built (custom code that doesn't parse or compile).
    /// `shader_errors` as JSON (`face_shaders::errors_json`; "[]" without face shaders).
    pub fn shader_errors_json(&self) -> &str {
        self.faces.as_ref().map_or("[]", |f| &f.errors_json)
    }

    pub fn shader_errors(&self) -> &[crate::face_shaders::LayerError] {
        self.faces.as_ref().map_or(&[], |f| &f.errors)
    }

    /// Whether the card animates by itself (live face shaders, add-ons): the host keeps drawing frames.
    pub fn animated(&self) -> bool {
        self.faces.as_ref().is_some_and(|f| f.animated) || self.shine.as_ref().is_some_and(|s| s.animated) || self.vines.as_ref().is_some_and(|v| v.animated)
    }

    /// Advances the card's own animations by `dt` seconds; `model` is the card's world transform.
    pub fn update(&mut self, dt: f64, model: Mat4) {
        if let Some(f) = self.faces.as_mut() {
            f.update(dt, model);
        }
        if let Some(s) = self.shine.as_mut() {
            s.update(dt);
        }
        if let Some(v) = self.vines.as_mut() {
            v.update(dt, model);
        }
    }

    /// The page's pointer moved (the canvas's normalised device coordinates): liquid metal stirs with
    /// its speed.
    pub fn set_pointer(&mut self, ndc: [f64; 2]) {
        if let Some(f) = self.faces.as_mut() {
            f.set_pointer(ndc);
        }
    }

    /// A wheel event on the page (its larger delta, px): liquid metal stirs.
    pub fn wheel(&mut self, delta: f64) {
        if let Some(f) = self.faces.as_mut() {
            f.wheel(delta);
        }
    }

    /// Before drawing: the face shaders' uniforms and skins, the add-ons' per-frame state.
    pub fn prepare(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, model: Mat4, cam: &crate::renderer::Camera) {
        if let Some(f) = self.faces.as_mut() {
            f.prepare(&self.renderer, device, queue);
        }
        if let Some(s) = self.shine.as_mut() {
            s.prepare(&mut self.renderer, queue, model, cam);
        }
        if let Some(v) = self.vines.as_mut() {
            v.prepare(&self.renderer, device, queue, model, cam);
        }
    }

    /// The `CardDesign.decals` indices of the animated stickers (the host decodes those GIFs).
    pub fn animated_stickers(&self) -> Vec<usize> {
        self.stickers.animated.iter().map(|s| s.decal).collect()
    }

    /// Shows a frame of animated sticker `decal` (RGBA, straight alpha, row 0 = top: the GIF frame
    /// inside its die-cut border). False when that sticker isn't animated.
    pub fn show_sticker_frame(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, decal: usize, width: u32, height: u32, rgba: &[u8]) -> bool {
        let Some(s) = self.stickers.animated.iter_mut().find(|s| s.decal == decal) else { return false };
        s.show_frame(&mut self.renderer, device, queue, width, height, rgba);
        true
    }

    /// Sticker `decal` as the page places it, without a rebuild (Card Studio's live sticker edits):
    /// `v` = [x, y, width, height (card units, the quad's centre and size in the card's plane), rotation
    /// (degrees, clockwise on its face), crop x, y, w, h, flip h, flip v, opacity, tint r, g, b (0..1),
    /// tint amount, brightness, contrast, saturation]; shorter (empty) leaves it as it is. Returns
    /// [z, the picture's aspect] (the quad's plane in card space and the image's width / height), or
    /// nothing when the card doesn't show that sticker.
    pub fn sticker(&mut self, decal: usize, v: &[f64]) -> Vec<f64> {
        let Some(p) = self.stickers.placed.iter().find(|p| p.decal == decal).copied() else { return Vec::new() };
        let r = &mut self.renderer;
        let it = &mut r.items[p.item];
        let z = it.transform.w_axis.z;
        if v.len() >= 19 {
            let (lo, hi) = r.meshes[it.mesh.0].bounds;
            let size = (hi - lo).max(Vec3::splat(1e-6));
            let back = z < 0.0;
            it.transform = Mat4::from_translation(Vec3::new(v[0] as f32, v[1] as f32, z))
                * Mat4::from_rotation_y(if back { std::f32::consts::PI } else { 0.0 })
                * Mat4::from_rotation_z(-(v[4] as f32).to_radians())
                * Mat4::from_scale(Vec3::new(v[2] as f32 / size.x, v[3] as f32 / size.y, 1.0));
            let d = crate::decals::Decal {
                crop: Some(crate::decals::Crop { x: v[5], y: v[6], w: v[7], h: v[8] }),
                flip: Some(crate::decals::Flip { h: v[9] != 0.0, v: v[10] != 0.0 }),
                ..Default::default()
            };
            let (offset, repeat) = crate::decals::uv_transform(&d);
            let m = &mut it.material;
            m.map_offset = offset;
            m.map_repeat = repeat;
            m.opacity = v[11] as f32;
            let tint = if v[15] > 0.0 { [v[12] as f32, v[13] as f32, v[14] as f32, v[15] as f32] } else { [0.0; 4] };
            let adjust = [v[16] as f32, v[17] as f32, v[18] as f32];
            m.look = (tint[3] > 0.0 || adjust != [0.0; 3]).then_some(crate::renderer::DecalLook { tint, adjust });
        }
        vec![z as f64, p.aspect]
    }

    /// Renders the card turned by Euler XYZ angles (radians) into `target` (`width` × `height`).
    pub fn render(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::TextureView, width: u32, height: u32, euler: [f32; 3]) {
        self.renderer.render(device, queue, target, width, height, euler);
    }
}
