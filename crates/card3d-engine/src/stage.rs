//! The single-card stage (`scene/stage.ts`, `createCardStage`) without the platform parts: the card
//! slot (`setRotation`, `setLift`), the interaction root (`scene/interaction.ts`), the camera framing
//! (`StageFit`: studio, or contain), and swapping cards. Frame scheduling, input listeners, canvas
//! sizing, pixel ratio and the GPU device stay with the host (packages/core on the web).
//!
//! Scene graph, as three's: camera on +z looking at the origin → "Card slot" (lift, then Euler XYZ)
//! → "Centered metal card root" (the interaction: position, quaternion, scale) → the card's items.

use glam::{DVec3, Mat4, Vec3};

use crate::canvas::Host;
use crate::card::{BuildKey, CardOptions, CardRenderer};
use crate::design::CardDesign;
use crate::interaction::{CardInteraction, CardRotation, InteractionEvent, InteractionFrame, InteractionOptions};
use crate::quality::Quality;
use crate::renderer::Camera;
use crate::LoadError;

/// `DEFAULT_CAMERA` (camera.ts): fov 34°, z 5.35, near 0.1, far 30.
pub const CAMERA_FOV_DEG: f64 = 34.0;
pub const CAMERA_Z: f64 = 5.35;
/// "contain": share of the half-frustum the card may fill (the rest is margin).
pub const CONTAIN_MARGIN: f64 = 0.88;
/// "studio": share of the half-height a taller-than-standard card fills when turned edge-on.
const STUDIO_TALL_MARGIN: f64 = 0.9;

/// `StageFit`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Fit {
    /// The fixed studio camera (room for a full turn; taller-than-standard cards pull back to fit).
    #[default]
    Studio,
    /// The card fills the canvas with a margin at rest; the camera backs off just enough to keep every
    /// corner in view as it turns (`<metal-card>`'s default).
    Contain,
}

impl Fit {
    pub fn parse(s: &str) -> Option<Fit> {
        match s {
            "studio" => Some(Fit::Studio),
            "contain" => Some(Fit::Contain),
            _ => None,
        }
    }
}

/// `StageOptions` (the parts the engine needs).
#[derive(Clone, Debug)]
pub struct StageOptions {
    pub quality: Quality,
    pub fit: Fit,
    /// Drag / flip / keyboard. Default true.
    pub interactive: bool,
    /// The one-shot intro on the first card. Default = `interactive`; the host passes false when the
    /// page has already played it (once per page) or the user prefers reduced motion.
    pub intro: bool,
    pub reduced_motion: bool,
    pub fit_to_viewport: bool,
    pub default_rotation: CardRotation,
}

impl Default for StageOptions {
    fn default() -> Self {
        StageOptions {
            quality: Quality::Performance,
            fit: Fit::Studio,
            interactive: true,
            intro: true,
            reduced_motion: false,
            fit_to_viewport: false,
            default_rotation: CardRotation::default(),
        }
    }
}

/// How a staged card is framed (`stagingView`, scene/staging.ts): with a floor or a sweep the camera
/// rises a little and looks slightly down at a point below the card's centre, from `distance` × the
/// stage's own distance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StagingView {
    /// Camera elevation above the target, radians.
    pub elevation: f64,
    /// World y the camera looks at.
    pub target_y: f64,
    /// Multiplier on the camera distance.
    pub distance: f64,
    /// World y of the floor (`None`: no floor).
    pub floor_y: Option<f64>,
}

/// The camera on its axis with no staging: the framing an orbit starts from (`AXIS_VIEW`).
const AXIS_VIEW: StagingView = StagingView { elevation: 0.0, target_y: 0.0, distance: 1.0, floor_y: None };

/// `CameraOrbit`: the camera around its framing target (camera paths), on top of the fit and any
/// staging view.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraOrbit {
    /// Degrees about the vertical.
    pub azimuth: f64,
    /// Extra elevation, degrees.
    pub elevation: f64,
    /// Multiplier on the framing distance.
    pub distance: f64,
}

