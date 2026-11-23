//! The marquee's maths (packages/core/src/marquee/constants.ts, pose.ts, strip.ts): the strip and its
//! motion store (drift, scrub, fling, seek, preview), slot assignment on the seven-slot pool, the
//! responsive layout, and each slot's pose (the arc, yaw / roll / pitch jitter, the wobble and the
//! intro fly-in). Pure functions and plain state, pinned to the TypeScript by tests/marquee.rs.

use std::f64::consts::PI;

/// World units are card units: the card is 3.37 × 2.125.
pub const ARC_SPAN: f64 = 2.8;
pub const ARC_Y: f64 = 1.05;
pub const AXIS_LOCK_PX: f64 = 10.0;
pub const MOBILE_AXIS_LOCK_PX: f64 = 14.0;
pub const CLICK_SLOP_PX: f64 = 6.0;
pub const MOBILE_CLICK_SLOP_PX: f64 = 12.0;
pub const CAM_Z: f64 = 12.0;
pub const CAM_FOV: f64 = 34.0;
pub const CAM_NEAR: f64 = 0.1;
pub const CAM_FAR: f64 = 60.0;
pub const CARD_HEIGHT_UNITS: f64 = 2.125;
pub const CARD_WIDTH_UNITS: f64 = 3.37;
pub const CARD_SPACING: f64 = 4.0;
pub const CENTER_POSE_KEEP: f64 = 0.42;
pub const CONTINUOUS_SPIN_YAW: f64 = 0.12;
pub const DRAG_SENSITIVITY: f64 = 0.01;
pub const DRIFT_RESUME_MS: f64 = 420.0;
pub const FOCUS_SPAN: f64 = 1.35;
pub const MAX_SIDE_YAW: f64 = 0.38;
pub const MAX_USER_PITCH: f64 = 1.3;
pub const MOBILE_BREAKPOINT_PX: f64 = 720.0;
pub const MOBILE_ROW_Y_FRAC: f64 = -0.02;
pub const ORBIT_HALF_ANGLE: f64 = 1.15;
pub const ORBIT_YAW_SCALE: f64 = 0.32;
pub const PITCH_RANGE: f64 = 0.2;
pub const PITCH_VAR: f64 = 0.08;
pub const PITCH_WOBBLE: f64 = 0.04;
/// Slots in the pool.
pub const POOL: usize = 7;
pub const ROLL_RANGE: f64 = 0.14;
pub const ROLL_SPAN: f64 = 1.8;
pub const ROLL_VAR: f64 = 0.06;
pub const SCRUB_FRICTION: f64 = 3.4;
pub const SCRUB_MIN_VELOCITY: f64 = 0.08;
pub const SCRUB_PX_TO_CARDS: f64 = 1.0 / 180.0;
pub const SCRUB_RESUME_DRIFT_MS: f64 = 700.0;
pub const SEEK_CENTER_EPS: f64 = 0.28;
pub const SEEK_MS_MIN: f64 = 900.0;
pub const SEEK_MS_MAX: f64 = 1300.0;
pub const SEEK_MS_PER_CARD: f64 = 150.0;
pub const SPEED: f64 = 0.24;
pub const TURN_FLIP_MS: f64 = 620.0;
pub const TURN_FLIP_SEEK_FRAC: f64 = 0.92;
pub const WOBBLE_SPEED: f64 = 0.42;
pub const YAW_PHASE_VAR: f64 = 0.25;
pub const YAW_SPAN: f64 = 1.9;
pub const YAW_VAR: f64 = 0.08;
pub const Z_FAR: f64 = -4.2;
pub const Z_NEAR: f64 = 2.2;
/// The intro.
pub const INTRO_WARM_FRAMES: u32 = 10;
pub const INTRO_SECONDS: f64 = 0.72;
pub const INTRO_MAX_FRAME: f64 = 1.0 / 45.0;
pub const INTRO_SETTLE_AT: f64 = 0.34;

const POOL_F: f64 = POOL as f64;
pub const HALF: f64 = POOL_F / 2.0;
pub const INTRO_N: f64 = 1.0 / ((POOL_F - 1.0) / 2.0);
pub const PERSP: f64 = (CAM_Z - Z_NEAR) / CAM_Z;
pub const NEAR_TO_FAR: f64 = Z_NEAR - Z_FAR;
pub const CARD_ASPECT: f64 = CARD_WIDTH_UNITS / CARD_HEIGHT_UNITS;

