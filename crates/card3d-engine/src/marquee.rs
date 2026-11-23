//! The marquee (`mountMarquee`, the three.js engine's marquee/marquee.ts) without the platform parts: the
//! seven recycled slots on the strip (`marquee_model`), the intro clock, the drift gate, flips and
//! turns, the pointer gestures (scrub, turn, scroll, click to seek and flip, fling, wheel), and one
//! frame of many cards: every slot's card is a [`CardRenderer`] built
//! on one shared environment and pipeline set (`SharedCards`: the PMREM atlas, the card shader's
//! pipelines, the surface and chip maps), drawn in turn into one multisampled target from one camera,
//! farthest first, with every card's point lights lighting every card (three's one scene).
//!
//! The host (packages/core/src/marquee/mount.ts on the web) owns the canvas, sizing, the frame loop,
//! the DOM listeners, the design order and the strip object pages share; it builds each card the
//! marquee asks for ([`Marquee::take_builds`]) with [`Marquee::card_options`] and hands it back
//! ([`Marquee::install`]).
//!
//! On the web this is the `marquee` chunk: [`create`] is its split point and everything else is
//! reached through the returned trait object, so none of it lands in the main module.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use glam::{DVec3, Mat4, Vec3};

use crate::canvas::Host;
use crate::card::{CardOptions, CardRenderer, SharedCards, SharedMaps, SharedSurface};
use crate::marquee_model::*;
use crate::quality::Quality;
use crate::renderer::{Camera, Layers, Lighting, PointLight, Shared};

/// The frontal fill of the active hero (`MARQUEE_FRONTAL_FILL`, scene/light-values.ts).
const FILL_INTENSITY: f64 = 0.28;
const FILL_POSITION: [f32; 3] = [0.0, 1.2, 8.0];

/// A lighting preset's multiplier on the frontal fill (`LightingPreset.frontFill`).
fn front_fill(id: &str) -> f64 {
    match id {
        "dark" => 0.9,
        "light" => 1.2,
        _ => 1.0,
    }
}

/// `IntroPhase`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntroPhase {
    Arrive = 0,
    Settle = 1,
    Done = 2,
}

/// How the marquee was mounted (`MarqueeOptions`, the parts the engine needs).
#[derive(Clone, Debug)]
pub struct Options {
    /// The live hero: the frontal fill, the intro, drift-gate publishing.
    pub active: bool,
    pub quality: Quality,
    /// A lighting preset id (`LIGHTING_PRESETS`); "studio" is the plain rig.
    pub lighting: String,
    /// Play the intro fly-in (`intro ?? active`, with motion allowed and animating).
    pub play_intro: bool,
    pub reduced_motion: bool,
}

/// A card the marquee wants built: slot `slot` shows design `design` (index into the host's order);
/// `token` identifies the request for `install`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BuildRequest {
    pub slot: usize,
    pub design: usize,
    pub token: u32,
}

/// What `step` reports, as bit flags.
pub const NEEDS_LOOP: u32 = 1;
pub const INTRO_CHANGED: u32 = 2;
pub const BUILDS: u32 = 4;