/// `containDistance`: camera distance (on +z, looking at the origin) at which every point projects
/// inside `k` of the half-frustum.
pub fn contain_distance(points: &[Vec3], fov_deg: f64, aspect: f64, k: f64) -> f64 {
    let tv = (fov_deg / 2.0).to_radians().tan() * k;
    let th = tv * aspect;
    points.iter().fold(0.0, |d, p| d.max(p.z as f64 + (p.x as f64).abs() / th).max(p.z as f64 + (p.y as f64).abs() / tv))
}

pub struct Stage {
    pub options: StageOptions,
    card: Option<CardRenderer>,
    /// What the card was built from (`install_keyed`), for `retune`.
    built: Option<BuildKey>,
    /// The card's box corners in its own space (contain), and its half-size when taller than standard (studio).
    corners: Vec<Vec3>,
    tall_half: Option<(f64, f64)>,
    /// The slot: Euler XYZ (radians) and lift (card units).
    slot_euler: [f64; 3],
    lift: f64,
    interaction: Option<CardInteraction>,
    /// The interaction was made with the first card; its intro starts on the next `advance`.
    intro_pending: bool,
    /// The canvas aspect (width / height), from the last render.
    aspect: f64,
    /// The last `advance` time (ms): the card's animations step by the difference.
    last_now: Option<f64>,
    /// The host's orbit of the camera (`setCameraOrbit`).
    orbit: Option<CameraOrbit>,
    /// The camera distance the host placed (three's `camera.position.z` set by the page, as Card
    /// Studio's exports do); `None`: the stage's own (`CAMERA_Z`).
    pub host_z: Option<f64>,
}

impl Stage {
    pub fn new(options: StageOptions) -> Stage {
        Stage {
            options,
            card: None,
            built: None,
            corners: Vec::new(),
            tall_half: None,
            slot_euler: [0.0; 3],
            lift: 0.0,
            interaction: None,
            intro_pending: false,
            aspect: 1.0,
            last_now: None,
            orbit: None,
            host_z: None,
        }
    }

    pub fn has_card(&self) -> bool {
        self.card.is_some()
    }

    /// The options to build this stage's cards with (`CardRenderer::new`).
    pub fn card_options(&self, custom_font_family: Option<String>) -> CardOptions {
        CardOptions { quality: self.options.quality, custom_font_family, reduced_motion: self.options.reduced_motion, ..Default::default() }
    }

    /// Shows `next` in place of the current card (`setDesign`, once the new card is built: building is
    /// async on the web, so the host builds it with `card_options` and the current card stays on screen
    /// meanwhile).
    pub fn install(&mut self, next: CardRenderer) {
        self.built = None;
        // `measureCard`.
        self.corners = next.renderer.local_box().map_or_else(Vec::new, |(a, b)| {
            (0..8).map(|k| Vec3::new(if k & 4 == 0 { a.x } else { b.x }, if k & 2 == 0 { a.y } else { b.y }, if k & 1 == 0 { a.z } else { b.z })).collect()
        });
        let frame = &next.frame;
        self.tall_half = frame.portrait.then_some((frame.width / 2.0, frame.height / 2.0));
        self.card = Some(next);
        // The interaction comes with the first card.
        if self.interaction.is_none() && self.options.interactive {
            let o = &self.options;
            self.interaction = Some(CardInteraction::new(InteractionOptions {
                default_rotation: o.default_rotation,
                interactive: o.interactive,
                fit_to_viewport: o.fit_to_viewport,
                play_intro: o.intro,
                reduced_motion: o.reduced_motion,
                aspect: self.aspect,
                ..Default::default()
            }));
            self.intro_pending = true;
        }
    }

    /// `install` for a card built from `key` (`BuildKey::new` with the card's options), which `retune`
    /// can then change in place.
    pub fn install_keyed(&mut self, next: CardRenderer, key: BuildKey) {
        self.install(next);
        self.built = Some(key);
    }

    /// Shows `design` without a build when the card was built from the same `key` (`install_keyed`):
    /// the design then differs from the card's only in values it takes in place
    /// (`CardRenderer::retune`). False when it needs a build.
    pub fn retune(&mut self, key: &BuildKey, design: &CardDesign) -> bool {
        match (&self.built, &mut self.card) {
            (Some(built), Some(card)) if built == key => card.retune(design),
            _ => false,
        }
    }