/// `cos(ORBIT_HALF_ANGLE)`.
pub fn cos_half() -> f64 {
    libm::cos(ORBIT_HALF_ANGLE)
}

/// The viewport's height in world units at z = 0 (camera at z 12, fov 34): a constant.
pub fn viewport_h() -> f64 {
    2.0 * CAM_Z * libm::tan((CAM_FOV / 2.0) * PI / 180.0)
}

pub fn clamp(v: f64, a: f64, b: f64) -> f64 {
    b.min(a.max(v))
}

pub fn clamp01(v: f64) -> f64 {
    clamp(v, 0.0, 1.0)
}

/// JavaScript's `Math.sign` (0 stays 0).
pub fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// JavaScript's `Math.round` (halves round up).
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `c²(3 − 2c)`, c = clamp(t, 0, 1).
pub fn smoothstep(t: f64) -> f64 {
    let c = clamp01(t);
    c * c * (3.0 - 2.0 * c)
}

pub fn ease_out_quart(t: f64) -> f64 {
    1.0 - libm::pow(1.0 - t, 4.0)
}

pub fn ease_in_out_cubic(t: f64) -> f64 {
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - libm::pow(-2.0 * t + 2.0, 3.0) / 2.0
    }
}

pub fn quad_bezier(p0: f64, p1: f64, p2: f64, t: f64) -> f64 {
    (1.0 - t) * (1.0 - t) * p0 + 2.0 * (1.0 - t) * t * p1 + t * t * p2
}

/// `fract(43758.5453 · sin(12.9898·x))`: seeds every jitter (fdlibm's sin, as V8's).
pub fn hash(x: f64) -> f64 {
    let v = 43758.5453 * libm::sin(12.9898 * x);
    v - v.floor()
}

/// The seek's easing: quadratic in to (0.4, 0.5714), quartic out.
pub fn seek_ease(t: f64) -> f64 {
    if t < 0.4 {
        let u = t / 0.4;
        return 0.5714 * u * u;
    }
    let r = 1.0 - (t - 0.4) / 0.6;
    0.5714 + 0.4286 * (1.0 - r * r * r * r)
}

// ── layout ─────────────────────────────────────────────────────

/// `MarqueeLayout`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layout {
    pub row_y_frac: f64,
    pub x_frac: f64,
    pub center_height_frac: f64,
    pub card_spacing: f64,
}

/// `DEFAULT_MARQUEE_LAYOUT`.
pub const DEFAULT_LAYOUT: Layout = Layout { row_y_frac: -0.12, x_frac: 0.0, center_height_frac: 0.3, card_spacing: 4.0 };

/// `computeMarqueeLayout`: the container's size (CSS px), an optional band (top, bottom) the centre
/// card must fit in, and whether the strip is pinned.
pub fn compute_layout(w: f64, h: f64, band: Option<(f64, f64)>, preview_paused: bool) -> Layout {
    // (NaN sizes too.)
    if w.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) || h.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return DEFAULT_LAYOUT;
    }
    let target = clamp((0.45 * h).min(0.5 * w), 172.0, 372.0);
    let narrow = clamp(target / h, 0.3, 0.4) * h;
    let mut card_h = narrow + (target - narrow) * smoothstep(clamp((w - 720.0) / 160.0, 0.0, 1.0));
    if preview_paused {
        card_h = card_h.min((0.92 * w) / CARD_ASPECT);
    }
    let row_y_frac;
    if let Some((top, bottom)) = band {
        let top = clamp(top, 0.0, h);
        let bottom = clamp(bottom, top, h);
        card_h = 1f64.max(card_h.min(bottom - top));
        row_y_frac = ((top + bottom) / 2.0 - h / 2.0) / h;
    } else {
        row_y_frac = if w <= MOBILE_BREAKPOINT_PX { MOBILE_ROW_Y_FRAC } else { -0.12 };
    }
    let center_height_frac = card_h / h;
    Layout { row_y_frac, x_frac: 0.0, center_height_frac, card_spacing: (CARD_SPACING * center_height_frac) / 0.3 }
}

pub fn layout_valid(l: &Layout) -> bool {
    [l.row_y_frac, l.x_frac, l.center_height_frac, l.card_spacing].iter().all(|v| v.is_finite()) && l.center_height_frac > 0.0 && l.card_spacing > 0.0
}