/// The marquee's operations (the web binding calls them through this trait, so the code stays in
/// the `marquee` chunk).
pub trait Marquee {
    /// The design order's length.
    fn set_designs(&mut self, count: usize);
    /// The strip (`Strip::to_array`), from the page's shared `MarqueeStrip`, and back.
    fn set_strip(&mut self, values: &[f64]);
    fn strip(&self) -> [f64; STRIP_FIELDS];
    /// `animating()` (animate on, motion allowed, document visible, on screen) and `interactive()`.
    fn set_gates(&mut self, animating: bool, interactive: bool);
    fn set_layout(&mut self, layout: Layout);
    /// `step(now, advance)`: intro, drift, flips, slots and poses, every card's clock. `aspect`: the
    /// canvas's CSS aspect; `only`: show one slot (`render({ only })`). Flags: [`NEEDS_LOOP`] (a flip
    /// or seek runs), [`INTRO_CHANGED`], [`BUILDS`] (cards to build: `take_builds`).
    fn step(&mut self, now: f64, advance: bool, aspect: f64, only: Option<usize>) -> u32;
    fn take_builds(&mut self) -> Vec<BuildRequest>;
    /// The options to build cards with (the shared environment and maps, `keepChipBright`).
    fn card_options(&self, custom_font_family: Option<String>) -> CardOptions;
    /// Shows a built card in its slot; false when a newer request for the slot replaced it.
    fn install(&mut self, slot: usize, token: u32, card: CardRenderer) -> bool;
    /// Draws the frame from the last `step` into `target` (`width` × `height` device pixels).
    fn render(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::TextureView, width: u32, height: u32);
    fn intro_phase(&self) -> IntroPhase;
    /// Ends the intro at once (hidden, off screen, reduced motion, animation turned off).
    fn force_intro_done(&mut self);
    /// Per slot: e, logical, design (−1: none), a, ready (0 / 1).
    fn slots(&self) -> Vec<f64>;
    /// The logical card under the pointer (CSS px in a `width` × `height` canvas), if any.
    fn pick(&self, x: f64, y: f64, width: f64, height: f64) -> Option<i64>;
    /// A press the page let through (its pointer lock claimed): `logical` from `pick`.
    fn begin_drag(&mut self, id: i32, logical: Option<i64>, touch: bool, coarse: bool, x: f64, y: f64, now: f64);
    /// The drag's pointer moved: the page scrolls by the returned dy (CSS px) in scroll mode (`NaN`:
    /// nothing to scroll).
    fn drag_move(&mut self, id: i32, x: f64, y: f64, now: f64) -> f64;
    /// The pointer of the drag in progress.
    fn drag_id(&self) -> Option<i32>;
    /// The drag is scrubbing (the page shows the grabbing cursor).
    fn scrubbing(&self) -> bool;
    /// The drag ended (`mine`: the page's pointer lock was this marquee's); a click seeks and flips.
    fn end_drag(&mut self, mine: bool, cancelled: bool, now: f64);
    /// A horizontal wheel (dx, dy in px): true when it scrubbed (prevent the default).
    fn wheel(&mut self, dx: f64, dy: f64, now: f64) -> bool;
    /// Rebuilds the environment for a lighting preset (the cards keep).
    fn set_lighting(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, id: &str);
    /// Another quality tier: a new environment, and every card rebuilt.
    fn set_quality(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, quality: Quality);

    /// The methods above as numbers in and out (`op::*`), for hosts that talk to the marquee through
    /// one call (the web binding: one export instead of one per method). Booleans are 0 / 1, a missing
    /// logical card or pointer is NaN.
    fn call(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, op: u32, a: &[f64]) -> Vec<f64> {
        let arg = |i: usize| a.get(i).copied().unwrap_or(f64::NAN);
        let flag = |i: usize| arg(i) == 1.0;
        let some = |v: f64| v.is_finite().then_some(v as i64);
        match op {
            op::SET_DESIGNS => self.set_designs(some(arg(0)).map_or(0, |n| n.max(0) as usize)),
            op::SET_STRIP => self.set_strip(a),
            op::STRIP => return self.strip().to_vec(),
            op::SET_GATES => self.set_gates(flag(0), flag(1)),
            op::SET_LAYOUT => self.set_layout(Layout { row_y_frac: arg(0), x_frac: arg(1), center_height_frac: arg(2), card_spacing: arg(3) }),
            op::STEP => return vec![self.step(arg(0), flag(1), arg(2), usize::try_from(some(arg(3)).unwrap_or(-1)).ok()) as f64],
            op::TAKE_BUILDS => return self.take_builds().iter().flat_map(|b| [b.slot as f64, b.design as f64, b.token as f64]).collect(),
            op::INTRO_PHASE => return vec![self.intro_phase() as u8 as f64],
            op::FORCE_INTRO_DONE => self.force_intro_done(),
            op::SLOTS => return self.slots(),
            op::PICK => return vec![self.pick(arg(0), arg(1), arg(2), arg(3)).map_or(f64::NAN, |l| l as f64)],
            op::BEGIN_DRAG => self.begin_drag(arg(0) as i32, some(arg(1)), flag(2), flag(3), arg(4), arg(5), arg(6)),
            op::DRAG_MOVE => return vec![self.drag_move(arg(0) as i32, arg(1), arg(2), arg(3)), self.scrubbing() as u8 as f64],
            op::DRAG_ID => return vec![self.drag_id().map_or(f64::NAN, f64::from)],
            op::END_DRAG => self.end_drag(flag(0), flag(1), arg(2)),
            op::WHEEL => return vec![self.wheel(arg(0), arg(1), arg(2)) as u8 as f64],
            op::SET_QUALITY => self.set_quality(device, queue, if flag(0) { Quality::Full } else { Quality::Performance }),
            _ => {}
        }
        Vec::new()
    }
}

