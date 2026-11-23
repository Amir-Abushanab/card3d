//! Single-card interaction (`scene/interaction.ts`): direct drag mapping, timed flip, the
//! one-shot intro, intro interruption, reset and keyboard. No springs, inertia or idle motion: the
//! card stays exactly where the pointer leaves it.
//!
//! The TypeScript schedules its own `requestAnimationFrame` loops and reads `performance.now()`. Here
//! the host drives time: every input takes `now_ms` (the host's monotonic clock, in milliseconds),
//! and [`CardInteraction::update`] runs the animations that were due, in the order the TypeScript
//! registers its loops (intro, interrupt, flip, drag coalescing), and returns the card's pose for
//! this frame. While [`InteractionFrame::animating`] is true the host must keep calling `update`
//! every frame. Nothing in here touches a DOM or a GPU.
//!
//! What stays in the host: the page-wide "intro played once per key" set (`playedIntros` /
//! `introKey`; see [`CardInteraction::intro_played`]), `prefers-reduced-motion` and document
//! visibility (pushed in with `set_reduced_motion` / `set_visible`), event listeners, pointer
//! capture, the primary-button check, `preventDefault`, `touch-action`, `data-*` attributes and the
//! accessible text (`role`, `aria-pressed`, "<label>; showing front|back": built from
//! [`CardInteraction::flipped`]).

use crate::geometry::CARD_W;
use glam::{DQuat, DVec3, Quat};

/// Card layout height (spec: `CARD_H`).
const CARD_H: f64 = 2.125;

/// `DEFAULT_CAMERA` (`scene/camera.ts`): field of view (degrees) and distance of the default camera.
pub const DEFAULT_CAMERA_FOV: f64 = 34.0;
pub const DEFAULT_CAMERA_Z: f64 = 5.35;

const INTRO_MS: f64 = 3600.0;
const INTERRUPT_MS: f64 = 320.0;
const CLICK_MS: f64 = 800.0;
const DRAG_SLOP_PX: f64 = 6.0;
const YAW_PER_WIDTH: f64 = 220.0;
const PITCH_PER_HEIGHT: f64 = 120.0;
const PITCH_LIMIT: f64 = 68.0;

/// Degrees: x = pitch, y = yaw (`CardRotation`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CardRotation {
    pub x: f64,
    pub y: f64,
}

/// `IntroState`: what the TypeScript publishes as `data-intro`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntroState {
    Running,
    Skipped,
    Complete,
    Interrupting,
    Interrupted,
    Reset,
}

impl IntroState {
    /// The `data-intro` value.
    pub fn as_str(self) -> &'static str {
        match self {
            IntroState::Running => "running",
            IntroState::Skipped => "skipped",
            IntroState::Complete => "complete",
            IntroState::Interrupting => "interrupting",
            IntroState::Interrupted => "interrupted",
            IntroState::Reset => "reset",
        }
    }
}

/// `rotationMode`: "front" additionally clamps the dragged yaw to the pitch limit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RotationMode {
    #[default]
    Full,
    Front,
}

/// `InteractionOptions` minus the DOM parts (element, target, `requestRender`, label, callbacks).
#[derive(Clone, Debug)]
pub struct InteractionOptions {
    pub default_rotation: CardRotation,
    /// Initial rotation (`props.rotation ?? defaultRotation`).
    pub rotation: Option<CardRotation>,
    pub default_flipped: bool,
    pub interactive: bool,
    pub rotation_mode: RotationMode,
    pub yaw_direction: f64,
    pub fit_to_viewport: bool,
    pub play_intro: bool,
    /// Whether this card's intro key already played on the page (`playedIntros.has(introKey)`).
    pub intro_played: bool,
    /// `prefers-reduced-motion: reduce`.
    pub reduced_motion: bool,
    /// Document visibility (`document.visibilityState !== "hidden"`).
    pub visible: bool,
    /// Element `clientWidth / clientHeight`, for fit-to-viewport.
    pub aspect: f64,
}

impl Default for InteractionOptions {
    fn default() -> Self {
        InteractionOptions {
            default_rotation: CardRotation::default(),
            rotation: None,
            default_flipped: false,
            interactive: true,
            rotation_mode: RotationMode::Full,
            yaw_direction: -1.0,
            fit_to_viewport: false,
            play_intro: true,
            intro_played: false,
            reduced_motion: false,
            visible: true,
            aspect: 1.0,
        }
    }
}