pub fn layout_differs(a: &Layout, b: &Layout) -> bool {
    (a.row_y_frac - b.row_y_frac).abs() > 1e-6
        || (a.x_frac - b.x_frac).abs() > 1e-6
        || (a.center_height_frac - b.center_height_frac).abs() > 1e-6
        || (a.card_spacing - b.card_spacing).abs() > 1e-6
}

/// `FrameInputs`: the per-frame world inputs from the layout and the canvas aspect.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameInputs {
    pub viewport_w: f64,
    /// Uniform card scale at the default layout.
    pub w: f64,
    pub x_off: f64,
    pub y_row: f64,
    pub spacing: f64,
}

pub fn frame_inputs(layout: &Layout, aspect: f64) -> FrameInputs {
    let vh = viewport_h();
    let viewport_w = vh * aspect;
    let v = (vh * layout.center_height_frac) / CARD_HEIGHT_UNITS;
    FrameInputs { viewport_w, w: v * PERSP, x_off: viewport_w * layout.x_frac * PERSP, y_row: -vh * layout.row_y_frac * PERSP, spacing: layout.card_spacing }
}

// ── per-slot and per-card randoms ────────────────────────────

/// `SlotRandoms`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SlotRandoms {
    pub phase_pitch: f64,
    pub pitch_bias: f64,
    pub intro_jitter: f64,
    pub intro_side: f64,
}

pub fn slot_randoms(e: usize) -> SlotRandoms {
    let e = e as f64;
    let r = 2.0 * hash(e + 9.0) - 1.0;
    let r1 = if r == 0.0 || r.is_nan() { 1.0 } else { r };
    SlotRandoms {
        phase_pitch: hash(e + 7.0) * 2.0 * PI,
        pitch_bias: sign(r1) * (0.35 + 0.65 * r.abs()),
        intro_jitter: (hash(3.1 * e) - 0.5) * 0.1,
        intro_side: if hash(e) > 0.5 { 1.0 } else { -1.0 },
    }
}

/// `LogicalJitter`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Jitter {
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
    pub phase: f64,
}

pub fn logical_jitter(o: f64) -> Jitter {
    Jitter {
        yaw: (2.0 * hash(1.7 * o + 3.1) - 1.0) * YAW_VAR,
        pitch: (2.0 * hash(2.3 * o + 8.7) - 1.0) * PITCH_VAR,
        roll: (2.0 * hash(3.9 * o + 1.3) - 1.0) * ROLL_VAR,
        phase: (2.0 * hash(0.7 * o + 5.5) - 1.0) * YAW_PHASE_VAR,
    }
}

/// `TurnPose`: the user's turn of a card (stand stays 0: the press / stand states are dormant).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TurnPose {
    pub yaw: f64,
    pub pitch: f64,
    pub flip: f64,
    pub stand: f64,
}

/// `SlotPose`: position, Euler XYZ (pitch, yaw, roll), uniform scale.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SlotPose {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub pitch: f64,
    pub yaw: f64,
    pub roll: f64,
    pub scale: f64,
    pub visible: bool,
}

/// `PoseInput`.
#[derive(Clone, Copy, Debug)]
pub struct PoseInput {
    pub a: f64,
    /// Marquee time, s.
    pub t: f64,
    pub frame: FrameInputs,
    pub slot: SlotRandoms,
    pub jitter: Jitter,
    pub turn: TurnPose,
    pub preview_paused: bool,
    /// The intro's `arriveT` while it runs (`introDone === false`), else `None`: the steady pose.
    pub intro: Option<f64>,
}

fn arc_angle(x: f64) -> f64 {
    clamp(x / ARC_SPAN, -1.0, 1.0) * ORBIT_HALF_ANGLE
}