/// `Marquee::call`'s operations and their arguments.
pub mod op {
    /// The number of designs (`set_designs`).
    pub const SET_DESIGNS: u32 = 0;
    /// The strip's 16 numbers.
    pub const SET_STRIP: u32 = 1;
    /// → the strip's 16 numbers.
    pub const STRIP: u32 = 2;
    /// animating, interactive.
    pub const SET_GATES: u32 = 3;
    /// rowYFrac, xFrac, centerHeightFrac, cardSpacing.
    pub const SET_LAYOUT: u32 = 4;
    /// now, advance, aspect, only (−1: all) → [flags].
    pub const STEP: u32 = 5;
    /// → [slot, design, token] per card to build.
    pub const TAKE_BUILDS: u32 = 6;
    /// → [0 arrive, 1 settle, 2 done].
    pub const INTRO_PHASE: u32 = 7;
    pub const FORCE_INTRO_DONE: u32 = 8;
    /// → [e, logical, design (−1: none), a, ready] per slot.
    pub const SLOTS: u32 = 9;
    /// x, y, width, height → [logical or NaN].
    pub const PICK: u32 = 10;
    /// id, logical, touch, coarse, x, y, now.
    pub const BEGIN_DRAG: u32 = 11;
    /// id, x, y, now → [dy to scroll or NaN, scrubbing].
    pub const DRAG_MOVE: u32 = 12;
    /// → [the drag's pointer or NaN].
    pub const DRAG_ID: u32 = 13;
    /// mine, cancelled, now.
    pub const END_DRAG: u32 = 15;
    /// dx, dy, now → [scrubbed].
    pub const WHEEL: u32 = 16;
    /// full (1) or performance (0).
    pub const SET_QUALITY: u32 = 17;
}

/// The maps the marquee's cards share (`SharedMaps`): surface maps by their inputs (one no card uses
/// any more is dropped when the next is made) and the chip's detail maps.
/// A surface's inputs: map size, grain and relief (bits), texture, orbit pattern.
type SurfaceKey = (u32, u64, u64, String, bool);

#[derive(Default)]
struct MapCache {
    surfaces: RefCell<HashMap<SurfaceKey, Rc<SharedSurface>>>,
    chip: RefCell<Option<(wgpu::Texture, wgpu::Texture)>>,
}

impl SharedMaps for MapCache {
    fn surface(&self, device: &wgpu::Device, queue: &wgpu::Queue, size: u32, recipe: &crate::design::Recipe) -> Rc<SharedSurface> {
        let orbit = recipe.pattern == "orbit";
        let key = (size, recipe.grain.to_bits(), recipe.relief.to_bits(), recipe.texture.clone(), orbit);
        let mut cache = self.surfaces.borrow_mut();
        if let Some(s) = cache.get(&key) {
            return s.clone();
        }
        cache.retain(|_, s| Rc::strong_count(s) > 1);
        let mut maps = crate::material::surface_maps(size, recipe.grain, recipe.relief, &recipe.texture, orbit);
        let up = |px: &[u8]| crate::renderer::upload(device, queue, &crate::material::mip_chain(px, size, size, false), false);
        let (normal, rough) = (up(&maps.normal), up(&maps.roughness));
        maps.normal = Vec::new();
        maps.roughness = Vec::new();
        let s = Rc::new(SharedSurface { normal, rough, maps });
        cache.insert(key, s.clone());
        s
    }

    fn chip(&self, device: &wgpu::Device, queue: &wgpu::Queue, host: &dyn Host) -> (wgpu::Texture, wgpu::Texture) {
        self.chip
            .borrow_mut()
            .get_or_insert_with(|| {
                let (w, h, color, height) = crate::chip::draw_detail(host);
                let up = |px: &[u8], srgb| crate::renderer::upload(device, queue, &crate::material::mip_chain(px, w, h, srgb), srgb);
                (up(&color, true), up(&height, false))
            })
            .clone()
    }
}

/// The marquee on `device` (the `marquee` chunk: only pages with a marquee download it).
#[wasm_split_helpers::wasm_split(marquee, fallible)]
pub fn create(device: &wgpu::Device, queue: &wgpu::Queue, format: wgpu::TextureFormat, options: Options) -> Result<Box<dyn Marquee>, crate::ChunkUnavailable> {
    Ok(Box::new(MarqueeState::new(device, queue, format, options)))
}

#[derive(Clone, Copy, Default)]
struct Turn {
    pose: TurnPose,
    flip_from: f64,
    flip_target: f64,
    flip_start_ms: f64,
    flip_duration_ms: f64,
}