    /// Builds `design` and shows it (native hosts: nothing waits there).
    pub async fn set_design(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        design: &CardDesign,
        host: &dyn Host,
        custom_font_family: Option<String>,
    ) -> Result<(), LoadError> {
        let next = CardRenderer::new(device, queue, format, design, host, &self.card_options(custom_font_family)).await?;
        self.install(next);
        Ok(())
    }

    /// The current card's face shader errors as JSON (`CardRenderer::shader_errors_json`).
    pub fn shader_errors_json(&self) -> &str {
        self.card.as_ref().map_or("[]", |c| c.shader_errors_json())
    }

    /// The current card's face shader errors (`CardRenderer::shader_errors`).
    pub fn shader_errors(&self) -> &[crate::face_shaders::LayerError] {
        self.card.as_ref().map_or(&[], |c| c.shader_errors())
    }

    /// The current card's animated stickers (`CardRenderer::animated_stickers`).
    pub fn animated_stickers(&self) -> Vec<usize> {
        self.card.as_ref().map_or_else(Vec::new, |c| c.animated_stickers())
    }

    /// A frame for animated sticker `decal` (`CardRenderer::show_sticker_frame`).
    pub fn show_sticker_frame(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, decal: usize, width: u32, height: u32, rgba: &[u8]) -> bool {
        self.card.as_mut().is_some_and(|c| c.show_sticker_frame(device, queue, decal, width, height, rgba))
    }

    /// Sticker `decal` placed by the host without a rebuild (`CardRenderer::sticker`).
    pub fn sticker(&mut self, decal: usize, v: &[f64]) -> Vec<f64> {
        self.card.as_mut().map_or_else(Vec::new, |c| c.sticker(decal, v))
    }

    /// Where the card and the camera are for a frame at `aspect` (hosts that draw over the card:
    /// Card Studio's sticker handles): the card's world transform (16, column-major: slot · root), the
    /// camera's view matrix (16), its eye (3), its vertical field of view (degrees), and the root's
    /// quaternion (x, y, z, w: the interaction's pose without the slot).
    pub fn view(&self, aspect: f64) -> Vec<f64> {
        let cam = self.camera(aspect);
        let q = self.interaction.as_ref().map_or(glam::Quat::IDENTITY, |i| i.snapshot().quaternion);
        let mut out: Vec<f64> = self.model().to_cols_array().iter().map(|&v| v as f64).collect();
        out.extend(cam.view.to_cols_array());
        out.extend(cam.eye.to_array());
        out.push(CAMERA_FOV_DEG);
        out.extend(q.to_array().map(|v| v as f64));
        out
    }

    /// The slot's rotation, radians, Euler XYZ (`setRotation`; independent of the interaction).
    pub fn set_rotation(&mut self, euler: [f64; 3]) {
        self.slot_euler = euler;
    }

    /// The page's pointer in the canvas's normalised device coordinates (x right, y up, −1..1; outside
    /// the canvas is fine), or `None` once it left the page: effects that follow the pointer (live
    /// liquid metal) read its speed. They redraw by themselves.
    pub fn set_pointer(&mut self, ndc: Option<[f64; 2]>) {
        if let (Some(ndc), Some(c)) = (ndc, self.card.as_mut()) {
            c.set_pointer(ndc);
        }
    }

    /// Orbits the camera around its framing target (`setCameraOrbit`; `None` returns to the plain
    /// camera). An orbit that changes nothing is none.
    pub fn set_camera_orbit(&mut self, orbit: Option<CameraOrbit>) {
        self.orbit = orbit.filter(|o| o.azimuth != 0.0 || o.elevation != 0.0 || o.distance != 1.0);
    }

    /// A wheel event on the page (its larger delta, px), for effects that react to scrolling.
    pub fn wheel(&mut self, delta: f64) {
        if let Some(c) = self.card.as_mut() {
            c.wheel(delta);
        }
    }

    /// A press at (`x`, `y`) CSS px in an element `width` × `height` (time `now`, ms): the
    /// interaction's drag. True: taken (the host captures the pointer). Only interactive stages.
    pub fn pointer_down(&mut self, id: i32, x: f64, y: f64, width: f64, height: f64, now: f64) -> bool {
        self.interaction.as_mut().is_some_and(|i| i.pointer_down(id, x, y, width, height, now))
    }