/// `computeSlotPose`: the steady pose, or the fly-in while the intro runs.
pub fn slot_pose(p: &PoseInput) -> SlotPose {
    let (a, t, frame, slot, jitter, turn) = (p.a, p.t, &p.frame, &p.slot, &p.jitter, &p.turn);
    let ch = cos_half();
    let s = smoothstep(clamp(1.0 - a.abs() / FOCUS_SPAN, 0.0, 1.0));
    let b = 1.0 - s * (1.0 - CENTER_POSE_KEEP);
    let u = (libm::cos(arc_angle(a).abs()) - ch) / (1.0 - ch);

    let x0 = a * frame.spacing + frame.x_off;
    let y0 = frame.y_row - ARC_Y * (1.0 - u);
    let z0 = Z_FAR + NEAR_TO_FAR * u;

    let q = clamp((a - jitter.phase) / YAW_SPAN, -1.0, 1.0);
    let mut yaw = arc_angle(a - jitter.phase) * ORBIT_YAW_SCALE
        + sign(q) * smoothstep(q.abs()) * MAX_SIDE_YAW
        + CONTINUOUS_SPIN_YAW * a
        + jitter.yaw
        + (turn.yaw + turn.flip);
    let yy = clamp(a / ROLL_SPAN, -1.0, 1.0);
    let mut roll = sign(yy) * smoothstep(yy.abs()) * ROLL_RANGE + jitter.roll + turn.stand;
    let wobble = libm::sin(t * WOBBLE_SPEED + slot.phase_pitch) * PITCH_WOBBLE;
    let pitch_base = slot.pitch_bias * PITCH_RANGE * b + jitter.pitch * b + turn.pitch;
    let mut pitch = pitch_base + wobble;
    let scale0 = frame.w;

    if p.preview_paused && a.abs() < 0.001 {
        yaw = turn.yaw + turn.flip;
        pitch = turn.pitch;
        roll = turn.stand;
    }

    if let Some(arrive_t) = p.intro {
        // The fly-in.
        let n = clamp(a.abs() * INTRO_N + slot.intro_jitter, 0.0, 1.0);
        let pr = clamp((arrive_t - 0.36 * n) * 1.5625, 0.0, 1.0);
        if pr <= 0.001 {
            return SlotPose { x: x0, y: y0, z: z0, pitch, yaw, roll, scale: scale0, visible: false };
        }
        let pos = ease_out_quart(pr);
        let lift = 1.0 - libm::pow(1.0 - clamp((pr - 0.06) / 0.94, 0.0, 1.0), 3.0);
        let grow = ease_out_quart(clamp(1.04 * pr, 0.0, 1.0));
        let sa = sign(a);
        let side = if sa != 0.0 && !sa.is_nan() { sa } else { slot.intro_side };
        let centre = a.abs() < 0.35;
        let spread = if centre { 0.18 } else { 0.5 + 0.5 * n };
        let sx = x0 + 1.05 * side * if centre { 0.12 } else { 0.5 + 0.5 * n };
        let sy = y0 - 0.36 * (0.65 + 0.35 * n);
        let sz = z0 - 1.85 * (0.7 + 0.3 * n);
        let cx = x0 + 1.05 * side * 0.1 * n;
        let cy = y0 + 0.16 * (0.35 + 0.65 * n);
        let cz = (sz + z0) / 2.0 + 0.4;
        let pitch_steady = pitch_base + if lift > 0.55 { wobble * lift } else { 0.0 };
        return SlotPose {
            x: quad_bezier(sx, cx, x0, pos),
            y: quad_bezier(sy, cy, y0, pos),
            z: quad_bezier(sz, cz, z0, pos),
            scale: 0.82 * scale0 + 0.18 * scale0 * grow,
            yaw: yaw + 0.78 * side * spread * (1.0 - lift),
            pitch: -0.22 * spread + (pitch_steady + 0.22 * spread) * lift,
            roll: 0.11 * side * spread + (roll - 0.11 * side * spread) * lift + 0.033 * side * spread * libm::sin(PI * lift) * (1.0 - lift),
            visible: true,
        };
    }
    SlotPose { x: x0, y: y0, z: z0, pitch, yaw, roll, scale: scale0, visible: true }
}

/// The drift gate during the intro.
pub fn intro_gate(arrive_t: f64, done: bool) -> f64 {
    if done {
        1.0
    } else {
        smoothstep((arrive_t - 0.1) / 0.45)
    }
}

// ── the strip ────────────────────────────────────────────────

/// `MarqueeSeek`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Seek {
    pub active: bool,
    pub from: f64,
    pub delta: f64,
    pub start_ms: f64,
    pub duration_ms: f64,
}

/// `MarqueeStrip`: the strip's position and motion store.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Strip {
    /// Real-valued strip position in cards; increasing moves the cards toward −x.
    pub offset: f64,
    /// Marquee time, s (the pitch wobble).
    pub time: f64,
    /// Fling inertia, cards/s.
    pub scrub_velocity: f64,
    /// Drift velocity, cards/s.
    pub drift_vel: f64,
    pub drift_paused_until: f64,
    pub drag_active: bool,
    pub scrubbing: bool,
    /// ms timestamp of the previous advance; 0 = not primed.
    pub last_advance: f64,
    pub seek: Seek,
    pub focus_held: bool,
    /// `?card=` preview: strip and time frozen.
    pub preview_paused: bool,
    /// The drift gate the active hero publishes during its intro (0..1).
    pub drift_gate: f64,
}