struct Slot {
    e: usize,
    rnd: SlotRandoms,
    logical: Option<i64>,
    design: Option<usize>,
    a: f64,
    jitter: Jitter,
    card: Option<CardRenderer>,
    token: u32,
    pose: SlotPose,
    /// Drawn this frame (`group.visible`).
    visible: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Pending,
    Scrub,
    Turn,
    Scroll,
}

struct Drag {
    id: i32,
    mode: Mode,
    logical: Option<i64>,
    card_actions: bool,
    touch: bool,
    coarse: bool,
    start: (f64, f64),
    last: (f64, f64),
    last_t: f64,
    moved: f64,
    vx: f64,
}

struct Intro {
    phase: IntroPhase,
    warm_frames: u32,
    running: bool,
    arrive_t: f64,
}

struct MarqueeState {
    options: Options,
    format: wgpu::TextureFormat,
    shared: SharedCards,
    lighting: Lighting,
    strip: Strip,
    /// The number of designs in the host's order.
    designs: usize,
    layout: Layout,
    animating: bool,
    interactive: bool,
    slots: Vec<Slot>,
    turns: HashMap<i64, Turn>,
    intro: Intro,
    any_mounted: bool,
    tweening: bool,
    was_animating: bool,
    last_frame: f64,
    aspect: f64,
    drag: Option<Drag>,
    builds: Vec<BuildRequest>,
    layers: Option<(u32, u32, u64, Layers)>,
}

/// The marquee's camera: on +z at 12, looking at the origin (fov 34°, far 60).
fn camera() -> Camera {
    Camera::axis(CAM_Z)
}

/// A slot's world transform: position · Euler XYZ · uniform scale.
fn slot_matrix(p: &SlotPose) -> Mat4 {
    Mat4::from_translation(Vec3::new(p.x as f32, p.y as f32, p.z as f32))
        * Mat4::from_rotation_x(p.pitch as f32)
        * Mat4::from_rotation_y(p.yaw as f32)
        * Mat4::from_rotation_z(p.roll as f32)
        * Mat4::from_scale(Vec3::splat(p.scale as f32))
}

impl MarqueeState {
    fn new(device: &wgpu::Device, queue: &wgpu::Queue, format: wgpu::TextureFormat, options: Options) -> MarqueeState {
        let preset = crate::lighting::preset(Some(&options.lighting));
        let options = Options { lighting: preset.id.to_string(), ..options };
        let gpu = Shared::studio(device, queue, format, preset.look.as_ref(), options.quality);
        let intro = options.play_intro;
        let mut m = MarqueeState {
            format,
            shared: SharedCards { gpu, maps: Rc::new(MapCache::default()) },
            lighting: Lighting::default(),
            strip: Strip::default(),
            designs: 0,
            layout: DEFAULT_LAYOUT,
            animating: false,
            interactive: false,
            slots: (0..POOL)
                .map(|e| Slot {
                    e,
                    rnd: slot_randoms(e),
                    logical: None,
                    design: None,
                    a: 0.0,
                    jitter: logical_jitter(0.0),
                    card: None,
                    token: 0,
                    pose: SlotPose::default(),
                    visible: false,
                })
                .collect(),
            turns: HashMap::new(),
            intro: Intro {
                phase: if intro { IntroPhase::Arrive } else { IntroPhase::Done },
                warm_frames: 0,
                running: false,
                arrive_t: if intro { 0.0 } else { 1.0 },
            },
            any_mounted: false,
            tweening: false,
            was_animating: false,
            last_frame: 0.0,
            aspect: 1.0,
            drag: None,
            builds: Vec::new(),
            layers: None,
            options,
        };
        m.apply_lighting();
        m
    }

    /// The lights of the marquee's rig: the studio lights (with the preset's values) and, for the
    /// active hero, the frontal fill.
    fn apply_lighting(&mut self) {
        let p = crate::lighting::preset(Some(&self.options.lighting));
        let lin = |hex: &str, k: f64| crate::material::srgb_hex_to_linear(hex).map(|c| c * k as f32);
        self.lighting = Lighting {
            exposure: p.exposure as f32,
            env_intensity: p.env_intensity as f32,
            env_rotation_y: p.env_rotation_y as f32,
            ambient: lin(p.ambient.0, p.ambient.1),
            key: lin(p.key.0, p.key.1),
            key_position: p.key.2.map(|v| v as f32),
            fill: if self.options.active { lin("#ffffff", FILL_INTENSITY * front_fill(p.id)) } else { [0.0; 3] },
            fill_position: FILL_POSITION,
        };
    }