/// The callbacks, as values: `onRotationChange` (after a drag frame and after reset) and
/// `onFlippedChange` (on every `setFlipped`, and on reset when the card was flipped).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum InteractionEvent {
    RotationChange(CardRotation),
    FlippedChange(bool),
}

/// The card's pose for one frame: what the TypeScript leaves in `target.quaternion/position/scale`.
#[derive(Clone, Copy, Debug)]
pub struct InteractionFrame {
    /// `orientCard`'s quaternion (f32, for the GPU).
    pub quaternion: Quat,
    /// The same, in the f64 arithmetic the TypeScript uses.
    pub quaternion_f64: DQuat,
    /// `target.position` (only y moves, during the intro).
    pub position: [f64; 3],
    /// `target.scale` (uniform): the fit-to-viewport scale when enabled, else 1.
    pub scale: f64,
    /// Pitch / yaw, degrees.
    pub rotation: CardRotation,
    pub flip_deg: f64,
    pub roll_deg: f64,
    pub flipped: bool,
    pub intro_state: Option<IntroState>,
    /// An animation is running (or a drag frame is pending): call `update` again next frame.
    pub animating: bool,
}

/// `degToRad`.
fn rad(deg: f64) -> f64 {
    deg * (std::f64::consts::PI / 180.0)
}