impl Default for Strip {
    fn default() -> Self {
        Strip::new(0.0, 0.0)
    }
}

/// The strip as 16 numbers (the web binding passes it to and from the page's `MarqueeStrip`):
/// offset, time, scrubVelocity, driftVel, driftPausedUntil, dragActive, scrubbing, lastAdvance,
/// seek.active, seek.from, seek.delta, seek.startMs, seek.durationMs, focusHeld, previewPaused, driftGate.
pub const STRIP_FIELDS: usize = 16;

impl Strip {
    /// `createMarqueeStrip({ offset, time })`.
    pub fn new(offset: f64, time: f64) -> Strip {
        Strip {
            offset,
            time,
            scrub_velocity: 0.0,
            drift_vel: 0.0,
            drift_paused_until: 0.0,
            drag_active: false,
            scrubbing: false,
            last_advance: 0.0,
            seek: Seek::default(),
            focus_held: false,
            preview_paused: false,
            drift_gate: 1.0,
        }
    }

    pub fn to_array(&self) -> [f64; STRIP_FIELDS] {
        let b = |v: bool| v as u8 as f64;
        let s = &self.seek;
        [
            self.offset,
            self.time,
            self.scrub_velocity,
            self.drift_vel,
            self.drift_paused_until,
            b(self.drag_active),
            b(self.scrubbing),
            self.last_advance,
            b(s.active),
            s.from,
            s.delta,
            s.start_ms,
            s.duration_ms,
            b(self.focus_held),
            b(self.preview_paused),
            self.drift_gate,
        ]
    }

    pub fn from_array(v: &[f64]) -> Option<Strip> {
        if v.len() < STRIP_FIELDS {
            return None;
        }
        let b = |x: f64| x != 0.0;
        Some(Strip {
            offset: v[0],
            time: v[1],
            scrub_velocity: v[2],
            drift_vel: v[3],
            drift_paused_until: v[4],
            drag_active: b(v[5]),
            scrubbing: b(v[6]),
            last_advance: v[7],
            seek: Seek { active: b(v[8]), from: v[9], delta: v[10], start_ms: v[11], duration_ms: v[12] },
            focus_held: b(v[13]),
            preview_paused: b(v[14]),
            drift_gate: v[15],
        })
    }