    fn set_intro_phase(&mut self, p: IntroPhase) -> bool {
        if self.intro.phase == p {
            return false;
        }
        self.intro.phase = p;
        true
    }

    fn turn(&mut self, logical: i64) -> &mut Turn {
        self.turns.entry(logical).or_default()
    }

    /// `buildSlot`: drop the slot's card (the slot shows nothing until the new one is ready) and
    /// ask for the slot's design.
    fn build_slot(&mut self, i: usize) {
        let s = &mut self.slots[i];
        s.token += 1;
        s.card = None;
        let Some(design) = s.design else { return };
        self.builds.retain(|b| b.slot != i);
        self.builds.push(BuildRequest { slot: i, design, token: s.token });
    }

    /// `syncSlots`: each slot's logical card and design for the current offset; a new design is built.
    fn sync_slots(&mut self) {
        let n = self.designs;
        for i in 0..self.slots.len() {
            let asg = assign_slot(self.slots[i].e, self.strip.offset, n);
            let s = &mut self.slots[i];
            s.a = asg.a;
            if s.logical != Some(asg.logical) {
                s.logical = Some(asg.logical);
                s.jitter = logical_jitter(asg.logical as f64);
            }
            let design = (n > 0).then_some(asg.design);
            if design != s.design {
                s.design = design;
                self.build_slot(i);
            }
        }
    }

    fn ray(&self, x: f64, y: f64, width: f64, height: f64) -> (DVec3, DVec3) {
        let (nx, ny) = (x / width * 2.0 - 1.0, -(y / height) * 2.0 + 1.0);
        let t = (CAM_FOV / 2.0).to_radians().tan();
        let cam = camera();
        (cam.eye, DVec3::new(nx * t * self.aspect, ny * t, -1.0).normalize())
    }

    /// Seek and flip.
    fn card_click(&mut self, logical: i64, now: f64) {
        let d = wrapped_distance(logical, self.strip.offset);
        let mut flip_ms = TURN_FLIP_MS;
        if d.abs() > SEEK_CENTER_EPS {
            if self.animating {
                let seek_ms = self.strip.seek_by(d, now);
                flip_ms = TURN_FLIP_MS.max(js_round(seek_ms * TURN_FLIP_SEEK_FRAC));
            } else {
                // As the TypeScript: the seek never progresses while the strip isn't animating, so jump.
                self.strip.seek.active = false;
                self.strip.offset += d;
                self.strip.scrub_velocity = 0.0;
                self.strip.drift_vel = 0.0;
            }
        }
        let t = self.turn(logical);
        t.flip_target = if (t.flip_target - std::f64::consts::PI).abs() < 0.05 { 0.0 } else { std::f64::consts::PI };
        t.flip_from = t.pose.flip;
        t.flip_start_ms = now;
        t.flip_duration_ms = flip_ms;
        t.pose.stand = 0.0;
        t.pose.yaw = 0.0;
        t.pose.pitch = 0.0;
        self.tweening = true;
    }

    fn layers(&mut self, device: &wgpu::Device, width: u32, height: u32) -> &Layers {
        let key = (self.aspect as f32).to_bits() as u64;
        if !self.layers.as_ref().is_some_and(|l| (l.0, l.1, l.2) == (width, height, key)) {
            let l = Layers::new(device, self.format, width, height, self.aspect as f32, CAM_FAR as f32);
            self.layers = Some((width, height, key, l));
        }
        &self.layers.as_ref().unwrap().3
    }
}

impl Marquee for MarqueeState {
    fn set_designs(&mut self, count: usize) {
        self.designs = count;
    }

    fn set_strip(&mut self, values: &[f64]) {
        if let Some(s) = Strip::from_array(values) {
            self.strip = s;
        }
    }

    fn strip(&self) -> [f64; STRIP_FIELDS] {
        self.strip.to_array()
    }

    fn set_gates(&mut self, animating: bool, interactive: bool) {
        self.animating = animating;
        self.interactive = interactive;
    }

    fn set_layout(&mut self, layout: Layout) {
        self.layout = layout;
    }