    /// True: the move belongs to a gesture (prevent the default, draw a frame).
    pub fn pointer_move(&mut self, id: i32, x: f64, y: f64, now: f64) -> bool {
        self.interaction.as_mut().is_some_and(|i| i.pointer_move(id, x, y, now))
    }

    pub fn pointer_up(&mut self, id: i32, x: f64, y: f64, now: f64) {
        if let Some(i) = self.interaction.as_mut() {
            i.pointer_up(id, x, y, now);
        }
    }

    pub fn pointer_cancel(&mut self, id: i32) {
        if let Some(i) = self.interaction.as_mut() {
            i.pointer_cancel(id);
        }
    }

    /// Raises the slot by `y` card units (`setLift`).
    pub fn set_lift(&mut self, y: f64) {
        self.lift = y;
    }

    pub fn interaction(&self) -> Option<&CardInteraction> {
        self.interaction.as_ref()
    }

    pub fn interaction_mut(&mut self) -> Option<&mut CardInteraction> {
        self.interaction.as_mut()
    }

    /// Advances the interaction to `now_ms` (starting the intro on the first call after the first
    /// card). Returns its events and whether another frame is needed (an intro, flip or interruption
    /// is running).
    pub fn advance(&mut self, now_ms: f64, aspect: f64) -> (Vec<InteractionEvent>, bool) {
        self.aspect = aspect;
        let dt = self.last_now.map_or(0.0, |t| ((now_ms - t) / 1000.0).max(0.0));
        self.last_now = Some(now_ms);
        let (events, animating) = self.advance_interaction(now_ms, aspect);
        // The card's own animations (live face shaders) step with the card's pose after the interaction.
        let model = self.model();
        let card_animates = match self.card.as_mut() {
            Some(c) => {
                c.update(dt, model);
                c.animated()
            }
            None => false,
        };
        (events, animating || card_animates)
    }

    fn advance_interaction(&mut self, now_ms: f64, aspect: f64) -> (Vec<InteractionEvent>, bool) {
        let Some(i) = self.interaction.as_mut() else { return (Vec::new(), false) };
        i.set_aspect(aspect);
        if std::mem::take(&mut self.intro_pending) {
            i.start_intro(now_ms);
        }
        let frame = i.update(now_ms);
        (i.drain_events(), frame.animating)
    }

    /// The card's world transform: slot (lift, Euler XYZ) · root (the interaction's pose).
    pub fn model(&self) -> Mat4 {
        let [x, y, z] = self.slot_euler.map(|v| v as f32);
        let slot =
            Mat4::from_translation(Vec3::new(0.0, self.lift as f32, 0.0)) * Mat4::from_rotation_x(x) * Mat4::from_rotation_y(y) * Mat4::from_rotation_z(z);
        let root = self.interaction.as_ref().map_or(Mat4::IDENTITY, |i| root_matrix(&i.snapshot()));
        slot * root
    }

    /// The camera's distance for this frame (`frameCamera`, without staging).
    pub fn camera_z(&self, aspect: f64) -> f64 {
        let base = self.host_z.unwrap_or(CAMERA_Z);
        if self.options.fit == Fit::Contain && !self.corners.is_empty() {
            let m = self.model();
            let world: Vec<Vec3> = self.corners.iter().map(|c| m.transform_point3(*c)).collect();
            return contain_distance(&world, CAMERA_FOV_DEG, aspect, CONTAIN_MARGIN);
        }
        if let Some((hx, hy)) = self.tall_half.filter(|_| base == CAMERA_Z) {
            // Edge-on (a turn about y) the near edge comes `hx` closer; keep the full height in view
            // (a host that places the camera itself frames the card its own way).
            let tv = (CAMERA_FOV_DEG / 2.0).to_radians().tan() * STUDIO_TALL_MARGIN;
            return base.max(hx + hy / tv);
        }
        base
    }