fn clamp(v: f64, a: f64, b: f64) -> f64 {
    b.min(a.max(v))
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// `expoOut`.
pub fn expo_out(t: f64) -> f64 {
    if t >= 1.0 {
        1.0
    } else {
        1.0 - 2f64.powf(-10.0 * t)
    }
}

/// `smootherstep`.
pub fn smootherstep(t: f64) -> f64 {
    let u = clamp(t, 0.0, 1.0);
    u * u * u * (u * (6.0 * u - 15.0) + 10.0)
}

/// JS `Math.round`: halves toward +infinity.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `orientCard`: `q = Euler(pitch, yaw, roll, XYZ) · AxisAngle(+Y, flip)`, so the flip is
/// applied first in the card's own frame. All angles in degrees. Written out as three.js does
/// (`setFromEuler` XYZ, then `multiply`) so the f64 results match.
pub fn orient_card(rot: CardRotation, flip_deg: f64, roll_deg: f64) -> DQuat {
    let (x, y, z) = (rad(rot.x), rad(rot.y), rad(roll_deg));
    let (c1, c2, c3) = ((x / 2.0).cos(), (y / 2.0).cos(), (z / 2.0).cos());
    let (s1, s2, s3) = ((x / 2.0).sin(), (y / 2.0).sin(), (z / 2.0).sin());
    let a = DQuat::from_xyzw(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
    let h = rad(flip_deg) / 2.0;
    let f = DQuat::from_xyzw(0.0, h.sin(), 0.0, h.cos());
    DQuat::from_xyzw(
        a.x * f.w + a.y * f.z - a.z * f.y + a.w * f.x,
        a.y * f.w + a.z * f.x - a.x * f.z + a.w * f.y,
        a.z * f.w + a.x * f.y - a.y * f.x + a.w * f.z,
        a.w * f.w - a.x * f.x - a.y * f.y - a.z * f.z,
    )
}

/// Always spin in the same (+Y) direction; JS `Math.round` (halves toward +infinity).
pub fn flip_target(from_deg: f64, flipped: bool) -> f64 {
    let target = if flipped { 180.0 } else { 0.0 };
    target + 360.0 * js_round((from_deg - target) / 360.0)
}

/// A 180 degree flip takes 620 ms.
pub fn flip_duration(delta_deg: f64) -> f64 {
    clamp(620.0 * (delta_deg / 180.0).sqrt(), 220.0, 620.0)
}

/// `fitToViewportScale` for the default camera.
pub fn fit_to_viewport_scale(quaternion: DQuat, aspect: f64) -> f64 {
    fit_to_viewport_scale_with(quaternion, aspect, DEFAULT_CAMERA_Z, DEFAULT_CAMERA_FOV)
}

/// The largest uniform scale <= 1 (and >= 0.68) at which every corner of the card's padded bounding
/// box projects inside 90 % of the half-frustum at camera distance `cam_z`.
pub fn fit_to_viewport_scale_with(quaternion: DQuat, aspect: f64, cam_z: f64, fov_deg: f64) -> f64 {
    if !aspect.is_finite() || aspect <= 0.0 {
        return 1.0;
    }
    let tv = rad(fov_deg / 2.0).tan();
    let th = tv * aspect;
    let mut s: f64 = 1.0;
    for sx in [-1.0, 1.0] {
        for sy in [-1.0, 1.0] {
            for sz in [-1.0, 1.0] {
                let p = quaternion * DVec3::new(sx * CARD_W / 2.0, sy * CARD_H / 2.0, sz * 0.09);
                let cx = p.x.abs() + 0.9 * th * p.z;
                let cy = p.y.abs() + 0.9 * tv * p.z;
                if cx > 0.0 {
                    s = s.min((0.9 * th * cam_z) / cx);
                }
                if cy > 0.0 {
                    s = s.min((0.9 * tv * cam_z) / cy);
                }
            }
        }
    }
    1f64.min(0.68f64.max(s))
}

struct Drag {
    pointer_id: i32,
    start_x: f64,
    start_y: f64,
    width: f64,
    height: f64,
    start_rot: CardRotation,
    started_at: f64,
    moved: bool,
}

#[derive(Clone, Copy)]
struct Intro {
    t0: f64,
    rot0: CardRotation,
}

struct Interrupt {
    t0: f64,
    p0: [f64; 3],
}

struct FlipAnim {
    t0: f64,
    from: f64,
    to: f64,
    duration: f64,
}

/// `CardInteraction`.
pub struct CardInteraction {
    rot: CardRotation,
    flip_deg: f64,
    flipped: bool,
    intro_state: Option<IntroState>,
    o: InteractionOptions,
    active: bool,
    drag: Option<Drag>,
    pending_drag: Option<CardRotation>,
    /// `dragFrame != 0`: a flush is scheduled for the next frame.
    drag_frame: bool,
    intro: Option<Intro>,
    interrupt: Option<Interrupt>,
    flip: Option<FlipAnim>,
    fit_cache: Option<(f64, f64)>,
    events: Vec<InteractionEvent>,
    // `target.quaternion/position/scale`, and the roll of the last `apply`.
    quat: DQuat,
    roll_deg: f64,
    position: [f64; 3],
    scale: f64,
}

impl CardInteraction {
    /// The constructor's state; like the TypeScript constructor, the host then calls
    /// [`start_intro`](Self::start_intro) once (after seeding [`InteractionOptions::intro_played`]).
    pub fn new(opts: InteractionOptions) -> Self {
        let rot = opts.rotation.unwrap_or(opts.default_rotation);
        let flipped = opts.default_flipped;
        CardInteraction {
            rot,
            flip_deg: if flipped { 180.0 } else { 0.0 },
            flipped,
            intro_state: None,
            o: opts,
            active: true,
            drag: None,
            pending_drag: None,
            drag_frame: false,
            intro: None,
            interrupt: None,
            flip: None,
            fit_cache: None,
            events: Vec::new(),
            quat: DQuat::IDENTITY,
            roll_deg: 0.0,
            position: [0.0; 3],
            scale: 1.0,
        }
    }

    // ── host state ────────────────────────────────────────────────────────────

    /// Whether this card's intro key has played; the host mirrors it into its page-wide set after
    /// `start_intro` / `set_active(true)` and seeds it from that set before them.
    pub fn intro_played(&self) -> bool {
        self.o.intro_played
    }

    pub fn set_intro_played(&mut self, played: bool) {
        self.o.intro_played = played;
    }

    pub fn set_reduced_motion(&mut self, reduced: bool) {
        self.o.reduced_motion = reduced;
    }

    /// Document visibility; hiding it ends a drag (`visibilitychange`).
    pub fn set_visible(&mut self, visible: bool) {
        self.o.visible = visible;
        if !visible {
            self.end_drag();
        }
    }

    /// The element's `clientWidth / clientHeight`, read at the next `apply` (fit-to-viewport).
    pub fn set_aspect(&mut self, aspect: f64) {
        self.o.aspect = aspect;
    }

    pub fn flipped(&self) -> bool {
        self.flipped
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn intro_state(&self) -> Option<IntroState> {
        self.intro_state
    }

    pub fn rotation(&self) -> CardRotation {
        self.rot
    }

    pub fn flip_deg(&self) -> f64 {
        self.flip_deg
    }

    /// A drag is in progress (the host keeps the pointer captured).
    pub fn dragging(&self) -> bool {
        self.drag.is_some()
    }

    /// The `onRotationChange` / `onFlippedChange` callbacks fired since the last call, in order.
    pub fn drain_events(&mut self) -> Vec<InteractionEvent> {
        std::mem::take(&mut self.events)
    }

    // ── frame ─────────────────────────────────────────────────────────────────

    /// The pose as it stands, without advancing any animation (the target object after an event).
    pub fn snapshot(&self) -> InteractionFrame {
        InteractionFrame {
            quaternion: self.quat.as_quat(),
            quaternion_f64: self.quat,
            position: self.position,
            scale: self.scale,
            rotation: self.rot,
            flip_deg: self.flip_deg,
            roll_deg: self.roll_deg,
            flipped: self.flipped,
            intro_state: self.intro_state,
            animating: self.intro.is_some() || self.interrupt.is_some() || self.flip.is_some() || self.drag_frame,
        }
    }

    /// One animation frame: runs the intro, interrupt and flip steps and the coalesced drag flush
    /// that came due by `now_ms`, then returns the pose.
    pub fn update(&mut self, now_ms: f64) -> InteractionFrame {
        self.step_intro(now_ms);
        self.step_interrupt(now_ms);
        self.step_flip(now_ms);
        if self.drag_frame {
            self.flush_drag();
        }
        self.snapshot()
    }

    // ── orientation ───────────────────────────────────────────────────────────

    /// `apply(rollDeg)`: orient the target and, when fitting, scale it. The cache is keyed only on
    /// the aspect, reproduced as-is.
    fn apply(&mut self, roll_deg: f64) {
        self.quat = orient_card(self.rot, self.flip_deg, roll_deg);
        self.roll_deg = roll_deg;
        if self.o.fit_to_viewport {
            let aspect = self.o.aspect;
            let stale = match self.fit_cache {
                None => true,
                Some((a, _)) => (a - aspect).abs() > 0.01,
            };
            if stale {
                self.fit_cache = Some((aspect, fit_to_viewport_scale(self.quat, aspect)));
            }
            self.scale = self.fit_cache.map_or(1.0, |c| c.1);
        }
    }

    fn settle(&mut self) {
        self.position = [0.0; 3];
        self.scale = 1.0;
    }

    /// Imperative `setRotation`: apply, no event. Degrees.
    pub fn set_rotation(&mut self, rot: CardRotation) {
        self.rot = rot;
        self.apply(0.0);
    }

    /// Restores a pose at once, without events (`<metal-card>` resuming a parked card sets `flipDeg`
    /// and `flipped`, then calls `setRotation`). Degrees.
    pub fn restore(&mut self, rot: CardRotation, flipped: bool) {
        self.flip = None;
        self.flipped = flipped;
        self.flip_deg = if flipped { 180.0 } else { 0.0 };
        self.set_rotation(rot);
    }

    // ── intro ────────────────────────────────────────────────────

    pub fn start_intro(&mut self, now_ms: f64) {
        if self.o.intro_played {
            if self.intro.is_some() {
                self.intro_state = Some(IntroState::Running);
            }
            // Nothing re-applied; we still orient once so a fresh target isn't left at identity.
            self.apply(0.0);
            return;
        }
        self.cancel_intro();
        if !self.o.play_intro || !self.active || self.o.reduced_motion {
            self.settle();
            self.apply(0.0);
            if self.o.play_intro && self.active {
                self.o.intro_played = true;
            }
            self.intro_state = Some(IntroState::Skipped);
            return;
        }
        self.o.intro_played = true;
        self.intro_state = Some(IntroState::Running);
        let rot0 = CardRotation { x: -10.0, y: 34.0 * self.o.yaw_direction };
        self.position = [0.0, -0.22, 0.0];
        self.scale = 1.0;
        self.rot = rot0;
        self.apply(-14.0);
        self.intro = Some(Intro { t0: now_ms, rot0 });
    }

    fn step_intro(&mut self, now_ms: f64) {
        let Some(Intro { t0, rot0 }) = self.intro else { return };
        let def = self.o.default_rotation;
        let p = clamp((now_ms - t0) / INTRO_MS, 0.0, 1.0);
        let a = smootherstep(p);
        let b = smootherstep(clamp((p - 0.3) / 0.7, 0.0, 1.0));
        self.rot = CardRotation { x: lerp(rot0.x, def.x, a), y: lerp(rot0.y, def.y, a) };
        self.position[1] = lerp(-0.22, 0.0, a);
        self.scale = 1.0;
        self.apply(lerp(-14.0, 0.0, b));
        if !(p < 1.0 && self.o.visible) {
            self.finish_intro();
        }
    }

    fn finish_intro(&mut self) {
        self.intro = None;
        self.rot = self.o.default_rotation;
        self.settle();
        self.apply(0.0);
        self.intro_state = Some(IntroState::Complete);
    }

    fn cancel_intro(&mut self) {
        self.intro = None;
    }

    /// Stop the intro and tween position only to 0 over 320 ms (expoOut).
    pub fn interrupt_intro(&mut self, now_ms: f64) {
        if self.intro.is_none() {
            return;
        }
        self.cancel_intro();
        self.intro_state = Some(IntroState::Interrupting);
        self.interrupt = Some(Interrupt { t0: now_ms, p0: self.position });
    }

    fn step_interrupt(&mut self, now_ms: f64) {
        let Some(i) = &self.interrupt else { return };
        let k = clamp((now_ms - i.t0) / INTERRUPT_MS, 0.0, 1.0);
        let s = 1.0 - expo_out(k);
        self.position = [i.p0[0] * s, i.p0[1] * s, i.p0[2] * s];
        if k >= 1.0 {
            self.position = [0.0; 3];
            self.intro_state = Some(IntroState::Interrupted);
            self.interrupt = None;
        }
    }

    // ── flip / reset ────────────────────────────────────────────

    pub fn set_flipped(&mut self, flipped: bool, now_ms: f64) {
        self.flip = None;
        self.flipped = flipped;
        self.events.push(InteractionEvent::FlippedChange(flipped));
        let from = self.flip_deg;
        let to = flip_target(from, flipped);
        let delta = (to - from).abs();
        if self.o.reduced_motion || delta < 0.01 {
            self.flip_deg = to;
            self.apply(0.0);
            return;
        }
        self.flip = Some(FlipAnim { t0: now_ms, from, to, duration: flip_duration(delta) });
    }

    pub fn toggle_flip(&mut self, now_ms: f64) {
        self.set_flipped(!self.flipped, now_ms);
    }

    fn step_flip(&mut self, now_ms: f64) {
        let Some(f) = &self.flip else { return };
        let (from, to) = (f.from, f.to);
        let k = clamp((now_ms - f.t0) / f.duration, 0.0, 1.0);
        if k < 1.0 && self.o.visible {
            self.flip_deg = from + (to - from) * expo_out(k);
        } else {
            self.flip_deg = to;
            self.flip = None;
        }
        self.apply(0.0);
    }

    pub fn reset(&mut self) {
        self.cancel_intro();
        self.flip = None;
        self.interrupt = None;
        self.flip_deg = 0.0;
        if self.flipped {
            self.flipped = false;
            self.events.push(InteractionEvent::FlippedChange(false));
        }
        self.rot = self.o.default_rotation;
        self.settle();
        self.apply(0.0);
        self.intro_state = Some(IntroState::Reset);
        self.events.push(InteractionEvent::RotationChange(self.rot));
    }

    /// `active = false`: end drag, cancel intro, settle position/scale, re-apply.
    pub fn set_active(&mut self, active: bool, now_ms: f64) {
        self.active = active;
        if !active {
            self.end_drag();
            self.cancel_intro();
            self.settle();
            self.apply(0.0);
        } else {
            self.start_intro(now_ms);
        }
    }

    // ── pointer + keyboard ───────────────────────────────────────

    /// `pointerdown` (primary button; the host filters the others). `x`, `y`: client coordinates;
    /// `width`, `height`: the element's bounding box (0 counts as 1, as `r.width || 1`). Returns
    /// whether the card took the pointer (the host then captures it).
    pub fn pointer_down(&mut self, id: i32, x: f64, y: f64, width: f64, height: f64, now_ms: f64) -> bool {
        if !self.active || !self.o.interactive || !self.o.visible {
            return false;
        }
        self.interrupt_intro(now_ms);
        let or1 = |v: f64| if v == 0.0 || v.is_nan() { 1.0 } else { v };
        self.drag = Some(Drag {
            pointer_id: id,
            start_x: x,
            start_y: y,
            width: or1(width),
            height: or1(height),
            start_rot: self.rot,
            started_at: now_ms,
            moved: false,
        });
        true
    }

    /// `pointermove`. Returns whether it belongs to the drag (the host calls `preventDefault`). The
    /// rotation is applied by the next [`update`](Self::update) (drag coalescing).
    pub fn pointer_move(&mut self, id: i32, x: f64, y: f64, _now_ms: f64) -> bool {
        let Some(d) = self.drag.as_mut() else { return false };
        if id != d.pointer_id || !self.o.visible {
            return false;
        }
        let dx = x - d.start_x;
        let dy = y - d.start_y;
        if !d.moved && dx.hypot(dy) < DRAG_SLOP_PX {
            return true;
        }
        d.moved = true;
        let mut yaw = d.start_rot.y + (dx / d.width) * YAW_PER_WIDTH * self.o.yaw_direction;
        let pitch = clamp(d.start_rot.x - (dy / d.height) * PITCH_PER_HEIGHT, -PITCH_LIMIT, PITCH_LIMIT);
        if self.o.rotation_mode == RotationMode::Front {
            yaw = clamp(yaw, -PITCH_LIMIT, PITCH_LIMIT);
        }
        self.pending_drag = Some(CardRotation { x: pitch, y: yaw });
        self.drag_frame = true;
        true
    }

    fn flush_drag(&mut self) {
        self.drag_frame = false;
        let next = self.pending_drag.take();
        let Some(next) = next else { return };
        if !self.o.visible {
            return;
        }
        self.rot = next;
        self.apply(0.0);
        self.events.push(InteractionEvent::RotationChange(next));
    }

    /// `pointerup`: applies a pending drag, ends it, and a quick (<= 800 ms) release that never left
    /// the slop toggles the flip.
    pub fn pointer_up(&mut self, id: i32, _x: f64, _y: f64, now_ms: f64) {
        let Some(d) = &self.drag else { return };
        if id != d.pointer_id {
            return;
        }
        let (moved, started_at) = (d.moved, d.started_at);
        if moved && self.pending_drag.is_some() {
            self.flush_drag();
        }
        self.end_drag();
        if !moved && now_ms - started_at <= CLICK_MS {
            self.toggle_flip(now_ms);
        }
    }

    /// `pointercancel` / `lostpointercapture`.
    pub fn pointer_cancel(&mut self, id: i32) {
        if self.drag.as_ref().is_some_and(|d| d.pointer_id == id) {
            self.end_drag();
        }
    }

    fn end_drag(&mut self) {
        self.drag = None;
    }

    /// `dblclick`: reset, when interactive.
    pub fn double_click(&mut self) {
        if self.o.interactive {
            self.reset();
        }
    }

    /// `keydown` (`KeyboardEvent.key`): Home / Escape reset, Enter / Space flip. Returns whether it
    /// was handled (the host calls `preventDefault`).
    pub fn key(&mut self, key: &str, now_ms: f64) -> bool {
        if !self.o.interactive || !self.active {
            return false;
        }
        match key {
            "Home" | "Escape" => {
                self.interrupt_intro(now_ms);
                self.reset();
                true
            }
            "Enter" | " " => {
                self.interrupt_intro(now_ms);
                self.toggle_flip(now_ms);
                true
            }
            _ => false,
        }
    }

    /// `dispose`: drop every pending animation.
    pub fn dispose(&mut self) {
        self.end_drag();
        self.cancel_intro();
        self.flip = None;
        self.interrupt = None;
        self.drag_frame = false;
    }
}