    fn step(&mut self, now: f64, advance: bool, aspect: f64, only: Option<usize>) -> u32 {
        self.aspect = aspect;
        let mut flags = 0;
        let dt_frame = if self.last_frame != 0.0 { ((now - self.last_frame) / 1000.0).min(0.1) } else { 0.0 };
        self.last_frame = now;
        let anim = advance && self.animating;
        if anim && !self.was_animating {
            self.strip.last_advance = 0.0; // resume without a jump
        }
        self.was_animating = anim;

        // The intro clock.
        if self.intro.phase != IntroPhase::Done && self.any_mounted && anim {
            if !self.intro.running {
                self.intro.warm_frames += 1;
                if self.intro.warm_frames >= INTRO_WARM_FRAMES {
                    self.intro.running = true;
                }
            } else {
                self.intro.arrive_t = clamp(self.intro.arrive_t + dt_frame.min(INTRO_MAX_FRAME) / INTRO_SECONDS, 0.0, 1.0);
            }
            if self.intro.arrive_t >= 1.0 {
                if self.set_intro_phase(IntroPhase::Done) {
                    flags |= INTRO_CHANGED;
                }
            } else if self.intro.arrive_t >= INTRO_SETTLE_AT && self.intro.phase == IntroPhase::Arrive && self.set_intro_phase(IntroPhase::Settle) {
                flags |= INTRO_CHANGED;
            }
        }
        let intro_done = self.intro.phase == IntroPhase::Done;
        let gate = intro_gate(self.intro.arrive_t, intro_done);
        if self.options.active {
            self.strip.publish_drift_gate(gate);
        }
        if anim {
            self.strip.advance_drift(now, gate);
        }

        // Flips.
        self.tweening = false;
        #[allow(clippy::iter_over_hash_type, reason = "each turn steps on its own: the order doesn't matter")]
        for t in self.turns.values_mut() {
            if t.flip_duration_ms <= 0.0 {
                continue;
            }
            let k = clamp((now - t.flip_start_ms) / t.flip_duration_ms, 0.0, 1.0);
            t.pose.flip = t.flip_from + (t.flip_target - t.flip_from) * ease_in_out_cubic(k);
            if k >= 1.0 {
                t.flip_duration_ms = 0.0;
            } else {
                self.tweening = true;
            }
        }
        if self.strip.seek.active {
            self.tweening = self.tweening || anim;
        }

        // Each slot's pose.
        self.sync_slots();
        let frame = frame_inputs(&self.layout, aspect);
        let intro = (!intro_done).then_some(self.intro.arrive_t);
        for i in 0..self.slots.len() {
            let s = &self.slots[i];
            let turn = s.logical.and_then(|l| self.turns.get(&l)).map_or_else(TurnPose::default, |t| t.pose);
            let pose = slot_pose(&PoseInput {
                a: s.a,
                t: self.strip.time,
                frame,
                slot: s.rnd,
                jitter: s.jitter,
                turn,
                preview_paused: self.strip.preview_paused,
                intro,
            });
            let s = &mut self.slots[i];
            s.pose = pose;
            s.visible = pose.visible && s.card.is_some() && only.is_none_or(|o| o == s.e);
        }
        let live: Vec<i64> = self.slots.iter().filter_map(|s| s.logical).collect();
        self.turns.retain(|k, _| live.contains(k));

        // Every mounted card ticks, so its clock keeps running.
        for s in &mut self.slots {
            let model = slot_matrix(&s.pose);
            if let Some(c) = s.card.as_mut() {
                c.update(dt_frame, model);
            }
        }
        if self.tweening || self.drag.is_some() {
            flags |= NEEDS_LOOP;
        }
        if !self.builds.is_empty() {
            flags |= BUILDS;
        }
        flags
    }

    fn take_builds(&mut self) -> Vec<BuildRequest> {
        std::mem::take(&mut self.builds)
    }

    fn card_options(&self, custom_font_family: Option<String>) -> CardOptions {
        let full = self.options.quality == Quality::Full;
        CardOptions {
            quality: self.options.quality,
            custom_font_family,
            reduced_motion: self.options.reduced_motion,
            keep_chip_bright: true,
            face_width: Some(if self.options.active && full { 1280 } else { 640 }),
            shared: Some(self.shared.clone()),
            print: false,
        }
    }

    fn install(&mut self, slot: usize, token: u32, card: CardRenderer) -> bool {
        let Some(s) = self.slots.get_mut(slot).filter(|s| s.token == token) else { return false };
        s.card = Some(card);
        self.any_mounted = true;
        true
    }