    /// `advanceMarqueeDrift(now, gate)`: once per animating frame, `now` in ms.
    pub fn advance_drift(&mut self, now: f64, gate: f64) {
        let prev = self.last_advance;
        self.last_advance = now;
        if prev == 0.0 {
            return;
        }
        let dt = (now - prev) / 1000.0;
        if dt.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            return;
        }
        let g = clamp(gate, 0.0, 1.0).min(self.drift_gate);
        if !self.preview_paused {
            self.time += dt;
        }
        if self.seek.active {
            let p = clamp((now - self.seek.start_ms) / self.seek.duration_ms.max(1.0), 0.0, 1.0);
            self.offset = self.seek.from + self.seek.delta * seek_ease(p);
            if p >= 1.0 {
                self.seek.active = false;
                self.scrub_velocity = 0.0;
                self.drift_paused_until = 0.0;
                self.drift_vel = 0.0;
            }
            return;
        }
        if self.focus_held || self.preview_paused {
            self.scrub_velocity = 0.0;
            self.drift_vel = 0.0;
            return;
        }
        let inertia = !self.scrubbing && self.scrub_velocity.abs() > SCRUB_MIN_VELOCITY;
        if inertia {
            self.offset += self.scrub_velocity * dt;
            self.scrub_velocity *= libm::exp(-SCRUB_FRICTION * dt);
            if self.scrub_velocity.abs() <= SCRUB_MIN_VELOCITY {
                self.drift_vel = self.scrub_velocity;
                self.scrub_velocity = 0.0;
                self.drift_paused_until = 0.0;
            }
        }
        if !self.scrubbing && !inertia && now >= self.drift_paused_until && !self.drag_active {
            let target = SPEED * g;
            let k = 1.0 - libm::exp(-dt / (DRIFT_RESUME_MS / 1000.0));
            self.drift_vel += (target - self.drift_vel) * k;
            self.offset += self.drift_vel * dt;
        }
    }

    /// Press: cancel the seek, stop the strip dead.
    pub fn begin_gesture(&mut self) {
        self.seek.active = false;
        self.drag_active = true;
        self.scrubbing = false;
        self.scrub_velocity = 0.0;
        self.drift_vel = 0.0;
    }

    pub fn end_gesture(&mut self) {
        self.drag_active = false;
        self.scrubbing = false;
    }

    pub fn scrub_by(&mut self, d: f64, now: f64) {
        self.seek.active = false;
        self.offset += d;
        self.scrub_velocity = 0.0;
        self.scrubbing = true;
        self.drift_paused_until = now + SCRUB_RESUME_DRIFT_MS;
        self.drift_vel = 0.0;
    }

    /// Like `scrub_by` without setting `scrubbing`.
    pub fn wheel_scrub(&mut self, d: f64, now: f64) {
        self.seek.active = false;
        self.offset += d;
        self.scrub_velocity = 0.0;
        self.drift_paused_until = now + SCRUB_RESUME_DRIFT_MS;
        self.drift_vel = 0.0;
    }

    pub fn fling(&mut self, v: f64) {
        self.seek.active = false;
        self.drag_active = false;
        self.scrubbing = false;
        self.scrub_velocity = v;
        self.drift_paused_until = 0.0;
        self.drift_vel = 0.0;
    }

    /// Starts a seek by `d` cards; returns its duration in ms (0 if ignored).
    pub fn seek_by(&mut self, d: f64, now: f64) -> f64 {
        if !d.is_finite() || d.abs() < 1e-4 {
            return 0.0;
        }
        self.seek.active = false;
        self.drag_active = false;
        self.scrubbing = false;
        self.scrub_velocity = 0.0;
        self.drift_vel = 0.0;
        self.drift_paused_until = 0.0;
        let duration_ms = clamp(SEEK_MS_MIN + SEEK_MS_PER_CARD * d.abs(), SEEK_MS_MIN, SEEK_MS_MAX);
        self.seek = Seek { active: true, from: self.offset, delta: d, start_ms: now, duration_ms };
        duration_ms
    }

    pub fn set_focus_hold(&mut self, held: bool) {
        self.focus_held = held;
        if held {
            self.scrubbing = false;
            self.scrub_velocity = 0.0;
            self.drift_vel = 0.0;
            self.drag_active = false;
            self.drift_paused_until = 0.0;
        }
    }

    pub fn publish_drift_gate(&mut self, g: f64) {
        self.drift_gate = clamp(g, 0.0, 1.0);
    }

    pub fn is_user_scrolling(&self, now: f64) -> bool {
        self.scrubbing || self.scrub_velocity.abs() > SCRUB_MIN_VELOCITY || now < self.drift_paused_until
    }

    /// `initializeMarqueePreview(i)`: centre design `i`, freeze the strip and its time.
    pub fn initialize_preview(&mut self, index: f64) {
        self.seek.active = false;
        self.offset = index;
        self.time = 0.0;
        self.scrub_velocity = 0.0;
        self.drift_vel = 0.0;
        self.drift_paused_until = 0.0;
        self.drag_active = false;
        self.scrubbing = false;
        self.preview_paused = true;
    }
}

/// `SlotAssignment`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Assignment {
    /// Logical card index (may be negative).
    pub logical: i64,
    /// Wrapped strip position in [−3.5, 3.5).
    pub a: f64,
    /// Design index `logical mod designs`.
    pub design: usize,
}

/// `assignSlot(e, offset, designCount)`.
pub fn assign_slot(e: usize, offset: f64, designs: usize) -> Assignment {
    let a0 = e as f64 - offset;
    let n = ((a0 + HALF) / POOL_F).floor();
    let logical = e as f64 - POOL_F * n;
    let a = a0 - POOL_F * n;
    let design = if designs > 0 { (logical as i64).rem_euclid(designs as i64) as usize } else { 0 };
    Assignment { logical: logical as i64, a, design }
}

/// `wrappedDistance(logical, offset)`: the seek distance for a click on `logical`.
pub fn wrapped_distance(logical: i64, offset: f64) -> f64 {
    let r = logical as f64 - offset;
    r - POOL_F * ((r + HALF) / POOL_F).floor()
}