    /// The camera for this frame (`frameCamera`): on its axis (studio or contain), or placed by a
    /// staged scene's view and the host's orbit (`frameStaged`).
    pub fn camera(&self, aspect: f64) -> Camera {
        let view = self.card.as_ref().and_then(|c| c.staging);
        if view.is_none() && self.orbit.is_none() {
            return Camera::axis(self.camera_z(aspect));
        }
        let v = view.unwrap_or(AXIS_VIEW);
        let orbit = self.orbit;
        let mut d = self.host_z.unwrap_or(CAMERA_Z);
        if let Some((hx, hy)) = self.tall_half.filter(|_| d == CAMERA_Z) {
            let tv = (CAMERA_FOV_DEG / 2.0).to_radians().tan() * STUDIO_TALL_MARGIN;
            d = d.max(hx + hy / tv);
        }
        d *= v.distance * orbit.map_or(1.0, |o| o.distance);
        if self.options.fit == Fit::Contain && !self.corners.is_empty() {
            // The card's corners and the visible part of its reflection, inside the margin: bisect the distance.
            let m = self.model();
            let mut points = Vec::with_capacity(self.corners.len() * 2);
            for c in &self.corners {
                let p = m.transform_point3(*c).as_dvec3();
                points.push(p);
                if let Some(floor) = v.floor_y {
                    points.push(DVec3::new(p.x, floor - (p.y - floor) * 0.45, p.z));
                }
            }
            let t = (CAMERA_FOV_DEG / 2.0).to_radians().tan();
            let fits = |dist: f64| {
                let cam = place_staged(&v, orbit, dist);
                points.iter().all(|p| {
                    let q = cam.view.transform_point3(*p);
                    let (x, y) = (q.x / (t * aspect) / -q.z, q.y / t / -q.z);
                    x.abs() <= CONTAIN_MARGIN && y.abs() <= CONTAIN_MARGIN
                })
            };
            // Monotonic in the distance (further = smaller); bounded by the far plane.
            let (mut lo, mut hi) = (0.5f64, (0.5f64 + 1.0).max(30.0 * 0.8));
            for _ in 0..26 {
                let mid = (lo + hi) / 2.0;
                if fits(mid) {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            d = hi;
        }
        place_staged(&v, orbit, d)
    }

    /// Renders the current state into `target` (`width` × `height` device pixels). Without a card,
    /// nothing is drawn.
    pub fn render(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::TextureView, width: u32, height: u32) {
        let aspect = width as f64 / height.max(1) as f64;
        let (model, cam) = (self.model(), self.camera(aspect));
        if let Some(card) = self.card.as_mut() {
            card.prepare(device, queue, model, &cam);
            card.renderer.render_with(device, queue, target, width, height, model, &cam);
        }
    }

    /// Renders with the slot at `euler` (radians, Euler XYZ) and the interaction's pose left out, as a
    /// non-interactive stage would draw it (native hosts' exports at a fixed pose). Leaves the stage as
    /// it was: the slot's rotation, the interaction and any animation in progress.
    pub fn render_posed(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::TextureView, width: u32, height: u32, euler: [f64; 3]) {
        let (slot, interaction) = (std::mem::replace(&mut self.slot_euler, euler), self.interaction.take());
        self.render(device, queue, target, width, height);
        (self.slot_euler, self.interaction) = (slot, interaction);
    }
}

/// `placeStaged`: the camera `d` from the view's target, raised by its elevation (plus the orbit's)
/// and turned by the orbit's azimuth, looking at the target.
fn place_staged(v: &StagingView, orbit: Option<CameraOrbit>, d: f64) -> Camera {
    let el = v.elevation + orbit.map_or(0.0, |o| o.elevation).to_radians();
    let az = orbit.map_or(0.0, |o| o.azimuth).to_radians();
    let eye = DVec3::new(d * az.sin() * el.cos(), v.target_y + d * el.sin(), d * az.cos() * el.cos());
    Camera::look_at(eye, DVec3::new(0.0, v.target_y, 0.0), az)
}

/// The root's matrix from an interaction pose (position · quaternion · scale, as three composes it).
fn root_matrix(f: &InteractionFrame) -> Mat4 {
    let [px, py, pz] = f.position.map(|v| v as f32);
    Mat4::from_scale_rotation_translation(Vec3::splat(f.scale as f32), f.quaternion, Vec3::new(px, py, pz))
}