    fn render(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::TextureView, width: u32, height: u32) {
        let cam = camera();
        // Farthest first: the cards don't intersect, so each one's own draw order holds within it.
        let mut order: Vec<usize> = (0..self.slots.len()).filter(|&i| self.slots[i].visible).collect();
        order.sort_by(|&a, &b| self.slots[a].pose.z.total_cmp(&self.slots[b].pose.z).then(a.cmp(&b)));
        // Each card's per-frame state, then every point light in world space (three's lights belong
        // to the scene: a shine add-on lights its neighbours too).
        let mut lights: Vec<PointLight> = Vec::new();
        for s in self.slots.iter_mut().filter(|s| s.visible) {
            let model = slot_matrix(&s.pose);
            let c = s.card.as_mut().unwrap();
            c.prepare(device, queue, model, &cam);
            for p in &c.renderer.point_lights {
                let w = model.transform_point3(Vec3::from(p.position));
                lights.push(PointLight { position: w.into(), ..*p });
            }
        }
        let lighting = self.lighting;
        self.layers(device, width, height);
        let layers = &self.layers.as_ref().unwrap().3;
        if order.is_empty() {
            // Nothing to draw: clear the canvas.
            let mut encoder = device.create_command_encoder(&Default::default());
            encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("marquee clear"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            queue.submit([encoder.finish()]);
            return;
        }
        for (k, &i) in order.iter().enumerate() {
            let s = &mut self.slots[i];
            let model = slot_matrix(&s.pose);
            let c = s.card.as_mut().unwrap();
            c.renderer.lighting = lighting;
            c.renderer.world_lights = Some(lights.clone());
            c.renderer.render_layer(device, queue, target, layers, k == 0, model, &cam);
        }
    }

    fn intro_phase(&self) -> IntroPhase {
        self.intro.phase
    }

    fn force_intro_done(&mut self) {
        if self.intro.phase == IntroPhase::Done {
            return;
        }
        self.intro.arrive_t = 1.0;
        self.intro.phase = IntroPhase::Done;
        if self.options.active {
            self.strip.publish_drift_gate(1.0);
        }
    }

    fn slots(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.slots.len() * 5);
        for s in &self.slots {
            out.extend([s.e as f64, s.logical.map_or(f64::NAN, |l| l as f64), s.design.map_or(-1.0, |d| d as f64), s.a, s.card.is_some() as u8 as f64]);
        }
        out
    }

    fn pick(&self, x: f64, y: f64, width: f64, height: f64) -> Option<i64> {
        let (o, d) = self.ray(x, y, width, height);
        let mut best: Option<(f64, i64)> = None;
        for s in self.slots.iter().filter(|s| s.visible) {
            let Some(c) = s.card.as_ref() else { continue };
            let Some((lo, hi)) = c.renderer.local_box() else { continue };
            let inv = slot_matrix(&s.pose).as_dmat4().inverse();
            let (lo_, ld) = (inv.transform_point3(o), inv.transform_vector3(d));
            // The ray against the card's box in its own space (slabs).
            let (mut t0, mut t1) = (f64::NEG_INFINITY, f64::INFINITY);
            for k in 0..3 {
                let (a, b) = (lo[k] as f64, hi[k] as f64);
                if ld[k].abs() < 1e-12 {
                    if lo_[k] < a || lo_[k] > b {
                        t0 = f64::INFINITY;
                    }
                    continue;
                }
                let (u, v) = ((a - lo_[k]) / ld[k], (b - lo_[k]) / ld[k]);
                t0 = t0.max(u.min(v));
                t1 = t1.min(u.max(v));
            }
            if t0 > t1 || t1 < 0.0 {
                continue;
            }
            // The hit's distance from the eye, in world space.
            let hit = slot_matrix(&s.pose).as_dmat4().transform_point3(lo_ + ld * t0.max(0.0));
            let dist = (hit - o).length();
            if let Some(l) = s.logical {
                if best.is_none_or(|(b, _)| dist < b) {
                    best = Some((dist, l));
                }
            }
        }
        best.map(|(_, l)| l)
    }

    fn begin_drag(&mut self, id: i32, logical: Option<i64>, touch: bool, coarse: bool, x: f64, y: f64, now: f64) {
        let card_actions = self.intro.phase == IntroPhase::Done;
        if let (true, Some(l)) = (card_actions, logical) {
            self.turn(l);
        }
        self.drag = Some(Drag { id, mode: Mode::Pending, logical, card_actions, touch, coarse, start: (x, y), last: (x, y), last_t: now, moved: 0.0, vx: 0.0 });
        if card_actions {
            self.strip.begin_gesture();
        }
    }

    fn drag_move(&mut self, id: i32, x: f64, y: f64, now: f64) -> f64 {
        let Some(drag) = self.drag.as_mut().filter(|d| d.id == id) else { return f64::NAN };
        let (dx, dy) = (x - drag.last.0, y - drag.last.1);
        let dt = (now - drag.last_t).max(1.0);
        drag.moved += dx.abs() + dy.abs();
        drag.last = (x, y);
        drag.last_t = now;
        let axis_lock = if drag.coarse { MOBILE_AXIS_LOCK_PX } else { AXIS_LOCK_PX };
        if drag.mode == Mode::Pending && drag.moved >= axis_lock {
            let (tx, ty) = (x - drag.start.0, y - drag.start.1);
            let vertical = ty.abs() > tx.abs();
            let bg = drag.logical.is_none();
            if drag.card_actions {
                if (drag.touch && vertical) || (bg && vertical) {
                    drag.mode = Mode::Scroll;
                    self.strip.end_gesture();
                } else if self.strip.preview_paused && bg {
                    return f64::NAN;
                } else if self.strip.preview_paused {
                    drag.mode = Mode::Turn;
                } else if bg || tx.abs() >= ty.abs() {
                    drag.mode = Mode::Scrub;
                } else {
                    drag.mode = Mode::Turn;
                }
            } else {
                drag.mode = if vertical { Mode::Scroll } else { Mode::Pending };
            }
        }
        match drag.mode {
            Mode::Scroll => return dy,
            Mode::Scrub => {
                let d = -dx * SCRUB_PX_TO_CARDS;
                drag.vx = 0.6 * drag.vx + 0.4 * (d / (dt / 1000.0));
                self.strip.scrub_by(d, now);
            }
            Mode::Turn => {
                if let Some(l) = drag.logical {
                    let t = self.turns.entry(l).or_default();
                    t.pose.yaw += dx * DRAG_SENSITIVITY;
                    t.pose.pitch = clamp(t.pose.pitch + dy * DRAG_SENSITIVITY, -MAX_USER_PITCH, MAX_USER_PITCH);
                }
            }
            Mode::Pending => {}
        }
        f64::NAN
    }

    fn drag_id(&self) -> Option<i32> {
        self.drag.as_ref().map(|d| d.id)
    }

    fn scrubbing(&self) -> bool {
        self.drag.as_ref().is_some_and(|d| d.mode == Mode::Scrub)
    }

    fn end_drag(&mut self, mine: bool, cancelled: bool, now: f64) {
        let Some(drag) = self.drag.take() else { return };
        if !mine {
            return;
        }
        if !drag.card_actions || drag.mode == Mode::Scroll || cancelled || self.intro.phase != IntroPhase::Done {
            self.strip.end_gesture();
            return;
        }
        let slop = if drag.coarse { MOBILE_CLICK_SLOP_PX } else { CLICK_SLOP_PX };
        let is_click = drag.moved < slop;
        if drag.mode == Mode::Scrub || (drag.mode == Mode::Pending && drag.logical.is_none()) {
            self.strip.fling(drag.vx);
            return;
        }
        self.strip.end_gesture();
        if let (true, Some(l)) = (is_click, drag.logical) {
            self.card_click(l, now);
        }
    }

    fn wheel(&mut self, dx: f64, dy: f64, now: f64) -> bool {
        if !self.interactive || self.intro.phase != IntroPhase::Done || self.strip.preview_paused {
            return false;
        }
        if dx.abs() > dy.abs() && dx.abs() >= 0.5 {
            self.strip.wheel_scrub(-dx * SCRUB_PX_TO_CARDS, now);
            return true;
        }
        false
    }

    fn set_lighting(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, id: &str) {
        let preset = crate::lighting::preset(Some(id));
        if preset.id == self.options.lighting {
            return;
        }
        self.options.lighting = preset.id.to_string();
        let atlas = crate::env::build_environment(device, queue, preset.look.as_ref(), self.options.quality, None);
        let gpu = self.shared.gpu.with_atlas(atlas);
        for c in self.slots.iter_mut().filter_map(|s| s.card.as_mut()) {
            c.renderer.set_environment(device, gpu.atlas());
        }
        self.shared = SharedCards { gpu, maps: self.shared.maps.clone() };
        self.apply_lighting();
    }

    fn set_quality(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, quality: Quality) {
        if quality == self.options.quality {
            return;
        }
        self.options.quality = quality;
        let preset = crate::lighting::preset(Some(&self.options.lighting));
        let gpu = Shared::studio(device, queue, self.format, preset.look.as_ref(), quality);
        self.shared = SharedCards { gpu, maps: Rc::new(MapCache::default()) };
        for i in 0..self.slots.len() {
            if self.slots[i].design.is_some() {
                self.build_slot(i);
            }
        }
    }
}
